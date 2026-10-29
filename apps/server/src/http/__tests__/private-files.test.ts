import { type TFile, type TTempFile } from '@sharkord/shared';
import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { initTest, sendMessage, uploadFile } from '../../__tests__/helpers';
import { tdb, testsBaseUrl } from '../../__tests__/setup';
import { channels, settings } from '../../db/schema';

// use the existing private voice and dm fixtures, creating attachments through the API.
const attachPrivateFile = async (userId = 1, channelId = 4) => {
  const { caller, mockedToken } = await initTest(userId);
  const response = await uploadFile(
    new File(['private attachment'], 'private-report.txt', {
      type: 'text/plain'
    }),
    mockedToken
  );
  expect(response.status).toBe(200);
  const tempFile = (await response.json()) as TTempFile;
  const messageId = await sendMessage(caller, {
    channelId,
    content: 'Private report',
    files: [tempFile.id]
  });
  const page = await caller.messages.get({ channelId });
  const message = page.messages.find(({ id }) => id === messageId);
  const file = message!.files[0]!;

  return { caller, file, messageId };
};

// matches the existing client's URL format, including its optional expiry.
const fileUrl = (file: TFile) => {
  const url = new URL(
    `${testsBaseUrl}/public/${encodeURIComponent(file.name)}`
  );
  if (file._accessToken) url.searchParams.set('accessToken', file._accessToken);
  if (file._accessTokenExpiresAt) {
    url.searchParams.set('expires', String(file._accessTokenExpiresAt));
  }
  return url;
};

describe('private attachment links', () => {
  test.each([
    [1, 4, 2],
    [3, 3, 1]
  ])(
    'should protect user %i channel %i attachments from user %i',
    async (userId, channelId, outsiderId) => {
      const { file } = await attachPrivateFile(userId, channelId);
      const rawUrl = `${testsBaseUrl}/public/${encodeURIComponent(file.name)}`;
      expect((await fetch(rawUrl)).status).toBe(403);
      const { caller: outsider } = await initTest(outsiderId);
      await expect(outsider.messages.get({ channelId })).rejects.toThrow();
      expect(file._accessToken).toMatch(/^[a-f0-9]{64}$/);
      expect(file._accessTokenExpiresAt).toBeUndefined();
      const allowed = await fetch(fileUrl(file));
      expect(allowed.status).toBe(200);
      expect(await allowed.text()).toBe('private attachment');
      expect(allowed.headers.get('Cache-Control')).toBe('private, no-store');
    }
  );

  test('should reject forged, cross-file and stripped keys before serving ranges or cache hits', async () => {
    const { file } = await attachPrivateFile();
    const { file: second } = await attachPrivateFile();
    const authorized = await fetch(fileUrl(file));
    const etag = authorized.headers.get('ETag')!;
    for (const token of [
      '',
      'x'.repeat(64),
      'я'.repeat(64),
      second._accessToken!
    ]) {
      const url = fileUrl({ ...file, _accessToken: token });
      const response = await fetch(url, {
        headers: { Range: 'bytes=0-3', 'If-None-Match': etag }
      });
      expect(response.status).toBe(403);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
    }
  });

  test('should protect an existing attachment when its channel becomes private', async () => {
    const { file } = await attachPrivateFile(1, 1);
    const rawUrl = `${testsBaseUrl}/public/${encodeURIComponent(file.name)}`;
    expect((await fetch(rawUrl)).status).toBe(200);
    await tdb.update(channels).set({ private: true }).where(eq(channels.id, 1));
    expect((await fetch(rawUrl)).status).toBe(403);
    expect((await fetch(fileUrl(file))).status).toBe(200);
  });

  test('should return working private links in message and file search results', async () => {
    const { caller } = await attachPrivateFile();
    const results = await caller.messages.search({ query: 'private' });
    expect(results.files.length).toBeGreaterThan(0);
    expect(results.messages.length).toBeGreaterThan(0);
    for (const file of [
      ...results.files.map(({ file }) => file),
      ...results.messages.flatMap(({ files }) => files)
    ]) {
      expect(file._accessToken).toBeDefined();
      expect((await fetch(fileUrl(file))).status).toBe(200);
    }
  });

  test('should reject permanent keys when expiring signed URLs are enabled', async () => {
    const { caller, file } = await attachPrivateFile();
    await tdb.update(settings).set({ storageSignedUrlsEnabled: true });
    expect((await fetch(fileUrl(file))).status).toBe(403);
    const page = await caller.messages.get({ channelId: 4 });
    const refreshed = page.messages[0]!.files[0]!;
    expect(refreshed._accessTokenExpiresAt).toBeGreaterThan(Date.now());
    expect((await fetch(fileUrl(refreshed))).status).toBe(200);
  });
});
