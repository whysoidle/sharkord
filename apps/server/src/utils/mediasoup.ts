import { getErrorMessage } from '@sharkord/shared';
import mediasoup from 'mediasoup';
import { config, SERVER_PUBLIC_IP } from '../config.js';
import { MEDIASOUP_BINARY_PATH } from '../helpers/paths.js';
import { logger } from '../logger.js';
import {
  patchSpawnForMediasoup,
  restoreSpawn
} from './bun-mediasoup-workaround.js';
import { IS_PRODUCTION } from './env.js';

let mediaSoupWorker: mediasoup.types.Worker<mediasoup.types.AppData>;
let webRtcServer: mediasoup.types.WebRtcServer<mediasoup.types.AppData>;
let webRtcServerListenInfo: { ip: string; announcedAddress?: string };

const resolveWebRtcListenInfo = (
  production: boolean,
  announcedAddress: string,
  publicIp?: string
): { ip: string; announcedAddress?: string } => {
  if (production || (announcedAddress && announcedAddress !== '127.0.0.1')) {
    return { ip: '0.0.0.0', announcedAddress: announcedAddress || publicIp };
  }
  return { ip: '127.0.0.1' };
};

const loadMediasoup = async () => {
  const port = +config.webRtc.port;

  const workerConfig: mediasoup.types.WorkerSettings = {
    logLevel: config.server.debug ? 'debug' : 'warn',
    disableLiburing: true,
    workerBin: MEDIASOUP_BINARY_PATH
  };

  logger.debug(
    `Loading mediasoup worker with config ${JSON.stringify(workerConfig, null, 2)}`
  );

  // On Bun/Windows, extra stdio pipes (fd 3/4) are broken (oven-sh/bun#11044).
  // This patches child_process.spawn to use Bun.spawn() for the mediasoup
  // worker, which correctly supports extra stdio pipe handles.
  try {
    patchSpawnForMediasoup();
    mediaSoupWorker = await mediasoup.createWorker(workerConfig);
  } catch (error) {
    logger.error('Failed to load mediasoup worker: %s', getErrorMessage(error));
    throw error;
  } finally {
    restoreSpawn();
  }

  mediaSoupWorker.on('died', (error) => {
    logger.error('Mediasoup worker died: %s', getErrorMessage(error));

    setTimeout(() => process.exit(1), 2000);
  });

  logger.debug('Mediasoup worker loaded');

  const listenInfo = resolveWebRtcListenInfo(
    IS_PRODUCTION,
    config.webRtc.announcedAddress,
    SERVER_PUBLIC_IP
  );
  webRtcServer = await mediaSoupWorker.createWebRtcServer({
    listenInfos: [
      { protocol: 'udp', ...listenInfo, port },
      { protocol: 'tcp', ...listenInfo, port }
    ]
  });
  webRtcServerListenInfo = listenInfo;
  logger.debug(
    `WebRtcServer created on ${listenInfo.ip}:${port} with announcedAddress ${listenInfo.announcedAddress ?? 'none'}`
  );
};

export {
  loadMediasoup,
  mediaSoupWorker,
  resolveWebRtcListenInfo,
  webRtcServer,
  webRtcServerListenInfo
};
