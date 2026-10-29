import { expect, loginAs, test } from './fixtures';
import { openChannel } from './helpers/channels';
import { messageByText, sendMessage } from './helpers/messages';

// administrative setup uses the real websocket client; upload and rendering use the
// unchanged UI. this catches a server URL format the browser cannot actually display.
test('private images load in the existing client while bare file URLs are rejected', async ({
  page
}) => {
  await loginAs(page, 'testowner', 'password123');
  const name = `private-link-${Date.now().toString().slice(-8)}`;
  const channelId = await page.evaluate<number>(`(async () => {
    const { getTRPCClient } = await import('/src/lib/trpc.ts');
    const trpc = getTRPCClient();
    const id = await trpc.channels.add.mutate({ name: ${JSON.stringify(name)}, type: 'TEXT', categoryId: 1 });
    await trpc.channels.update.mutate({ channelId: id, private: true });
    return id;
  })()`);
  try {
    await openChannel(page, name);
    await page.locator('input[type="file"]').setInputFiles({
      name: 'private-pixel.png',
      mimeType: 'image/png',
      buffer: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        'base64'
      )
    });
    const text = `Private image ${name}`;
    await sendMessage(page, text);
    const image = messageByText(page, text).locator('img[src*="/public/"]');
    await expect(image).toHaveCount(1);
    await expect
      .poll(() =>
        image.evaluate(
          (element) =>
            (element as unknown as { naturalWidth: number }).naturalWidth
        )
      )
      .toBe(1);
    const src = await image.getAttribute('src');
    const url = new URL(src!);
    expect(url.searchParams.get('accessToken')).toMatch(/^[a-f0-9]{64}$/);
    expect((await page.request.get(url.href)).status()).toBe(200);
    url.search = '';
    expect((await page.request.get(url.href)).status()).toBe(403);

    await page.reload();
    await loginAs(page, 'testowner', 'password123');
    await openChannel(page, name);
    await expect
      .poll(() =>
        image.evaluate(
          (element) =>
            (element as unknown as { naturalWidth: number }).naturalWidth
        )
      )
      .toBe(1);
  } finally {
    if (!page.isClosed()) {
      await page.evaluate(`(async () => {
      const { getTRPCClient } = await import('/src/lib/trpc.ts');
      const trpc = getTRPCClient();
      await trpc.channels.delete.mutate({ channelId: ${channelId} });
    })()`);
    }
  }
});
