import { getLocalStorageItem, LocalStorageKey } from './storage';

type TTheme = 'system' | 'dark' | 'light';

const isTheme = (value: unknown): value is TTheme => {
  return value === 'system' || value === 'dark' || value === 'light';
};

const getStoredTheme = (
  storageKey = LocalStorageKey.VITE_UI_THEME,
  fallback: TTheme = 'system'
): TTheme => {
  const stored = getLocalStorageItem(storageKey);
  return isTheme(stored) ? stored : fallback;
};

const applyTheme = (theme: TTheme) => {
  let resolved = theme;

  if (resolved === 'system') {
    resolved = window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light';
  }

  const root = document.documentElement;
  root.classList.remove('light', 'dark');
  root.classList.add(resolved);
  root.style.colorScheme = resolved;
};

export { applyTheme, getStoredTheme, isTheme, type TTheme };
