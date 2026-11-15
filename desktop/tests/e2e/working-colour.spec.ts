import {expect,test} from '@playwright/test';
import {existsSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import type {Adjustments} from '../../src/shared/adjustments';
import type {Geometry} from '../../src/shared/geometry';
import type {OutputTransform} from '../../src/shared/colour';
const path=resolve('../artifacts/colour-oracle.json');
type Fixture={size:{width:number;height:number};data:number[];
  transforms:Record<'srgb'|'p3'|'originalP3',Omit<OutputTransform,'cmax'>&{cmax:number[]}>;
  cases:{name:string;adjustments:Adjustments;geometry:Geometry;out:{width:number;height:number};expected:number[]}[]};
test('16-bit working canvas agrees with CPU grade and real native output transform',async({page})=>{
  test.skip(!existsSync(path),'Generate the native colour oracle with scripts/colour-oracle.ts; this is not a passed native gate.');
  const fixture=JSON.parse(readFileSync(path,'utf8')) as Fixture;
  expect(fixture.transforms.srgb.gamut_compress.lightness_compression_active).toBe(false);
  await page.goto('/');
  const results=await page.evaluate(async fixture=>{
    const module='/src/canvas/glRenderer.ts';
    const {GLRenderer}=await import(/* @vite-ignore */ module);
    const renderer=new GLRenderer(new OffscreenCanvas(1,1));
    const transforms=Object.fromEntries(Object.entries(fixture.transforms).map(([key,t])=>[key,{...t,cmax:new Float32Array(t.cmax)}]));
    renderer.setImage({...fixture.size,data:new Uint16Array(fixture.data),colorSpace:'ProPhoto RGB',transforms});
    return fixture.cases.map(c=>{
      const pixels=renderer.renderOutput({viewport:c.out,offset:{x:0,y:0},outSize:c.out,display:c.geometry,editingCrop:null,
        sourceSize:fixture.size,adjustments:c.adjustments,compare:0,split:.5,surround:0},c.out.width,c.out.height);
      const error=renderer.gl.getError();
      return {name:c.name,error,pixels:Array.from(pixels??[]) as number[]};
    });
  },fixture);
  for(let i=0;i<results.length;i++){
    const r=results[i]!,reference=fixture.cases[i]!;
    expect(r.error,r.name).toBe(0);
    expect(r.pixels.length,r.name).toBe(reference.expected.length);
    const max=Math.max(...r.pixels.map((v,j)=>Math.abs(v-reference.expected[j]!)));
    expect(max,r.name+' maximum difference in 8-bit display code values').toBeLessThanOrEqual(1);
  }
});
