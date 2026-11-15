import type {HelloResult,HostState} from '../shared/protocol';
import {HostCallError,type Transport} from '../host/transport';
import {androidCall,fromBase64,toBase64} from './bridge';
export function androidTransport():Transport {
  let ready:Promise<HostState>|null=null;
  let phase:HostState={phase:'starting'};
  const listeners=new Set<(state:HostState)=>void>();
  const emit=(state:HostState)=>{phase=state;for(const listener of listeners)listener(state);};
  const request:Transport['request']=async(method,params,opts={})=>{
    const upload=opts.payload?await androidCall<string>('upload_open',{bytes:opts.payload.length}):null;
    try {
      if(upload&&opts.payload)for(let offset=0;offset<opts.payload.length;offset+=196608)
        await androidCall('upload_chunk',{id:upload,offset,data:toBase64(opts.payload.subarray(offset,offset+196608))});
      const answer=await androidCall<{header:{ok:boolean;result?:Record<string,unknown>;error?:{code:string;message:string}};id:string;bytes:number}>('host_request',{method,params,upload}).catch(e=>{emit({phase:'failed',reason:String(e)});throw e;});
      try {
        if(!answer.header.ok)throw new HostCallError(method,answer.header.error?.code??'internal',answer.header.error?.message??'Android host error');
        if(!Number.isSafeInteger(answer.bytes)||answer.bytes<0||answer.bytes>512*1024*1024)throw new Error('Invalid Android payload length');
        const payload=new Uint8Array(answer.bytes);
        for(let offset=0;offset<payload.length;){const chunk=fromBase64(await androidCall<string>('binary_read',{id:answer.id,offset}));if(!chunk.length||chunk.length>payload.length-offset)throw new Error('Truncated Android payload');payload.set(chunk,offset);offset+=chunk.length;}
        return {result:answer.header.result??{},payload};
      } finally {await androidCall('binary_drop',{id:answer.id});}
    } finally {if(upload)await androidCall('binary_drop',{id:upload});}
  };
  const state=async()=>{if(!ready)ready=request('hello',{}).then(r=>{emit({phase:'ready',hello:r.result as unknown as HelloResult});return phase;}).catch(e=>{emit({phase:'failed',reason:String(e)});return phase;});await ready;return phase;};
  return {kind:'tauri',request,state,onState(cb){listeners.add(cb);void state().then(cb);return()=>{listeners.delete(cb);};},onEvent(){return()=>{};},async restart(){await androidCall('host_restart');ready=null;emit({phase:'starting'});await state();},diagnostics:()=>androidCall('host_diagnostics')};
}
