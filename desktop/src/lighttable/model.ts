// Local light-table document. No image bytes, recipes or edits are stored here.
import {createStore} from 'zustand/vanilla';
import {useStore} from 'zustand';
import {platform,type FileEntry} from '../platform';

export interface Card {path:string;x:number;y:number;scale:number;rotation:number;z:number;tileW?:number;tileH?:number}
export interface Tray {id:string;name:string;photos:FileEntry[];cards:Card[]}
export interface TableDocument {version:1;trays:Tray[];active:string;lamp:boolean;brightness:number;sleeves:boolean}
export const MAX_CARDS=48,MAX_PHOTOS=2000,MAX_TRAYS=32;
const validId=(value:string)=>value.length>0&&value.length<=40&&/^[A-Za-z0-9_-]+$/.test(value);
export const bound=(v:number,lo:number,hi:number)=>Math.min(hi,Math.max(lo,Number.isFinite(v)?v:lo));
const id=()=>`tray-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,9)}`;
export function emptyTable():TableDocument {const tray={id:id(),name:'01',photos:[],cards:[]};return{version:1,trays:[tray],active:tray.id,lamp:true,brightness:1,sleeves:false};}
const record=(v:unknown):Record<string,unknown>=>v&&typeof v==='object'?v as Record<string,unknown>:{};
export function decodeTable(value:unknown):TableDocument {
 const v=record(value);if(v.version!==1||!Array.isArray(v.trays))return emptyTable();
 const used=new Set<string>(),trays:Tray[]=[];
 for(const raw of v.trays.slice(0,MAX_TRAYS)){
  const t=record(raw);if(typeof t.id!=='string'||!validId(t.id)||used.has(t.id))continue;used.add(t.id);
  const photos:FileEntry[]=[],paths=new Set<string>();
  for(const rawPhoto of (Array.isArray(t.photos)?t.photos:[]).slice(0,MAX_PHOTOS)){
   const p=record(rawPhoto);if(typeof p.path!=='string'||!p.path||p.path.length>8192||paths.has(p.path))continue;paths.add(p.path);
   photos.push({path:p.path,name:(typeof p.name==='string'?p.name:p.path.split(/[\\/]/).pop()!).slice(0,8192),size:Number(p.size)||0,mtime_ms:Number(p.mtime_ms)||0});
  }
  const placed=new Set<string>(),cards:Card[]=[];
  for(const rawCard of (Array.isArray(t.cards)?t.cards:[]).slice(0,MAX_CARDS)){
   const c=record(rawCard);if(typeof c.path!=='string'||!paths.has(c.path)||placed.has(c.path))continue;placed.add(c.path);
   const card:Card={path:c.path,x:bound(Number(c.x),.02,.98),y:bound(Number(c.y),.02,.98),scale:bound(Number(c.scale),.4,2.5),rotation:bound(Number(c.rotation),-180,180),z:cards.length+1};
   if(typeof c.tileW==='number'&&Number.isFinite(c.tileW)&&c.tileW>0&&c.tileW<=1&&
      typeof c.tileH==='number'&&Number.isFinite(c.tileH)&&c.tileH>0&&c.tileH<=1){card.tileW=c.tileW;card.tileH=c.tileH;}
   cards.push(card);
  }
  trays.push({id:t.id,name:typeof t.name==='string'?t.name.slice(0,80):String(trays.length+1),photos,cards});
 }
 if(!trays.length)return emptyTable();
 return{version:1,trays,active:trays.some(t=>t.id===v.active)?v.active as string:trays[0]!.id,lamp:v.lamp!==false,brightness:bound(Number(v.brightness??1),.1,1.6),sleeves:v.sleeves===true};
}
export function mergePhotos(tray:Tray,photos:FileEntry[]):Tray {const seen=new Set(tray.photos.map(p=>p.path));return{...tray,photos:[...tray.photos,...photos.filter(p=>!seen.has(p.path)&&!!seen.add(p.path))].slice(0,MAX_PHOTOS)};}
export function tiledCards(photos:FileEntry[],stageWidth=800,stageHeight=600):Card[]{
 const count=Math.min(photos.length,MAX_CARDS);
 const width=Number.isFinite(stageWidth)&&stageWidth>0?stageWidth:800;
 const height=Number.isFinite(stageHeight)&&stageHeight>0?stageHeight:600;
 const columns=Math.max(1,Math.min(count||1,Math.ceil(Math.sqrt(count*width/height/1.5))));
 const rows=Math.max(1,Math.ceil(count/columns));
 return photos.slice(0,count).map((p,i)=>({path:p.path,x:(i%columns+.5)/columns,y:(Math.floor(i/columns)+.5)/rows,
  scale:1,rotation:0,z:i+1,tileW:.9/columns,tileH:.9/rows}));
}
export function placeCard(tray:Tray,path:string,x=.5,y=.5):Tray {if(tray.cards.some(c=>c.path===path)||tray.cards.length>=MAX_CARDS||!tray.photos.some(p=>p.path===path))return tray;return{...tray,cards:[...tray.cards,{path,x:bound(x,.02,.98),y:bound(y,.02,.98),scale:1,rotation:0,z:Math.max(0,...tray.cards.map(c=>c.z))+1}]};}
export function returnCard(tray:Tray,path:string):Tray {return{...tray,cards:tray.cards.filter(c=>c.path!==path)};}
export function removePhoto(tray:Tray,path:string):Tray {return{...returnCard(tray,path),photos:tray.photos.filter(p=>p.path!==path)};}
export function nextSlide(order:string[],current:string,delta:number):string|null {if(!order.length)return null;const i=Math.max(0,order.indexOf(current));return order[((i+delta)%order.length+order.length)%order.length]!;}
export const tableStore=createStore<{open:boolean;ready:boolean;document:TableDocument;error:string}>(()=>({open:false,ready:false,document:emptyTable(),error:''}));
export const useTable=<T,>(selector:(s:ReturnType<typeof tableStore.getState>)=>T)=>useStore(tableStore,selector);

