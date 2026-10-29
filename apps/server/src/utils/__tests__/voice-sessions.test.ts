import { ServerEvents, StreamKind } from '@sharkord/shared';
import { describe, expect, test } from 'bun:test';
import { createFakeSocket, initTest } from '../../__tests__/helpers';
import { VoiceRuntime } from '../../runtimes/voice';
import { pubsub } from '../pubsub';
import { getOnlineUserIds, handleSocketClose } from '../wss';

const connect = async () => {
  const socket = createFakeSocket();
  const { caller } = await initTest(2, { socket });
  return { socket, caller };
};
const joinInput = {
  channelId: 2,
  state: { micMuted: false, soundMuted: false }
};

describe('voice session ownership', () => {
  test('should not recreate voice for a connection whose close was already handled', async () => {
    const runtime = new VoiceRuntime(2);
    await runtime.init();
    const first = await connect();
    try {
      await handleSocketClose(first.socket);
      await expect(first.caller.voice.join(joinInput)).rejects.toThrow(
        'User not authenticated'
      );
      expect(runtime.getUser(2)).toBeUndefined();
    } finally {
      await runtime.destroy();
    }
  });
  test('should clean voice when its owner closes while another tab stays online', async () => {
    const runtime = new VoiceRuntime(2);
    await runtime.init();
    const first = await connect();
    const idle = await connect();
    const departures: number[] = [];
    const subscription = pubsub
      .subscribe(ServerEvents.USER_LEAVE_VOICE)
      .subscribe({
        next: ({ userId }) => departures.push(userId)
      });
    try {
      await first.caller.voice.join(joinInput);
      await handleSocketClose(first.socket);
      expect(runtime.getUser(2)).toBeUndefined();
      expect(getOnlineUserIds()).toContain(2);
      expect(departures).toEqual([2]);
      await idle.caller.voice.join(joinInput);
      expect(runtime.getUser(2)).toBeDefined();
    } finally {
      subscription.unsubscribe();
      await runtime.destroy();
    }
  });

  test('should preserve voice when an unrelated tab closes', async () => {
    const runtime = new VoiceRuntime(2);
    await runtime.init();
    const first = await connect();
    const idle = await connect();
    try {
      await first.caller.voice.join(joinInput);
      await handleSocketClose(idle.socket);
      expect(runtime.getUser(2)).toBeDefined();
      await first.caller.voice.updateState({ micMuted: true });
      expect(runtime.getUserState(2).micMuted).toBe(true);
    } finally {
      await runtime.destroy();
    }
  });

  test('should take over a stale connection and ignore its later controls and close', async () => {
    const runtime = new VoiceRuntime(2);
    await runtime.init();
    const first = await connect();
    const replacement = await connect();
    try {
      await first.caller.voice.join(joinInput);
      await replacement.caller.voice.join(joinInput);
      await expect(
        first.caller.voice.updateState({ micMuted: true })
      ).rejects.toThrow('User is not in a voice channel');
      await expect(first.caller.voice.leave()).rejects.toThrow(
        'User is not in a voice channel'
      );
      await first.caller.voice.closeProducer({ kind: StreamKind.AUDIO });
      await handleSocketClose(first.socket);
      expect(runtime.getUser(2)).toBeDefined();
      expect(runtime.getUserState(2).micMuted).toBe(false);
      await replacement.caller.voice.leave();
      expect(runtime.getUser(2)).toBeUndefined();
    } finally {
      await runtime.destroy();
    }
  });

  test('should reject a duplicate join from the owner and preserve voice after a denied takeover', async () => {
    const runtime = new VoiceRuntime(2);
    await runtime.init();
    const first = await connect();
    const replacement = await connect();
    try {
      await first.caller.voice.join(joinInput);
      await expect(first.caller.voice.join(joinInput)).rejects.toThrow(
        'User already in a voice channel'
      );
      await expect(
        replacement.caller.voice.join({ ...joinInput, channelId: 4 })
      ).rejects.toThrow('Insufficient channel permissions');
      expect(runtime.getUser(2)).toBeDefined();
      await first.caller.voice.updateState({ micMuted: true });
      expect(runtime.getUserState(2).micMuted).toBe(true);
    } finally {
      await runtime.destroy();
    }
  });
});
