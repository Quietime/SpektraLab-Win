import {expect,test} from '@playwright/test';

const modelModule='/src/lighttable/model.ts';
const platformModule='/src/platform/index.ts';

test('synthetic 2000-photo table stays bounded through trays, card operations and reload',async({page})=>{
  await page.goto('/?open=');
  await expect(page.getByTestId('tier-badge')).toHaveText('full');
  await page.getByTestId('lighttable-open').click();
  await expect(page.getByTestId('lighttable')).toBeVisible();

  const seeded=await page.evaluate(async({modelModule})=>{
    const model=await import(/* @vite-ignore */ modelModule);
    const photos=Array.from({length:2000},(_,i)=>({
      path:`/synthetic/相片-${String(i).padStart(4,'0')}.NEF`,
      name:`负片-${i}.NEF`,size:24_000_000+i,mtime_ms:1_790_000_000_000+i,
    }));
    const duplicateInputs=[...photos,photos[0]!,photos[879]!,photos[1999]!];
    model.changeTable((d:{trays:{photos:unknown[];cards:unknown[]}[]})=>({...d,trays:d.trays.map(t=>({...t,photos:[],cards:[]}))}));
    await model.saveTable();
    await model.openTable(duplicateInputs);
    const initialId=model.tableStore.getState().document.active;
    for(let i=1;i<32;i++)model.newTray();
    model.changeTable((d:{trays:{id:string}[];active:string})=>({...d,active:initialId}));
    const stage=document.querySelector('[data-testid="lighttable-stage"]');
    const rect=stage?.getBoundingClientRect();
    if(!rect||rect.width<=0||rect.height<=0)throw new Error('LightTable stage has no layout size');
    model.changeTray((tray:{photos:unknown[];cards:unknown[]})=>({...tray,cards:model.tiledCards(tray.photos,rect.width,rect.height)}));
    // Repeated return/place operations exercise immutable store updates and
    // the debounced persistence queue before the final tiled layout is saved.
    const first=photos[0]!.path;
    for(let i=0;i<24;i++){
      model.changeTray((tray:never)=>model.returnCard(tray,first));
      model.changeTray((tray:never)=>model.placeCard(tray,first,.5,.5));
    }
    model.changeTray((tray:{photos:unknown[];cards:unknown[]})=>({...tray,cards:model.tiledCards(tray.photos,rect.width,rect.height)}));
    await model.saveTable();
    const doc=model.tableStore.getState().document;
    return {photoCount:doc.trays.reduce((n:number,t:{photos:unknown[]})=>n+t.photos.length,0),
      trayCount:doc.trays.length,cardCount:doc.trays[0]!.cards.length,storageVersion:JSON.parse(localStorage.getItem('store:LightTable/layout.json')??'{}').version};
  },{modelModule});
  expect(seeded).toEqual({photoCount:2000,trayCount:32,cardCount:48,storageVersion:2});

  const tabs=page.locator('[data-testid="lighttable"] [role="tab"]');
  await expect(tabs).toHaveCount(32);
  const cards=page.locator('[data-testid="lt-photo-card"]');
  await expect(cards).toHaveCount(48);
  await expect(page.locator('[data-testid="lt-pending-photo"]')).toHaveCount(60);
  const centers=await page.evaluate(()=>Array.from(document.querySelectorAll<HTMLElement>('[data-testid="lt-photo-card"]'),card=>{
    const r=card.getBoundingClientRect(),hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);
    return !!hit&&hit.closest('[data-testid="lt-photo-card"]')===card;
  }));
  expect(centers).toHaveLength(48);
  expect(centers.every(Boolean)).toBe(true);
  await cards.first().click();

  await page.reload();
  await expect(page.getByTestId('tier-badge')).toHaveText('full');
  await page.getByTestId('lighttable-open').click();
  await expect(page.getByTestId('lighttable')).toBeVisible();
  const reloaded=await page.evaluate(async({modelModule,platformModule})=>{
    const model=await import(/* @vite-ignore */ modelModule);
    await model.loadTable();
    const d=model.tableStore.getState().document;
    const paths=d.trays.flatMap((t:{photos:{path:string}[]})=>t.photos.map(p=>p.path));
    const platform=await import(/* @vite-ignore */ platformModule);
    const sources=await platform.platform().listImages('/mock/Roll 01');
    return {photos:paths.length,uniquePaths:new Set(paths).size,trays:d.trays.length,cards:d.trays[0]!.cards.length,
      sourceFrameCounts:sources.map((p:{path:string})=>paths.filter((path:string)=>path===p.path).length)};
  },{modelModule,platformModule});
  // Opening the table from the editor merges the eight real current-roll
  // frames once after loading the 2,000 synthetic metadata rows.
  expect(reloaded).toEqual({photos:2008,uniquePaths:2008,trays:32,cards:48,sourceFrameCounts:Array.from({length:8},()=>1)});
  await expect(page.locator('[data-testid="lighttable"] [role="tab"]')).toHaveCount(32);
  await expect(page.locator('[data-testid="lt-photo-card"]')).toHaveCount(48);
  await expect(page.locator('[data-testid="lt-pending-photo"]')).toHaveCount(60);
});

