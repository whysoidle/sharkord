import { expect, spyOn, test } from 'bun:test';
import mediasoup from 'mediasoup';
import { loadMediasoup } from '../mediasoup';

test('propagates the original media worker startup error', async () => {
  const error = new Error('Worker could not start');
  spyOn(mediasoup, 'createWorker').mockRejectedValueOnce(error);
  await expect(loadMediasoup()).rejects.toBe(error);
});
