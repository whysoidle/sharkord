import { ThemeContext } from '@/components/theme-provider/context';
import { useContext } from 'react';

const useTheme = () => {
  const context = useContext(ThemeContext);

  if (!context) throw new Error('Theme controls require ThemeProvider');

  return context;
};

export { useTheme };
