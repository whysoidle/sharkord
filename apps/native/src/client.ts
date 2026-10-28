import { createTimeline } from 'animejs';
import { animate } from 'motion/mini';
import macStyle from './macos.css' with { type: 'text' };

declare global {
  interface Window {
    __sharkordPlatform?: 'macos' | 'windows';
    __sharkordServerUrl?: string;
    __sharkordNativeReply?: (
      id: number,
      result: NotificationPermission
    ) => void;
    webkit?: {
      messageHandlers?: {
        sharkord?: { postMessage: (value: unknown) => void };
      };
    };
    chrome?: { webview?: { postMessage: (value: unknown) => void } };
  }
}

const server = window.__sharkordServerUrl
  ? new URL(window.__sharkordServerUrl)
  : undefined;
const platform = window.__sharkordPlatform;
const isTrusted =
  window === window.top &&
  !!server &&
  location.origin === server.origin &&
  location.pathname.startsWith(server.pathname);

const start = () => {
  if (!isTrusted || !platform) return;

  const post = (value: object) => {
    if (platform === 'macos') {
      window.webkit?.messageHandlers?.sharkord?.postMessage(value);
    } else {
      window.chrome?.webview?.postMessage(value);
    }
  };

  const tracks = new Set<MediaStreamTrack>();
  const sendCaptureState = () => {
    for (const track of tracks) {
      if (track.readyState === 'ended') tracks.delete(track);
    }
    post({ type: 'capture', active: tracks.size > 0 });
  };
  const media = navigator.mediaDevices;
  const observeStream = (stream: MediaStream) => {
    for (const track of stream.getTracks()) {
      tracks.add(track);
      track.addEventListener('ended', sendCaptureState, { once: true });
      const stop = track.stop.bind(track);
      track.stop = () => {
        stop();
        sendCaptureState();
      };
    }
    sendCaptureState();
    return stream;
  };
  if (media?.getUserMedia) {
    const getUserMedia = media.getUserMedia.bind(media);
    media.getUserMedia = async (constraints) => {
      return observeStream(await getUserMedia(constraints));
    };
  }
  if (media?.getDisplayMedia) {
    const getDisplayMedia = media.getDisplayMedia.bind(media);
    media.getDisplayMedia = async (constraints) => {
      return observeStream(await getDisplayMedia(constraints));
    };
  }
  window.addEventListener('pagehide', () => {
    for (const track of tracks) track.stop();
    post({ type: 'capture', active: false });
  });

  let permission: NotificationPermission = 'default';
  let nextId = 0;
  const pending = new Map<number, (value: NotificationPermission) => void>();
  window.__sharkordNativeReply = (id, result) => {
    if (!['default', 'granted', 'denied'].includes(result)) return;
    permission = result;
    pending.get(id)?.(result);
    pending.delete(id);
  };
  class NativeNotification extends EventTarget {
    static get permission() {
      return permission;
    }
    static requestPermission() {
      return new Promise<NotificationPermission>((resolve) => {
        const id = ++nextId;
        pending.set(id, resolve);
        post({ type: 'requestNotifications', id });
        setTimeout(() => {
          if (!pending.has(id)) return;
          pending.delete(id);
          resolve('default');
        }, 60_000);
      });
    }
    constructor(title: string, options: NotificationOptions = {}) {
      super();
      if (permission === 'granted') {
        post({
          type: 'notify',
          title: String(title).slice(0, 120),
          body: String(options.body ?? '').slice(0, 2000)
        });
      }
    }
    close() {}
  }
  Object.defineProperty(window, 'Notification', {
    configurable: true,
    value: NativeNotification
  });
  post({ type: 'notificationStatus', id: 0 });

  const ready = () => {
    document.documentElement.dataset.sharkordNative = platform;
    const syncAppearance = () => {
      let system = true;
      try {
        const stored = localStorage.getItem('vite-ui-theme');
        system = stored !== 'dark' && stored !== 'light';
      } catch {
        /* browser storage may be disabled */
      }
      post({
        type: 'appearance',
        dark: document.documentElement.classList.contains('dark'),
        system
      });
    };
    new MutationObserver(syncAppearance).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class']
    });
    syncAppearance();
    if (platform !== 'macos') return;

    const style = document.createElement('style');
    style.id = 'sharkord-native-style';
    style.textContent = macStyle;
    document.head.append(style);
    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
    const animated = new WeakSet<Element>();
    const controls = new Set<{ cancel: () => unknown }>();
    const reveal = () => {
      if (reducedMotion.matches) return;
      const cards =
        document.querySelectorAll<HTMLElement>('[data-slot="card"]');
      for (const card of cards) {
        if (animated.has(card)) continue;
        animated.add(card);
        // keep content visible when a background WebView pauses its animation timeline
        const logo = card.querySelector('img');
        if (!logo) continue;
        const sequence = createTimeline();
        sequence.add(logo, {
          translateY: [-5, 0],
          duration: 420,
          ease: 'outCubic'
        });
        controls.add(sequence);
        sequence.then(() => controls.delete(sequence));
      }
    };
    const observer = new MutationObserver(reveal);
    observer.observe(document.body, { childList: true, subtree: true });
    reveal();

    const stopAnimations = () => {
      for (const control of controls) control.cancel();
      controls.clear();
    };
    reducedMotion.addEventListener('change', stopAnimations);
    document.addEventListener('pointerover', (event) => {
      if (reducedMotion.matches || !(event.target instanceof Element)) return;
      const button = event.target.closest<HTMLButtonElement>(
        'button[data-slot="select-trigger"]'
      );
      if (!button || button.contains(event.relatedTarget as Node | null))
        return;
      const gesture = animate(
        button,
        { opacity: [0.75, 1] },
        { duration: 0.2 }
      );
      controls.add(gesture);
      gesture.then(() => controls.delete(gesture));
    });
    window.addEventListener(
      'pagehide',
      () => {
        observer.disconnect();
        stopAnimations();
      },
      { once: true }
    );
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ready, { once: true });
  } else {
    ready();
  }
};

start();
