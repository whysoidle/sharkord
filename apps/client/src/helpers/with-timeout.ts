export const withTimeout = async <T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  parent: AbortSignal
): Promise<T> => {
  parent.throwIfAborted();
  const controller = new AbortController();
  const cancel = () => controller.abort(parent.reason);
  parent.addEventListener('abort', cancel, { once: true });
  if (parent.aborted) cancel();
  const timer = setTimeout(
    () => controller.abort(new Error('Voice recovery timed out')),
    timeoutMs
  );
  let removeAbort = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    const abort = () => reject(controller.signal.reason);
    controller.signal.addEventListener('abort', abort, { once: true });
    removeAbort = () => controller.signal.removeEventListener('abort', abort);
    if (controller.signal.aborted) abort();
  });
  try {
    controller.signal.throwIfAborted();
    return await Promise.race([operation(controller.signal), cancelled]);
  } finally {
    clearTimeout(timer);
    removeAbort();
    parent.removeEventListener('abort', cancel);
    controller.abort();
  }
};