test('source-frame merge is deduplicated and async persistence failure keeps the document recoverable',async({page})=>{
  await page.goto('/?open=');
  await expect(page.getByTestId('tier-badge')).toHaveText('full');
  await page.getByTestId('lighttable-open').click();
  const result=await page.evaluate(async({modelModule,platformModule})=>{
    const model=await import(/* @vite-ignore */ modelModule);
    const platformModuleValue=await import(/* @vite-ignore */ platformModule);
    const os=platformModuleValue.platform();
    const source=await os.listImages('/mock/Roll 01');
    await model.openTable(source);
    await model.saveTable();
    await model.closeTable();
    await model.openTable([...source,source[0]!]);
    await model.saveTable();
    const afterMerge=model.tableStore.getState().document;
    const beforePaths=afterMerge.trays.flatMap((t:{photos:{path:string}[]})=>t.photos.map(p=>p.path));
    const removed=source[0]!.path;
    model.changeTable((d:{trays:{photos:{path:string}[];cards:never[]}[]})=>({...d,trays:d.trays.map(t=>({...t,photos:t.photos.filter(p=>p.path!==removed)}))}));

    const originalWrite=os.storeWrite.bind(os);
    let failedIndex=false;
    os.storeWrite=async(area:string,name:string,value:unknown)=>{
      if(area==='LightTable'&&name==='layout.json'&&!failedIndex){failedIndex=true;throw new Error('synthetic async store failure');}
      return originalWrite(area,name,value);
    };
    const extra={path:'/mock/Roll 01/合并后新增.NEF',name:'合并后新增.NEF',size:123,mtime_ms:456};
    model.changeTable((d:{trays:{photos:unknown[];cards:unknown[]}[]})=>({...d,trays:d.trays.map((t,i)=>i===0?{...t,photos:[...t.photos,extra]}:t)}));
    let saveError='';try{await model.saveTable();}catch(e){saveError=String(e);}
    const retained=model.tableStore.getState().document.trays.flatMap((t:{photos:{path:string}[]})=>t.photos.map(p=>p.path)).includes(extra.path);
    os.storeWrite=originalWrite;
    await model.saveTable();
    const pathStillExists=await os.pathExists(removed);
    const reopened=await os.storeRead('LightTable','layout.json');
    return {sourceCount:source.length,mergedCount:beforePaths.length,uniqueCount:new Set(beforePaths).size,
      removedTableEntry:!model.tableStore.getState().document.trays.some((t:{photos:{path:string}[]})=>t.photos.some(p=>p.path===removed)),
      sourceStillExists:pathStillExists,failedIndex,saveError,documentRetainedAfterFailure:retained,
      persistedVersion:(reopened as {version?:number}|null)?.version};
  },{modelModule,platformModule});
  expect(result.sourceCount).toBeGreaterThan(1);
  expect(result.mergedCount).toBe(result.uniqueCount);
  expect(result.removedTableEntry).toBe(true);
  expect(result.sourceStillExists).toBe(true);
  expect(result.failedIndex).toBe(true);
  expect(result.saveError).toContain('synthetic async store failure');
  expect(result.documentRetainedAfterFailure).toBe(true);
  expect(result.persistedVersion).toBe(2);
});
