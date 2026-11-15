import {expect,test,type Browser,type Page} from '@playwright/test';

const modelModule='/src/lighttable/model.ts';
const platformModule='/src/platform/index.ts';
const settingsModule='/src/state/settings.ts';
const sessionModule='/src/state/session.ts';

async function enterTable(page:Page):Promise<void>{
  await page.goto('/?open=');
  await expect(page.getByTestId('tier-badge')).toHaveText('full');
  await page.getByTestId('lighttable-open').click();
  await expect(page.getByTestId('lighttable')).toBeVisible();
}

test('light table places photos, changes lamp, returns them and restores layout',async({page})=>{
  await enterTable(page);
  const seeded=await page.evaluate(async({modelModule,platformModule})=>{
    const model=await import(/* @vite-ignore */ modelModule);
    const platform=await import(/* @vite-ignore */ platformModule);
    const photos=await platform.platform().listImages('/mock/Roll 01');
    await model.openTable(photos);
    const source=photos[0]!.path;
    model.changeTray((t:{photos:unknown[];cards:unknown[]})=>model.placeCard(t,source));
    await model.saveTable();
    return {source,photos:photos.length};
  },{modelModule,platformModule});
  await expect(page.locator('[data-testid="lt-photo-card"]')).toHaveCount(1);
  const lamp=page.getByTestId('lt-lamp');
  const initial=await lamp.getAttribute('aria-pressed');
  await lamp.click();
  await expect(lamp).not.toHaveAttribute('aria-pressed',initial??'true');
  await page.locator('[data-testid="lt-photo-card"]').click();
  await page.getByTestId('lt-remove-card').click();
  await expect(page.locator('[data-testid="lt-photo-card"]')).toHaveCount(0);
  await page.evaluate(async(modelModule)=>{const m=await import(/* @vite-ignore */ modelModule);await m.saveTable();},modelModule);
  const sourceExists=await page.evaluate(async({platformModule,path})=>{
    const p=await import(/* @vite-ignore */ platformModule);return p.platform().pathExists(path);
  },{platformModule,path:seeded.source});
  expect(sourceExists).toBe(true);
  await page.reload();
  await expect(page.getByTestId('tier-badge')).toHaveText('full');
  await page.getByTestId('lighttable-open').click();
  await expect(page.getByTestId('lighttable')).toBeVisible();
  const restored=await page.evaluate(async(modelModule)=>{
    const model=await import(/* @vite-ignore */ modelModule);await model.loadTable();
    const d=model.tableStore.getState().document;
    return {photos:d.trays.reduce((n:number,t:{photos:unknown[]})=>n+t.photos.length,0),cards:d.trays.reduce((n:number,t:{cards:unknown[]})=>n+t.cards.length,0),lamp:d.lamp};
  },modelModule);
  expect(restored).toEqual({photos:seeded.photos,cards:0,lamp:initial==='false'});
});

