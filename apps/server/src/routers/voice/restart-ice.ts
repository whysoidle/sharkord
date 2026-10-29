import { z } from 'zod';
import { config } from '../../config';
import { getCurrentVoiceRuntime } from '../../helpers/get-current-voice-runtime';
import { invariant } from '../../utils/invariant';
import { protectedProcedure, rateLimitedProcedure } from '../../utils/trpc';

const restartIceRoute = rateLimitedProcedure(protectedProcedure, {
  ...config.rateLimiters.voiceTransport,
  logLabel: 'restartIce'
})
  .input(
    z.object({
      direction: z.enum(['send', 'recv']),
      transportId: z.string().min(1).max(128)
    })
  )
  .mutation(async ({ ctx, input }) => {
    const { runtime } = await getCurrentVoiceRuntime(ctx);
    const transport =
      input.direction === 'send'
        ? runtime.getProducerTransport(ctx.user.id)
        : runtime.getConsumerTransport(ctx.user.id);
    invariant(
      transport && !transport.closed && transport.id === input.transportId,
      {
        code: 'NOT_FOUND',
        message: 'Voice transport not found'
      }
    );
    const iceParameters = await transport.restartIce();
    await getCurrentVoiceRuntime(ctx);
    return { iceParameters };
  });

export { restartIceRoute };
