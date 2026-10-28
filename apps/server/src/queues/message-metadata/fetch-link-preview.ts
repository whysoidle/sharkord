import dns from 'dns/promises';
import { getPreviewFromContent } from 'link-preview-js';
import { isPrivateIP } from '../../helpers/network';
import { readBodyWithLimit } from '../../utils/read-body-with-limit';

const MAX_PREVIEW_BYTES = 512 * 1024;

const fetchLinkPreview = async (url: string) => {
  const signal = AbortSignal.timeout(2000);
  let current = new URL(url);

  for (let redirects = 0; redirects <= 3; redirects++) {
    if (
      !['http:', 'https:'].includes(current.protocol) ||
      current.username ||
      current.password
    ) {
      throw new Error('Unsupported preview URL');
    }

    const addresses = await dns.lookup(current.hostname, { all: true });
    if (
      addresses.length === 0 ||
      addresses.some(({ address }) => isPrivateIP(address))
    ) {
      throw new Error('Cannot resolve private IP addresses');
    }

    signal.throwIfAborted();
    const response = await fetch(current, { redirect: 'manual', signal });
    const location = response.headers.get('location');

    if (response.status >= 300 && response.status < 400 && location) {
      await response.body?.cancel();
      current = new URL(location, current);
      continue;
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (
      !response.ok ||
      !/^(text\/html|application\/xhtml\+xml)(?:;|$)/i.test(contentType)
    ) {
      await response.body?.cancel();
      return;
    }

    const chunks: Uint8Array[] = [];

    await readBodyWithLimit(response, {
      maxBytes: MAX_PREVIEW_BYTES,
      tooLargeMessage: 'Link preview response is too large',
      onChunk: (chunk) => {
        chunks.push(chunk);
      }
    });

    return getPreviewFromContent({
      url: current.href,
      headers: { 'content-type': contentType },
      data: Buffer.concat(chunks).toString('utf8')
    });
  }

  throw new Error('Too many preview redirects');
};

export { fetchLinkPreview };
