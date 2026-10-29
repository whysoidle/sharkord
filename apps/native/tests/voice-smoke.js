// this script runs only against the disposable loopback e2e server.
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const { getTRPCClient } = await import('/src/lib/trpc.ts');
const { collectVoiceDebugSnapshot, getVoiceDebugEvents } =
  await import('/src/helpers/voice-debug.ts');
const channelName = 'Native voice smoke';
const bytesReceived = (snapshot) =>
  snapshot.consumers
    .flatMap(({ stats }) => stats)
    .filter(({ type }) => type === 'inbound-rtp')
    .reduce((sum, stat) => sum + (stat.bytesReceived ?? 0), 0);

if (phase === 'setup') {
  const NativePeer = window.RTCPeerConnection;
  window.__nativePeerEvents = [];
  window.RTCPeerConnection = class extends NativePeer {
    constructor(...args) {
      super(...args);
      for (const name of [
        'connectionstatechange',
        'iceconnectionstatechange',
        'icegatheringstatechange',
        'icecandidateerror'
      ]) {
        this.addEventListener(name, (event) =>
          window.__nativePeerEvents.push({
            event: name,
            connection: this.connectionState,
            ice: this.iceConnectionState,
            gathering: this.iceGatheringState,
            error: event.errorText
          })
        );
      }
    }
  };
  const capture = async () => {
    const context = new AudioContext({ sampleRate: 48000 });
    const oscillator = context.createOscillator();
    const destination = context.createMediaStreamDestination();
    oscillator.frequency.value = 440;
    oscillator.connect(destination);
    oscillator.start();
    context.resume();
    destination.stream.getTracks().forEach((track) => {
      track.addEventListener(
        'ended',
        () => {
          oscillator.stop();
          context.close();
        },
        { once: true }
      );
    });
    return destination.stream;
  };
  for (const target of [
    Object.getPrototypeOf(navigator.mediaDevices),
    navigator.mediaDevices
  ]) {
    Object.defineProperty(target, 'getUserMedia', {
      configurable: true,
      value: capture
    });
  }
  const response = await fetch('http://localhost:4991/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identity, password: 'password123' })
  });
  if (!response.ok) throw new Error('Local fixture login failed');
  const { token } = await response.json();
  const { setSessionStorageItem, SessionStorageKey } =
    await import('/src/helpers/storage.ts');
  const { connect } = await import('/src/features/server/actions.ts');
  setSessionStorageItem(SessionStorageKey.TOKEN, token);
  await connect();
  return JSON.stringify({ ready: true });
}
const trpc = getTRPCClient();
if (phase === 'create') {
  const id = await trpc.channels.add.mutate({
    name: channelName,
    type: 'VOICE',
    categoryId: 2
  });
  window.__nativeVoiceChannel = id;
}
if (phase === 'join') {
  let item;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    item = [...document.querySelectorAll('[data-testid="channel-item"]')].find(
      (element) => element.textContent.includes(channelName)
    );
    if (item) break;
    await delay(100);
  }
  if (!item) throw new Error('Local voice channel did not appear');
  item.click();
}
if (phase === 'check') {
  let previousBytes;
  let snapshot;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    await delay(200);
    snapshot = await collectVoiceDebugSnapshot();
    const bytes = bytesReceived(snapshot);
    if (
      snapshot.transports.length === 2 &&
      snapshot.transports.every(
        (transport) => transport.connectionState === 'connected'
      ) &&
      snapshot.producers.length === 1 &&
      snapshot.consumers.length === 1
    ) {
      previousBytes ??= bytes;
      if (bytes > previousBytes + 100)
        return JSON.stringify({
          passed: true,
          userAgent: navigator.userAgent,
          bytesReceived: bytes
        });
    }
    if (
      getVoiceDebugEvents().some(
        (event) => event.message === 'session: init failed'
      )
    )
      break;
  }
  return JSON.stringify({
    passed: false,
    snapshot,
    events: getVoiceDebugEvents(),
    peerEvents: window.__nativePeerEvents
  });
}
if (phase === 'cleanup') {
  const { leaveVoice } = await import('/src/features/server/voice/actions.ts');
  await leaveVoice({ reason: 'user_disconnect_button' });
  if (window.__nativeVoiceChannel)
    await trpc.channels.delete.mutate({
      channelId: window.__nativeVoiceChannel
    });
}
return JSON.stringify({ ready: true });
