import { isTheme } from '@/helpers/theme';
import { useTheme } from '@/hooks/use-theme';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@sharkord/ui';
import { Monitor, Moon, Sun } from 'lucide-react';
import { memo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';

const THEME_ICONS = { system: Monitor, dark: Moon, light: Sun };

const ThemeSwitcher = memo(() => {
  const { t } = useTranslation('settings');
  const { theme, setTheme } = useTheme();
  const Icon = THEME_ICONS[theme];

  const handleChange = useCallback(
    (value: string) => {
      if (isTheme(value)) setTheme(value);
    },
    [setTheme]
  );

  return (
    <Select value={theme} onValueChange={handleChange}>
      <SelectTrigger
        className="w-40 gap-2"
        aria-label={t('themeLabel')}
        data-testid="theme-switcher"
      >
        <Icon className="size-4 shrink-0" aria-hidden="true" />
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="system">{t('themeSystem')}</SelectItem>
        <SelectItem value="dark">{t('themeDark')}</SelectItem>
        <SelectItem value="light">{t('themeLight')}</SelectItem>
      </SelectContent>
    </Select>
  );
});

export { ThemeSwitcher };
