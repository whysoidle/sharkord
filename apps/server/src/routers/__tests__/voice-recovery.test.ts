import { Permission } from '@sharkord/shared';
import { describe, expect, spyOn, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { createFakeSocket, initTest } from '../../__tests__/helpers';
import { tdb } from '../../__tests__/setup';
import { rolePermissions } from '../../db/schema';
import { disconnectVoiceUser } from '../../helpers/voice-moderation';
import * as hooks from '../../plugins/run-hook';
import { VoiceRuntime } from '../../runtimes/voice';
import { handleSocketClose } from '../../utils/wss';

const connect = async () => {
  const socket = createFakeSocket();
  const { caller } = await initTest(2, { socket });
  return { socket, caller };
};
const joinInput = {
  channelId: 2,
  sessionId: '21b34d99-de8e-454b-92df-9d372aa7c034',
  state: { micMuted: true, soundMuted: true }
};

describe('voice recovery', () => {
  test('should accept authenticated recovery when a fresh server has no prior session claim', async () => {
    const runtime = new VoiceRuntime(2);
    await runtime.init();
    const { caller } = await connect();
    try {
      await caller.voice.join({ ...joinInput, recover: true });
      expect(runtime.getUserSessionId(2)).toBe(joinInput.sessionId);
      expect(runtime.getUserState(2)).toMatchObject(joinInput.state);
    } finally {
      await runtime.destroy();
    }
  });
  test('should cancel a join still waiting for a plugin hook', async () => {
    const runtime = new VoiceRuntime(2);
    await runtime.init();
    const { caller } = await connect();
    let entered!: () => void;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    spyOn(hooks, 'runHook').mockImplementation(async ({ payload }) => {
      entered();
      await gate;
      return payload;
    });
    try {
      const joining = caller.voice.join(joinInput);
      await waiting;
      await caller.voice.leave({ sessionId: joinInput.sessionId });
      release();
      await expect(joining).rejects.toThrow('Voice join was cancelled');
      expect(runtime.getUser(2)).toBeUndefined();
    } finally {
      release();
      await runtime.destroy();
    }
  });
  test('should rebuild the same session on its current socket', async () => {
    const runtime = new VoiceRuntime(2);
    await runtime.init();
    const { caller } = await connect();
    try {
      await caller.voice.join(joinInput);
      await caller.voice.createProducerTransport();
      const previous = runtime.getProducerTransport(2)!;
      await caller.voice.join({ ...joinInput, recover: true });
      expect(previous.closed).toBe(true);
      expect(runtime.getUserState(2)).toMatchObject(joinInput.state);
      expect(runtime.getUserSessionId(2)).toBe(joinInput.sessionId);
    } finally {
      await runtime.destroy();
    }
  });

  test('should recover after its socket closes while a second tab stays online', async () => {
    const runtime = new VoiceRuntime(2);
    await runtime.init();
    const first = await connect();
    const second = await connect();
    try {
      await first.caller.voice.join(joinInput);
      await handleSocketClose(first.socket);
      await second.caller.voice.join({ ...joinInput, recover: true });
      expect(runtime.getUserSocket(2)).toBe(second.socket);
    } finally {
      await runtime.destroy();
    }
  });

  test('should refuse recovery after a moderator disconnected the user', async () => {
    const runtime = new VoiceRuntime(2);
    await runtime.init();
    const { caller } = await connect();
    try {
      await caller.voice.join(joinInput);
      await disconnectVoiceUser(2);
      await expect(
        caller.voice.join({ ...joinInput, recover: true })
      ).rejects.toThrow('Voice session recovery is no longer allowed');
    } finally {
      await runtime.destroy();
    }
  });

  test('should not let an old recovering tab take a newer manual call over', async () => {
    const runtime = new VoiceRuntime(2);
    await runtime.init();
    const first = await connect();
    const second = await connect();
    try {
      await first.caller.voice.join(joinInput);
      const newerId = crypto.randomUUID();
      await second.caller.voice.join({ ...joinInput, sessionId: newerId });
      await expect(
        first.caller.voice.join({ ...joinInput, recover: true })
      ).rejects.toThrow('Voice session recovery is no longer allowed');
      await first.caller.voice.leave({ sessionId: joinInput.sessionId });
      expect(runtime.getUserSessionId(2)).toBe(newerId);
      expect(runtime.getUserSocket(2)).toBe(second.socket);
    } finally {
      await runtime.destroy();
    }
  });

  test('should cancel recovery even when the replacement socket has not joined voice yet', async () => {
    const runtime = new VoiceRuntime(2);
    await runtime.init();
    const first = await connect();
    const second = await connect();
    try {
      await first.caller.voice.join(joinInput);
      await handleSocketClose(first.socket);
      await second.caller.voice.leave({ sessionId: joinInput.sessionId });
      await expect(
        second.caller.voice.join({ ...joinInput, recover: true })
      ).rejects.toThrow('Voice session recovery is no longer allowed');
    } finally {
      await runtime.destroy();
    }
  });

  test('should refuse recovery with no session id and validate session ids', async () => {
    const { caller } = await connect();
    await expect(
      caller.voice.join({ ...joinInput, sessionId: undefined, recover: true })
    ).rejects.toThrow('Voice session recovery is no longer allowed');
    await expect(
      caller.voice.join({ ...joinInput, sessionId: 'invalid' })
    ).rejects.toThrow();
  });

  test.each(['send', 'recv'] as const)(
    'should restart ICE for the owned %s transport without closing it',
    async (direction) => {
      const runtime = new VoiceRuntime(2);
      await runtime.init();
      const { caller } = await connect();
      try {
        await caller.voice.join(joinInput);
        const params =
          direction === 'send'
            ? await caller.voice.createProducerTransport()
            : await caller.voice.createConsumerTransport();
        const response = await caller.voice.restartIce({
          direction,
          transportId: params.id
        });
        expect(response.iceParameters.usernameFragment).not.toBe(
          params.iceParameters.usernameFragment
        );
        expect(response.iceParameters.password).not.toBe(
          params.iceParameters.password
        );
        const transport =
          direction === 'send'
            ? runtime.getProducerTransport(2)
            : runtime.getConsumerTransport(2);
        expect(transport!.closed).toBe(false);
      } finally {
        await runtime.destroy();
      }
    }
  );

  test('should reject missing, stale and another direction transport ids', async () => {
    const runtime = new VoiceRuntime(2);
    await runtime.init();
    const { caller } = await connect();
    try {
      await caller.voice.join(joinInput);
      await expect(
        caller.voice.restartIce({ direction: 'recv', transportId: 'missing' })
      ).rejects.toThrow('Voice transport not found');
      const previous = await caller.voice.createProducerTransport();
      await caller.voice.createProducerTransport();
      for (const direction of ['send', 'recv'] as const) {
        await expect(
          caller.voice.restartIce({ direction, transportId: previous.id })
        ).rejects.toThrow('Voice transport not found');
      }
    } finally {
      await runtime.destroy();
    }
  });

  test('should reject an ICE restart without a voice session or global permission', async () => {
    const { caller } = await connect();
    await expect(
      caller.voice.restartIce({ direction: 'send', transportId: 'missing' })
    ).rejects.toThrow('User is not in a voice channel');
    await tdb
      .delete(rolePermissions)
      .where(
        and(
          eq(rolePermissions.roleId, 2),
          eq(rolePermissions.permission, Permission.JOIN_VOICE_CHANNELS)
        )
      );
    await expect(
      caller.voice.restartIce({ direction: 'send', transportId: 'missing' })
    ).rejects.toThrow('Insufficient permissions');
    await expect(
      caller.voice.restartIce({ direction: 'send', transportId: '' })
    ).rejects.toThrow();
  });
});
