import type { TFile } from '@sharkord/shared';
import crypto from 'crypto';
import { getServerTokenSync } from '../db/queries/server';
import { safeCompare } from './safe-compare';

const generateFileToken = (fileId: number, expiresAt: number): string => {
  const hmac = crypto.createHmac('sha256', getServerTokenSync());

  hmac.update(`${fileId}:${expiresAt}`);

  return hmac.digest('hex');
};

const verifyFileToken = (
  fileId: number,
  providedToken: string,
  expiresAt: number
): boolean => {
  if (!Number.isSafeInteger(expiresAt) || Date.now() >= expiresAt) {
    return false;
  }

  const expectedToken = generateFileToken(fileId, expiresAt);

  return safeCompare(expectedToken, providedToken);
};

// capability links keep private attachments unguessable even when expiry is disabled.
// use a separate domain so an expiring signature can never become a permanent key.
const generateAttachmentToken = (fileId: number): string => {
  const hmac = crypto.createHmac('sha256', getServerTokenSync());
  hmac.update(`attachment:${fileId}`);
  return hmac.digest('hex');
};

const verifyAttachmentToken = (fileId: number, token: string): boolean =>
  safeCompare(generateAttachmentToken(fileId), token);

const attachFileToken = (
  file: TFile,
  signedUrlsEnabled: boolean,
  ttlSeconds: number
): TFile => {
  if (!signedUrlsEnabled) return file;

  const expiresAt = Date.now() + ttlSeconds * 1000;

  return {
    ...file,
    _accessToken: generateFileToken(file.id, expiresAt),
    _accessTokenExpiresAt: expiresAt
  };
};

// used to attach token to the file, but in cases where the file might not exist (eg: user logo, user might not have a logo set, so file can be null)
const signFile = (
  file: TFile | null,
  enabled: boolean,
  ttl: number
): TFile | null => {
  if (!file) return null;

  return attachFileToken(file, enabled, ttl);
};

const signAttachment = (file: TFile, enabled: boolean, ttl: number): TFile => {
  if (enabled) return attachFileToken(file, true, ttl);

  return {
    ...file,
    _accessToken: generateAttachmentToken(file.id),
    _accessTokenExpiresAt: undefined
  };
};

export {
  attachFileToken,
  generateFileToken,
  signAttachment,
  signFile,
  verifyAttachmentToken,
  verifyFileToken
};
