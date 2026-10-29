import {
  ChannelPermission,
  ChannelType,
  Permission,
  ServerEvents,
  type TBeforeVoiceJoinPayload
} from '@sharkord/shared';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { config } from '../../config';
import { db } from '../../db';
import { channels } from '../../db/schema';
import {
  consumeVoiceMoveGrant,
  hasVoiceMoveGrant
} from '../../helpers/voice-move-grants';
import { logger } from '../../logger';
import { pluginManager } from '../../plugins';
import { runHook } from '../../plugins/run-hook';
import { VoiceRuntime } from '../../runtimes/voice';
import { invariant } from '../../utils/invariant';
import { protectedProcedure, rateLimitedProcedure } from '../../utils/trpc';

const joinVoiceRoute = rateLimitedProcedure(protectedProcedure, {
  maxRequests: config.rateLimiters.joinVoiceChannel.maxRequests,
  windowMs: config.rateLimiters.joinVoiceChannel.windowMs,
  logLabel: 'joinVoice'
})
  .input(
    z.object({
      channelId: z.number(),
      state: z.object({
        micMuted: z.boolean().default(false),
        soundMuted: z.boolean().default(false)
      })
    })
  )
  .mutation(async ({ input, ctx }) => {
    await ctx.needsPermission(Permission.JOIN_VOICE_CHANNELS);

    const movedByModerator = hasVoiceMoveGrant(ctx.user.id, input.channelId);

    if (!movedByModerator) {
      await ctx.needsChannelPermission(input.channelId, ChannelPermission.JOIN);
    }

    const channel = await db
      .select({
        id: channels.id,
        name: channels.name,
        type: channels.type,
        isDm: channels.isDm
      })
      .from(channels)
      .where(eq(channels.id, input.channelId))
      .get();

    invariant(channel, {
      code: 'NOT_FOUND',
      message: 'Channel not found'
    });

    invariant(channel.type === ChannelType.VOICE, {
      code: 'BAD_REQUEST',
      message: 'Channel is not a voice channel'
    });

    invariant(!channel.isDm, {
      code: 'BAD_REQUEST',
      message: 'Cannot join a direct message channel as a voice channel'
    });

    const previousRuntime = VoiceRuntime.findRuntimeByUserId(ctx.user.id);
    const socket = ctx.getOwnWs();

    invariant(
      !previousRuntime ||
        (socket &&
          previousRuntime.getUserSocket(ctx.user.id) &&
          !previousRuntime.ownsUserSession(ctx.user.id, socket)),
      {
        code: 'BAD_REQUEST',
        message: 'User already in a voice channel'
      }
    );

    await runHook<TBeforeVoiceJoinPayload, never>({
      entries: pluginManager.getHooks('beforeVoiceJoin'),
      payload: {
        channelId: input.channelId,
        userId: ctx.user.id,
        movedByModerator
      }
    });

    const runtime = VoiceRuntime.findById(input.channelId);

    invariant(runtime, {
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Voice runtime not found for this channel'
    });

    const router = runtime.getRouter();

    // a connection may have closed while a plugin hook was running.
    invariant(!socket || socket.userId === ctx.user.id, {
      code: 'UNAUTHORIZED',
      message: 'User not authenticated'
    });

    // hooks can yield. recheck immediately before replacing the old session, then do the
    // replacement without an await so a concurrent join cannot interleave with cleanup.
    const existingRuntime = VoiceRuntime.findRuntimeByUserId(ctx.user.id);
    invariant(
      !existingRuntime ||
        (socket &&
          existingRuntime.getUserSocket(ctx.user.id) &&
          !existingRuntime.ownsUserSession(ctx.user.id, socket)),
      {
        code: 'BAD_REQUEST',
        message: 'User already in a voice channel'
      }
    );
    if (existingRuntime) {
      existingRuntime.removeUser(ctx.user.id);
      ctx.pubsub.publish(ServerEvents.USER_LEAVE_VOICE, {
        channelId: existingRuntime.id,
        userId: ctx.user.id
      });
    }

    runtime.addUser(ctx.user.id, input.state, socket);

    if (movedByModerator) consumeVoiceMoveGrant(ctx.user.id);

    const state = runtime.getUserState(ctx.user.id);

    ctx.currentVoiceChannelId = channel.id;
    ctx.pubsub.publish(ServerEvents.USER_JOIN_VOICE, {
      channelId: input.channelId,
      userId: ctx.user.id,
      state
    });

    logger.info('%s joined voice channel %s', ctx.user.name, channel.name);

    return {
      routerRtpCapabilities: router.rtpCapabilities
    };
  });

export { joinVoiceRoute };
