import { expect, test, type Page } from '@playwright/test';

const state = (page: Page, expression: string) => page.evaluate(e => {
  const s = (window as unknown as { __spk: { sessionStore: { getState(): unknown } } }).__spk.sessionStore.getState();
  return new Function('s', `return ${e}`)(s);
}, expression);
async function open(page: Page) {
  await page.goto('/?open=');
  await expect(page.getByTestId('tier-badge')).toHaveText('full');
}

test('pointer reordering preserves selection and edits, persists, and holds during batch export', async ({ page }) => {
  await open(page);
  const before = await state(page, '({selection:s.selection,picked:s.picked,sidecar:s.sidecar,names:s.frames.map(f=>f.name)})');
  const first = await page.locator('.thumb').nth(0).boundingBox();
  const third = await page.locator('.thumb').nth(2).boundingBox();
  await page.mouse.move(first!.x + first!.width / 2, first!.y + first!.height / 2);
  await page.mouse.down();
  await page.mouse.move(third!.x + third!.width / 2, third!.y + third!.height / 2, { steps: 10 });
  await page.mouse.up();
  const names = [before.names[1], before.names[2], before.names[0], ...before.names.slice(3)];
  expect(await state(page, 's.frames.map(f=>f.name)')).toEqual(names);
  expect(await state(page, '({selection:s.selection,picked:s.picked,sidecar:s.sidecar})')).toEqual({ selection: before.selection, picked: before.picked, sidecar: before.sidecar });
  await expect.poll(() => page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('store:FrameOrder/')).length)).toBe(1);
  await page.reload();
  await expect(page.getByTestId('tier-badge')).toHaveText('full');
  expect(await state(page, 's.frames.map(f=>f.name)')).toEqual(names);
  expect(await state(page, 's.selection.endsWith(s.frames[0].name)')).toBe(true);
  await page.evaluate(() => (window as unknown as { __spk: { sessionStore: { setState(s: object): void } } }).__spk.sessionStore.setState({ batchExporting: true }));
  const a = await page.locator('.thumb').nth(0).boundingBox(), b = await page.locator('.thumb').nth(2).boundingBox();
  await page.mouse.move(a!.x + 30, a!.y + 30); await page.mouse.down();
  await page.mouse.move(b!.x + 30, b!.y + 30, { steps: 8 }); await page.mouse.up();
  expect(await state(page, 's.frames.map(f=>f.name)')).toEqual(names);
});

test('Ctrl horizon drag commits once, survives reload, supports undo and cancels with Escape', async ({ page }) => {
  await open(page);
  await page.getByTestId('crop-tool').click();
  const box = (await page.getByTestId('canvas').boundingBox())!;
  const x = box.x + box.width * .3, y = box.y + box.height * .4;
  await page.keyboard.down('Control');
  await page.mouse.move(x, y); await page.mouse.down();
  await page.mouse.move(x + 180, y + 36, { steps: 6 });
  await expect(page.getByTestId('straighten-line')).toBeVisible();
  expect(await state(page, 's.sidecar.geometry.angle')).toBe(0);
  await page.mouse.up(); await page.keyboard.up('Control');
  await expect(page.getByTestId('straighten-line')).toHaveCount(0);
  expect(await state(page, 's.sidecar.geometry.angle')).toBeCloseTo(Math.atan2(36, 180) * 180 / Math.PI, 4);
  const geometry = await state(page, 's.sidecar.geometry');
  await page.keyboard.press('Control+z');
  await expect.poll(() => state(page, 's.sidecar.geometry.angle')).toBe(0);
  await page.keyboard.press('Control+y');
  expect(await state(page, 's.sidecar.geometry')).toEqual(geometry);
  await page.keyboard.down('Control'); await page.mouse.move(x, y); await page.mouse.down();
  await page.mouse.move(x + 100, y - 50);
  await page.keyboard.press('Escape'); await page.mouse.up(); await page.keyboard.up('Control');
  expect(await state(page, 's.sidecar.geometry')).toEqual(geometry);
  await expect(page.getByTestId('straighten-line')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => Object.keys(localStorage).some(k => k.startsWith('sidecar:')))).toBe(true);
  await page.reload(); await expect(page.getByTestId('tier-badge')).toHaveText('full');
  expect(await state(page, 's.sidecar.geometry')).toEqual(geometry);
});
