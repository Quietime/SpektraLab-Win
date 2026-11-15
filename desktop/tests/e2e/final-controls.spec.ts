import {expect,test}from '@playwright/test';

test('three-way wheels, physical arc sampling and reset use the same colour grade',async({page})=>{
  await page.goto('/?open=');await expect(page.getByTestId('tier-badge')).toHaveText('full');
  await page.getByRole('tab',{name:'Post-Dev',exact:true}).click();
  await page.getByRole('button',{name:'3-Way',exact:true}).click();
  await expect(page.getByTestId('three-way-wheels').getByTestId('color-wheel')).toHaveCount(3);
  await page.getByRole('button',{name:'Master',exact:true}).click();
  const wheel=page.getByTestId('color-wheel');await wheel.scrollIntoViewIfNeeded();
  // The left arc's lower half crosses atan2's -180/180 seam. Its physical
  // bottom is zero saturation, and its midpoint is .5, at any CSS size.
  await wheel.evaluate((svg)=>{svg.style.width='180px';svg.style.height='180px';});
  await wheel.scrollIntoViewIfNeeded();
  const box=(await wheel.boundingBox())!,cx=box.x+box.width/2,cy=box.y+box.height/2;
  const point=(angle:number)=>({x:cx+55*Math.cos(angle*Math.PI/180)*box.width/128,y:cy-55*Math.sin(angle*Math.PI/180)*box.height/128});
  const middle=point(180);await page.mouse.click(middle.x,middle.y);
  const read=()=>page.evaluate(async()=>{const module='/src/state/session.ts';return(await import(/* @vite-ignore */ module)).sessionStore.getState().sidecar.adjustments.colorBalance.master;});
  expect((await read()).saturation).toBeCloseTo(.5,4);
  const lower=point(-115);
  expect(await page.evaluate(p=>document.elementFromPoint(p.x,p.y)?.closest('[data-wheel-part]')?.getAttribute('data-wheel-part'),lower)).toBe('saturation');
  await page.mouse.click(lower.x,lower.y);
  expect((await read()).saturation).toBeCloseTo(0,4);
  await page.mouse.dblclick(cx+box.width*.15,cy-box.height*.1);
  expect(await read()).toEqual({hue:0,saturation:0,luminance:0});
});

test('export grid keeps the library selection, persists its mode and obeys the export lock',async({page})=>{
  await page.goto('/?open=');await expect(page.getByTestId('tier-badge')).toHaveText('full');
  await page.keyboard.press('Control+e');await expect(page.getByTestId('export-page')).toBeVisible();
  await page.getByRole('button',{name:'Grid',exact:true}).click();
  const grid=page.getByTestId('export-grid');await expect(grid.locator('.export-cell')).toHaveCount(8);
  await grid.locator('.export-cell').nth(1).click();
  await grid.locator('.export-cell').nth(2).click({modifiers:['Control']});
  const selection=await page.evaluate(async()=>{const module='/src/state/session.ts';const s=(await import(/* @vite-ignore */ module)).sessionStore.getState();return{path:s.selection,picked:s.picked};});
  expect(selection.path).toContain('DSC_0002');expect(selection.picked).toHaveLength(2);
  await page.reload();await expect(page.getByTestId('tier-badge')).toHaveText('full');await page.keyboard.press('Control+e');
  await expect(page.getByTestId('export-grid')).toBeVisible();
  await page.evaluate(async()=>{const module='/src/state/session.ts';(await import(/* @vite-ignore */ module)).sessionStore.setState({batchExporting:true});});
  await expect(page.getByTestId('export-grid').locator('.export-cell').first()).toBeDisabled();
  await expect(page.getByRole('button',{name:'Viewer',exact:true})).toBeDisabled();
});
