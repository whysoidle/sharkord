import type { Page } from '@playwright/test';
import { TestId } from '@sharkord/shared';
import { expect, loginAs, test } from './fixtures';

type TSnapshot = {
  transports: { id: string; connectionState: string }[];
  producers: { id: string; closed: boolean }[];
  consumers: {
    id: string;
    closed: boolean;
    stats: { type: string; bytesReceived?: number }[];
  }[];
};

const prepare = async (page: Page) => {
  await page.addInitScript(`(() => {
    const NativeSocket = window.WebSocket;
    window.WebSocket = class extends NativeSocket {
      constructor(...args) { super(...args); window.__testSocket = this; }
    };
    const NativePeer = window.RTCPeerConnection;
    window.__testPeers = [];
    window.RTCPeerConnection = class extends NativePeer {
      constructor(...args) { super(...args); window.__testPeers.push(this); }
    };
    // webkit needs a gesture to unlock synthetic Web Audio. real microphone capture
    // has its own permission flow, which this fixture deliberately avoids.
    document.addEventListener('pointerdown', () => {
      window.__testAudioContext ||= new AudioContext({ sampleRate: 48000 });
      window.__testAudioContext.resume();
    }, { capture: true });
    // patch the prototype because webkit does not retain instance overrides here.
    Object.defineProperty(Object.getPrototypeOf(navigator.mediaDevices), 'getUserMedia', {
      configurable: true,
      value: async () => {
        const context = window.__testAudioContext || new AudioContext({ sampleRate: 48000 });
        const oscillator = context.createOscillator();
        const destination = context.createMediaStreamDestination();
        oscillator.frequency.value = 440;
        oscillator.connect(destination);
        oscillator.start();
        await context.resume();
        destination.stream.getTracks().forEach(track => {
          track.addEventListener('ended', () => oscillator.stop(), { once: true });
        });
        return destination.stream;
      }
    });
  })()`);
};

const snapshot = (page: Page) =>
  page.evaluate<TSnapshot>(`(async () => {
  const { collectVoiceDebugSnapshot } = await import('/src/helpers/voice-debug.ts');
  return await collectVoiceDebugSnapshot();
})()`);

const receivedBytes = async (page: Page) => {
  const data = await snapshot(page);
  return data.consumers
    .flatMap(({ stats }) => stats)
    .filter(({ type }) => type === 'inbound-rtp')
    .reduce((total, stat) => total + (stat.bytesReceived ?? 0), 0);
};

const waitForAudio = async (pages: Page[]) => {
  for (const page of pages) {
    await expect
      .poll(
        async () => {
          const data = await snapshot(page);
          return (
            data.transports.length === 2 &&
            data.transports.every(
              ({ connectionState }) => connectionState === 'connected'
            ) &&
            data.consumers.length === 1
          );
        },
        { timeout: 20000 }
      )
      .toBe(true);
    const before = await receivedBytes(page);
    await expect
      .poll(() => receivedBytes(page), { timeout: 10000 })
      .toBeGreaterThan(before + 100);
  }
};

