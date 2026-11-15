import {expect,it} from 'vitest';
import {decodeTransform} from './colour';

const identity=[1,0,0,0,1,0,0,0,1];
const constants=()=>({matrix:identity,source_cctf_mode:2,target_cctf_mode:1,gamut_compress:{
  algorithm:'cam16_ucs',lightness_compression_active:false,m_to_xyz:identity,m_to_rgb:identity,
  k:Array.from({length:22},()=>1),cmax_rows:2,cmax_cols:2}});
it('reads real float values at an unaligned IPC offset and rejects corrupt gamut tables',()=>{
  const data=new Uint8Array(17),view=new DataView(data.buffer);
  [0,.25,1,100].forEach((x,i)=>view.setFloat32(1+i*4,x,true));
  expect([...decodeTransform(constants(),data.subarray(1)).cmax]).toEqual([0,.25,1,100]);
  view.setFloat32(5,NaN,true);
  expect(()=>decodeTransform(constants(),data.subarray(1))).toThrow('Invalid C_max');
  expect(()=>decodeTransform(constants(),data.subarray(2))).toThrow('Invalid output-transform');
  const broken=constants();broken.matrix[0]=Infinity;
  expect(()=>decodeTransform(broken,new Uint8Array(16))).toThrow('Invalid output-transform');
});
