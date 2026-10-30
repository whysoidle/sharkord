import { describe, expect, test } from 'bun:test';
import { resolveWebRtcListenInfo } from '../mediasoup';

describe('WebRTC listener addresses', () => {
  test('keeps ordinary development local when no address was configured', () => {
    expect(resolveWebRtcListenInfo(false, '', '203.0.113.1')).toEqual({
      ip: '127.0.0.1'
    });
  });
  test('honors an explicit interface address during development', () => {
    expect(resolveWebRtcListenInfo(false, '192.168.1.10')).toEqual({
      ip: '0.0.0.0',
      announcedAddress: '192.168.1.10'
    });
  });
  test('keeps loopback available as an explicit test address', () => {
    expect(resolveWebRtcListenInfo(false, '127.0.0.1')).toEqual({
      ip: '127.0.0.1'
    });
  });
  test('preserves production address selection', () => {
    expect(resolveWebRtcListenInfo(true, '203.0.113.2', '203.0.113.1')).toEqual(
      { ip: '0.0.0.0', announcedAddress: '203.0.113.2' }
    );
    expect(resolveWebRtcListenInfo(true, '', '203.0.113.1')).toEqual({
      ip: '0.0.0.0',
      announcedAddress: '203.0.113.1'
    });
  });
});
