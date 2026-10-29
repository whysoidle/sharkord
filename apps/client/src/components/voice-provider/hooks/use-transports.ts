import { voiceLogger } from '@/helpers/browser-logger';
import { getTRPCClient } from '@/lib/trpc';
import type { TRemoteUserStreamKinds } from '@/types';
import {
  type ConsumerType,
  getMediasoupKind,
  StreamKind,
  type TProducibleStreamKind,
  type TStreamQualityLayer
} from '@sharkord/shared';
import { TRPCClientError } from '@trpc/client';
import {
  type AppData,
  type Consumer,
  type Device,
  type RtpCapabilities,
  type Transport
} from 'mediasoup-client/types';
import { useCallback, useRef } from 'react';
import { getStoredStreamQuality } from '../helpers';
import { waitForTransportConnected } from '../transport-recovery';

type TUseTransportParams = {
  onRecoveryNeeded: () => void;
  addRemoteUserStream: (
    userId: number,
    stream: MediaStream,
    kind: TRemoteUserStreamKinds
  ) => void;
  removeRemoteUserStream: (
    userId: number,
    kind: TRemoteUserStreamKinds
  ) => void;
  addExternalStreamTrack: (
    streamId: number,
    stream: MediaStream,
    kind: StreamKind.EXTERNAL_AUDIO | StreamKind.EXTERNAL_VIDEO
  ) => void;
  removeExternalStreamTrack: (
    streamId: number,
    kind: StreamKind.EXTERNAL_AUDIO | StreamKind.EXTERNAL_VIDEO
  ) => void;
  setRemoteConsumerType: (
    remoteId: number,
    kind: StreamKind,
    consumerType: ConsumerType | undefined
  ) => void;
  setRemoteStreamQualityLayers: (
    remoteId: number,
    kind: StreamKind,
    layers: TStreamQualityLayer[]
  ) => void;
  clearRemoteConsumerMetadata: () => void;
};

