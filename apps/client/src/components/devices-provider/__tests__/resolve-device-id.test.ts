import { describe, expect, test } from 'bun:test';
import { resolveDeviceId } from '../resolve-device-id';

describe('saved device selection', () => {
  test('preserves a microphone hidden before capture permission', () => {
    expect(resolveDeviceId('studio-mic', [{ deviceId: 'default' }])).toBe(
      'studio-mic'
    );
    expect(resolveDeviceId('studio-mic', [])).toBe('studio-mic');
  });
  test('keeps the choice while a device is disconnected and after it returns', () => {
    const saved = resolveDeviceId('usb-mic', [{ deviceId: 'built-in' }]);
    expect(saved).toBe('usb-mic');
    expect(
      resolveDeviceId(saved, [
        { deviceId: 'built-in' },
        { deviceId: 'usb-mic' }
      ])
    ).toBe('usb-mic');
  });
  test('respects an explicit system default choice', () => {
    expect(resolveDeviceId('default', [{ deviceId: 'usb-mic' }])).toBe(
      'default'
    );
  });
  test('chooses a fallback only when the user has no saved preference', () => {
    expect(
      resolveDeviceId(undefined, [
        { deviceId: 'usb-mic' },
        { deviceId: 'default' }
      ])
    ).toBe('default');
    expect(resolveDeviceId(undefined, [{ deviceId: 'usb-mic' }])).toBe(
      'usb-mic'
    );
    expect(resolveDeviceId(undefined, [])).toBe('default');
  });
});
