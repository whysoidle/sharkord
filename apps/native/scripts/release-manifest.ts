import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import config from '../client-config.json';

const directory = resolve(process.argv[2] ?? 'dist');
const names = ['Sharkord-macos-universal.zip', 'Sharkord-windows-x64.zip'];
const files = await readdir(directory);
const assets = [];
for (const name of names) {
  if (!files.includes(name))
    throw new Error(`Missing release artifact: ${name}`);
  const file = Bun.file(resolve(directory, name));
  const bytes = await file.arrayBuffer();
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(bytes);
  assets.push({ name, sha256: hasher.digest('hex'), size: bytes.byteLength });
}
const manifest = { version: config.version, assets };
await Bun.write(
  resolve(directory, 'client-update.json'),
  JSON.stringify(manifest, null, 2)
);
console.log(JSON.stringify(manifest, null, 2));