const useTransports = ({
  onRecoveryNeeded,
  addRemoteUserStream,
  removeRemoteUserStream,
  addExternalStreamTrack,
  removeExternalStreamTrack,
  setRemoteConsumerType,
  setRemoteStreamQualityLayers,
  clearRemoteConsumerMetadata
}: TUseTransportParams) => {
  const producerTransport = useRef<Transport<AppData> | undefined>(undefined);
  const consumerTransport = useRef<Transport<AppData> | undefined>(undefined);
  const consumers = useRef<{
    [userId: number]: {
      [kind: string]: Consumer<AppData>;
    };
  }>({});
  const consumerCodecs = useRef<Map<string, string>>(new Map());
  const consumeOperationsInProgress = useRef<Set<string>>(new Set());
  const transportGeneration = useRef(0);
  const recoveryTimers = useRef(
    new Map<Transport, ReturnType<typeof setTimeout>>()
  );
  const monitorConnection = useCallback(
    (transport: Transport, isCurrent: () => boolean) => {
      transport.on('connectionstatechange', (state) => {
        const timer = recoveryTimers.current.get(transport);
        if (timer) clearTimeout(timer);
        recoveryTimers.current.delete(transport);
        if (!isCurrent()) return;
        voiceLogger.info('transport: connection state changed', {
          transportId: transport.id,
          state
        });
        if (state === 'failed' || state === 'closed') onRecoveryNeeded();
        if (state === 'disconnected') {
          recoveryTimers.current.set(
            transport,
            setTimeout(() => {
              recoveryTimers.current.delete(transport);
              if (isCurrent() && transport.connectionState === 'disconnected')
                onRecoveryNeeded();
            }, 4000)
          );
        }
      });
    },
    [onRecoveryNeeded]
  );

  const createProducerTransport = useCallback(
    async (device: Device) => {
      const generation = transportGeneration.current;
      voiceLogger.info('producer transport: creating');

      const trpc = getTRPCClient();

      try {
        const params = await trpc.voice.createProducerTransport.mutate();
        if (generation !== transportGeneration.current)
          throw new DOMException('Voice session changed', 'AbortError');

        voiceLogger.info('producer transport: created', {
          transportId: params.id,
          iceCandidates: params.iceCandidates.length
        });

        producerTransport.current = device.createSendTransport(params);
        const sending = producerTransport.current;
        monitorConnection(sending, () => producerTransport.current === sending);

        producerTransport.current.on(
          'connect',
          async ({ dtlsParameters }, callback, errback) => {
            voiceLogger.info('producer transport: dtls connect requested', {
              role: dtlsParameters.role
            });

            try {
              await trpc.voice.connectProducerTransport.mutate({
                dtlsParameters
              });

              callback();
            } catch (error) {
              errback(error as Error);
              voiceLogger.error(
                'producer transport: dtls connect failed',
                error
              );
            }
          }
        );

        producerTransport.current.on('icecandidateerror', (error) => {
          voiceLogger.warn('producer transport: ice candidate error', {
            address: error.address,
            port: error.port,
            errorCode: error.errorCode,
            errorText: error.errorText
          });
        });

        producerTransport.current.on(
          'produce',
          async ({ rtpParameters, appData }, callback, errback) => {
            voiceLogger.info('producer transport: producing track', {
              kind: (appData as { kind: StreamKind }).kind,
              codec: rtpParameters.codecs[0]?.mimeType,
              encodings: rtpParameters.encodings?.length ?? 0
            });

            const { kind, qualityLayers } = appData as {
              kind: TProducibleStreamKind;
              qualityLayers?: TStreamQualityLayer[];
            };

            if (!producerTransport.current) return;

            try {
              const producerId = await trpc.voice.produce.mutate({
                transportId: producerTransport.current.id,
                kind,
                rtpParameters,
                qualityLayers
              });

              voiceLogger.info('producer transport: track produced', {
                kind,
                producerId
              });

              callback({ id: producerId });
            } catch (error) {
              if (error instanceof TRPCClientError) {
                if (error.data.code === 'FORBIDDEN') {
                  voiceLogger.warn('producer transport: produce denied', {
                    kind
                  });
                  errback(
                    new Error(
                      `You don't have permission to ${kind} in this channel`
                    )
                  );

                  return;
                }
              }

              voiceLogger.error('producer transport: produce failed', error, {
                kind
              });
              errback(error as Error);
            }
          }
        );
      } catch (error) {
        voiceLogger.error('producer transport: create failed', error);
        throw error;
      }
    },
    [monitorConnection]
  );

  const createConsumerTransport = useCallback(
    async (device: Device) => {
      const generation = transportGeneration.current;
      voiceLogger.info('consumer transport: creating');

      const trpc = getTRPCClient();

      try {
        const params = await trpc.voice.createConsumerTransport.mutate();
        if (generation !== transportGeneration.current)
          throw new DOMException('Voice session changed', 'AbortError');

        voiceLogger.info('consumer transport: created', {
          transportId: params.id,
          iceCandidates: params.iceCandidates.length
        });

        consumerTransport.current = device.createRecvTransport(params);
        const receiving = consumerTransport.current;
        monitorConnection(
          receiving,
          () => consumerTransport.current === receiving
        );

        consumerTransport.current.on(
          'connect',
          async ({ dtlsParameters }, callback, errback) => {
            voiceLogger.info('consumer transport: dtls connect requested', {
              role: dtlsParameters.role
            });

            try {
              await trpc.voice.connectConsumerTransport.mutate({
                dtlsParameters
              });

              callback();
            } catch (error) {
              errback(error as Error);
              voiceLogger.error(
                'consumer transport: dtls connect failed',
                error
              );
            }
          }
        );

        consumerTransport.current.on('icecandidateerror', (error) => {
          voiceLogger.warn('consumer transport: ice candidate error', {
            address: error.address,
            port: error.port,
            errorCode: error.errorCode,
            errorText: error.errorText
          });
        });
      } catch (error) {
        voiceLogger.error('consumer transport: create failed', error);
        throw error;
      }
    },
    [monitorConnection]
  );

  const consume = useCallback(
    async (
      remoteId: number,
      kind: StreamKind,
      rtpCapabilities: RtpCapabilities
    ) => {
      if (!consumerTransport.current) {
        voiceLogger.warn('consumer: skipped, no consumer transport', {
          remoteId,
          kind
        });
        return;
      }

      const operationKey = `${remoteId}-${kind}`;

      if (consumeOperationsInProgress.current.has(operationKey)) {
        voiceLogger.warn('consumer: skipped, consume already in progress', {
          remoteId,
          kind
        });
        return;
      }

      consumeOperationsInProgress.current.add(operationKey);
      const receiving = consumerTransport.current;
      const generation = transportGeneration.current;

      try {
        voiceLogger.info('consumer: consuming', { remoteId, kind });

        const trpc = getTRPCClient();

        const {
          producerId,
          consumerId,
          consumerKind,
          consumerRtpParameters,
          consumerType,
          qualityLayers
        } = await trpc.voice.consume.mutate({
          kind,
          remoteId,
          rtpCapabilities
        });
        if (receiving !== consumerTransport.current || receiving.closed) return;

        voiceLogger.info('consumer: parameters received', {
          remoteId,
          producerId,
          consumerId,
          consumerKind,
          consumerType,
          qualityLayers: qualityLayers.length
        });

        if (!consumers.current[remoteId]) {
          consumers.current[remoteId] = {};
        }

        const existingConsumer = consumers.current[remoteId][consumerKind];

        if (existingConsumer && !existingConsumer.closed) {
          voiceLogger.info('consumer: replacing existing consumer', {
            remoteId,
            kind
          });

          existingConsumer.close();
          delete consumers.current[remoteId][consumerKind];
        }

        const newConsumer = await receiving.consume({
          id: consumerId,
          producerId: producerId,
          kind: getMediasoupKind(consumerKind),
          rtpParameters: consumerRtpParameters
        });
        if (receiving !== consumerTransport.current || receiving.closed) {
          newConsumer.close();
          return;
        }

        voiceLogger.info('consumer: created', {
          remoteId,
          kind,
          consumerId: newConsumer.id,
          codec: newConsumer.rtpParameters.codecs[0]?.mimeType
        });

        const cleanupEvents = [
          'transportclose',
          'trackended',
          '@close',
          'close'
        ];

        cleanupEvents.forEach((event) => {
          // @ts-expect-error - YOLO
          newConsumer?.on(event, () => {
            if (consumers.current[remoteId]?.[consumerKind] !== newConsumer)
              return;
            voiceLogger.info('consumer: cleanup event', {
              event,
              remoteId,
              kind
            });

            if (
              kind === StreamKind.EXTERNAL_VIDEO ||
              kind === StreamKind.EXTERNAL_AUDIO
            ) {
              removeExternalStreamTrack(remoteId, kind);
            } else {
              removeRemoteUserStream(remoteId, kind);
            }

            if (consumers.current[remoteId]?.[consumerKind]) {
              delete consumers.current[remoteId][consumerKind];
            }

            consumerCodecs.current.delete(`${remoteId}-${kind}`);

            setRemoteConsumerType(remoteId, kind, undefined);
            setRemoteStreamQualityLayers(remoteId, kind, []);
          });
        });

        consumers.current[remoteId][consumerKind] = newConsumer;

        setRemoteConsumerType(remoteId, kind, consumerType);
        setRemoteStreamQualityLayers(remoteId, kind, qualityLayers);

        const codecKey = `${remoteId}-${kind}`;

        const negotiatedCodec =
          newConsumer.rtpParameters?.codecs?.[0]?.mimeType;

        if (negotiatedCodec) {
          consumerCodecs.current.set(codecKey, negotiatedCodec);
        }

        if (
          consumerType === 'simulcast' &&
          (kind === StreamKind.VIDEO ||
            kind === StreamKind.SCREEN ||
            kind === StreamKind.EXTERNAL_VIDEO)
        ) {
          const quality = getStoredStreamQuality(remoteId, kind, qualityLayers);

          if (quality.mode === 'layer') {
            await trpc.voice.setConsumerQuality.mutate({
              remoteId,
              kind,
              quality
            });
          }
        }

        const stream = new MediaStream();

        stream.addTrack(newConsumer.track);

        if (
          kind === StreamKind.EXTERNAL_VIDEO ||
          kind === StreamKind.EXTERNAL_AUDIO
        ) {
          addExternalStreamTrack(remoteId, stream, kind);
        } else {
          addRemoteUserStream(remoteId, stream, kind);
        }
      } catch (error) {
        voiceLogger.error('consumer: consume failed', error, {
          remoteId,
          kind
        });
      } finally {
        if (generation === transportGeneration.current)
          consumeOperationsInProgress.current.delete(operationKey);
      }
    },
    [
      addRemoteUserStream,
      removeRemoteUserStream,
      addExternalStreamTrack,
      removeExternalStreamTrack,
      setRemoteConsumerType,
      setRemoteStreamQualityLayers
    ]
  );

  const consumeExistingProducers = useCallback(
    async (
      rtpCapabilities: RtpCapabilities,
      externalStreamTracks?: {
        [streamId: number]: { audio?: boolean; video?: boolean };
      }
    ) => {
      voiceLogger.info('session: consuming existing producers');

      const trpc = getTRPCClient();

      try {
        const {
          remoteAudioIds,
          remoteScreenIds,
          remoteScreenAudioIds,
          remoteVideoIds,
          remoteExternalStreamIds
        } = await trpc.voice.getProducers.query();

        voiceLogger.info('session: existing producers received', {
          remoteAudioIds,
          remoteVideoIds,
          remoteScreenIds,
          remoteScreenAudioIds,
          remoteExternalStreamIds
        });

        const pending = [
          ...remoteAudioIds.map((id) =>
            consume(id, StreamKind.AUDIO, rtpCapabilities)
          ),
          ...remoteVideoIds.map((id) =>
            consume(id, StreamKind.VIDEO, rtpCapabilities)
          ),
          ...remoteScreenIds.map((id) =>
            consume(id, StreamKind.SCREEN, rtpCapabilities)
          ),
          ...remoteScreenAudioIds.map((id) =>
            consume(id, StreamKind.SCREEN_AUDIO, rtpCapabilities)
          )
        ];

        remoteExternalStreamIds.forEach((streamId: number) => {
          const tracks = externalStreamTracks?.[streamId];

          if (tracks?.audio !== false) {
            pending.push(
              consume(streamId, StreamKind.EXTERNAL_AUDIO, rtpCapabilities)
            );
          }
          if (tracks?.video !== false) {
            pending.push(
              consume(streamId, StreamKind.EXTERNAL_VIDEO, rtpCapabilities)
            );
          }
        });
        await Promise.all(pending);
      } catch (error) {
        voiceLogger.error(
          'session: consuming existing producers failed',
          error
        );
        throw error;
      }
    },
    [consume]
  );

  const getConsumerCodec = useCallback(
    (remoteId: number, kind: StreamKind): string | undefined => {
      return consumerCodecs.current.get(`${remoteId}-${kind}`);
    },
    []
  );

  const cleanupTransports = useCallback(() => {
    transportGeneration.current += 1;
    for (const timer of recoveryTimers.current.values()) clearTimeout(timer);
    recoveryTimers.current.clear();
    voiceLogger.info('session: cleaning up transports');

    Object.values(consumers.current).forEach((userConsumers) => {
      Object.values(userConsumers).forEach((consumer) => {
        if (!consumer.closed) {
          consumer.close();
        }
      });
    });

    consumers.current = {};
    consumerCodecs.current.clear();

    clearRemoteConsumerMetadata();

    consumeOperationsInProgress.current.clear();

    const sending = producerTransport.current;
    const receiving = consumerTransport.current;
    producerTransport.current = undefined;
    consumerTransport.current = undefined;
    sending?.close();
    receiving?.close();

    voiceLogger.info('session: transports cleanup complete');
  }, [clearRemoteConsumerMetadata]);

  const closeConsumer = useCallback(
    (remoteId: number, kind: StreamKind, producerId?: string): boolean => {
      const consumer = consumers.current[remoteId]?.[kind];
      if (!consumer || (producerId && consumer.producerId !== producerId))
        return false;
      consumer?.close();
      delete consumers.current[remoteId]?.[kind];
      consumerCodecs.current.delete(`${remoteId}-${kind}`);
      if (
        consumers.current[remoteId] &&
        Object.keys(consumers.current[remoteId]).length === 0
      )
        delete consumers.current[remoteId];
      return true;
    },
    []
  );

  const closeUserConsumers = useCallback(
    (remoteId: number) => {
      const kinds = Object.keys(
        consumers.current[remoteId] ?? {}
      ) as StreamKind[];
      for (const kind of kinds) closeConsumer(remoteId, kind);
    },
    [closeConsumer]
  );

  const waitForConnection = useCallback(async (signal: AbortSignal) => {
    const sending = producerTransport.current;
    const receiving = consumerTransport.current;
    if (!sending || !receiving) throw new Error('Voice transports are missing');
    const pending = [waitForTransportConnected(sending, signal)];
    if (
      receiving.connectionState !== 'new' ||
      Object.keys(consumers.current).length > 0
    )
      pending.push(waitForTransportConnected(receiving, signal));
    await Promise.all(pending);
  }, []);

  const restartIce = useCallback(
    async (signal: AbortSignal) => {
      const trpc = getTRPCClient();
      const transports = [producerTransport.current, consumerTransport.current];
      for (const [index, transport] of transports.entries()) {
        signal.throwIfAborted();
        if (!transport || transport.closed)
          throw new Error('Voice transport is missing');
        const { iceParameters } = await trpc.voice.restartIce.mutate(
          {
            direction: index === 0 ? 'send' : 'recv',
            transportId: transport.id
          },
          { signal }
        );
        signal.throwIfAborted();
        await transport.restartIce({ iceParameters });
      }
      await waitForConnection(signal);
    },
    [waitForConnection]
  );

  return {
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
  };
};

export { useTransports };
