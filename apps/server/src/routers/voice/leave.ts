import { ChannelType, ServerEvents } from '@sharkord/shared';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { unpublishHiddenChannelFromUser } from '../../db/publishers';
import { channels } from '../../db/schema';
import { getCurrentVoiceRuntime } from '../../helpers/get-current-voice-runtime';
import { logger } from '../../logger';
import { VoiceRuntime } from '../../runtimes/voice';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';

const leaveVoiceRoute = protectedProcedure
  .input(z.object({ sessionId: z.uuid() }).optional())
  .mutation(async ({ ctx, input }) => {
    if (input?.sessionId) {
      VoiceRuntime.cancelSessionRecovery(ctx.user.id, input.sessionId);
      const runtime = VoiceRuntime.findRuntimeByUserId(ctx.user.id);
      if (!runtime || runtime.getUserSessionId(ctx.user.id) !== input.sessionId)
        return;
      const channelId = runtime.id;
      runtime.removeUser(ctx.user.id);
      ctx.pubsub.publish(ServerEvents.USER_LEAVE_VOICE, {
        userId: ctx.user.id,
        channelId,
        sessionId: input.sessionId
      });
      await unpublishHiddenChannelFromUser(ctx.user.id, channelId);
      ctx.currentVoiceChannelId = undefined;
      return;
    }
    const { runtime, channelId } = await getCurrentVoiceRuntime(ctx);

    const channel = await db
      .select({
        id: channels.id,
        name: channels.name,
        type: channels.type
      })
      .from(channels)
      .where(eq(channels.id, channelId))
      .get();

    invariant(channel, {
      code: 'NOT_FOUND',
      message: 'Channel not found'
    });

    invariant(channel.type === ChannelType.VOICE, {
      code: 'BAD_REQUEST',
      message: 'Channel is not a voice channel'
    });

    const userInChannel = runtime.getUser(ctx.user.id);

    invariant(userInChannel, {
      code: 'BAD_REQUEST',
      message: 'User not in voice channel'
    });

    runtime.removeUser(ctx.user.id);

    ctx.pubsub.publish(ServerEvents.USER_LEAVE_VOICE, {
      channelId,
      userId: ctx.user.id
    });

    await unpublishHiddenChannelFromUser(ctx.user.id, channel.id);

    ctx.currentVoiceChannelId = undefined;

    logger.info('%s left voice channel %s', ctx.user.name, channel.name);
  });

export { leaveVoiceRoute };
