import {expect,it} from 'vitest';
import {agentFields,editDocument,patchedDocument,validatePatch} from './document';
import {newSidecar} from '@shared/sidecar';
import {StockCatalog} from '@shared/stocks';
const catalog=new StockCatalog([
  {id:'negative',name:'Negative',stage:'filming',use:'still',type:'negative',hasPreviewLUT:true},
  {id:'paper',name:'Paper',stage:'printing',use:'still',hasPreviewLUT:true},
]);
it('exposes every extracted Mac field with resolved enums and no generator expressions',()=>{
  const fields=agentFields(catalog);expect(fields).toHaveLength(138);
  expect(new Set(fields.map(f=>f.path)).size).toBe(fields.length);
  for(const field of fields){expect(field).not.toHaveProperty('choiceSource');if(field.type==='string')expect(field.enum).toBeInstanceOf(Array);}
  expect(fields.find(f=>f.path==='params.filmSide')!.enum).toEqual(['long','short']);
});
it('rejects an entire mixed patch before changing any state or clamping a value',()=>{
  const current=editDocument(newSidecar()),before=structuredClone(current);
  const invalid=[
    {adjustments:{exposure:4}},{params:{filmStock:'missing'}},{params:{filmFormatMM:36}},
    {params:{contrastMask:{active:true}}},{decode:{temperature:1000}},
    {adjustments:{temperature:12,exposure:null}},{geometry:{quarterTurns:1.5}},
    {params:{sceneLatitude:{highlightPullBack:2}}},{adjustments:{unknown:1}},
    JSON.parse('{"__proto__":{"polluted":true}}'),{geometry:{crop:[]}},
    {adjustments:{curves:{rgb:{points:[[0,0],[.5,.7],[.5,.8],[1,1]]}}}},
  ];
  for(const patch of invalid){expect(()=>patchedDocument(current,patch,catalog)).toThrow();expect(current).toEqual(before);}
});
it('merges only specified leaves and accepts a valid ordered curve',()=>{
  const current=editDocument(newSidecar());
  const patch={params:{filmStock:'negative'},adjustments:{exposure:.3,curves:{rgb:{points:[[0,0],[.5,.7],[1,1]]}}}};
  const result=patchedDocument(current,patch,catalog);
  expect(result.document.params.filmStock).toBe('negative');
  expect(result.document.adjustments.exposure).toBe(.3);
  expect(result.document.geometry).toEqual(current.geometry);
  expect(result.document.decode).toEqual(current.decode);
  expect(validatePatch(patch,catalog)).toEqual(['adjustments.curves.rgb.points','adjustments.exposure','params.filmStock']);
  expect(current.adjustments.exposure).toBe(0);
});
