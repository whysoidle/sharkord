import { StorageOverflowAction } from '@sharkord/shared';
import { describe, expect, spyOn, test } from 'bun:test';
import fs from 'fs/promises';
import { config } from '../../config';
import { getUsedFileQuota } from '../../db/queries/files';
import { getSettings } from '../../db/queries/server';
import { getStorageUsageByUserId } from '../../db/queries/users';
import { fileManager } from '../file-manager';
import { UPLOADS_PATH } from '../paths';
import { reserveUpload } from '../upload-capacity';

describe('upload admission', () => {
  test('releases concurrency slots after successful admission', async () => {
    const settings = await getSettings();
    const releases: (() => void)[] = [];

    try {
      for (let i = 0; i < config.server.maxConcurrentUploads; i++) {
        releases.push(await reserveUpload(1, 1, settings));
      }

      await expect(reserveUpload(1, 1, settings)).rejects.toThrow(
        'Uploads are busy'
      );
    } finally {
      releases.forEach((release) => release());
    }

    const release = await reserveUpload(1, 1, settings);
    release();
    release();
  });

  test('refuses a full disk without leaking a slot', async () => {
    const settings = await getSettings();
    const disk = await fs.statfs(UPLOADS_PATH);
    const stat = spyOn(fs, 'statfs').mockResolvedValue({ ...disk, bavail: 0 });

    await expect(reserveUpload(1, 1, settings)).rejects.toThrow(
      'Not enough free disk space'
    );
    stat.mockRestore();

    const release = await reserveUpload(1, 1, settings);
    release();
  });

  test('checks the server quota before accepting the body', async () => {
    const settings = await getSettings();
    const usage = await getUsedFileQuota();

    await expect(
      reserveUpload(1, 2, {
        ...settings,
        storageQuota: usage + 1,
        storageOverflowAction: StorageOverflowAction.PREVENT_UPLOADS
      })
    ).rejects.toThrow('Server storage limit exceeded');
  });

  test('checks the effective user quota before accepting the body', async () => {
    const settings = await getSettings();
    const usage = await getStorageUsageByUserId(2);

    await expect(
      reserveUpload(2, 2, {
        ...settings,
        storageSpaceQuotaByUser: usage.usedStorage + 1
      })
    ).rejects.toThrow('User storage limit exceeded');
  });

  test('counts uploaded files waiting to be attached to a message', async () => {
    const settings = await getSettings();
    const usage = await getUsedFileQuota();
    const filePath = await fileManager.getSafeUploadPath('pending.txt');
    await fs.writeFile(filePath, 'pending');
    await fileManager.addTemporaryFile({
      filePath,
      size: 7,
      originalName: 'pending.txt',
      userId: 1
    });

    await expect(
      reserveUpload(1, 1, {
        ...settings,
        storageQuota: usage + 7,
        storageOverflowAction: StorageOverflowAction.PREVENT_UPLOADS
      })
    ).rejects.toThrow('Server storage limit exceeded');
  });

  test('counts the bytes reserved by another in-flight upload', async () => {
    const settings = await getSettings();
    const usage = await getUsedFileQuota();
    const bounded = {
      ...settings,
      storageQuota: usage + 10,
      storageOverflowAction: StorageOverflowAction.PREVENT_UPLOADS
    };
    const release = await reserveUpload(1, 6, bounded);

    try {
      await expect(reserveUpload(2, 6, bounded)).rejects.toThrow(
        'Server storage limit exceeded'
      );
    } finally {
      release();
    }
  });
});
