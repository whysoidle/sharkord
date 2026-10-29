import type { Transport } from 'mediasoup-client/types';

export const waitForTransportConnected = (
  transport: Transport,
  signal: AbortSignal
): Promise<void> =>
  new Promise((resolve, reject) => {
    const finish = (error?: unknown) => {
      transport.off('connectionstatechange', changed);
      transport.observer.off('close', closed);
      signal.removeEventListener('abort', aborted);
      if (error) reject(error);
      else resolve();
    };
    const changed = (state: string) => {
      if (state === 'connected') finish();
      else if (state === 'failed' || state === 'closed')
        finish(new Error(`Voice transport ${state}`));
    };
    const closed = () => finish(new Error('Voice transport closed'));
    const aborted = () => finish(signal.reason);
    transport.on('connectionstatechange', changed);
    transport.observer.on('close', closed);
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
    else if (transport.closed) closed();
    else if (transport.connectionState === 'connected') finish();
  });
