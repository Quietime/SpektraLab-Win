// Android's bridge is exposed only to bundled HTTPS app assets. Binary data
// travels in bounded chunks, never as an unbounded evaluateJavascript string.
interface NativeBridge { call(id:number,method:string,args:string):void }
declare global { interface Window { SpektraAndroid?:NativeBridge; __spkAndroidReply?:(id:number,result:unknown,error?:string)=>void } }
export const inAndroid=()=>typeof window!=='undefined'&&!!window.SpektraAndroid;
let sequence=0;
const pending=new Map<number,{resolve:(value:unknown)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
export function androidCall<T>(method:string,args:Record<string,unknown>={}):Promise<T>{
  return new Promise<T>((resolve,reject)=>{
    if(!window.SpektraAndroid){reject(new Error('Android bridge unavailable'));return;}
    window.__spkAndroidReply=(id,result,error)=>{const task=pending.get(id);if(!task)return;pending.delete(id);clearTimeout(task.timer);if(error)task.reject(new Error(error));else task.resolve(result);};
    const id=++sequence;const timer=setTimeout(()=>{pending.delete(id);reject(new Error(`${method}: Android operation timed out`));},1_800_000);
    pending.set(id,{resolve:value=>resolve(value as T),reject,timer});
    window.SpektraAndroid.call(id,method,JSON.stringify(args));
  });
}
export function fromBase64(text:string):Uint8Array {const raw=atob(text);const bytes=new Uint8Array(raw.length);for(let i=0;i<raw.length;i++)bytes[i]=raw.charCodeAt(i);return bytes;}
export function toBase64(bytes:Uint8Array):string {let raw='';for(let i=0;i<bytes.length;i+=8192)raw+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(raw);}