test('desktop card movement, sleeves and slideshow leave the table document consistent',async({page})=>{
  await enterTable(page);
  await page.evaluate(async({modelModule,platformModule})=>{
    const model=await import(/* @vite-ignore */ modelModule),p=await import(/* @vite-ignore */ platformModule);
    const photos=(await p.platform().listImages('/mock/Roll 01')).slice(0,4);
    model.changeTable((d:{trays:{photos:unknown[];cards:unknown[]}[]})=>({...d,trays:d.trays.map(t=>({...t,photos:[],cards:[]}))}));
    await model.saveTable();
    await model.openTable(photos);
    model.changeTray((t:{photos:typeof photos;cards:unknown[]})=>({...t,cards:model.tiledCards(t.photos,1000,600)}));
    await model.saveTable();
  },{modelModule,platformModule});
  const cards=page.locator('[data-testid="lt-photo-card"]');
  await expect(cards).toHaveCount(4);
  const initialPosition=await page.evaluate(async(modelModule)=>{
    const model=await import(/* @vite-ignore */ modelModule),d=model.tableStore.getState().document;
    const tray=d.trays.find((value:{id:string})=>value.id===d.active)!;
    return {x:tray.cards[0]!.x,y:tray.cards[0]!.y};
  },modelModule);
  const start=await cards.first().boundingBox();
  const stage=page.getByTestId('lighttable-stage');
  const stageBox=await stage.boundingBox();
  expect(start).not.toBeNull();expect(stageBox).not.toBeNull();
  await cards.first().dragTo(stage,{targetPosition:{x:stageBox!.width*.75,y:stageBox!.height*.5}});
  const sleeves=page.getByTestId('lt-sleeves');
  const before=await sleeves.getAttribute('aria-pressed');
  await sleeves.click();
  await expect(sleeves).not.toHaveAttribute('aria-pressed',before??'false');
  const show=page.getByTestId('lt-slideshow');
  await show.click();
  await expect(page.locator('[data-testid="lighttable"]')).toHaveAttribute('data-slideshow','true');
  await expect(page.getByRole('dialog',{name:'Slideshow'})).toBeVisible();
  await page.getByRole('dialog',{name:'Slideshow'}).getByRole('button',{name:'Close'}).click();
  await expect(page.locator('[data-testid="lighttable"]')).not.toHaveAttribute('data-slideshow');
  const state=await page.evaluate(async(modelModule)=>{
    const model=await import(/* @vite-ignore */ modelModule);await model.saveTable();
    const d=model.tableStore.getState().document,t=d.trays.find((v:{id:string})=>v.id===d.active)!;
    return {photos:t.photos.length,cards:t.cards.length,sleeves:d.sleeves,
      firstCard:{x:t.cards[0]!.x,y:t.cards[0]!.y},
      next:model.nextSlide(t.photos.map((p:{path:string})=>p.path),t.photos[0]!.path,1)};
  },modelModule);
  expect(state.photos).toBe(4);expect(state.cards).toBe(4);expect(state.sleeves).toBe(before!=='true');
  expect(Math.hypot(state.firstCard.x-initialPosition.x,state.firstCard.y-initialPosition.y)).toBeGreaterThan(.02);
  expect(state.next).toBeTruthy();
});

