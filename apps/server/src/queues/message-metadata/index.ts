import Queue from 'queue';
import { config } from '../../config';
import { publishMessage } from '../../db/publishers';
import { processMessageMetadata } from './get-message-metadata';

const messageMetadataQueue = new Queue({
  concurrency: 1,
  autostart: true,
  timeout: 10_000
});

messageMetadataQueue.autostart = true;

const enqueueProcessMetadata = (content: string, messageId: number) => {
  if (!config.server.linkPreviewsEnabled || messageMetadataQueue.length >= 32)
    return;
  messageMetadataQueue.push(async (callback) => {
    const updatedMessage = await processMessageMetadata(content, messageId);

    if (updatedMessage) {
      publishMessage(messageId, updatedMessage.channelId, 'update');
    }

    callback?.();
  });
};

export { enqueueProcessMetadata, messageMetadataQueue };
