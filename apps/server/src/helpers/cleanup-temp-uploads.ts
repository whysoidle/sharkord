import fs from 'fs/promises';
import path from 'path';
import { TMP_PATH, UPLOADS_PATH } from './paths';

const STALE_UPLOAD_AGE_MS = 60 * 60 * 1000;
const UPLOAD_NAME =
  /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}(?:-optimized)?(?:\.[^/\\]+)?$/i;

const cleanupTempUploads = async () => {
  const cutoff = Date.now() - STALE_UPLOAD_AGE_MS;

  for (const directory of [UPLOADS_PATH, TMP_PATH]) {
    const entries = await fs.readdir(directory, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isFile() || !UPLOAD_NAME.test(entry.name)) continue;

      const filePath = path.join(directory, entry.name);

      try {
        const stats = await fs.stat(filePath);
        if (stats.mtimeMs < cutoff) await fs.rm(filePath, { force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }
};

export { cleanupTempUploads };
