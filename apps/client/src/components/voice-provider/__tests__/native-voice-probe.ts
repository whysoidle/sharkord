import { Device, detectDevice } from 'mediasoup-client';

// bundled only for the native runtime test, never imported by the application.
const probe = async () => {
  try {
    const device = new Device();
    await device.load({
      routerRtpCapabilities: {
        codecs: [
          {
            kind: 'audio',
            mimeType: 'audio/opus',
            preferredPayloadType: 100,
            clockRate: 48000,
            channels: 2,
            parameters: {},
            rtcpFeedback: []
          }
        ],
        headerExtensions: []
      }
    });
    const canProduceAudio = device.canProduce('audio');
    const codecs = device.rtpCapabilities.codecs?.map(
      ({ mimeType }) => mimeType
    );
    return {
      passed: canProduceAudio && codecs?.includes('audio/opus'),
      userAgent: navigator.userAgent,
      handler: detectDevice(),
      canProduceAudio,
      codecs
    };
  } catch (error) {
    return {
      passed: false,
      userAgent: navigator.userAgent,
      error: String(error)
    };
  }
};

probe().then((result) =>
  Object.assign(window, { __sharkordVoiceResult: result })
);
