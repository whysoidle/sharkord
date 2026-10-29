import { ChannelPermission, ServerEvents, StreamKind } from '@sharkord/shared';
import { channelUserCan } from '../db/queries/channels';
import { VoiceRuntime } from '../runtimes/voice';
import { pubsub } from '../utils/pubsub';

const enforceVoiceMediaPermissions = async (userId: number) => {
  const runtime = VoiceRuntime.findRuntimeByUserId(userId);
  if (!runtime) return;
  const [canUseWebcam, canShareScreen] = await Promise.all([
    channelUserCan(runtime.id, userId, ChannelPermission.WEBCAM),
    channelUserCan(runtime.id, userId, ChannelPermission.SHARE_SCREEN)
  ]);
  const user = runtime.getUser(userId);
  if (!user) return;

  const revokedKinds: StreamKind[] = [];
  if (!canUseWebcam) revokedKinds.push(StreamKind.VIDEO);
  if (!canShareScreen)
    revokedKinds.push(StreamKind.SCREEN, StreamKind.SCREEN_AUDIO);
  let changed = false;

  for (const kind of revokedKinds) {
    if (!runtime.getProducer(kind, userId)) continue;
    runtime.removeProducer(userId, kind);
    pubsub.publishForChannel(runtime.id, ServerEvents.VOICE_PRODUCER_CLOSED, {
      channelId: runtime.id,
      remoteId: userId,
      kind
    });
    changed = true;
  }

  if (
    (!canUseWebcam && user.state.webcamEnabled) ||
    (!canShareScreen && user.state.sharingScreen)
  )
    changed = true;
  if (!changed) return;
  runtime.updateUserState(userId, {
    webcamEnabled: canUseWebcam && user.state.webcamEnabled,
    sharingScreen: canShareScreen && user.state.sharingScreen
  });
  pubsub.publish(ServerEvents.USER_VOICE_STATE_UPDATE, {
    channelId: runtime.id,
    userId,
    state: runtime.getUserState(userId)
  });
};

export { enforceVoiceMediaPermissions };
