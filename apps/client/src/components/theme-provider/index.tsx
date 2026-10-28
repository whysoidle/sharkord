import { LocalStorageKey, setLocalStorageItem } from '@/helpers/storage';
import { applyTheme, getStoredTheme, type TTheme } from '@/helpers/theme';
import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode
} from 'react';
import { ThemeContext } from './context';

type TThemeProviderProps = {
  children: ReactNode;
  defaultTheme?: TTheme;
  storageKey?: LocalStorageKey;
};

const ThemeProvider = ({
  children,
  defaultTheme = 'system',
  storageKey = LocalStorageKey.VITE_UI_THEME
}: TThemeProviderProps) => {
  const [theme, setCurrentTheme] = useState<TTheme>(() =>
    getStoredTheme(storageKey, defaultTheme)
  );

  useLayoutEffect(() => {
    applyTheme(theme);
    if (theme !== 'system') return;

    const preference = window.matchMedia('(prefers-color-scheme: dark)');
    const update = () => applyTheme('system');
    preference.addEventListener('change', update);

    return () => preference.removeEventListener('change', update);
  }, [theme]);

  const setTheme = useCallback(
    (value: TTheme) => {
      setLocalStorageItem(storageKey, value);
      setCurrentTheme(value);
    },
    [storageKey]
  );

  const value = useMemo(() => ({ theme, setTheme }), [theme, setTheme]);

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
};

export { ThemeProvider };
