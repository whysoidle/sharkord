import { useCurrentVoiceChannelId } from '@/features/server/channels/hooks';
import { useWebRtcSimulcastEnabled } from '@/features/server/hooks';
import { SoundType } from '@/features/server/types';
import { useOwnVoiceState } from '@/features/server/voice/hooks';
import {
  clampMicrophoneDecibels,
  MICROPHONE_GATE_CLOSE_HOLD_MS,
  MICROPHONE_GATE_DEFAULT_THRESHOLD_DB
} from '@/helpers/audio-gate';
import {
  createNoiseGateWorkletNode,
  getNoiseGateWorkletAvailabilitySnapshot,
  markNoiseGateWorkletUnavailable,
  postNoiseGateWorkletConfig
} from '@/helpers/audio-worklet/noise-gate-worklet';
import { createNsChain } from '@/helpers/audio-worklet/ns-worklet';
import { playSound } from '@/helpers/sounds';

import { voiceSessionIdSelector } from '@/features/server/voice/selectors';
import { store } from '@/features/store';
import { voiceLogger } from '@/helpers/browser-logger';
import {
  getRestrictOwnAudioSupport,
  getSuppressLocalAudioPlaybackSupport
} from '@/helpers/get-display-media-support';
import { getResWidthHeight } from '@/helpers/get-res-with-height';
import { registerVoiceDebugSource } from '@/helpers/voice-debug';
import { withTimeout } from '@/helpers/with-timeout';
import { useScreenShareSupport } from '@/hooks/use-screen-share-support';
import { getTRPCClient } from '@/lib/trpc';
import { NoiseSuppression, VideoCodec, type TStreamQuality } from '@/types';
import {
  DEFAULT_BITRATE,
  getErrorMessage,
  StreamKind,
  type ConsumerType,
  type TStreamQualityLayer,
  type TVoiceUserState
} from '@sharkord/shared';
import { Device } from 'mediasoup-client';
import type {
  ProducerOptions,
  RtpCapabilities,
  RtpCodecCapability
} from 'mediasoup-client/types';
import {
  createContext,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react';
import { useDevices } from '../devices-provider/hooks/use-devices';
import {
  clearVoiceControlsBridge,
  setVoiceControlsBridge
} from './controls-bridge';
import { FloatingPinnedCard } from './floating-pinned-card';
import {
  getRemoteConsumerTypeKey,
  getScreenShareSimulcastEncodings,
  getSimulcastCodec,
  getSimulcastEncodings,
  getSimulcastQualityLayers,
  getStreamQualityStorageKey,
  loadStreamQualitiesFromStorage,
  normalizeStreamQuality,
  saveStreamQualitiesToStorage,
  type TRemoteConsumerTypes,
  type TRemoteQualityLayers,
  type TStreamQualitySettings
} from './helpers';
import { useLocalStreams } from './hooks/use-local-streams';
import { useRemoteStreams } from './hooks/use-remote-streams';
import { useTransportStats } from './hooks/use-transport-stats';
import { useTransports } from './hooks/use-transports';
import { useVoiceControls } from './hooks/use-voice-controls';
import { useVoiceEvents } from './hooks/use-voice-events';
import { useVoiceHotkeys } from './hooks/use-voice-hotkeys';
import { useVoiceRecovery } from './hooks/use-voice-recovery';
import { SIMULCAST_WEBCAM_MAX_BITRATE } from './statics';
import { VoiceStatsContext } from './stats-context';
import { VolumeControlProvider } from './volume-control-context';

type AudioVideoRefs = {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  audioRef: React.RefObject<HTMLAudioElement | null>;
  screenShareRef: React.RefObject<HTMLVideoElement | null>;
  screenShareAudioRef: React.RefObject<HTMLAudioElement | null>;
  externalAudioRef: React.RefObject<HTMLAudioElement | null>;
  externalVideoRef: React.RefObject<HTMLVideoElement | null>;
};

type TVideoProducerAppData = {
  kind: StreamKind;
  qualityLayers?: TStreamQualityLayer[];
};

type TRefsKey = number | `external:${number}`;

export type { AudioVideoRefs };

enum ConnectionStatus {
  DISCONNECTED = 'disconnected',
  CONNECTING = 'connecting',
  CONNECTED = 'connected',
  FAILED = 'failed'
}

export type TVoiceProvider = {
  loading: boolean;
  connectionStatus: ConnectionStatus;
  audioVideoRefsMap: Map<TRefsKey, AudioVideoRefs>;
  ownVoiceState: TVoiceUserState;
  isScreenShareSupported: boolean;
  getOrCreateRefs: (remoteId: number, isExternal?: boolean) => AudioVideoRefs;
  getConsumerCodec: (remoteId: number, kind: StreamKind) => string | undefined;
  getStreamQuality: (remoteId: number, kind: StreamKind) => TStreamQuality;
  getStreamQualityLayers: (
    remoteId: number,
    kind: StreamKind
  ) => TStreamQualityLayer[];
  setStreamQuality: (
    remoteId: number,
    kind: StreamKind.VIDEO | StreamKind.SCREEN | StreamKind.EXTERNAL_VIDEO,
    quality: TStreamQuality
  ) => Promise<void>;
  isSimulcastConsumer: (remoteId: number, kind: StreamKind) => boolean;
  init: (
    routerRtpCapabilities: RtpCapabilities,
    channelId: number
  ) => Promise<void>;
} & Pick<
  ReturnType<typeof useLocalStreams>,
  | 'localAudioStream'
  | 'localVideoStream'
  | 'localScreenShareStream'
  | 'localScreenShareAudioStream'
> &
  Pick<
    ReturnType<typeof useRemoteStreams>,
    'remoteUserStreams' | 'externalStreams'
  > &
  ReturnType<typeof useVoiceControls>;

const VoiceProviderContext = createContext<TVoiceProvider>({
  loading: false,
  connectionStatus: ConnectionStatus.DISCONNECTED,
  audioVideoRefsMap: new Map(),
  isScreenShareSupported: false,
  getOrCreateRefs: () => ({
    videoRef: { current: null },
    audioRef: { current: null },
    screenShareRef: { current: null },
    screenShareAudioRef: { current: null },
    externalAudioRef: { current: null },
    externalVideoRef: { current: null }
  }),
  getConsumerCodec: () => undefined,
  getStreamQuality: () => ({ mode: 'auto' }),
  getStreamQualityLayers: () => [],
  setStreamQuality: () => Promise.resolve(),
  isSimulcastConsumer: () => false,
  init: () => Promise.resolve(),
  toggleMic: () => Promise.resolve(),
  toggleSound: () => Promise.resolve(),
  toggleWebcam: () => Promise.resolve(),
  toggleScreenShare: () => Promise.resolve(),
  ownVoiceState: {
    micMuted: false,
    soundMuted: false,
    webcamEnabled: false,
    sharingScreen: false,
    serverMuted: false
  },
  localAudioStream: undefined,
  localVideoStream: undefined,
  localScreenShareStream: undefined,
  localScreenShareAudioStream: undefined,

  remoteUserStreams: {},
  externalStreams: {}
});

type TVoiceProviderProps = {
  children: React.ReactNode;
};

const VoiceProvider = memo(({ children }: TVoiceProviderProps) => {
  const [loading, setLoading] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>(
    ConnectionStatus.DISCONNECTED
  );
  const routerRtpCapabilities = useRef<RtpCapabilities | null>(null);
  const deviceRtpCapabilities = useRef<RtpCapabilities | null>(null);
  const audioVideoRefsMap = useRef<Map<TRefsKey, AudioVideoRefs>>(new Map());
  const previousVoiceChannelIdRef = useRef<number | undefined>(undefined);
  const initializationGeneration = useRef(0);
  const recoveryCallback = useRef<() => void>(() => {});
  const [mediaRevision, setMediaRevision] = useState(0);
  const onRecoveryNeeded = useCallback(() => recoveryCallback.current(), []);
  const [streamQualities, setStreamQualities] =
    useState<TStreamQualitySettings>(loadStreamQualitiesFromStorage);
  const [remoteConsumerTypes, setRemoteConsumerTypes] =
    useState<TRemoteConsumerTypes>({});
  const [remoteQualityLayers, setRemoteQualityLayers] =
    useState<TRemoteQualityLayers>({});
  const currentVoiceChannelId = useCurrentVoiceChannelId();
  const webRtcSimulcastEnabled = useWebRtcSimulcastEnabled();
  const ownVoiceState = useOwnVoiceState();
  const { devices } = useDevices();
  const { isScreenShareSupported } = useScreenShareSupport();

  const simulcastEnabled =
    !!webRtcSimulcastEnabled && !!devices.simulcastEnabled;

  const getStreamQuality = useCallback(
    (remoteId: number, kind: StreamKind): TStreamQuality => {
      const storageKey = getStreamQualityStorageKey(remoteId, kind);
      const consumerKey = getRemoteConsumerTypeKey(remoteId, kind);
      const layers = remoteQualityLayers[consumerKey] ?? [];

      return normalizeStreamQuality(streamQualities[storageKey], layers);
    },
    [remoteQualityLayers, streamQualities]
  );

  const getStreamQualityLayers = useCallback(
    (remoteId: number, kind: StreamKind): TStreamQualityLayer[] => {
      const consumerKey = getRemoteConsumerTypeKey(remoteId, kind);

      return remoteQualityLayers[consumerKey] ?? [];
    },
    [remoteQualityLayers]
  );

  const setRemoteStreamQualityLayers = useCallback(
    (remoteId: number, kind: StreamKind, layers: TStreamQualityLayer[]) => {
      const key = getRemoteConsumerTypeKey(remoteId, kind);

      setRemoteQualityLayers((prev) => {
        if (layers.length === 0) {
          const next = { ...prev };

          delete next[key];

          return next;
        }

        return { ...prev, [key]: layers };
      });
    },
    []
  );

  const clearRemoteConsumerMetadata = useCallback(() => {
    setRemoteConsumerTypes({});
    setRemoteQualityLayers({});
  }, []);

  const shouldShowQualityPicker = useCallback(
    (remoteId: number, kind: StreamKind): boolean => {
      const key = getRemoteConsumerTypeKey(remoteId, kind);

      return (
        remoteConsumerTypes[key] === 'simulcast' &&
        (remoteQualityLayers[key]?.length ?? 0) > 0
      );
    },
    [remoteConsumerTypes, remoteQualityLayers]
  );

  const setRemoteConsumerType = useCallback(
    (
      remoteId: number,
      kind: StreamKind,
      consumerType: ConsumerType | undefined
    ) => {
      const key = getRemoteConsumerTypeKey(remoteId, kind);

      setRemoteConsumerTypes((prev) => {
        if (consumerType === undefined) {
          const next = { ...prev };

          delete next[key];

          return next;
        }

        return { ...prev, [key]: consumerType };
      });
    },
    []
  );

  const isSimulcastConsumer = useCallback(
    (remoteId: number, kind: StreamKind): boolean => {
      return shouldShowQualityPicker(remoteId, kind);
    },
    [shouldShowQualityPicker]
  );

  const setStreamQuality = useCallback(
    async (
      remoteId: number,
      kind: StreamKind.VIDEO | StreamKind.SCREEN | StreamKind.EXTERNAL_VIDEO,
      quality: TStreamQuality
    ) => {
      setStreamQualities((prev) => {
        const next = {
          ...prev,
          [getStreamQualityStorageKey(remoteId, kind)]: quality
        };

        saveStreamQualitiesToStorage(next);

        return next;
      });

      if (!shouldShowQualityPicker(remoteId, kind)) return;

      const client = getTRPCClient();

      try {
        await client.voice.setConsumerQuality.mutate({
          remoteId,
          kind,
          quality
        });

        voiceLogger.info('consumer: quality changed', {
          remoteId,
          kind,
          quality
        });
      } catch (error) {
        voiceLogger.error('consumer: quality change failed', error, {
          remoteId,
          kind,
          quality
        });
      }
    },
    [shouldShowQualityPicker]
  );

  const getOrCreateRefs = useCallback(
    (remoteId: number, isExternal = false): AudioVideoRefs => {
      const key: TRefsKey = isExternal ? `external:${remoteId}` : remoteId;

      if (!audioVideoRefsMap.current.has(key)) {
        audioVideoRefsMap.current.set(key, {
          videoRef: { current: null },
          audioRef: { current: null },
          screenShareRef: { current: null },
          screenShareAudioRef: { current: null },
          externalAudioRef: { current: null },
          externalVideoRef: { current: null }
        });
      }

      return audioVideoRefsMap.current.get(key)!;
    },
    []
  );

  const {
    addExternalStreamTrack,
    removeExternalStreamTrack,
    removeExternalStream,
    clearExternalStreams,
    addRemoteUserStream,
    removeRemoteUserStream,
    clearRemoteUserStreamsForUser,
    clearRemoteUserStreams,
    externalStreams,
    remoteUserStreams
  } = useRemoteStreams();

  const {
    localAudioProducer,
    localVideoProducer,
    localAudioStream,
    localVideoStream,
    localScreenShareStream,
    localScreenShareAudioStream,
    localScreenShareProducer,
    localScreenShareAudioProducer,
    setLocalAudioStream,
    setLocalVideoStream,
    setLocalScreenShare,
    setLocalScreenShareAudio,
    clearLocalStreams
  } = useLocalStreams();

  const {
    producerTransport,
    consumerTransport,
    consumers,
    createProducerTransport,
    createConsumerTransport,
    consume,
    consumeExistingProducers,
    cleanupTransports,
    getConsumerCodec,
    restartIce,
    waitForConnection,
    closeConsumer,
    closeUserConsumers
  } = useTransports({
    onRecoveryNeeded,
    addExternalStreamTrack,
    removeExternalStreamTrack,
    addRemoteUserStream,
    removeRemoteUserStream,
    setRemoteConsumerType,
    setRemoteStreamQualityLayers,
    clearRemoteConsumerMetadata
  });

  const {
    stats: transportStats,
    subscribe: subscribeToStats,
    startMonitoring,
    stopMonitoring,
    resetStats,
    setScreenShareProducer
  } = useTransportStats();
  const rawMicrophoneStreamRef = useRef<MediaStream | null>(null);
  const transmitMicrophoneTrackRef = useRef<MediaStreamTrack | null>(null);
  const microphoneNoiseGateAudioContextRef = useRef<AudioContext | null>(null);
  const microphoneNoiseGateWorkletNodeRef = useRef<AudioWorkletNode | null>(
    null
  );
  const nsAudioContextsRef = useRef<AudioContext[]>([]);
  const micMutedRef = useRef(ownVoiceState.micMuted);

  const syncTransmitMicrophoneTrackState = useCallback(() => {
    const track = transmitMicrophoneTrackRef.current;

    if (!track) return;

    const shouldEnable = !micMutedRef.current;

    if (track.enabled !== shouldEnable) {
      track.enabled = shouldEnable;
    }
  }, []);

  const cleanupMicProcessingResources = useCallback(() => {
    voiceLogger.info('mic: releasing capture resources');

    if (microphoneNoiseGateWorkletNodeRef.current) {
      microphoneNoiseGateWorkletNodeRef.current.disconnect();
      microphoneNoiseGateWorkletNodeRef.current = null;
    }

    if (microphoneNoiseGateAudioContextRef.current) {
      microphoneNoiseGateAudioContextRef.current.close();
      microphoneNoiseGateAudioContextRef.current = null;
    }

    nsAudioContextsRef.current.forEach((ctx) => ctx.close());
    nsAudioContextsRef.current = [];

    rawMicrophoneStreamRef.current
      ?.getTracks()
      .forEach((track) => track.stop());
    rawMicrophoneStreamRef.current = null;

    transmitMicrophoneTrackRef.current?.stop();
    transmitMicrophoneTrackRef.current = null;
  }, []);

  useEffect(() => {
    micMutedRef.current = ownVoiceState.micMuted;
    syncTransmitMicrophoneTrackState();
  }, [ownVoiceState.micMuted, syncTransmitMicrophoneTrackState]);

  useEffect(() => {
    if (!microphoneNoiseGateWorkletNodeRef.current) return;

    postNoiseGateWorkletConfig(microphoneNoiseGateWorkletNodeRef.current, {
      enabled: devices.noiseGateEnabled ?? true,
      holdMs: MICROPHONE_GATE_CLOSE_HOLD_MS
    });
  }, [devices.noiseGateEnabled]);

  useEffect(() => {
    if (!microphoneNoiseGateWorkletNodeRef.current) return;

    postNoiseGateWorkletConfig(microphoneNoiseGateWorkletNodeRef.current, {
      thresholdDb: clampMicrophoneDecibels(
        devices.noiseGateThresholdDb ?? MICROPHONE_GATE_DEFAULT_THRESHOLD_DB
      )
    });
  }, [devices.noiseGateThresholdDb]);

  const startMicStream = useCallback(
    async (signal?: AbortSignal) => {
      const sending = producerTransport.current;
      let acquired: MediaStream | undefined;
      const assertCurrent = () => {
        signal?.throwIfAborted();
        if (sending !== producerTransport.current || !sending || sending.closed)
          throw new DOMException('Voice transport changed', 'AbortError');
      };
      try {
        voiceLogger.info('mic: starting');
        cleanupMicProcessingResources();

        const useNsChain =
          devices.noiseSuppression === NoiseSuppression.DTLN ||
          devices.noiseSuppression === NoiseSuppression.RNNOISE;
        const useStandardNs =
          devices.noiseSuppression === NoiseSuppression.STANDARD;
        const useDtln = devices.noiseSuppression === NoiseSuppression.DTLN;

        const hasSpecificMic =
          !!devices.microphoneId && devices.microphoneId !== 'default';

        const micStreamConstraints: MediaStreamConstraints = {
          audio: {
            deviceId: hasSpecificMic
              ? { exact: devices.microphoneId }
              : undefined,
            autoGainControl: devices.autoGainControl,
            echoCancellation: devices.echoCancellation,
            noiseSuppression: useStandardNs,
            sampleRate: useDtln ? 16000 : undefined,
            channelCount: 1
          },
          video: false
        };

        voiceLogger.info('mic: requesting stream', {
          constraints: micStreamConstraints
        });

        const rawStream =
          await navigator.mediaDevices.getUserMedia(micStreamConstraints);
        acquired = rawStream;
        assertCurrent();

        voiceLogger.info('mic: stream obtained', {
          trackId: rawStream.getAudioTracks()[0]?.id,
          label: rawStream.getAudioTracks()[0]?.label
        });

        rawMicrophoneStreamRef.current = rawStream;

        const rawAudioTrack = rawStream.getAudioTracks()[0];

        if (rawAudioTrack) {
          const shouldUseNoiseGate = !!devices.noiseGateEnabled;
          const noiseGateAvailability =
            getNoiseGateWorkletAvailabilitySnapshot();
          let transmitTrack: MediaStreamTrack = rawAudioTrack;
          let transmitStream: MediaStream = rawStream;

          if (shouldUseNoiseGate && noiseGateAvailability.available) {
            let audioContext: AudioContext | null = null;

            try {
              audioContext = new window.AudioContext();
              const source = audioContext.createMediaStreamSource(rawStream);
              const noiseGateNode = await createNoiseGateWorkletNode(
                audioContext,
                {
                  enabled: true,
                  thresholdDb: clampMicrophoneDecibels(
                    devices.noiseGateThresholdDb ??
                      MICROPHONE_GATE_DEFAULT_THRESHOLD_DB
                  ),
                  holdMs: MICROPHONE_GATE_CLOSE_HOLD_MS
                }
              );
              const destination = audioContext.createMediaStreamDestination();

              source.connect(noiseGateNode);
              noiseGateNode.connect(destination);

              const processedTrack = destination.stream.getAudioTracks()[0];

              if (processedTrack) {
                microphoneNoiseGateAudioContextRef.current = audioContext;
                microphoneNoiseGateWorkletNodeRef.current = noiseGateNode;
                transmitTrack = processedTrack;
                transmitStream = destination.stream;
              } else {
                noiseGateNode.disconnect();
                audioContext.close();
                audioContext = null;
                voiceLogger.warn(
                  'mic: noise gate produced no track, using ungated stream'
                );
              }
            } catch (error) {
              if (audioContext) {
                audioContext.close();
              }
              if (signal?.aborted || sending !== producerTransport.current)
                throw error;

              voiceLogger.error(
                'mic: noise gate worklet failed, using ungated stream',
                error
              );
              markNoiseGateWorkletUnavailable(
                'Failed to initialize the noise gate audio processor.'
              );
            }
          } else if (shouldUseNoiseGate && !noiseGateAvailability.available) {
            voiceLogger.warn(
              'mic: noise gate unavailable, using ungated stream',
              {
                reason: noiseGateAvailability.reason
              }
            );
          }

          if (useNsChain) {
            voiceLogger.info('mic: setting up noise suppression', {
              type: devices.noiseSuppression
            });

            try {
              const chain = await createNsChain(
                devices.noiseSuppression,
                transmitStream
              );
              if (signal?.aborted || sending !== producerTransport.current) {
                chain.outputTrack.stop();
                chain.contexts.forEach((context) => {
                  context.close();
                });
                assertCurrent();
              }
              nsAudioContextsRef.current = chain.contexts;
              transmitTrack = chain.outputTrack;
              transmitStream = new MediaStream([chain.outputTrack]);
              voiceLogger.info('mic: noise suppression ready');
            } catch (nsError) {
              voiceLogger.warn('mic: noise suppression setup failed', {
                error: nsError
              });
            }
          }

          assertCurrent();
          transmitMicrophoneTrackRef.current = transmitTrack;
          setLocalAudioStream(transmitStream);
          syncTransmitMicrophoneTrackState();

          voiceLogger.info('mic: audio track obtained', {
            trackId: rawAudioTrack.id,
            readyState: rawAudioTrack.readyState,
            settings: rawAudioTrack.getSettings()
          });

          if (!producerTransport.current) {
            throw new Error('Producer transport is not available');
          }

          const audioProducer = await sending!.produce({
            track: transmitTrack,
            codecOptions: {
              opusStereo: false,
              opusFec: true,
              opusDtx: false,
              opusMaxPlaybackRate: 48000,
              opusMaxAverageBitrate: 128000
            },
            appData: { kind: StreamKind.AUDIO }
          });
          if (signal?.aborted || sending !== producerTransport.current) {
            audioProducer.close();
            assertCurrent();
          }
          localAudioProducer.current = audioProducer;

          voiceLogger.info('mic: producer created', {
            producerId: localAudioProducer.current.id
          });

          audioProducer.observer.on('close', async () => {
            voiceLogger.info('mic: producer closed');

            const trpc = getTRPCClient();

            try {
              await trpc.voice.closeProducer.mutate({
                kind: StreamKind.AUDIO,
                producerId: audioProducer.id
              });
            } catch (error) {
              voiceLogger.error(
                'mic: closing producer on the server failed',
                error
              );
            }
          });

          rawAudioTrack.onended = () => {
            voiceLogger.warn('mic: track ended, cleaning up');

            transmitStream.getAudioTracks().forEach((track) => {
              track.stop();
            });
            cleanupMicProcessingResources();
            localAudioProducer.current?.close();

            setLocalAudioStream(undefined);
          };
        } else {
          rawStream.getTracks().forEach((track) => track.stop());
          throw new Error('Failed to obtain audio track from microphone');
        }
      } catch (error) {
        acquired?.getTracks().forEach((track) => track.stop());
        if (sending !== producerTransport.current) throw error;
        cleanupMicProcessingResources();
        setLocalAudioStream(undefined);
        voiceLogger.error('mic: start failed', error);
        throw error;
      }
    },
    [
      cleanupMicProcessingResources,
      producerTransport,
      setLocalAudioStream,
      localAudioProducer,
      syncTransmitMicrophoneTrackState,
      devices.microphoneId,
      devices.autoGainControl,
      devices.echoCancellation,
      devices.noiseSuppression,
      devices.noiseGateEnabled,
      devices.noiseGateThresholdDb
    ]
  );

  const startWebcamStream = useCallback(async () => {
    try {
      voiceLogger.info('webcam: starting');

      const hasSpecificWebcam =
        !!devices?.webcamId && devices.webcamId !== 'default';

      const webcamConstraints: MediaStreamConstraints = {
        video: {
          deviceId: hasSpecificWebcam ? { exact: devices.webcamId } : undefined,
          frameRate: devices.webcamFramerate,
          ...getResWidthHeight(devices?.webcamResolution)
        },
        audio: false
      };

      voiceLogger.info('webcam: requesting stream', {
        constraints: webcamConstraints
      });

      const stream =
        await navigator.mediaDevices.getUserMedia(webcamConstraints);

      voiceLogger.info('webcam: stream obtained', {
        trackId: stream.getVideoTracks()[0]?.id,
        label: stream.getVideoTracks()[0]?.label
      });

      setLocalVideoStream(stream);

      const videoTrack = stream.getVideoTracks()[0];

      if (videoTrack) {
        voiceLogger.info('webcam: video track obtained', {
          trackId: videoTrack.id,
          readyState: videoTrack.readyState,
          settings: videoTrack.getSettings()
        });

        const simulcastCodec = simulcastEnabled
          ? getSimulcastCodec(routerRtpCapabilities.current)
          : undefined;

        const webcamProducerOptions: ProducerOptions<TVideoProducerAppData> = {
          track: videoTrack,
          appData: {
            kind: StreamKind.VIDEO
          }
        };
        let simulcastWebcamProducerOptions = webcamProducerOptions;

        if (simulcastCodec) {
          voiceLogger.info('webcam: using vp8 for simulcast', {
            codec: simulcastCodec.mimeType
          });

          const encodings = getSimulcastEncodings(SIMULCAST_WEBCAM_MAX_BITRATE);

          const qualityLayers = getSimulcastQualityLayers(encodings);

          simulcastWebcamProducerOptions = {
            ...webcamProducerOptions,
            appData: { kind: StreamKind.VIDEO, qualityLayers },
            codec: simulcastCodec,
            encodings
          };
        }

        try {
          localVideoProducer.current = await producerTransport.current?.produce(
            simulcastWebcamProducerOptions
          );
        } catch (error) {
          if (!simulcastCodec) throw error;

          voiceLogger.warn(
            'webcam: simulcast producer failed, retrying without simulcast',
            { error: getErrorMessage(error) }
          );

          localVideoProducer.current = await producerTransport.current?.produce(
            webcamProducerOptions
          );
        }

        voiceLogger.info('webcam: producer created', {
          producerId: localVideoProducer.current?.id
        });

        const videoProducer = localVideoProducer.current;
        videoProducer?.observer.on('close', async () => {
          voiceLogger.info('webcam: producer closed');

          try {
            const trpc = getTRPCClient();
            await trpc.voice.closeProducer.mutate({
              kind: StreamKind.VIDEO,
              producerId: videoProducer.id
            });
          } catch (error) {
            voiceLogger.error(
              'webcam: closing producer on the server failed',
              error
            );
          }
        });

        videoTrack.onended = () => {
          voiceLogger.warn('webcam: track ended, cleaning up');

          localVideoStream?.getVideoTracks().forEach((track) => {
            track.stop();
          });
          localVideoProducer.current?.close();

          setLocalVideoStream(undefined);
        };
      } else {
        throw new Error('Failed to obtain video track from webcam');
      }
    } catch (error) {
      voiceLogger.error('webcam: start failed', error);
      throw error;
    }
  }, [
    setLocalVideoStream,
    localVideoProducer,
    producerTransport,
    localVideoStream,
    devices.webcamId,
    devices.webcamFramerate,
    devices.webcamResolution,
    simulcastEnabled
  ]);

  const stopWebcamStream = useCallback(() => {
    voiceLogger.info('webcam: stopping');

    localVideoStream?.getVideoTracks().forEach((track) => {
      voiceLogger.info('webcam: stopping track', { trackId: track.id });

      track.stop();
      localVideoStream.removeTrack(track);
    });

    localVideoProducer.current?.close();
    localVideoProducer.current = undefined;

    setLocalVideoStream(undefined);
  }, [localVideoStream, setLocalVideoStream, localVideoProducer]);

  const stopScreenShareStream = useCallback(() => {
    voiceLogger.info('screen: stopping');

    localScreenShareStream?.getTracks().forEach((track) => {
      voiceLogger.info('screen: stopping track', {
        trackId: track.id,
        kind: track.kind
      });

      track.stop();
      localScreenShareStream.removeTrack(track);
    });

    localScreenShareProducer.current?.close();
    localScreenShareProducer.current = undefined;

    localScreenShareAudioProducer.current?.close();
    localScreenShareAudioProducer.current = undefined;

    setScreenShareProducer(null);
    setLocalScreenShare(undefined);
    setLocalScreenShareAudio(undefined);
  }, [
    localScreenShareStream,
    setLocalScreenShare,
    setLocalScreenShareAudio,
    localScreenShareProducer,
    localScreenShareAudioProducer,
    setScreenShareProducer
  ]);

  const startScreenShareStream = useCallback(async () => {
    try {
      voiceLogger.info('screen: starting');
      const canRestrictOwnAudio = getRestrictOwnAudioSupport();
      const canSuppressLocalAudioPlayback =
        getSuppressLocalAudioPlaybackSupport();

      const displayMediaConstraints: MediaStreamConstraints = {
        video: {
          ...getResWidthHeight(devices?.screenResolution),
          frameRate: devices?.screenFramerate,
          // @ts-expect-error - display capture only, not in MediaTrackConstraints
          cursor: devices.screenCursor
        },
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 2,
          sampleRate: 48000,
          // @ts-expect-error - experimental, not in types yet
          suppressLocalAudioPlayback: canSuppressLocalAudioPlayback
            ? (devices.suppressLocalAudioPlayback ?? false)
            : undefined,
          restrictOwnAudio: canRestrictOwnAudio
            ? (devices.restrictOwnAudio ?? false)
            : undefined
        }
      };

      voiceLogger.info('screen: requesting display media', {
        constraints: displayMediaConstraints
      });

      const stream = await navigator.mediaDevices.getDisplayMedia(
        displayMediaConstraints
      );

      voiceLogger.info('screen: stream obtained', {
        videoTrackId: stream.getVideoTracks()[0]?.id,
        hasAudio: stream.getAudioTracks().length > 0
      });
      setLocalScreenShare(stream);

      const videoTrack = stream.getVideoTracks()[0];
      const audioTrack = stream.getAudioTracks()[0];

      if (videoTrack) {
        voiceLogger.info('screen: video track obtained', {
          trackId: videoTrack.id,
          readyState: videoTrack.readyState,
          settings: videoTrack.getSettings()
        });

        videoTrack.contentHint = 'detail';

        let preferredCodec: RtpCodecCapability | undefined;

        if (
          !simulcastEnabled &&
          devices.screenCodec &&
          devices.screenCodec !== VideoCodec.AUTO &&
          routerRtpCapabilities.current?.codecs
        ) {
          preferredCodec = routerRtpCapabilities.current.codecs.find(
            (c) =>
              c.mimeType.toLowerCase() === devices.screenCodec.toLowerCase()
          );

          if (preferredCodec) {
            voiceLogger.info('screen: using preferred codec', {
              codec: preferredCodec.mimeType
            });
          }
        }

        const maxBitrateKbps = devices.screenBitrate ?? DEFAULT_BITRATE;
        const simulcastCodec = simulcastEnabled
          ? getSimulcastCodec(routerRtpCapabilities.current)
          : undefined;
        const screenCodec = simulcastCodec ?? preferredCodec;

        if (simulcastCodec) {
          voiceLogger.info('screen: using vp8 for simulcast', {
            codec: simulcastCodec.mimeType
          });
        } else if (simulcastEnabled) {
          voiceLogger.warn(
            'screen: vp8 unavailable, creating without simulcast'
          );
        }
        const screenShareProducerOptions: ProducerOptions<TVideoProducerAppData> =
          {
            track: videoTrack,
            codec: screenCodec,
            codecOptions: {
              videoGoogleStartBitrate: Math.min(2000, maxBitrateKbps),
              videoGoogleMaxBitrate: maxBitrateKbps,
              videoGoogleMinBitrate: Math.min(200, maxBitrateKbps)
            },
            appData: {
              kind: StreamKind.SCREEN
            }
          };
        const fallbackScreenShareProducerOptions = {
          ...screenShareProducerOptions,
          codec: preferredCodec
        };
        let simulcastScreenShareProducerOptions = screenShareProducerOptions;

        if (simulcastCodec) {
          const encodings = getScreenShareSimulcastEncodings(
            maxBitrateKbps * 1000
          );
          const qualityLayers = getSimulcastQualityLayers(encodings);

          simulcastScreenShareProducerOptions = {
            ...screenShareProducerOptions,
            appData: { kind: StreamKind.SCREEN, qualityLayers },
            encodings
          };
        }

        try {
          localScreenShareProducer.current =
            await producerTransport.current?.produce(
              simulcastScreenShareProducerOptions
            );
        } catch (error) {
          if (!simulcastCodec) throw error;

          voiceLogger.warn(
            'screen: simulcast producer failed, retrying without simulcast',
            { error: getErrorMessage(error) }
          );

          localScreenShareProducer.current =
            await producerTransport.current?.produce(
              fallbackScreenShareProducerOptions
            );
        }

        voiceLogger.info('screen: producer created', {
          producerId: localScreenShareProducer.current?.id,
          simulcast: !!simulcastCodec
        });

        setScreenShareProducer(localScreenShareProducer.current);

        const screenProducer = localScreenShareProducer.current;
        screenProducer?.observer.on('close', async () => {
          voiceLogger.info('screen: producer closed');

          try {
            const trpc = getTRPCClient();
            await trpc.voice.closeProducer.mutate({
              kind: StreamKind.SCREEN,
              producerId: screenProducer.id
            });
          } catch (error) {
            voiceLogger.error(
              'screen: closing producer on the server failed',
              error
            );
          }
        });

        videoTrack.onended = () => {
          voiceLogger.info('screen: track ended, cleaning up');

          stream.getTracks().forEach((track) => {
            track.stop();
          });
          localScreenShareProducer.current?.close();
          localScreenShareProducer.current = undefined;
          localScreenShareAudioProducer.current?.close();
          localScreenShareAudioProducer.current = undefined;

          setScreenShareProducer(null);
          setLocalScreenShare(undefined);
          setLocalScreenShareAudio(undefined);
        };

        if (audioTrack) {
          voiceLogger.info('screen audio: audio track obtained', {
            trackId: audioTrack.id,
            settings: audioTrack.getSettings()
          });

          localScreenShareAudioProducer.current =
            await producerTransport.current?.produce({
              track: audioTrack,
              codecOptions: {
                opusStereo: true,
                opusFec: true,
                opusDtx: false,
                opusMaxPlaybackRate: 48000,
                opusMaxAverageBitrate: 128000
              },
              appData: { kind: StreamKind.SCREEN_AUDIO }
            });

          voiceLogger.info('screen audio: producer created', {
            producerId: localScreenShareAudioProducer.current?.id
          });

          setLocalScreenShareAudio(new MediaStream([audioTrack]));

          const screenAudioProducer = localScreenShareAudioProducer.current;
          screenAudioProducer?.observer.on('close', async () => {
            voiceLogger.info('screen audio: producer closed');

            const trpc = getTRPCClient();

            try {
              await trpc.voice.closeProducer.mutate({
                kind: StreamKind.SCREEN_AUDIO,
                producerId: screenAudioProducer.id
              });
            } catch (error) {
              voiceLogger.error(
                'screen audio: closing producer on the server failed',
                error
              );
            }
          });

          audioTrack.onended = () => {
            localScreenShareAudioProducer.current?.close();
            localScreenShareAudioProducer.current = undefined;
            setLocalScreenShareAudio(undefined);
          };
        }

        return videoTrack;
      } else {
        throw new Error('No video track obtained for screen share');
      }
    } catch (error) {
      localScreenShareAudioProducer.current?.close();
      localScreenShareAudioProducer.current = undefined;
      localScreenShareProducer.current?.close();
      localScreenShareProducer.current = undefined;

      setLocalScreenShare(undefined);
      setLocalScreenShareAudio(undefined);
      voiceLogger.error('screen: start failed', error);
      throw error;
    }
  }, [
    setLocalScreenShare,
    setLocalScreenShareAudio,
    localScreenShareProducer,
    localScreenShareAudioProducer,
    producerTransport,
    setScreenShareProducer,
    devices.screenResolution,
    devices.screenFramerate,
    devices.screenCodec,
    devices.screenBitrate,
    devices.restrictOwnAudio,
    devices.suppressLocalAudioPlayback,
    devices.screenCursor,
    simulcastEnabled
  ]);

  const cleanup = useCallback(() => {
    initializationGeneration.current += 1;
    voiceLogger.info('session: cleanup');

    stopMonitoring();
    resetStats();
    cleanupMicProcessingResources();
    clearLocalStreams();
    clearRemoteUserStreams();
    clearExternalStreams();
    cleanupTransports();
    deviceRtpCapabilities.current = null;

    setConnectionStatus(ConnectionStatus.DISCONNECTED);
    setLoading(false);
  }, [
    stopMonitoring,
    resetStats,
    cleanupMicProcessingResources,
    clearLocalStreams,
    clearRemoteUserStreams,
    clearExternalStreams,
    cleanupTransports
  ]);

  const init = useCallback(
    async (
      incomingRouterRtpCapabilities: RtpCapabilities,
      channelId: number,
      signal?: AbortSignal
    ) => {
      voiceLogger.info('session: initializing', {
        channelId,
        routerCodecs: incomingRouterRtpCapabilities.codecs?.length ?? 0
      });

      cleanup();
      const generation = initializationGeneration.current;
      const sessionId = voiceSessionIdSelector(store.getState());
      const assertCurrent = () => {
        signal?.throwIfAborted();
        if (
          generation !== initializationGeneration.current ||
          voiceSessionIdSelector(store.getState()) !== sessionId
        )
          throw new DOMException('Voice session changed', 'AbortError');
      };

      try {
        setLoading(true);
        setConnectionStatus(ConnectionStatus.CONNECTING);

        routerRtpCapabilities.current = incomingRouterRtpCapabilities;

        const device = new Device();

        await device.load({
          routerRtpCapabilities: incomingRouterRtpCapabilities
        });
        assertCurrent();

        const loadedDevice = device as Device & {
          rtpCapabilities?: RtpCapabilities;
          recvRtpCapabilities?: RtpCapabilities;
        };

        const recvRtpCapabilities =
          loadedDevice.recvRtpCapabilities ?? loadedDevice.rtpCapabilities;

        if (!recvRtpCapabilities) {
          throw new Error('Failed to load device RTP capabilities');
        }

        deviceRtpCapabilities.current = recvRtpCapabilities;

        await createProducerTransport(device);
        assertCurrent();
        await createConsumerTransport(device);
        assertCurrent();
        setMediaRevision((revision) => revision + 1);
        await consumeExistingProducers(recvRtpCapabilities);
        assertCurrent();
        await startMicStream(signal);
        assertCurrent();
        await withTimeout(
          waitForConnection,
          10000,
          signal ?? new AbortController().signal
        );
        assertCurrent();

        startMonitoring(producerTransport.current, consumerTransport.current);
        setConnectionStatus(ConnectionStatus.CONNECTED);
        setLoading(false);
        playSound(SoundType.OWN_USER_JOINED_VOICE_CHANNEL);
      } catch (error) {
        voiceLogger.error('session: init failed', error, { channelId });
        if (
          generation !== initializationGeneration.current ||
          voiceSessionIdSelector(store.getState()) !== sessionId
        )
          throw error;
        cleanup();

        setConnectionStatus(ConnectionStatus.FAILED);
        setLoading(false);

        throw error;
      }
    },
    [
      cleanup,
      createProducerTransport,
      createConsumerTransport,
      consumeExistingProducers,
      startMicStream,
      startMonitoring,
      waitForConnection,
      producerTransport,
      consumerTransport
    ]
  );

  const onRecovering = useCallback(() => {
    setLoading(true);
    setConnectionStatus(ConnectionStatus.CONNECTING);
  }, []);
  const onRecovered = useCallback(() => {
    setLoading(false);
    setConnectionStatus(ConnectionStatus.CONNECTED);
  }, []);
  const requestRecovery = useVoiceRecovery({
    init,
    cleanup,
    restartIce,
    waitForConnection,
    onRecovering,
    onRecovered
  });
  recoveryCallback.current = requestRecovery;

  const { toggleMic, toggleSound, toggleWebcam, toggleScreenShare } =
    useVoiceControls({
      startMicStream,
      localAudioStream,
      startWebcamStream,
      stopWebcamStream,
      startScreenShareStream,
      stopScreenShareStream
    });

  useVoiceHotkeys({ toggleMic, toggleSound });

  const setMicMutedForBridge = useCallback(
    async (muted: boolean) => {
      if (ownVoiceState.micMuted === muted) return;
      await toggleMic();
    },
    [ownVoiceState.micMuted, toggleMic]
  );

  const setSoundMutedForBridge = useCallback(
    async (muted: boolean) => {
      if (ownVoiceState.soundMuted === muted) return;
      await toggleSound();
    },
    [ownVoiceState.soundMuted, toggleSound]
  );

  useEffect(() => {
    setVoiceControlsBridge({
      setMicMuted: setMicMutedForBridge,
      setSoundMuted: setSoundMutedForBridge
    });

    return () => {
      clearVoiceControlsBridge();
    };
  }, [setMicMutedForBridge, setSoundMutedForBridge]);

  useVoiceEvents({
    closeConsumer,
    closeUserConsumers,
    consumeExistingProducers,
    mediaRevision,
    consume,
    removeRemoteUserStream,
    removeExternalStreamTrack,
    removeExternalStream,
    clearRemoteUserStreamsForUser,
    rtpCapabilitiesRef: deviceRtpCapabilities,
    isVoiceSessionActive:
      connectionStatus === ConnectionStatus.CONNECTING ||
      connectionStatus === ConnectionStatus.CONNECTED
  });

  const previousConnectionStatus = useRef(connectionStatus);

  useEffect(() => {
    if (previousConnectionStatus.current === connectionStatus) return;

    voiceLogger.info('session: connection status changed', {
      from: previousConnectionStatus.current,
      to: connectionStatus
    });

    previousConnectionStatus.current = connectionStatus;
  }, [connectionStatus]);

  const getVoiceDebugSource = useCallback(
    () => ({
      producerTransport: producerTransport.current,
      consumerTransport: consumerTransport.current,
      producers: [
        { kind: StreamKind.AUDIO, producer: localAudioProducer.current },
        { kind: StreamKind.VIDEO, producer: localVideoProducer.current },
        { kind: StreamKind.SCREEN, producer: localScreenShareProducer.current },
        {
          kind: StreamKind.SCREEN_AUDIO,
          producer: localScreenShareAudioProducer.current
        }
      ],
      consumers: Object.entries(consumers.current).flatMap(
        ([remoteId, byKind]) =>
          Object.entries(byKind).map(([kind, consumer]) => ({
            remoteId: +remoteId,
            kind,
            consumer
          }))
      ),
      routerRtpCapabilities: routerRtpCapabilities.current,
      deviceRtpCapabilities: deviceRtpCapabilities.current
    }),
    [
      producerTransport,
      consumerTransport,
      consumers,
      localAudioProducer,
      localVideoProducer,
      localScreenShareProducer,
      localScreenShareAudioProducer
    ]
  );

  useEffect(
    () => registerVoiceDebugSource(getVoiceDebugSource),
    [getVoiceDebugSource]
  );

  useEffect(() => {
    const previousVoiceChannelId = previousVoiceChannelIdRef.current;

    previousVoiceChannelIdRef.current = currentVoiceChannelId;

    if (
      previousVoiceChannelId !== undefined &&
      currentVoiceChannelId === undefined
    ) {
      voiceLogger.info('session: left voice channel, releasing resources', {
        channelId: previousVoiceChannelId
      });
      cleanup();
    }
  }, [currentVoiceChannelId, cleanup]);

  useEffect(() => {
    return () => {
      voiceLogger.info('session: provider unmounting');
      cleanup();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const contextValue = useMemo<TVoiceProvider>(
    () => ({
      loading,
      connectionStatus,
      audioVideoRefsMap: audioVideoRefsMap.current,
      isScreenShareSupported,
      getOrCreateRefs,
      getConsumerCodec,
      getStreamQuality,
      getStreamQualityLayers,
      setStreamQuality,
      isSimulcastConsumer,
      init,

      toggleMic,
      toggleSound,
      toggleWebcam,
      toggleScreenShare,
      ownVoiceState,

      localAudioStream,
      localVideoStream,
      localScreenShareStream,
      localScreenShareAudioStream,

      remoteUserStreams,
      externalStreams
    }),
    [
      loading,
      connectionStatus,
      isScreenShareSupported,
      getOrCreateRefs,
      getConsumerCodec,
      getStreamQuality,
      getStreamQualityLayers,
      setStreamQuality,
      isSimulcastConsumer,
      init,

      toggleMic,
      toggleSound,
      toggleWebcam,
      toggleScreenShare,
      ownVoiceState,

      localAudioStream,
      localVideoStream,
      localScreenShareStream,
      localScreenShareAudioStream,
      remoteUserStreams,
      externalStreams
    ]
  );

  const statsContextValue = useMemo(
    () => ({ stats: transportStats, subscribe: subscribeToStats }),
    [transportStats, subscribeToStats]
  );

  return (
    <VoiceProviderContext.Provider value={contextValue}>
      <VoiceStatsContext.Provider value={statsContextValue}>
        <VolumeControlProvider>
          <div className="relative">
            <FloatingPinnedCard
              remoteUserStreams={remoteUserStreams}
              externalStreams={externalStreams}
              localScreenShareStream={localScreenShareStream}
              localVideoStream={localVideoStream}
            />
            {children}
          </div>
        </VolumeControlProvider>
      </VoiceStatsContext.Provider>
    </VoiceProviderContext.Provider>
  );
});

export { VoiceProvider, VoiceProviderContext };