test('selected light-table card matches the cropped, turned, flipped and graded canvas pixels',async({page})=>{
  test.setTimeout(120_000);
  await enterTable(page);
  const paths=await page.evaluate(async({modelModule,platformModule,sessionModule})=>{
    const model=await import(/* @vite-ignore */ modelModule),p=await import(/* @vite-ignore */ platformModule);
    const photos=await p.platform().listImages('/mock/Roll 01');
    await model.openTable(photos);
    const sessionModuleValue=await import(/* @vite-ignore */ sessionModule);
    const path=sessionModuleValue.sessionStore.getState().selection as string;
    if(!photos.some((photo:{path:string})=>photo.path===path))throw new Error('selected editor source is not in the current roll');
    model.changeTray((tray:{photos:typeof photos;cards:unknown[]})=>model.placeCard(tray,path));
    await model.saveTable();
    return {path};
  },{modelModule,platformModule,sessionModule});

  await expect.poll(()=>page.evaluate(async(outputModule)=>!!(await import(/* @vite-ignore */ outputModule)).canvasOutput(),
    '/src/canvas/output.ts'),{timeout:15_000}).toBe(true);
  const baseline=await page.evaluate(async(outputModule)=>{
    const output=await import(/* @vite-ignore */ outputModule);
    const image=output.canvasOutput() as {width:number;height:number;data:Uint8Array}|null;
    if(!image)throw new Error('Canvas has not published output pixels');
    const at=(x:number,y:number)=>{const i=(Math.round(y*(image.height-1))*image.width+Math.round(x*(image.width-1)))*4;return [image.data[i]!,image.data[i+1]!,image.data[i+2]!];};
    return {width:image.width,height:image.height,samples:[[.2,.2],[.5,.5],[.8,.8]].map(([x,y])=>at(x!,y!))};
  },'/src/canvas/output.ts');

  await page.evaluate(async({sessionModule,path})=>{
    const session=await import(/* @vite-ignore */ sessionModule);
    const current=session.sessionStore.getState();
    if(current.selection!==path)throw new Error('table card does not match the editor-owned source');
    session.setGeometry((g:{crop:{x:number;y:number;width:number;height:number};angle:number;quarterTurns:number;flipH:boolean;flipV:boolean;aspect:string;intendedSize:unknown;lockedRatio:unknown})=>({
      ...g,crop:{x:.2,y:.15,width:.5,height:.5},angle:0,quarterTurns:1,flipH:true,flipV:false,aspect:'free',intendedSize:null,lockedRatio:null,
    }));
  },{sessionModule,path:paths.path});

  const outputPath='/src/canvas/output.ts',geometryModule='/src/shared/geometry.ts';
  await expect.poll(()=>page.evaluate(async({outputPath,geometryModule,path})=>{
    const outputModule=await import(/* @vite-ignore */ outputPath),geometry=await import(/* @vite-ignore */ geometryModule);
    const output=outputModule.canvasOutput() as {width:number;height:number;data:Uint8Array}|null;
    const state=(window as unknown as {__spk:{sessionStore:{getState():{selection:string|null;nativeSize:{width:number;height:number}|null;sidecar:{geometry:{crop:{x:number;y:number;width:number;height:number};quarterTurns:number;flipH:boolean};adjustments:{exposure:number;contrast:number;saturation:number}}}}}}).__spk.sessionStore.getState();
    const card=Array.from(document.querySelectorAll<HTMLElement>('[data-testid="lt-photo-card"]')).find((node)=>node.dataset.path===path);
    const image=card?.querySelector<HTMLImageElement>('img.lt-photo-image');
    const expected=state.nativeSize?geometry.outputSize(state.sidecar.geometry,state.nativeSize):null;
    const expectedAspect=expected?expected.width/expected.height:0;
    return !!output&&!!image&&image.complete&&image.naturalWidth>0&&state.selection===path&&!!expected&&
      image.naturalWidth===output.width&&image.naturalHeight===output.height&&
      Math.abs(output.width/output.height-expectedAspect)<.005&&
      state.sidecar.geometry.quarterTurns===1&&state.sidecar.geometry.flipH;
  },{outputPath,geometryModule,path:paths.path}),{timeout:45_000,intervals:[100]}).toBe(true);

  const geometrySnapshot=await page.evaluate(async({outputPath,path})=>{
    const module=await import(/* @vite-ignore */ outputPath),output=module.canvasOutput() as {width:number;height:number;data:Uint8Array}|null;
    const card=Array.from(document.querySelectorAll<HTMLElement>('[data-testid="lt-photo-card"]')).find((node)=>node.dataset.path===path);
    const image=card?.querySelector<HTMLImageElement>('img.lt-photo-image');
    if(!output||!image||!image.complete)throw new Error('geometry-only canvas preview has not landed');
    const center=(Math.floor(output.height/2)*output.width+Math.floor(output.width/2))*4;
    return {center:[output.data[center]!,output.data[center+1]!,output.data[center+2]!],imageUrl:image.src};
  },{outputPath,path:paths.path});
  await page.evaluate(async(sessionModule)=>{
    const session=await import(/* @vite-ignore */ sessionModule);
    session.setAdjustments((a:{exposure:number;contrast:number;saturation:number})=>({...a,exposure:.75,contrast:.2,saturation:.25}));
  },sessionModule);
  await expect.poll(()=>page.evaluate(async({outputPath,path,geometrySnapshot})=>{
    const module=await import(/* @vite-ignore */ outputPath),output=module.canvasOutput() as {width:number;height:number;data:Uint8Array}|null;
    const card=Array.from(document.querySelectorAll<HTMLElement>('[data-testid="lt-photo-card"]')).find((node)=>node.dataset.path===path);
    const image=card?.querySelector<HTMLImageElement>('img.lt-photo-image');
    if(!output||!image||!image.complete||image.src===geometrySnapshot.imageUrl||image.naturalWidth!==output.width||image.naturalHeight!==output.height)return false;
    const center=(Math.floor(output.height/2)*output.width+Math.floor(output.width/2))*4;
    return JSON.stringify([output.data[center],output.data[center+1],output.data[center+2]])!==JSON.stringify(geometrySnapshot.center);
  },{outputPath,path:paths.path,geometrySnapshot}),{timeout:45_000,intervals:[100]}).toBe(true);

  const comparison=await page.evaluate(async({outputPath,path,baseline})=>{
    const outputModule=await import(/* @vite-ignore */ outputPath);
    const output=outputModule.canvasOutput() as {width:number;height:number;data:Uint8Array}|null;
    const card=Array.from(document.querySelectorAll<HTMLElement>('[data-testid="lt-photo-card"]')).find((node)=>node.dataset.path===path);
    const image=card?.querySelector<HTMLImageElement>('img.lt-photo-image');
    if(!output||!image||!image.complete)throw new Error('selected CanvasPreview has no decoded image');
    const canvasLabel=card?.querySelector<HTMLElement>('.lt-source-label.current')?.textContent??'';
    const surface=document.createElement('canvas');surface.width=image.naturalWidth;surface.height=image.naturalHeight;
    const ctx=surface.getContext('2d',{willReadFrequently:true});if(!ctx)throw new Error('2D canvas unavailable for pixel sampling');
    ctx.drawImage(image,0,0);const decoded=ctx.getImageData(0,0,surface.width,surface.height).data;
    let sum=0,count=0,maxMean=0;
    for(const y of [.12,.24,.36,.5,.64,.76,.88])for(const x of [.12,.24,.36,.5,.64,.76,.88]){
      const actualIndex=(Math.round(y*(surface.height-1))*surface.width+Math.round(x*(surface.width-1)))*4;
      const sourceIndex=(Math.round(y*(output.height-1))*output.width+Math.round(x*(output.width-1)))*4;
      let pixel=0;
      for(let c=0;c<3;c++){const delta=Math.abs(decoded[actualIndex+c]!-output.data[sourceIndex+c]!);sum+=delta;pixel+=delta;count++;}
      maxMean=Math.max(maxMean,pixel/3);
    }
    const finalSamples=[[.2,.2],[.5,.5],[.8,.8]].map(([x,y])=>{
      const i=(Math.round(y!*(output.height-1))*output.width+Math.round(x!*(output.width-1)))*4;
      return [output.data[i]!,output.data[i+1]!,output.data[i+2]!];
    });
    if(!card)throw new Error('selected card disappeared while comparing pixels');
    const outputAspect=output.width/output.height,imageAspect=image.naturalWidth/image.naturalHeight;
    return {width:output.width,height:output.height,imageWidth:image.naturalWidth,imageHeight:image.naturalHeight,
      outputAspect,imageAspect,meanRgbDelta:sum/count,maxSampleMeanDelta:maxMean,
      baselineChanged:JSON.stringify(finalSamples)!==JSON.stringify(baseline.samples),
      source:card.dataset.path,canvasLabel,imageUrlIsBlob:image.src.startsWith('blob:')};
  },{outputPath,path:paths.path,baseline});
  expect(comparison.source).toBe(paths.path);
  expect(comparison.canvasLabel).toContain('Canvas output');
  expect(comparison.imageUrlIsBlob).toBe(true);
  expect(comparison.imageWidth).toBe(comparison.width);
  expect(comparison.imageHeight).toBe(comparison.height);
  expect(Math.abs(comparison.imageAspect-comparison.outputAspect)).toBeLessThan(.005);
  expect(comparison.meanRgbDelta).toBeLessThan(12);
  expect(comparison.baselineChanged).toBe(true);
});

