import { useTheme } from '@/hooks/use-theme';
import { Toaster } from '@sharkord/ui';
import { memo } from 'react';

const ThemedToaster = memo(() => {
  const { theme } = useTheme();
  return <Toaster theme={theme} />;
});

export { ThemedToaster };
