import {expect,it} from 'vitest';
import {decodePixels} from './client';
import type {ImageInfo} from '@shared/protocol';

it('decodes little-endian 16-bit rows with padding and an unaligned IPC payload',()=>{
  const values=[0,1,32768,65535,12345,54321,42,65535];
  const bytes=new Uint8Array(21),view=new DataView(bytes.buffer);
  values.forEach((v,i)=>view.setUint16(1+Math.floor(i/4)*10+(i%4)*2,v,true));
  const info:ImageInfo={width:1,height:2,format:'rgba16',row_bytes:10,color_space:'ProPhoto RGB'};
  const image=decodePixels(info,bytes.subarray(1));
  expect(image.data).toBeInstanceOf(Uint16Array);
  expect([...image.data]).toEqual(values);
  const single=decodePixels({...info,height:1,row_bytes:8},bytes.subarray(1,9));
  expect([...single.data]).toEqual(values.slice(0,4));
});

it('refuses incomplete rows and fractional dimensions before constructing a pixel view',()=>{
  const info:ImageInfo={width:1,height:1,format:'rgba16',row_bytes:8,color_space:'ProPhoto RGB'};
  for(const [metadata,data] of [[info,new Uint8Array(7)],[{...info,row_bytes:7},new Uint8Array(7)],
    [{...info,width:.5},new Uint8Array(8)]] as const)
    expect(()=>decodePixels(metadata,data)).toThrow();
});
