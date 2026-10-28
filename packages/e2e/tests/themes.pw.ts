import { expect, test, type Page } from '@playwright/test';
import { TestId } from '@sharkord/shared';
import { loginAs } from './fixtures';

test.use({ locale: 'en-US' });

const selectTheme = async (page: Page, name: string, inSettings = false) => {
  const controls = page.getByTestId('theme-switcher');
  const control = inSettings ? controls.last() : controls.first();
  await control.click();
  await page.getByRole('option', { name, exact: true }).click();
};

test('system theme follows operating system changes without a reload', async ({
  page
}) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');
  await expect(page.getByTestId('theme-switcher')).toContainText('System');
  await expect(page.locator('html')).toHaveClass('dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveClass('light');
  await expect(page.locator('html')).toHaveCSS('color-scheme', 'light');
});

test('manual selection overrides the system and survives reloads', async ({
  page
}) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/');
  await selectTheme(page, 'Dark');
  await expect(page.locator('html')).toHaveClass('dark');
  await page.emulateMedia({ colorScheme: 'dark' });
  await selectTheme(page, 'Light');
  await expect(page.locator('html')).toHaveClass('light');
  await page.reload();
  await expect(page.locator('html')).toHaveClass('light');
  await expect(page.getByTestId('theme-switcher')).toContainText('Light');
  expect(await page.evaluate(() => localStorage.getItem('vite-ui-theme'))).toBe(
    'light'
  );
  await selectTheme(page, 'System');
  await expect(page.locator('html')).toHaveClass('dark');
});

test('the switcher works with the keyboard', async ({ page }) => {
  await page.goto('/');
  const control = page.getByTestId('theme-switcher');
  await control.focus();
  await control.press('ArrowDown');
  await expect(
    page.getByRole('option', { name: 'System', exact: true })
  ).toBeFocused();
  await page.keyboard.press('End');
  await expect(
    page.getByRole('option', { name: 'Light', exact: true })
  ).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(control).toContainText('Light');
  await expect(page.locator('html')).toHaveClass('light');
});

test('an invalid saved theme falls back to the system preference', async ({
  page
}) => {
  await page.addInitScript(() =>
    localStorage.setItem('vite-ui-theme', 'invalid-theme')
  );
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');
  await expect(page.getByTestId('theme-switcher')).toContainText('System');
  await expect(page.locator('html')).toHaveClass('dark');
});

test('theme selection still works when browser storage is unavailable', async ({
  page
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(globalThis, 'localStorage', {
      get() {
        throw new DOMException('Storage is unavailable', 'SecurityError');
      }
    });
  });
  await page.goto('/');
  await selectTheme(page, 'Dark');
  await expect(page.locator('html')).toHaveClass('dark');
  await selectTheme(page, 'Light');
  await expect(page.locator('html')).toHaveClass('light');
});

test('the switcher fits a small mobile viewport', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto('/');
  await selectTheme(page, 'Light');
  await expect(page.getByTestId('theme-switcher')).toBeInViewport();
  const width = await page.evaluate(() => {
    const browser = globalThis as unknown as {
      document: { documentElement: { scrollWidth: number } };
    };
    return browser.document.documentElement.scrollWidth;
  });
  expect(width).toBeLessThanOrEqual(320);
});

test('theme changes apply to the app and settings without remounting the app', async ({
  page
}) => {
  await page.goto('/');
  await selectTheme(page, 'Light');
  await loginAs(page, 'testowner', 'password123');
  const app = await page.getByTestId(TestId.SERVER_VIEW).elementHandle();
  await selectTheme(page, 'Dark');
  expect(
    await app?.evaluate((element) => {
      const node = element as unknown as { isConnected: boolean };
      return node.isConnected;
    })
  ).toBe(true);
  await expect(page.locator('html')).toHaveClass('dark');
  await page.getByTestId(TestId.USER_SETTINGS_TRIGGER).click();
  await page
    .getByTestId(TestId.SETTINGS_SIDEBAR_ENTRY)
    .filter({ hasText: 'Others' })
    .click();
  await selectTheme(page, 'Light', true);
  await expect(page.locator('html')).toHaveClass('light');
  await expect(page.locator('body .dark')).toHaveCount(0);
});
