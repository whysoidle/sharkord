import { StorageOverflowAction, type TJoinedSettings } from '@sharkord/shared';
import fs from 'fs/promises';
import { config } from '../config';
import { getUsedFileQuota } from '../db/queries/files';
import { getEffectiveStorageSpaceQuotaByUserId } from '../db/queries/roles';
import { getStorageUsageByUserId } from '../db/queries/users';
import { fileManager } from './file-manager';
import { UPLOADS_PATH } from './paths';

class UploadCapacityError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string
  ) {
    super(message);
  }
}

const reservations = new Set<{ userId: number; size: number }>();

const reserveUpload = async (
  userId: number,
  size: number,
  settings: TJoinedSettings
): Promise<() => void> => {
  if (reservations.size >= config.server.maxConcurrentUploads) {
    throw new UploadCapacityError(
      429,
      'Uploads are busy. Please try again shortly.'
    );
  }

  const reservation = { userId, size };
  const release = () => {
    reservations.delete(reservation);
  };

  // reserve before yielding so concurrent checks include each other's uploads
  reservations.add(reservation);

  try {
    const [disk, usedSpace, userStorage, userQuota] = await Promise.all([
      fs.statfs(UPLOADS_PATH),
      getUsedFileQuota(),
      getStorageUsageByUserId(userId),
      getEffectiveStorageSpaceQuotaByUserId(
        userId,
        settings.storageSpaceQuotaByUser
      )
    ]);

    let reservedBytes = 0;
    let userReservedBytes = 0;

    for (const entry of reservations) {
      reservedBytes += entry.size;
      if (entry.userId === userId) userReservedBytes += entry.size;
    }

    if (
      disk.bavail * disk.bsize - reservedBytes <
      config.server.minFreeDiskBytes
    ) {
      throw new UploadCapacityError(
        507,
        'Not enough free disk space for this upload.'
      );
    }

    const pendingBytes = fileManager.getTemporaryStorageUsage();
    const userPendingBytes = fileManager.getTemporaryStorageUsage(userId);

    if (
      userQuota > 0 &&
      userStorage.usedStorage + userPendingBytes + userReservedBytes > userQuota
    ) {
      throw new UploadCapacityError(413, 'User storage limit exceeded');
    }

    if (
      settings.storageQuota > 0 &&
      settings.storageOverflowAction ===
        StorageOverflowAction.PREVENT_UPLOADS &&
      usedSpace + pendingBytes + reservedBytes > settings.storageQuota
    ) {
      throw new UploadCapacityError(413, 'Server storage limit exceeded.');
    }

    return release;
  } catch (error) {
    release();
    throw error;
  }
};

export { reserveUpload, UploadCapacityError };
