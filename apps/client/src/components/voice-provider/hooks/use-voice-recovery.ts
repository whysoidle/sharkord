import { pushToTalkSelectedSelector } from '@/features/app/selectors';
import { currentVoiceChannelIdSelector } from '@/features/server/channels/selectors';
import { connectedSelector } from '@/features/server/selectors';
import {
  clearLocalVoiceSession,
  updateOwnVoiceState
} from '@/features/server/voice/actions';
import {
  connectionEpochSelector,
  ownVoiceStateSelector,
  voiceSessionIdSelector
} from '@/features/server/voice/selectors';
import { store } from '@/features/store';
import { voiceLogger } from '@/helpers/browser-logger';
import { withTimeout as withRecoveryTimeout } from '@/helpers/with-timeout';
import { getTRPCClient } from '@/lib/trpc';
import { TRPCClientError } from '@trpc/client';
import type { RtpCapabilities } from 'mediasoup-client/types';
import { useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useSelector } from 'react-redux';
import { toast } from 'sonner';

type TRecoveryOptions = {
  init: (
    capabilities: RtpCapabilities,
    channelId: number,
    signal?: AbortSignal
  ) => Promise<void>;
  cleanup: () => void;
  restartIce: (signal: AbortSignal) => Promise<void>;
  waitForConnection: (signal: AbortSignal) => Promise<void>;
  onRecovering: () => void;
  onRecovered: () => void;
};

const useVoiceRecovery = (options: TRecoveryOptions) => {
  const { t } = useTranslation('common');
  const sessionId = useSelector(voiceSessionIdSelector);
  const channelId = useSelector(currentVoiceChannelIdSelector);
  const connected = useSelector(connectedSelector);
  const epoch = useSelector(connectionEpochSelector);
  const latest = useRef(options);
  latest.current = options;
  const active = useRef<AbortController | null>(null);
  const activeSession = useRef<string | undefined>(undefined);
  const followup = useRef(false);
  const previousEpoch = useRef(epoch);
  const initialRecovery = useRef(!!sessionId);
  const requestRef = useRef<() => void>(() => {});

  const requestRecovery = useCallback(() => {
    const state = store.getState();
    const desiredSession = voiceSessionIdSelector(state);
    const desiredChannel = currentVoiceChannelIdSelector(state);
    const connectionEpoch = connectionEpochSelector(state);
    if (
      active.current ||
      !desiredSession ||
      !desiredChannel ||
      !connectedSelector(state)
    )
      return;
    const controller = new AbortController();
    active.current = controller;
    activeSession.current = desiredSession;
    const deadline = setTimeout(
      () => controller.abort(new Error('Voice recovery deadline exceeded')),
      45000
    );
    const assertCurrent = () => {
      controller.signal.throwIfAborted();
      const current = store.getState();
      if (
        voiceSessionIdSelector(current) !== desiredSession ||
        !connectedSelector(current) ||
        connectionEpochSelector(current) !== connectionEpoch
      ) {
        throw new DOMException('Voice session changed', 'AbortError');
      }
    };

    const recover = async () => {
      latest.current.onRecovering();
      try {
        await withRecoveryTimeout(
          latest.current.restartIce,
          6000,
          controller.signal
        );
        assertCurrent();
        voiceLogger.info('recovery: ICE restart succeeded');
        latest.current.onRecovered();
        return;
      } catch (error) {
        assertCurrent();
        voiceLogger.info('recovery: rebuilding voice session', {
          error: String(error)
        });
      }

      for (let attempt = 0; attempt < 3; attempt += 1) {
        assertCurrent();
        try {
          await withRecoveryTimeout(
            async (signal) => {
              latest.current.cleanup();
              latest.current.onRecovering();
              const current = store.getState();
              const ownState = ownVoiceStateSelector(current);
              const micMuted =
                ownState.micMuted || pushToTalkSelectedSelector(current);
              const trpc = getTRPCClient();
              const response = await trpc.voice.join.mutate(
                {
                  channelId: desiredChannel,
                  sessionId: desiredSession,
                  recover: true,
                  state: { micMuted, soundMuted: ownState.soundMuted }
                },
                { signal }
              );
              assertCurrent();
              signal.throwIfAborted();
              updateOwnVoiceState({
                micMuted,
                webcamEnabled: false,
                sharingScreen: false
              });
              await latest.current.init(
                response.routerRtpCapabilities,
                desiredChannel,
                signal
              );
              await latest.current.waitForConnection(signal);
              assertCurrent();
            },
            10000,
            controller.signal
          );
          latest.current.onRecovered();
          voiceLogger.info('recovery: voice session restored', {
            attempt: attempt + 1
          });
          return;
        } catch (error) {
          assertCurrent();
          if (
            error instanceof TRPCClientError &&
            ['FORBIDDEN', 'UNAUTHORIZED', 'NOT_FOUND', 'CONFLICT'].includes(
              error.data?.code
            )
          )
            throw error;
          if (attempt === 2) throw error;
          await withRecoveryTimeout(
            (signal) =>
              new Promise<void>((resolve, reject) => {
                const timer = setTimeout(
                  resolve,
                  700 * 2 ** attempt + Math.random() * 300
                );
                signal.addEventListener(
                  'abort',
                  () => {
                    clearTimeout(timer);
                    reject(signal.reason);
                  },
                  { once: true }
                );
              }),
            4000,
            controller.signal
          );
        }
      }
    };

    recover()
      .catch(async (error) => {
        const current = store.getState();
        if (
          voiceSessionIdSelector(current) !== desiredSession ||
          followup.current ||
          !connectedSelector(current)
        )
          return;
        voiceLogger.error('recovery: voice recovery failed', error);
        clearLocalVoiceSession();
        latest.current.cleanup();
        toast.error(t('failedInitVoiceConnection'));
        try {
          const trpc = getTRPCClient();
          await withRecoveryTimeout(
            (signal) =>
              trpc.voice.leave.mutate(
                { sessionId: desiredSession },
                { signal }
              ),
            2000,
            new AbortController().signal
          );
        } catch {
          // local resources are already released; a dead socket is cleaned by the server.
        }
      })
      .finally(() => {
        clearTimeout(deadline);
        if (active.current === controller) active.current = null;
        if (followup.current) {
          followup.current = false;
          requestRef.current();
        }
      });
  }, [t]);
  requestRef.current = requestRecovery;

  useEffect(() => {
    const changed = epoch !== previousEpoch.current;
    previousEpoch.current = epoch;
    if (active.current) {
      followup.current =
        sessionId === activeSession.current && !!channelId && connected;
      active.current.abort();
    }
    if (
      connected &&
      sessionId &&
      channelId &&
      (changed || initialRecovery.current)
    ) {
      initialRecovery.current = false;
      if (!active.current) requestRecovery();
    }
  }, [sessionId, channelId, connected, epoch, requestRecovery]);

  useEffect(
    () => () => {
      followup.current = false;
      active.current?.abort();
    },
    []
  );
  return requestRecovery;
};

export { useVoiceRecovery };
