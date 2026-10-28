import { describe, expect, spyOn, test } from 'bun:test';
import type { LookupAddress } from 'dns';
import dns from 'dns/promises';
import { fetchLinkPreview } from '../fetch-link-preview';

const dnsWithAll: {
  lookup: (
    hostname: string,
    options: { all: true }
  ) => Promise<LookupAddress[]>;
} = dns;

describe('bounded link previews', () => {
  test('parses a small HTML page', async () => {
    spyOn(dnsWithAll, 'lookup').mockResolvedValue([
      { address: '93.184.216.34', family: 4 }
    ]);
    spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('<html><head><title>A small page</title></head></html>', {
        headers: { 'content-type': 'text/html' }
      })
    );
    const preview = await fetchLinkPreview('https://preview.example.org/');
    expect(preview).toHaveProperty('title', 'A small page');
  });

  test('rejects private addresses before issuing an HTTP request', async () => {
    spyOn(dnsWithAll, 'lookup').mockResolvedValue([
      { address: '127.0.0.1', family: 4 }
    ]);
    const fetch = spyOn(globalThis, 'fetch');
    await expect(
      fetchLinkPreview('https://private.example.org/')
    ).rejects.toThrow('Cannot resolve private IP addresses');
    expect(fetch).not.toHaveBeenCalled();
  });

  test('checks the destination of a redirect', async () => {
    spyOn(dnsWithAll, 'lookup')
      .mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }])
      .mockResolvedValueOnce([{ address: '10.0.0.1', family: 4 }]);
    const fetch = spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: 'http://internal.example.org/' }
      })
    );
    await expect(
      fetchLinkPreview('https://preview.example.org/')
    ).rejects.toThrow('Cannot resolve private IP addresses');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test('rejects oversized HTML even without a content-length header', async () => {
    spyOn(dnsWithAll, 'lookup').mockResolvedValue([
      { address: '93.184.216.34', family: 4 }
    ]);
    spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('a'.repeat(512 * 1024 + 1), {
        headers: { 'content-type': 'text/html' }
      })
    );
    await expect(
      fetchLinkPreview('https://preview.example.org/')
    ).rejects.toThrow('Link preview response is too large');
  });

  test('does not read binary response bodies', async () => {
    spyOn(dnsWithAll, 'lookup').mockResolvedValue([
      { address: '93.184.216.34', family: 4 }
    ]);
    let cancelled = false;
    const body = new ReadableStream({
      cancel() {
        cancelled = true;
      }
    });
    spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(body, {
        headers: { 'content-type': 'application/octet-stream' }
      })
    );
    expect(
      await fetchLinkPreview('https://preview.example.org/')
    ).toBeUndefined();
    expect(cancelled).toBe(true);
  });
});
