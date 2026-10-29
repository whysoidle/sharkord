import { useCurrentVoiceChannelId } from '@/features/server/channels/hooks';
import { useOwnUserId } from '@/features/server/users/hooks';
import { voiceLogger } from '@/helpers/browser-logger';
import { getTRPCClient } from '@/lib/trpc';
import type { TRemoteUserStreamKinds } from '@/types';
import { StreamKind } from '@sharkord/shared';
import type { RtpCapabilities } from 'mediasoup-client/types';
import type { RefObject } from 'react';
import { useEffect } from 'react';
import { isOwnProducerEvent } from '../helpers';

type TEvents = {
  closeConsumer: (
    remoteId: number,
    kind: StreamKind,
    producerId?: string
  ) => boolean;
  closeUserConsumers: (remoteId: number) => void;
  consumeExistingProducers: (capabilities: RtpCapabilities) => Promise<void>;
  mediaRevision: number;
  consume: (
    remoteId: number,
    kind: StreamKind,
    rtpCapabilities: RtpCapabilities
  ) => Promise<void>;
  removeRemoteUserStream: (
    userId: number,
    kind: TRemoteUserStreamKinds
  ) => void;
  removeExternalStreamTrack: (
    streamId: number,
    kind: StreamKind.EXTERNAL_AUDIO | StreamKind.EXTERNAL_VIDEO
  ) => void;
  removeExternalStream: (streamId: number) => void;
  clearRemoteUserStreamsForUser: (userId: number) => void;
  rtpCapabilitiesRef: RefObject<RtpCapabilities | null | undefined>;
  isVoiceSessionActive: boolean;
};

const useVoiceEvents = ({
  closeConsumer,
  closeUserConsumers,
  consumeExistingProducers,
  mediaRevision,
  consume,
  removeRemoteUserStream,
  removeExternalStreamTrack,
  removeExternalStream,
  clearRemoteUserStreamsForUser,
  rtpCapabilitiesRef,
  isVoiceSessionActive
}: TEvents) => {
  const currentVoiceChannelId = useCurrentVoiceChannelId();
  const ownUserId = useOwnUserId();

  useEffect(() => {
    if (!currentVoiceChannelId) {
      voiceLogger.info('events: not subscribed, no voice channel');
      return;
    }

    if (!isVoiceSessionActive) {
      voiceLogger.info(
        'events: not subscribed, voice session not established yet'
      );
      return;
    }

    const trpc = getTRPCClient();

    let isCleaningUp = false;

    const onVoiceNewProducerSub = trpc.voice.onNewProducer.subscribe(
      undefined,
      {
        onStarted: () => {
          const capabilities = rtpCapabilitiesRef.current;
          if (isCleaningUp || !capabilities) return;
          consumeExistingProducers(capabilities).catch((error) => {
            voiceLogger.error('events: producer snapshot failed', error);
          });
        },
        onData: ({ remoteId, kind, channelId }) => {
          if (currentVoiceChannelId !== channelId || isCleaningUp) return;

          if (isOwnProducerEvent(remoteId, ownUserId, kind)) {
            voiceLogger.info('events: ignoring own new producer', {
              kind,
              channelId
            });

            return;
          }

          voiceLogger.info('events: new producer', {
            remoteId,
            kind,
            channelId
          });

          const rtpCapabilities = rtpCapabilitiesRef.current;

          // init sets the ref before it consumes the existing producers, so anything that
          // lands in the gap is picked up by that pass instead
          if (!rtpCapabilities) {
            voiceLogger.warn(
              'events: new producer ignored, no rtp capabilities',
              {
                remoteId,
                kind
              }
            );

            return;
          }

          try {
            consume(remoteId, kind, rtpCapabilities);
          } catch (error) {
            voiceLogger.error('events: consuming new producer failed', error, {
              remoteId,
              kind,
              channelId
            });
          }
        },
        onError: (error) => {
          voiceLogger.error('events: new producer subscription error', error);
        }
      }
    );

    const onVoiceProducerClosedSub = trpc.voice.onProducerClosed.subscribe(
      undefined,
      {
        onData: ({ channelId, remoteId, kind, producerId }) => {
          if (currentVoiceChannelId !== channelId || isCleaningUp) return;

          voiceLogger.info('events: producer closed', {
            remoteId,
            kind,
            channelId
          });

          try {
            if (!closeConsumer(remoteId, kind, producerId)) return;
            if (
              kind === StreamKind.EXTERNAL_VIDEO ||
              kind === StreamKind.EXTERNAL_AUDIO
            ) {
              removeExternalStreamTrack(remoteId, kind);
            } else {
              removeRemoteUserStream(remoteId, kind);
            }
          } catch (error) {
            voiceLogger.error(
              'events: removing stream for closed producer failed',
              error,
              { remoteId, kind, channelId }
            );
          }
        },
        onError: (error) => {
          voiceLogger.error(
            'events: producer closed subscription error',
            error
          );
        }
      }
    );

    const onVoiceUserLeaveSub = trpc.voice.onLeave.subscribe(undefined, {
      onData: ({ channelId, userId }) => {
        if (currentVoiceChannelId !== channelId || isCleaningUp) return;

        voiceLogger.info('events: user left voice', { userId, channelId });

        try {
          closeUserConsumers(userId);
          clearRemoteUserStreamsForUser(userId);
        } catch (error) {
          voiceLogger.error('events: clearing streams for user failed', error, {
            userId
          });
        }
      },
      onError: (error) => {
        voiceLogger.error('events: user leave subscription error', error);
      }
    });

    const onVoiceRemoveExternalStreamSub =
      trpc.voice.onRemoveExternalStream.subscribe(undefined, {
        onData: ({ channelId, streamId }) => {
          if (currentVoiceChannelId !== channelId || isCleaningUp) return;

          voiceLogger.info('events: external stream removed', {
            streamId,
            channelId
          });

          try {
            closeUserConsumers(streamId);
            removeExternalStream(streamId);
          } catch (error) {
            voiceLogger.error(
              'events: removing external stream failed',
              error,
              {
                streamId,
                channelId
              }
            );
          }
        },
        onError: (error) => {
          voiceLogger.error(
            'events: external stream subscription error',
            error
          );
        }
      });

    return () => {
      voiceLogger.info('events: unsubscribing');

      isCleaningUp = true;

      onVoiceNewProducerSub.unsubscribe();
      onVoiceProducerClosedSub.unsubscribe();
      onVoiceUserLeaveSub.unsubscribe();
      onVoiceRemoveExternalStreamSub.unsubscribe();
    };
  }, [
    closeConsumer,
    closeUserConsumers,
    mediaRevision,
    currentVoiceChannelId,
    ownUserId,
    consume,
    consumeExistingProducers,
    removeRemoteUserStream,
    removeExternalStreamTrack,
    removeExternalStream,
    clearRemoteUserStreamsForUser,
    rtpCapabilitiesRef,
    isVoiceSessionActive
  ]);
};

export { useVoiceEvents };