interface TrayIndex {id:string;name:string;photos:string[];cards:string[]}
interface TableIndex {version:2;trays:TrayIndex[];active:string;lamp:boolean;brightness:number;sleeves:boolean}
interface CachedChunk {serialized:string;filename:string}
interface CachedArray {items:FileEntry[]|Card[];count:number}
const CHUNK_RECORDS=64,CHUNK_BYTES=200_000;
const encoder=new TextEncoder();
// Native JSON stores may reorder object keys. Canonicalization runs only on
// the failed-write readback path, never during ordinary card moves.
const canonicalJson=(value:unknown):string=>JSON.stringify(value,(_key,item)=>
 item&&typeof item==='object'&&!Array.isArray(item)
  ?Object.fromEntries(Object.keys(item as object).sort().map(key=>[key,(item as Record<string,unknown>)[key]]))
  :item);
const validChunk=(name:string,id:string,kind:'photos'|'cards')=>
 validId(id)&&new RegExp(`^tray-${id}-${kind}-[A-Za-z0-9_-]+-[0-9]+\\.json$`).test(name);
let loading:Promise<void>|null=null,timer:ReturnType<typeof setTimeout>|null=null,writing:Promise<void>=Promise.resolve();
let committedChunks=new Map<string,CachedChunk>(),committedIndex='';
let committedArrays=new Map<string,CachedArray>();
let pendingDeletes=new Set<string>(),uncertainChunks=new Set<string>();
const chunkNames=(cache:Map<string,CachedChunk>)=>new Set([...cache.values()].map(c=>c.filename));
async function cleanupChunks(){
 const active=chunkNames(committedChunks);
 for(const name of [...pendingDeletes]){
  if(active.has(name)){pendingDeletes.delete(name);continue;}
  // Every queued name came from our strict index validator or generator.
  try{await platform().storeDelete('LightTable',name);pendingDeletes.delete(name);}catch{/* Retry at the next save. */}
 }
}
function chunks<T>(items:T[]):string[]{
 const out:string[]=[];let part:T[]=[],partBytes=2;
 for(const item of items){
  const bytes=encoder.encode(JSON.stringify(item)).length;
  if(bytes+2>CHUNK_BYTES)throw new Error('Light table record exceeds storage chunk limit');
  if(part.length===CHUNK_RECORDS||partBytes+bytes+1>CHUNK_BYTES){out.push(JSON.stringify(part));part=[];partBytes=2;}
  part.push(item);partBytes+=bytes+(part.length>1?1:0);
 }
 if(part.length)out.push(JSON.stringify(part));
 return out;
}
async function loadIndexed(raw:Record<string,unknown>):Promise<{document:TableDocument;cache:Map<string,CachedChunk>;arrays:Map<string,CachedArray>;index:string}>{
 if(!Array.isArray(raw.trays)||raw.trays.length>MAX_TRAYS)throw new Error('Invalid light table index');
 const cache=new Map<string,CachedChunk>(),trays:Tray[]=[];
 for(const entry of raw.trays){
  const t=record(entry);
  if(typeof t.id!=='string'||!validId(t.id)||trays.some(p=>p.id===t.id)||
     !Array.isArray(t.photos)||!Array.isArray(t.cards))throw new Error('Invalid light table tray index');
  const id=t.id,photos:unknown[]=[],cards:unknown[]=[];
  for(const [kind,names,target,max] of [['photos',t.photos,photos,MAX_PHOTOS],['cards',t.cards,cards,MAX_CARDS]] as const){
   if(names.length>max)throw new Error('Invalid light table chunk count');
   for(let i=0;i<names.length;i++){
    const name=names[i];if(typeof name!=='string'||!validChunk(name,id,kind))throw new Error('Invalid light table chunk filename');
    const value=await platform().storeRead('LightTable',name);
    if(!Array.isArray(value)||value.length>CHUNK_RECORDS||encoder.encode(JSON.stringify(value)).length>CHUNK_BYTES)
     throw new Error('Invalid light table chunk');
    target.push(...value);if(target.length>max)throw new Error('Invalid light table chunk count');
    cache.set(`${id}:${kind}:${i}`,{serialized:JSON.stringify(value),filename:name});
   }
  }
  trays.push({id,name:typeof t.name==='string'?t.name.slice(0,80):String(trays.length+1),photos:photos as FileEntry[],cards:cards as Card[]});
 }
 const doc=decodeTable({version:1,trays,active:raw.active,lamp:raw.lamp,brightness:raw.brightness,sleeves:raw.sleeves});
 if(doc.trays.length!==trays.length)throw new Error('Invalid light table index');
 const arrays=new Map<string,CachedArray>();
 for(let i=0;i<doc.trays.length;i++)for(const kind of ['photos','cards'] as const){
  const original=trays[i]![kind],normalized=doc.trays[i]![kind];
  const fields=kind==='photos'?['path','name','size','mtime_ms']:['path','x','y','scale','rotation','z','tileW','tileH'];
  if(original.length===normalized.length&&original.every((item,j)=>fields.every(field=>
   (item as unknown as Record<string,unknown>)[field]===(normalized[j] as unknown as Record<string,unknown>)[field])))
   arrays.set(`${doc.trays[i]!.id}:${kind}`,{items:normalized,count:(record(raw.trays[i])[kind] as unknown[]).length});
 }
 return{document:doc,cache,arrays,index:JSON.stringify(raw)};
}
export async function loadTable(){
 if(tableStore.getState().ready)return;
 if(!loading)loading=(async()=>{try{
  const raw=await platform().storeRead('LightTable','layout.json');
  if(record(raw).version===2){const loaded=await loadIndexed(record(raw));committedChunks=loaded.cache;committedArrays=loaded.arrays;committedIndex=loaded.index;pendingDeletes=new Set();uncertainChunks=new Set();tableStore.setState({document:loaded.document,ready:true,error:''});}
  else {committedChunks=new Map();committedArrays=new Map();committedIndex='';pendingDeletes=new Set();uncertainChunks=new Set();tableStore.setState({document:decodeTable(raw),ready:true,error:''});}
 }catch(e){tableStore.setState({error:String(e)});throw e;}finally{loading=null;}})();
 await loading;
}
async function persist(snapshot:TableDocument){
 const nextChunks=new Map<string,CachedChunk>(),nextArrays=new Map<string,CachedArray>(),trays:TrayIndex[]=[];
 const created=new Set<string>();
 let indexMayHaveCommitted=false;
 const nonce=`${Date.now().toString(36)}-${Math.random().toString(36).slice(2,10)}`;
 try{
 for(const tray of snapshot.trays){
  if(!validId(tray.id))throw new Error('Invalid light table tray ID');
  const entry:TrayIndex={id:tray.id,name:tray.name,photos:[],cards:[]};
  for(const kind of ['photos','cards'] as const){
   const arrayKey=`${tray.id}:${kind}`,items=tray[kind];
   const previous=committedArrays.get(arrayKey);
   if(previous?.items===items){
    for(let i=0;i<previous.count;i++){
     const key=`${arrayKey}:${i}`,cached=committedChunks.get(key);
     if(!cached)throw new Error('Missing cached light table chunk');
     nextChunks.set(key,cached);entry[kind].push(cached.filename);
    }
    nextArrays.set(arrayKey,previous);
    continue;
   }
   const serializedChunks=chunks(tray[kind] as (FileEntry|Card)[]);
   nextArrays.set(arrayKey,{items,count:serializedChunks.length});
   for(let i=0;i<serializedChunks.length;i++){
    const serialized=serializedChunks[i]!,key=`${tray.id}:${kind}:${i}`;
    let cached=committedChunks.get(key);
    if(!cached||cached.serialized!==serialized){
     const filename=`tray-${tray.id}-${kind}-${nonce}-${i}.json`;
     created.add(filename);
     await platform().storeWrite('LightTable',filename,JSON.parse(serialized));
     cached={serialized,filename};
    }
    nextChunks.set(key,cached);entry[kind].push(cached.filename);
   }
  }
  trays.push(entry);
 }
 const index:TableIndex={version:2,trays,active:snapshot.active,lamp:snapshot.lamp,brightness:snapshot.brightness,sleeves:snapshot.sleeves};
 const serialized=JSON.stringify(index);
 if(encoder.encode(serialized).length>800_000)throw new Error('Light table index exceeds storage limit');
 if(serialized!==committedIndex){
  try{await platform().storeWrite('LightTable','layout.json',index);}
  catch(e){
   // Native write may commit before the bridge rejects. Never delete a chunk
   // if readback is also unavailable: the index may now refer to it.
   let stored:unknown;
   try{stored=await platform().storeRead('LightTable','layout.json');}
   catch{indexMayHaveCommitted=true;throw e;}
   if(canonicalJson(stored)!==canonicalJson(index))throw e;
  }
 }
 const current=chunkNames(nextChunks);
 for(const name of chunkNames(committedChunks))if(!current.has(name))pendingDeletes.add(name);
 for(const name of uncertainChunks)if(!current.has(name))pendingDeletes.add(name);
 uncertainChunks.clear();
 committedChunks=nextChunks;committedArrays=nextArrays;committedIndex=serialized;
 await cleanupChunks();
 }catch(e){
  if(indexMayHaveCommitted)for(const name of created)uncertainChunks.add(name);
  else {for(const name of created)pendingDeletes.add(name);await cleanupChunks();}
  throw e;
 }
}
export function saveTable():Promise<void>{
 if(timer){clearTimeout(timer);timer=null;}
 if(!tableStore.getState().ready)return Promise.resolve();
 // All production updates replace the document and changed tray/array.
 const snapshot=tableStore.getState().document;
 writing=writing.catch(()=>{}).then(()=>persist(snapshot)).then(()=>{tableStore.setState({error:''});},e=>{tableStore.setState({error:String(e)});throw e;});
 return writing;
}
export function changeTable(fn:(d:TableDocument)=>TableDocument){if(!tableStore.getState().ready)return;tableStore.setState({document:fn(tableStore.getState().document)});if(timer)clearTimeout(timer);timer=setTimeout(()=>{void saveTable().catch(()=>{});},450);}
export function changeTray(fn:(t:Tray)=>Tray){changeTable(d=>({...d,trays:d.trays.map(t=>t.id===d.active?fn(t):t)}));}
function addFiles(files:FileEntry[]){
 if(!files.length)return;
 const doc=tableStore.getState().document;
 const seen=new Set(doc.trays.flatMap(t=>t.photos.map(p=>p.path)));
 const unique=files.filter(p=>typeof p.path==='string'&&!!p.path&&p.path.length<=8192&&!seen.has(p.path)&&!!seen.add(p.path))
  .map(p=>({...p,name:(typeof p.name==='string'?p.name:p.path.split(/[\\/]/).pop()!).slice(0,8192)}));
 const capacity=doc.trays.reduce((n,t)=>n+MAX_PHOTOS-t.photos.length,0)+(MAX_TRAYS-doc.trays.length)*MAX_PHOTOS;
 if(unique.length>capacity){const error='Light table is full (32 trays of 2000 photos)';tableStore.setState({error});throw new Error(error);}
 if(!unique.length)return;
 changeTable(d=>{
  const trays=[...d.trays];let remaining=unique;
  const ordered=[trays.findIndex(t=>t.id===d.active),...trays.map((_,i)=>i)].filter((i,k,a)=>i>=0&&a.indexOf(i)===k);
  for(const i of ordered){const tray=trays[i]!;const n=Math.min(MAX_PHOTOS-tray.photos.length,remaining.length);if(n)trays[i]={...tray,photos:[...tray.photos,...remaining.slice(0,n)]};remaining=remaining.slice(n);if(!remaining.length)break;}
  while(remaining.length){const tray:Tray={id:id(),name:String(trays.length+1).padStart(2,'0'),photos:remaining.slice(0,MAX_PHOTOS),cards:[]};trays.push(tray);remaining=remaining.slice(MAX_PHOTOS);}
  return{...d,trays};
 });
}
export async function openTable(photos:FileEntry[]=[]){tableStore.setState({open:true});await loadTable();addFiles(photos);}
export async function closeTable(){await saveTable();tableStore.setState({open:false});}
export async function importTablePaths(paths:string[]){if(!paths.length)return;await loadTable();const files=await platform().expandPaths(paths);addFiles(files);}
export function newTray(){changeTable(d=>{if(d.trays.length>=MAX_TRAYS)return d;const tray:Tray={id:id(),name:String(d.trays.length+1).padStart(2,'0'),photos:[],cards:[]};return{...d,trays:[...d.trays,tray],active:tray.id};});}