test('voice recovers after ICE failure and websocket loss without duplicate streams', async ({
  browser
}) => {
  test.setTimeout(90000);
  const firstContext = await browser.newContext();
  const secondContext = await browser.newContext();
  const first = await firstContext.newPage();
  const second = await secondContext.newPage();
  await prepare(first);
  await prepare(second);
  let channelId: number | undefined;
  try {
    await loginAs(first, 'testowner', 'password123');
    await loginAs(second, 'testuser', 'password123');
    for (const page of [first, second]) {
      expect(
        await page.evaluate(
          "String(navigator.mediaDevices.getUserMedia).includes('oscillator')"
        )
      ).toBe(true);
    }
    const name = `Recovery ${Date.now().toString().slice(-8)}`;
    channelId = await first.evaluate<number>(`(async () => {
      const { getTRPCClient } = await import('/src/lib/trpc.ts');
      const trpc = getTRPCClient();
      return await trpc.channels.add.mutate({ name: ${JSON.stringify(name)}, type: 'VOICE', categoryId: 2 });
    })()`);
    for (const page of [first, second]) {
      await page
        .getByTestId(TestId.CHANNEL_ITEM)
        .filter({ hasText: name })
        .first()
        .click({ force: true });
    }
    await waitForAudio([first, second]);
    const beforeIce = await snapshot(first);
    await first.evaluate(`(() => {
      const peer = window.__testPeers.find(peer => peer.connectionState === 'connected');
      Object.defineProperty(peer, 'connectionState', { configurable: true, value: 'failed' });
      peer.dispatchEvent(new Event('connectionstatechange'));
      delete peer.connectionState;
      // the synthetic failure did not change the browser's actual network. deliver its
      // current state after the restart begins; the new ICE credentials are real.
      setTimeout(() => peer.dispatchEvent(new Event('connectionstatechange')), 100);
    })()`);
    await expect
      .poll(
        () =>
          first.evaluate(`(async () => {
      const { getVoiceDebugEvents } = await import('/src/helpers/voice-debug.ts');
      return getVoiceDebugEvents().some(event => event.message === 'recovery: ICE restart succeeded');
    })()`),
        { timeout: 15000 }
      )
      .toBe(true);
    await waitForAudio([first, second]);
    expect((await snapshot(first)).transports.map(({ id }) => id)).toEqual(
      beforeIce.transports.map(({ id }) => id)
    );

    await first.evaluate('window.__testSocket.close()');
    await expect
      .poll(
        async () => {
          const data = await snapshot(first);
          return (
            data.transports.length === 2 &&
            data.transports[0]!.id !== beforeIce.transports[0]!.id &&
            data.transports.every(
              ({ connectionState }) => connectionState === 'connected'
            )
          );
        },
        { timeout: 30000 }
      )
      .toBe(true);
    await waitForAudio([first, second]);
    for (const page of [first, second]) {
      const data = await snapshot(page);
      expect(data.producers).toHaveLength(1);
      expect(data.consumers).toHaveLength(1);
      expect(data.producers[0]!.closed).toBe(false);
      expect(data.consumers[0]!.closed).toBe(false);
    }

    // replace the server's sending transport while signaling stays alive. this really
    // destroys its old media path and exercises full recovery after ICE cannot help.
    const beforeMediaLoss = await snapshot(first);
    await first.evaluate(`(async () => {
      const { getTRPCClient } = await import('/src/lib/trpc.ts');
      const trpc = getTRPCClient();
      await trpc.voice.createProducerTransport.mutate();
    })()`);
    await expect
      .poll(
        async () => {
          const data = await snapshot(first);
          return (
            data.transports.length === 2 &&
            data.transports[0]!.id !== beforeMediaLoss.transports[0]!.id &&
            data.transports.every(
              ({ connectionState }) => connectionState === 'connected'
            )
          );
        },
        { timeout: 30000 }
      )
      .toBe(true);
    await waitForAudio([first, second]);

    await first.evaluate(`(async () => {
      window.__testSocket.close();
      const { leaveVoice } = await import('/src/features/server/voice/actions.ts');
      await leaveVoice({ reason: 'user_disconnect_button' });
    })()`);
    await expect
      .poll(
        () =>
          first.evaluate(`(async () => {
      const { store } = await import('/src/features/store.ts');
      return store.getState().server.connected;
    })()`),
        { timeout: 20000 }
      )
      .toBe(true);
    expect((await snapshot(first)).producers).toHaveLength(0);
    expect((await snapshot(first)).consumers).toHaveLength(0);
    await expect
      .poll(async () => (await snapshot(second)).consumers.length)
      .toBe(0);
    const solo = await snapshot(second);
    await second.evaluate('window.__testSocket.close()');
    await expect
      .poll(
        async () => {
          const data = await snapshot(second);
          return (
            data.transports.length === 2 &&
            data.transports[0]!.id !== solo.transports[0]!.id &&
            data.transports[0]!.connectionState === 'connected' &&
            data.producers.length === 1 &&
            data.consumers.length === 0
          );
        },
        { timeout: 30000 }
      )
      .toBe(true);
  } finally {
    if (channelId) {
      await first
        .evaluate(
          `(async () => {
        const { getTRPCClient } = await import('/src/lib/trpc.ts');
        const trpc = getTRPCClient();
        await trpc.channels.delete.mutate({ channelId: ${channelId} });
      })()`
        )
        .catch(() => {});
    }
    await firstContext.close();
    await secondContext.close();
  }
});