test('phone-sized table controls stay reachable and card placement responds to touch',async({browser})=>{
  const context=await browser.newContext({baseURL:'http://127.0.0.1:5173',viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  const page=await context.newPage();
  try{
    await page.addInitScript(()=>{document.documentElement.dataset.mobile='true';});
    await page.goto('/?open=');
    await page.evaluate(async(settingsModule)=>{
      const settings=await import(/* @vite-ignore */ settingsModule);
      settings.settingsStore.getState().set('leftCollapsed',true);
      settings.settingsStore.getState().set('rightCollapsed',true);
    },settingsModule);
    await expect(page.getByTestId('tier-badge')).toHaveText('full');
    await page.getByTestId('lighttable-open').click();
    await expect(page.getByTestId('lighttable')).toBeVisible();
    await page.evaluate(async({modelModule,platformModule})=>{
      const model=await import(/* @vite-ignore */ modelModule),p=await import(/* @vite-ignore */ platformModule);
      const photos=(await p.platform().listImages('/mock/Roll 01')).slice(0,3);
      model.changeTable((d:{trays:{photos:unknown[];cards:unknown[]}[]})=>({...d,trays:d.trays.map(t=>({...t,photos:[],cards:[]}))}));
      await model.saveTable();
      await model.openTable(photos);
      model.changeTray((t:{photos:typeof photos;cards:unknown[]})=>({...t,cards:model.tiledCards(t.photos,360,550)}));
      await model.saveTable();
    },{modelModule,platformModule});
    await expect(page.getByTestId('lighttable-stage')).toBeVisible();
    for(const id of ['lt-lamp','lt-tile','lt-close'])await expect(page.getByTestId(id)).toBeVisible();
    const card=page.locator('[data-testid="lt-photo-card"]').first();
    await expect(card).toBeVisible();
    const box=await card.boundingBox();expect(box).not.toBeNull();
    await page.touchscreen.tap(box!.x+box!.width/2,box!.y+box!.height/2);
    await expect(card.getByTestId('lt-remove-card')).toBeVisible();
  }finally{await context.close();}
});

test('table cards stay local during an export lock and cannot steal the editor frame',async({page})=>{
  await enterTable(page);
  await page.evaluate(async({modelModule,platformModule})=>{
    const model=await import(/* @vite-ignore */ modelModule),p=await import(/* @vite-ignore */ platformModule);
    const photos=(await p.platform().listImages('/mock/Roll 01')).slice(0,2);
    model.changeTable((d:{trays:{photos:unknown[];cards:unknown[]}[]})=>({...d,trays:d.trays.map(t=>({...t,photos:[],cards:[]}))}));
    await model.saveTable();
    await model.openTable(photos);
    model.changeTray((t:{photos:typeof photos;cards:unknown[]})=>({...t,cards:model.tiledCards(t.photos,1000,600)}));
    await model.saveTable();
  },{modelModule,platformModule});
  const cards=page.locator('[data-testid="lt-photo-card"]');
  await expect(cards).toHaveCount(2);
  const before=await page.evaluate(()=>{
    const s=(window as unknown as {__spk:{sessionStore:{getState():{selection:string|null;sidecar:unknown;batchExporting:boolean}}}}).__spk.sessionStore.getState();
    return {selection:s.selection,sidecar:JSON.stringify(s.sidecar)};
  });
  await page.evaluate(()=>{
    (window as unknown as {__spk:{sessionStore:{setState(s:object):void}}}).__spk.sessionStore.setState({batchExporting:true});
  });
  await cards.nth(1).click();
  await page.keyboard.press('Control+z');
  const afterClick=await page.evaluate(()=>{
    const s=(window as unknown as {__spk:{sessionStore:{getState():{selection:string|null;sidecar:unknown;batchExporting:boolean}}}}).__spk.sessionStore.getState();
    return {selection:s.selection,sidecar:JSON.stringify(s.sidecar),batchExporting:s.batchExporting};
  });
  expect(afterClick).toEqual({...before,batchExporting:true});
  // Returning a card is a local table-layout edit. It may proceed during an
  // export, but must leave the export-owned source frame and recipe untouched.
  await cards.nth(1).getByTestId('lt-remove-card').click();
  await expect(cards).toHaveCount(1);
  const afterLayout=await page.evaluate(()=>{
    const s=(window as unknown as {__spk:{sessionStore:{getState():{selection:string|null;sidecar:unknown;batchExporting:boolean}}}}).__spk.sessionStore.getState();
    return {selection:s.selection,sidecar:JSON.stringify(s.sidecar),batchExporting:s.batchExporting};
  });
  expect(afterLayout).toEqual({...before,batchExporting:true});
  await page.evaluate(()=>{
    (window as unknown as {__spk:{sessionStore:{setState(s:object):void}}}).__spk.sessionStore.setState({batchExporting:false});
  });
});

async function verifyNativeDensity(browser:Browser,width:number,height:number):Promise<void>{
  const context=await browser.newContext({baseURL:'http://127.0.0.1:5173',viewport:{width,height},deviceScaleFactor:3});
  const page=await context.newPage();
  try{
    await page.addInitScript(()=>{document.documentElement.dataset.mobile='true';});
    await page.goto('/?open=');
    // On the 400px handset viewport both desktop rails would consume the
    // centre column. Collapse them as the mobile layout does; the source stays
    // at its native 1800x1200 dimensions.
    await page.evaluate(async(settingsModule)=>{
      document.documentElement.dataset.mobile='true';
      const settings=await import(/* @vite-ignore */ settingsModule);
      settings.settingsStore.getState().set('leftCollapsed',true);
      settings.settingsStore.getState().set('rightCollapsed',true);
    },settingsModule);
    await expect(page.getByTestId('tier-badge')).toHaveText('full');
    await expect.poll(()=>page.evaluate(()=>{
      const app=(window as unknown as {__spk:{sessionStore:{getState():{badge:string|null;developing:boolean;nativeSize:{width:number;height:number}|null}};frameImages:{print:{width:number;height:number}|null}}}).__spk;
      const s=app.sessionStore.getState(),image=app.frameImages.print;
      return !!image&&!!s.nativeSize&&s.badge==='full'&&!s.developing&&image.width===s.nativeSize.width&&image.height===s.nativeSize.height;
    }),{timeout:30_000}).toBe(true);
    await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
    const density=()=>page.evaluate(()=>{
      const canvas=document.querySelector<HTMLCanvasElement>('[data-testid="canvas"] canvas');
      const wrap=document.querySelector<HTMLElement>('[data-testid="canvas"]');
      const rect=canvas?.getBoundingClientRect(),wrapRect=wrap?.getBoundingClientRect();
      const gl=canvas?.getContext('webgl2');
      const dpr=window.devicePixelRatio;
      return {deltaX:rect?Math.abs(canvas!.width-rect.width*dpr):Number.POSITIVE_INFINITY,
        deltaY:rect?Math.abs(canvas!.height-rect.height*dpr):Number.POSITIVE_INFINITY,
        canvasWidth:canvas?.width??0,canvasHeight:canvas?.height??0,cssWidth:rect?.width??0,cssHeight:rect?.height??0,
        wrapWidth:wrapRect?.width??0,wrapHeight:wrapRect?.height??0,dpr,
        drawingBufferWidth:gl?.drawingBufferWidth??0,drawingBufferHeight:gl?.drawingBufferHeight??0,
        contextLost:gl?.isContextLost()??true,visualViewport:{width:window.visualViewport?.width??0,scale:window.visualViewport?.scale??0}};
    });
    try{
      await expect.poll(async()=>{const d=await density();return d.cssWidth>0&&d.cssHeight>0&&d.canvasWidth>0&&d.canvasHeight>0&&
        d.deltaX<2&&d.deltaY<2&&!d.contextLost&&d.drawingBufferWidth===d.canvasWidth&&d.drawingBufferHeight===d.canvasHeight;},
        {timeout:30_000,intervals:[100]}).toBe(true);
    }catch(error){
      throw new Error(`Native-density canvas did not converge: ${JSON.stringify(await density())}`,{cause:error});
    }
    const report=await density();
    expect(report.dpr).toBe(3);
    expect(report.deltaX).toBeLessThan(2);
    expect(report.deltaY).toBeLessThan(2);
    expect(report.contextLost).toBe(false);
    expect(report.drawingBufferWidth).toBeGreaterThan(0);
    expect(report.drawingBufferHeight).toBeGreaterThan(0);
    await page.getByTestId('lighttable-open').click();
    await expect(page.getByTestId('lighttable-stage')).toBeVisible();
  }finally{await context.close();}
}

test('Xiaomi 17 Ultra viewport retains native-density editor and light table',async({browser})=>{
  // Approximate the handset's 1200x2608 panel at DPR 3 in the browser fixture.
  await verifyNativeDensity(browser,400,869);
});

test('Xiaomi Pad 6S Pro viewport retains native-density editor and light table',async({browser})=>{
  await verifyNativeDensity(browser,1016,677);
});
