import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const script = readFileSync(
  resolve(import.meta.dirname, '../../../apps/native/dist/client.js'),
  'utf8'
);
const setup = (
  platform: 'macos' | 'windows',
  url = 'http://localhost:5173/'
) => `
  window.__sharkordPlatform = ${JSON.stringify(platform)};
  window.__sharkordServerUrl = ${JSON.stringify(url)};
  window.__nativeMessages = [];
  const postMessage = message => window.__nativeMessages.push(message);
  window.webkit = { messageHandlers: { sharkord: { postMessage } } };
  window.chrome = { webview: { postMessage } };
  ${script}
`;

test('the web client remains unchanged outside the native application', async ({
  page
}) => {
  await page.goto('/');
  await expect(page.getByTestId('theme-switcher')).toBeVisible();
  await expect(page.locator('html')).not.toHaveAttribute(
    'data-sharkord-native'
  );
  await expect(page.locator('#sharkord-native-style')).toHaveCount(0);
});

test('Mac enhancements follow the selected server and preserve theme preferences', async ({
  page
}) => {
  await page.addInitScript({ content: setup('macos') });
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute(
    'data-sharkord-native',
    'macos'
  );
  await expect(page.locator('#sharkord-native-style')).toHaveCount(1);
  await page.getByTestId('theme-switcher').click();
  await page.getByRole('option', { name: 'Dark', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        `window.__nativeMessages.filter(m => m.type === 'appearance').at(-1)`
      )
    )
    .toEqual({ type: 'appearance', dark: true, system: false });
  await page.getByTestId('theme-switcher').click();
  await page.getByRole('option', { name: 'System', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        `window.__nativeMessages.filter(m => m.type === 'appearance').at(-1).system`
      )
    )
    .toBe(true);
});

test('Windows keeps the existing visual style', async ({ page }) => {
  await page.addInitScript({ content: setup('windows') });
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute(
    'data-sharkord-native',
    'windows'
  );
  await expect(page.locator('#sharkord-native-style')).toHaveCount(0);
});

test('native code ignores pages outside the selected server', async ({
  page
}) => {
  await page.addInitScript({
    content: setup('macos', 'https://other.example.com/voice/')
  });
  await page.goto('/');
  await expect(page.getByTestId('theme-switcher')).toBeVisible();
  expect(await page.evaluate('window.__nativeMessages')).toEqual([]);
  await expect(page.locator('#sharkord-native-style')).toHaveCount(0);
});

test('native notification permission is required before notifications are sent', async ({
  page
}) => {
  await page.addInitScript({ content: setup('windows') });
  await page.goto('/');
  await page.evaluate(`new Notification('before permission')`);
  expect(
    await page.evaluate(
      `window.__nativeMessages.filter(m => m.type === 'notify').length`
    )
  ).toBe(0);
  await page.evaluate(
    `(() => { window.__permission = Notification.requestPermission(); })()`
  );
  const id = await page.evaluate<number>(
    `window.__nativeMessages.find(m => m.type === 'requestNotifications').id`
  );
  await page.evaluate(`window.__sharkordNativeReply(${id}, 'granted')`);
  expect(await page.evaluate('window.__permission')).toBe('granted');
  await page.evaluate(`new Notification('New message', { body: 'hello' })`);
  expect(
    await page.evaluate(
      `window.__nativeMessages.filter(m => m.type === 'notify').at(-1)`
    )
  ).toEqual({ type: 'notify', title: 'New message', body: 'hello' });
});

test('capture tracking stops when the stream is stopped without using a physical microphone', async ({
  page
}) => {
  await page.addInitScript({
    content: `
    navigator.mediaDevices.getUserMedia = async () => {
      const audio = new AudioContext();
      window.__testAudio = audio;
      return audio.createMediaStreamDestination().stream;
    };
    ${setup('windows')}
  `
  });
  await page.goto('/');
  await page.evaluate(
    `(async () => { window.__testStream = await navigator.mediaDevices.getUserMedia({ audio: true }); })()`
  );
  expect(
    await page.evaluate(
      `window.__nativeMessages.filter(m => m.type === 'capture').at(-1).active`
    )
  ).toBe(true);
  await page.evaluate(
    `window.__testStream.getTracks().forEach(t => t.stop()); window.__testAudio.close()`
  );
  expect(
    await page.evaluate(
      `window.__nativeMessages.filter(m => m.type === 'capture').at(-1).active`
    )
  ).toBe(false);
});

test('native animations respect reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript({ content: setup('macos') });
  await page.goto('/');
  await expect(page.getByTestId('theme-switcher')).toBeVisible();
  expect(
    await page.evaluate(
      `document.querySelector('[data-slot="card"]').getAnimations({ subtree: true }).length`
    )
  ).toBe(0);
});
