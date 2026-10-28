import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import config from '../client-config.json';

const root = resolve(import.meta.dir, '..');
const result = await Bun.build({
  entrypoints: [resolve(root, 'src/client.ts')],
  target: 'browser',
  format: 'iife',
  minify: true,
  loader: { '.css': 'text' }
});
if (!result.success)
  throw new AggregateError(result.logs, 'Native assets failed');
const [output] = result.outputs;
const javascript = await output.text();
for (const platform of ['macos', 'windows'] as const) {
  const directory =
    platform === 'macos'
      ? 'macos/Sources/Sharkord/Resources'
      : 'windows/Assets';
  const destination = resolve(root, directory);
  await mkdir(destination, { recursive: true });
  await Bun.write(
    resolve(destination, 'client.js'),
    `window.__sharkordPlatform=${JSON.stringify(platform)};\n${javascript}`
  );
  await Bun.write(
    resolve(destination, 'client-config.json'),
    JSON.stringify(config)
  );
}
let licenses = await Bun.file(resolve(root, '../../LICENSE')).text();
for (const dependency of [
  'animejs',
  'motion',
  'framer-motion',
  'motion-dom',
  'motion-utils'
]) {
  const directory = dirname(
    Bun.resolveSync(
      dependency + '/package.json',
      Bun.resolveSync('motion', root)
    )
  );
  let found = false;
  for (const basename of ['LICENSE', 'LICENSE.md', 'LICENSE.txt']) {
    const license = Bun.file(resolve(directory, basename));
    if (!(await license.exists())) continue;
    licenses += `\n\n${dependency}\n\n${await license.text()}`;
    found = true;
    break;
  }
  if (!found) throw new Error(`Missing third party license: ${dependency}`);
}
await Bun.write(resolve(root, 'windows/Assets/LICENSES.txt'), licenses);
await mkdir(resolve(root, 'dist'), { recursive: true });
await Bun.write(resolve(root, 'dist/client.js'), javascript);
console.log(`Native assets built (${javascript.length} bytes)`);
