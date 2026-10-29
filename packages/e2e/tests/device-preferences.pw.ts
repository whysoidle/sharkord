import { expect, test } from '@playwright/test';
import { TestId } from '@sharkord/shared';
import { loginAs } from './fixtures';

test.use({ locale: 'en-US' });

test('keeps the chosen microphone before permission, after reload and when devices appear', async ({
  page
}) => {
  await page.addInitScript(`(() => {
    const key = 'sharkord-devices-settings';
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({ microphoneId: 'studio-mic', noiseSuppression: 'none' }));
    window.__deviceWrites = [];
    window.__devicesVisible = false;
    const write = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (key === 'sharkord-devices-settings') window.__deviceWrites.push(JSON.parse(value));
      return write.call(this, key, value);
    };
    const enumerate = async () => window.__devicesVisible ? [
      { kind: 'audioinput', deviceId: 'default', label: 'System default', groupId: 'builtin' },
      { kind: 'audioinput', deviceId: 'studio-mic', label: 'Studio Microphone', groupId: 'usb' }
    ] : [{ kind: 'audioinput', deviceId: '', label: '', groupId: '' }];
    for (const target of [Object.getPrototypeOf(navigator.mediaDevices), navigator.mediaDevices]) {
      Object.defineProperty(target, 'enumerateDevices', { configurable: true, value: enumerate });
    }
  })()`);
  await page.goto('/');
  await expect
    .poll(() => page.evaluate<number>('window.__deviceWrites.length'))
    .toBeGreaterThan(0);
  expect(
    await page.evaluate(
      'window.__deviceWrites.every(settings => settings.microphoneId === "studio-mic")'
    )
  ).toBe(true);
  await page.reload();
  await expect
    .poll(() => page.evaluate<number>('window.__deviceWrites.length'))
    .toBeGreaterThan(0);
  expect(
    await page.evaluate(
      'JSON.parse(localStorage.getItem("sharkord-devices-settings")).microphoneId'
    )
  ).toBe('studio-mic');
  await loginAs(page, 'testowner', 'password123');
  await page.evaluate(`(() => {
    window.__devicesVisible = true;
    navigator.mediaDevices.dispatchEvent(new Event('devicechange'));
  })()`);
  await page.getByTestId(TestId.USER_SETTINGS_TRIGGER).click();
  await page
    .getByTestId(TestId.SETTINGS_SIDEBAR_ENTRY)
    .filter({ hasText: 'Devices' })
    .click();
  await expect(
    page.getByRole('combobox').filter({ hasText: 'Studio Microphone' })
  ).toBeVisible();
  expect(
    await page.evaluate(
      'JSON.parse(localStorage.getItem("sharkord-devices-settings")).microphoneId'
    )
  ).toBe('studio-mic');
});
