import { expect, test } from 'bun:test';
import fs from 'fs/promises';
import path from 'path';
import { cleanupTempUploads } from '../cleanup-temp-uploads';
import { TMP_PATH, UPLOADS_PATH } from '../paths';

test('only removes stale upload files and preserves fresh files and directories', async () => {
  const oldPath = path.join(UPLOADS_PATH, `${Bun.randomUUIDv7()}.png`);
  const freshPath = path.join(TMP_PATH, `${Bun.randomUUIDv7()}.png`);
  const otherPath = path.join(TMP_PATH, 'keep-unrelated.txt');
  const directoryPath = path.join(TMP_PATH, Bun.randomUUIDv7());
  const paths = [oldPath, freshPath, otherPath, directoryPath];

  try {
    await Promise.all([
      fs.writeFile(oldPath, 'old'),
      fs.writeFile(freshPath, 'fresh'),
      fs.writeFile(otherPath, 'keep'),
      fs.mkdir(directoryPath)
    ]);
    const oldTime = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await Promise.all([
      fs.utimes(oldPath, oldTime, oldTime),
      fs.utimes(otherPath, oldTime, oldTime)
    ]);
    await cleanupTempUploads();

    expect(await fs.exists(oldPath)).toBe(false);
    expect(await fs.readFile(freshPath, 'utf8')).toBe('fresh');
    expect(await fs.readFile(otherPath, 'utf8')).toBe('keep');
    const directory = await fs.stat(directoryPath);
    expect(directory.isDirectory()).toBe(true);
  } finally {
    await Promise.all(
      paths.map((entry) => fs.rm(entry, { force: true, recursive: true }))
    );
  }
});
