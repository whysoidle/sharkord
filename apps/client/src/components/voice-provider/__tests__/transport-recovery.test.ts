import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'events';
import type { Transport } from 'mediasoup-client/types';
import { withTimeout } from '../../../helpers/with-timeout';
import { waitForTransportConnected } from '../transport-recovery';

describe('voice recovery deadlines', () => {
  test('should abort a stalled operation when its deadline expires', async () => {
    let aborted = false;
    await expect(
      withTimeout(
        (signal) =>
          new Promise<never>(() => {
            signal.addEventListener('abort', () => {
              aborted = true;
            });
          }),
        5,
        new AbortController().signal
      )
    ).rejects.toThrow('Voice recovery timed out');
    expect(aborted).toBe(true);
  });
  test('should cancel immediately when the user already left', async () => {
    const parent = new AbortController();
    parent.abort(new Error('User left'));
    let called = false;
    await expect(
      withTimeout(
        async () => {
          called = true;
        },
        100,
        parent.signal
      )
    ).rejects.toThrow('User left');
    expect(called).toBe(false);
  });
  test('should complete and release child work before its deadline', async () => {
    let signal: AbortSignal | undefined;
    const result = await withTimeout(
      async (child) => {
        signal = child;
        return 42;
      },
      100,
      new AbortController().signal
    );
    expect(result).toBe(42);
    expect(signal!.aborted).toBe(true);
  });
});

const fakeTransport = (state = 'connecting') => {
  const events = new EventEmitter();
  const observer = new EventEmitter();
  const transport = Object.assign(events, {
    observer,
    closed: false,
    connectionState: state
  }) as unknown as Transport;
  return { transport, events, observer };
};

describe('transport readiness', () => {
  test('should wait for actual connectivity and remove its listeners', async () => {
    const { transport, events, observer } = fakeTransport();
    const result = waitForTransportConnected(
      transport,
      new AbortController().signal
    );
    events.emit('connectionstatechange', 'connected');
    await result;
    expect(events.listenerCount('connectionstatechange')).toBe(0);
    expect(observer.listenerCount('close')).toBe(0);
  });
  test('should accept a transport already connected', async () => {
    const { transport } = fakeTransport('connected');
    await expect(
      waitForTransportConnected(transport, new AbortController().signal)
    ).resolves.toBeUndefined();
  });
  test('should release readiness listeners when the session is cancelled', async () => {
    const { transport, events, observer } = fakeTransport();
    const parent = new AbortController();
    const result = waitForTransportConnected(transport, parent.signal);
    parent.abort(new Error('Session changed'));
    await expect(result).rejects.toThrow('Session changed');
    expect(events.listenerCount('connectionstatechange')).toBe(0);
    expect(observer.listenerCount('close')).toBe(0);
  });
  test('should reject a transport that closes during recovery', async () => {
    const { transport, observer } = fakeTransport();
    const result = waitForTransportConnected(
      transport,
      new AbortController().signal
    );
    observer.emit('close');
    await expect(result).rejects.toThrow('Voice transport closed');
  });
});
