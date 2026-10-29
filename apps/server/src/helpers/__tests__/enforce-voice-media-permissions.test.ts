import { ChannelPermission, ServerEvents, StreamKind } from '@sharkord/shared';
import { describe, expect, test } from 'bun:test';
import { createFakeSocket, initTest } from '../../__tests__/helpers';
import { publishChannelPermissions } from '../../db/publishers';
import { VoiceRuntime } from '../../runtimes/voice';
import { pubsub } from '../../utils/pubsub';

// only lifecycle bookkeeping is needed; the SFU does not need a physical capture device.
const addProducer = (
  runtime: VoiceRuntime,
  userId: number,
  kind: StreamKind
) => {
  const closeListeners: (() => void)[] = [];
  const producer = {
    observer: {
      on: (_event: string, listener: () => void) =>
        closeListeners.push(listener)
    },
    close: () => closeListeners.forEach((listener) => listener())
  } as unknown as Parameters<VoiceRuntime['addProducer']>[2];
  runtime.addProducer(userId, kind, producer);
};

describe('voice media permission revocation', () => {
  test('should close camera and both screen producers when the role loses permissions', async () => {
    const { caller: owner } = await initTest(1);
    await owner.channels.updatePermissions({
      channelId: 4,
      roleId: 2,
      permissions: [
        ChannelPermission.VIEW_CHANNEL,
        ChannelPermission.WEBCAM,
        ChannelPermission.SHARE_SCREEN
      ]
    });
    await initTest(2, { socket: createFakeSocket() });
    const runtime = new VoiceRuntime(4);
    runtime.addUser(2, { micMuted: false, soundMuted: false });
    runtime.updateUserState(2, { webcamEnabled: true, sharingScreen: true });
    const kinds = [
      StreamKind.VIDEO,
      StreamKind.SCREEN,
      StreamKind.SCREEN_AUDIO
    ];
    for (const kind of kinds) addProducer(runtime, 2, kind);
    addProducer(runtime, 2, StreamKind.AUDIO);
    const closed: StreamKind[] = [];
    const subscription = pubsub
      .subscribeForChannel(4, ServerEvents.VOICE_PRODUCER_CLOSED)
      .subscribe({
        next: ({ kind }) => closed.push(kind)
      });
    try {
      await owner.channels.updatePermissions({
        channelId: 4,
        roleId: 2,
        permissions: [ChannelPermission.VIEW_CHANNEL]
      });
      expect(closed).toEqual(kinds);
      for (const kind of kinds)
        expect(runtime.getProducer(kind, 2)).toBeUndefined();
      expect(runtime.getProducer(StreamKind.AUDIO, 2)).toBeDefined();
      expect(runtime.getUserState(2)).toMatchObject({
        webcamEnabled: false,
        sharingScreen: false
      });
      await publishChannelPermissions([2]);
      expect(closed).toEqual(kinds);
    } finally {
      subscription.unsubscribe();
      await runtime.destroy();
    }
  });

  test.each([
    [2, 2],
    [1, 4],
    [3, 3]
  ])(
    'should preserve media for user %i in public, owner or DM channel %i',
    async (userId, channelId) => {
      const runtime = new VoiceRuntime(channelId);
      runtime.addUser(userId, { micMuted: false, soundMuted: false });
      runtime.updateUserState(userId, {
        webcamEnabled: true,
        sharingScreen: true
      });
      addProducer(runtime, userId, StreamKind.VIDEO);
      try {
        await publishChannelPermissions([userId]);
        expect(runtime.getProducer(StreamKind.VIDEO, userId)).toBeDefined();
        expect(runtime.getUserState(userId)).toMatchObject({
          webcamEnabled: true,
          sharingScreen: true
        });
      } finally {
        await runtime.destroy();
      }
    }
  );
});
