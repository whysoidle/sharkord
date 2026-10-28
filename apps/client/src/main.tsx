import { i18nReady } from '@/i18n';
import 'prosemirror-view/style/prosemirror.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Provider } from 'react-redux';
import { DebugInfo } from './components/debug-info/index.tsx';
import { StoreDebug } from './components/debug/store-debug.tsx';
import { DevicesProvider } from './components/devices-provider/index.tsx';
import { DialogsProvider } from './components/dialogs/index.tsx';
import { GlobalErrorBoundary } from './components/error-boundary/global-error-boundary.tsx';
import { HotkeyBridgeController } from './components/hotkey-bridge-controller/index.tsx';
import { KeyboardController } from './components/keyboard-controller/index.tsx';
import { PluginsController } from './components/plugins-controller/index.tsx';
import { AutoLoginController } from './components/routing/auto-login-controller.tsx';
import { Routing } from './components/routing/index.tsx';
import { ServerScreensProvider } from './components/server-screens/index.tsx';
import { ThemeProvider } from './components/theme-provider/index.tsx';
import { ThemedToaster } from './components/theme-provider/themed-toaster.tsx';
import { exposePluginStore } from './features/server/plugins/plugin-store.ts';
import { store } from './features/store.ts';
import { exposeLibs, exposeReact } from './helpers/exposes.ts';
import { LocalStorageKey } from './helpers/storage.ts';
import { applyTheme, getStoredTheme } from './helpers/theme.ts';
import './index.css';

exposeReact();
exposeLibs();
exposePluginStore();
applyTheme(getStoredTheme());

await i18nReady;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider
      defaultTheme="system"
      storageKey={LocalStorageKey.VITE_UI_THEME}
    >
      <GlobalErrorBoundary>
        <DebugInfo />
        <ThemedToaster />
        <Provider store={store}>
          <StoreDebug />
          <KeyboardController />
          <HotkeyBridgeController />
          <DevicesProvider>
            <PluginsController />
            <DialogsProvider />
            <ServerScreensProvider />
            <AutoLoginController />
            <Routing />
          </DevicesProvider>
        </Provider>
      </GlobalErrorBoundary>
    </ThemeProvider>
  </StrictMode>
);
