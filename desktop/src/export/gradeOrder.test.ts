import {expect,it} from 'vitest';
import {filePixels} from './exporter';
import {ADJUSTMENTS_DEFAULT,PROPHOTO_MID_GREY} from '@shared/adjustments';
import {GEOMETRY_DEFAULT} from '@shared/geometry';

it('grades at source precision before downsampling, as the Mac Layer 2 texture does',()=>{
  const pixels=new Uint16Array([0,0,0,65535,65535,65535,65535,65535]);
  const result=filePixels(pixels,{width:2,height:1},GEOMETRY_DEFAULT,{...ADJUSTMENTS_DEFAULT,exposure:1},{width:1,height:1},PROPHOTO_MID_GREY);
  // The lit source pixel clips before it is mixed with the dark source pixel.
  // Grading their average instead would produce approximately 0.685, not 0.5.
  expect([...result]).toEqual([32768,32768,32768,65535]);
});
