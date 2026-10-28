import type { TFile } from '@sharkord/shared';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  getFileUrl,
  getHostFromServer,
  getUrlFromServer
} from '../get-file-url';

const getFile = (name: string, accessToken?: string): TFile =>
  ({
    name,
    _accessToken: accessToken,
    _accessTokenExpiresAt: accessToken ? 1700000000000 : undefined
  }) as TFile;

describe('getFileUrl', () => {
  beforeAll(() => {
    globalThis.window = {
      location: { host: 'chat.example.com', protocol: 'https:' }
    } as never;
  });

  afterAll(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  test('should return an empty string without a file', () => {
    expect(getFileUrl(undefined)).toBe('');
  });

  test.each(['/voice/', '/%D0%B3%D0%BE%D0%BB%D0%BE%D1%81/'])(
    'keeps HTTP, WebSocket and attachment URLs under %s',
    (basePath) => {
      const previous = process.env.BASE_URL;
      process.env.BASE_URL = basePath;

      try {
        const prefix = basePath.slice(0, -1);
        expect(getHostFromServer()).toBe(`chat.example.com${prefix}`);
        expect(getUrlFromServer()).toBe(`https://chat.example.com${prefix}`);
        expect(getFileUrl(getFile('photo.png'))).toBe(
          `https://chat.example.com${prefix}/public/photo.png`
        );
      } finally {
        if (previous === undefined) delete process.env.BASE_URL;
        else process.env.BASE_URL = previous;
      }
    }
  );

  test('should encode a non ascii name', () => {
    const url = new URL(getFileUrl(getFile('Отчёт за март.png')));

    expect(decodeURIComponent(url.pathname)).toBe('/public/Отчёт за март.png');
  });

  test.each(['foto#1.png', 'que?.png', 'a&b=c.png', '100%.png'])(
    'should keep %s inside the path',
    (name) => {
      const url = new URL(getFileUrl(getFile(name)));

      expect(decodeURIComponent(url.pathname)).toBe(`/public/${name}`);
      expect(url.hash).toBe('');
      expect(url.search).toBe('');
    }
  );

  test('should append the access token and its expiry', () => {
    const url = new URL(getFileUrl(getFile('foto#1.png', 'abc123')));

    expect(url.searchParams.get('accessToken')).toBe('abc123');
    expect(url.searchParams.get('expires')).toBe('1700000000000');
  });
});
