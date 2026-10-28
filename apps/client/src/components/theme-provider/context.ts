import type { TTheme } from '@/helpers/theme';
import { createContext } from 'react';

type TThemeContext = {
  theme: TTheme;
  setTheme: (theme: TTheme) => void;
};

const ThemeContext = createContext<TThemeContext | null>(null);

export { ThemeContext };
