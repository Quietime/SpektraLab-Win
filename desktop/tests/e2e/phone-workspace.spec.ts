import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true });

test('phone import shows tappable photos before editing and restores the library', async ({ page }) => {
  await page.goto('/?mobile-workspace');
  const importButton = page.locator('.phone-actions button');
  await expect(importButton).toBeEnabled();
  await expect(page.locator('.topbar')).toHaveCount(0);
  await importButton.tap();
  const photos = page.getByTestId('phone-photo');
  await expect(photos).toHaveCount(3);
  const bounds = await photos.first().boundingBox();
  expect(bounds?.height).toBeGreaterThan(48);
  expect(bounds?.width).toBeGreaterThan(100);
  await photos.nth(1).tap();
  await expect(page.locator('.phone-preview canvas')).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).__spk.sessionStore.getState().selection)).toBeTruthy();
  await page.locator('.phone-actions button').first().tap();
  await expect(page.locator('.phone-adjust input')).toHaveCount(3);
  await page.evaluate(() => window.dispatchEvent(new Event('spektralab-mobile-back', { cancelable: true })));
  await expect(page.locator('.phone-adjust')).toHaveCount(0);
  await page.locator('.phone-header button').first().tap();
  await expect(photos).toHaveCount(3);
  await page.reload();
  await expect(photos).toHaveCount(3);
});
