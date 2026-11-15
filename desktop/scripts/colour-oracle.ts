// Generate an independent CPU grade -> native output-transform reference for
// the real WebGL shader. No photographic fixture and no browser mock host.
import {spawn} from 'node:child_process';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {FrameDecoder,encodeFrame} from '../src/shared/framing';
import {filePixels} from '../src/export/exporter';
import {ADJUSTMENTS_DEFAULT,PROPHOTO_MID_GREY,type Adjustments} from '../src/shared/adjustments';
import {GEOMETRY_DEFAULT,outputSize,type Geometry} from '../src/shared/geometry';
const root=resolve(import.meta.dirname,'../..');
const container=process.argv[2];
const host=container?spawn('docker',['exec','-i',container,'/work/build/host-linux-x64/spektralab-host','--resources','/work/build/host-linux-x64/engine']):
  spawn(resolve(root,'build/host-linux-x64/spektralab-host'),['--resources',resolve(root,'build/host-linux-x64/engine')]);
type Reply={result:Record<string,unknown>;payload:Uint8Array};
const waiting=new Map<number,{resolve:(r:Reply)=>void;reject:(e:Error)=>void}>();
const decoder=new FrameDecoder();let sequence=0;
host.stderr.on('data',()=>{});
host.stdout.on('data',(data:Buffer)=>{
  for(const frame of decoder.push(data)) {
    const head=frame.header as {id:number;ok:boolean;result:Record<string,unknown>;error?:unknown};
    const pending=waiting.get(head.id);if(!pending)continue;waiting.delete(head.id);
    if(!head.ok)pending.reject(new Error(JSON.stringify(head.error)));else pending.resolve({result:head.result,payload:frame.payload});
  }
});
async function call(method:string,params:Record<string,unknown>={},payload?:Uint8Array):Promise<Reply>{
  const id=++sequence;
  return new Promise((res,rej)=>{
    const timeout=setTimeout(()=>{waiting.delete(id);rej(new Error(method+' timed out'));},120_000);
    waiting.set(id,{resolve:r=>{clearTimeout(timeout);res(r);},reject:e=>{clearTimeout(timeout);rej(e);}});
    host.stdin.write(encodeFrame({id,method,params},payload));
  });
}
try {
  const hello=await call('hello');
  if(!(hello.result.backend as {available:boolean}).available)throw new Error('Real Vulkan device required; not a skipped pass');
  const transforms:Record<string,unknown>={};
  for(const [key,source,target,colorimetric] of [['srgb','prophoto','srgb',false],['p3','prophoto','display-p3',false],['originalP3','srgb','display-p3',true]] as const){
    const r=await call('output_transform',{source,target,colorimetric});
    transforms[key]={...r.result,cmax:Array.from(new Float32Array(r.payload.slice().buffer))};
  }
  const size={width:48,height:32},data=new Uint16Array(size.width*size.height*4);
  let seed=42;
  for(let i=0;i<data.length;i++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;data[i]=i%4===3?65535:seed%65536;}
  const cases:{name:string;geometry:Geometry;adjustments:Adjustments;out:{width:number;height:number};expected:number[]}[]=[];
  for(const [name,a,g] of [
    ['neutral',ADJUSTMENTS_DEFAULT,GEOMETRY_DEFAULT],
    ['tone',{...ADJUSTMENTS_DEFAULT,exposure:.7,contrast:.2,brightness:-.15,saturation:.7,shadows:.1,highlights:-.2},GEOMETRY_DEFAULT],
    ['curve',{...ADJUSTMENTS_DEFAULT,curves:{...ADJUSTMENTS_DEFAULT.curves,rgb:{points:[[0,0],[.3,.2],[.7,.85],[1,1]]}}},GEOMETRY_DEFAULT],
    ['crop-turn-vignette',{...ADJUSTMENTS_DEFAULT,temperature:.2,tint:-.1,vignette:{amount:-.6,midpoint:40}},
      {...GEOMETRY_DEFAULT,crop:{x:.15,y:.2,width:.6,height:.5},quarterTurns:1}],
  ] as [string,Adjustments,Geometry][]){
    const native=outputSize(g,size);const out={width:Math.max(1,Math.round(native.width*.7)),height:Math.max(1,Math.round(native.height*.7))};
    const graded=filePixels(data,size,g,a,out,PROPHOTO_MID_GREY);
    const r=await call('convert_pixels',{...out,source:'prophoto',target:'srgb'},new Uint8Array(graded.buffer));
    cases.push({name,geometry:g,adjustments:a,out,expected:Array.from(r.payload)});
  }
  mkdirSync(resolve(root,'artifacts'),{recursive:true});
  writeFileSync(resolve(root,'artifacts/colour-oracle.json'),JSON.stringify({size,data:Array.from(data),transforms,cases}));
  console.log('Generated four CPU/native colour reference cases');
  await call('shutdown');host.stdin.end();
} finally {if(host.exitCode===null)host.kill();}
