import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const directory = resolve(root, 'dist/voice-probe');
await mkdir(directory, { recursive: true });
const result = await Bun.build({
  entrypoints: [
    resolve(
      root,
      '../client/src/components/voice-provider/__tests__/native-voice-probe.ts'
    )
  ],
  target: 'browser',
  format: 'iife',
  minify: true
});
if (!result.success)
  throw new AggregateError(result.logs, 'Voice probe failed');
await Bun.write(
  resolve(directory, 'voice-probe.js'),
  await result.outputs[0].text()
);
await Bun.write(
  resolve(directory, 'index.html'),
  '<!doctype html><html><head><meta charset="utf-8"></head><body><script src="voice-probe.js"></script></body></html>'
);
