import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true });

test('phone import shows tappable photos before editing and restores the library', async ({ page }) => {
  await page.goto('/?mobile-workspace');
  const importButton = page.getByRole('button', { name: 'Import photos', exact: true });
  await expect(importButton).toBeEnabled();
  await expect(page.locator('.topbar')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Import photos to get started' })).toBeVisible();
  await importButton.tap();
  const photos = page.getByTestId('phone-photo');
  await expect(photos).toHaveCount(3);
  const bounds = await photos.first().boundingBox();
  expect(bounds?.height).toBeGreaterThan(48);
  expect(bounds?.width).toBeGreaterThan(100);
  await photos.nth(1).tap();
  await expect(page.locator('.phone-preview canvas')).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __spk: { sessionStore: { getState(): { selection: unknown } } } }).__spk.sessionStore.getState().selection)).toBeTruthy();
  await page.locator('.phone-actions button').first().tap();
  await expect(page.locator('.phone-tone-field.active input')).toBeVisible();
  await page.locator('.phone-adjust input').first().fill('0.5');
  await expect(page.locator('.phone-adjust output').first()).toHaveText('0.50');
  await page.evaluate(() => window.dispatchEvent(new Event('spektralab-mobile-back', { cancelable: true })));
  await expect(page.locator('.phone-adjust')).toHaveCount(0);
  await page.getByRole('button', { name: 'Film', exact: true }).tap();
  await expect(page.getByLabel('Film stock')).toBeVisible();
  await page.getByRole('button', { name: 'Export', exact: true }).tap();
  await expect(page.getByRole('group', { name: 'Export format' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save to folder' })).toBeVisible();
  await page.getByRole('button', { name: '‹ Edit' }).tap();
  await page.locator('.phone-header button').first().tap();
  await expect(photos).toHaveCount(3);
  await page.reload();
  await expect(photos).toHaveCount(3);
});

test('new imports appear first when the existing library spans pages', async ({ page }) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem('spektralab-phone-library-v1')) {
      const paths = Array.from({ length: 25 }, (_, i) => `/older/roll-${i}.jpg`);
      localStorage.setItem('spektralab-phone-library-v1', JSON.stringify(paths));
    }
  });
  await page.goto('/?mobile-workspace');
  const photos = page.getByTestId('phone-photo');
  await expect(photos).toHaveCount(24);
  await expect(photos.first()).toHaveAccessibleName('roll-0.jpg');
  await page.getByRole('button', { name: 'Import photos', exact: true }).tap();
  await expect(photos.first()).toHaveAccessibleName('DSC_0001.NEF');
  await expect(photos.nth(3)).toHaveAccessibleName('roll-0.jpg');
  await page.getByRole('button', { name: 'Next page' }).tap();
  await expect(photos).toHaveCount(4);
});

test('film cards choose a stock by tap or keyboard and keep paper compatible', async ({ page }) => {
  await page.goto('/?mobile-workspace');
  await page.getByRole('button', { name: 'Import photos', exact: true }).tap();
  await page.getByTestId('phone-photo').first().tap();
  await expect(page.locator('.phone-preview canvas')).toBeVisible();
  await page.getByRole('button', { name: 'Film', exact: true }).tap();
  const films = page.getByRole('radiogroup', { name: 'Film stock' });
  await expect(films.getByRole('radio', { checked: true })).toHaveCount(1);
  const card = films.locator('[data-stock="kodak_tri_x_400"]');
  const box = await card.boundingBox();
  expect(box?.height).toBeGreaterThanOrEqual(48);
  await card.tap();
  await expect(card).toHaveAttribute('aria-checked', 'true');
  const params = () => page.evaluate(() => (window as unknown as { __spk: { sessionStore: { getState(): { sidecar: { params: { filmStock: string; printStock: string } } } } } }).__spk.sessionStore.getState().sidecar.params);
  await expect.poll(async () => (await params()).printStock).toBe('ilford_multigrade_iv_rc');
  await card.focus();
  await page.keyboard.press('ArrowLeft');
  await expect.poll(async () => (await params()).filmStock).not.toBe('kodak_tri_x_400');
  await expect(films.getByRole('radio', { checked: true })).toBeFocused();
});
