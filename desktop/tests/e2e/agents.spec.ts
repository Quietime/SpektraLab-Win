// Browser session regression with the in-page stand-in host. Native host and
// Windows CLI/MCP protocol checks are separate gates, never implied by this.
import {expect,test} from '@playwright/test';

test('agent access is off by default; a validated edit uses the editor history and refuses invalid patches atomically',async({page})=>{
  await page.goto('/?open=');await expect(page.getByTestId('tier-badge')).toHaveText('full');
  const result=await page.evaluate(async()=>{
    const workspace='/src/agent/workspace.ts',session='/src/state/session.ts',settings='/src/state/settings.ts';
    const {callAgent}=await import(/* @vite-ignore */ workspace);
    const {sessionStore}=await import(/* @vite-ignore */ session);
    const {settingsStore}=await import(/* @vite-ignore */ settings);
    let refusal='';try{await callAgent('get_schema',{});}catch(e){refusal=String(e);}
    settingsStore.getState().set('agentsEnabled',true);
    const schema=await callAgent('get_schema',{}) as {fields:unknown[]};
    const path=sessionStore.getState().selection!;
    const edited=await callAgent('edit_image',{path,patch:{adjustments:{exposure:.4}},preview:false}) as {written:string[]};
    const before=JSON.stringify(sessionStore.getState().sidecar),count=sessionStore.getState().undo.length;
    let invalid='';try{await callAgent('edit_image',{path,patch:{adjustments:{exposure:.1,notAControl:1}},preview:false});}catch(e){invalid=String(e);}
    return {refusal,fieldCount:schema.fields.length,written:edited.written,invalid,unchanged:JSON.stringify(sessionStore.getState().sidecar)===before,
      exposure:sessionStore.getState().sidecar.adjustments.exposure,undo:count,held:sessionStore.getState().batchExporting};
  });
  expect(result.refusal).toContain('Access is off');expect(result.fieldCount).toBe(138);
  expect(result.written).toEqual(['adjustments.exposure']);expect(result.exposure).toBe(.4);
  expect(result.invalid).toContain('notAControl');expect(result.unchanged).toBe(true);
  expect(result.undo).toBe(1);expect(result.held).toBe(false);
  await page.keyboard.press('Control+z');
  expect(await page.evaluate(async()=>{const session='/src/state/session.ts';return (await import(/* @vite-ignore */ session)).sessionStore.getState().sidecar.adjustments.exposure;})).toBe(0);
});

test('agent frame operations respect the existing export lock and validate tool arguments',async({page})=>{
  await page.goto('/?open=');await expect(page.getByTestId('tier-badge')).toHaveText('full');
  const result=await page.evaluate(async()=>{
    const workspace='/src/agent/workspace.ts',session='/src/state/session.ts',settings='/src/state/settings.ts';
    const {callAgent}=await import(/* @vite-ignore */ workspace);
    const {sessionStore}=await import(/* @vite-ignore */ session);
    const {settingsStore}=await import(/* @vite-ignore */ settings);settingsStore.getState().set('agentsEnabled',true);
    const path=sessionStore.getState().selection!,before=JSON.stringify(sessionStore.getState().sidecar);
    sessionStore.setState({batchExporting:true});
    const errors=[];for(const [name,args]of [['get_edit',{path}],['preview_image',{path,long_edge:5000}],['process_image',{path,force:true}]] as const){
      try{await callAgent(name,args);}catch(e){errors.push(String(e));}
    }
    return {errors,held:sessionStore.getState().batchExporting,unchanged:before===JSON.stringify(sessionStore.getState().sidecar)};
  });
  expect(result.errors[0]).toContain('batch export');expect(result.errors[1]).toContain('outside its range');
  expect(result.errors[2]).toContain('force');expect(result.held).toBe(true);expect(result.unchanged).toBe(true);
});
