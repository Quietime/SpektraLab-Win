// The CLI/MCP drives the editor's session and exporter, including its grade,
// framing, stock pairing rules, sidecars and real native output transform.
import tools from './tools.json';
import {agentFields,editDocument,object,patchedDocument,validatePatch,type EditDocument} from './document';
import {settingsStore} from '../state/settings';
import {sessionStore,openPaths,flushPendingEdits,flushSave,commitEditDocument,solveNow,resolvedParams,resumeFullRender} from '../state/session';
import {platform,joinPath} from '../platform';
import {host} from '../host/client';
import {exportFrame,type FrameToExport} from '../export/exporter';
import {DEFAULT_RECIPES,decodeRecipes,type ExportRecipe} from '../export/recipes';
import {FILM_PARAMS_DEFAULT,filmFrameNamed,FILM_FRAME_CUSTOM} from '@shared/params';
import {ADJUSTMENTS_DEFAULT} from '@shared/adjustments';
import {GEOMETRY_DEFAULT,fitted} from '@shared/geometry';
import {selectedFilm,selectedPaper} from '@shared/stocks';
import {WB_KELVIN,type WhiteBalanceMode} from '@shared/whiteBalance';

export class AgentRefusal extends Error {}
const state=()=>sessionStore.getState();
function access(){if(!settingsStore.getState().agentsEnabled)throw new AgentRefusal('Access is off. Enable Settings > Agents.');}
const absolute=(path:string)=>/^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(path);
function validateArguments(name:string,args:unknown):Record<string,unknown>{
  const tool=tools.find(t=>t.name===name);if(!tool)throw new AgentRefusal(`No tool named ${name}.`);
  if(!object(args))throw new AgentRefusal('Tool arguments must be an object.');
  const schema=tool.inputSchema as unknown as {properties:Record<string,{type:string;minimum?:number;maximum?:number}>;required:string[]};
  for(const required of schema.required)if(!Object.hasOwn(args,required))throw new AgentRefusal(`${name} needs ${required}.`);
  for(const [key,value] of Object.entries(args)){
    const spec=schema.properties[key];if(!spec)throw new AgentRefusal(`${name} takes no argument ${key}.`);
    if(spec.type==='object'?!object(value):spec.type==='integer'?!Number.isInteger(value):typeof value!==spec.type)
      throw new AgentRefusal(`${key} must be ${spec.type}.`);
    if(typeof value==='number'&&(!Number.isFinite(value)||value<(spec.minimum??-Infinity)||value>(spec.maximum??Infinity)))throw new AgentRefusal(`${key} is outside its range.`);
    if(['path','output','folder'].includes(key)&&typeof value==='string'&&!absolute(value))throw new AgentRefusal(`${key} must be an absolute path.`);
  }
  return args;
}
async function settled(path:string){
  const end=performance.now()+900_000;
  await flushPendingEdits();
  while(true){
    access();const s=state();if(s.selection!==path)throw new Error('The selected image changed during the agent call.');
    if(s.lastError&&!s.developing&&!s.redecoding)throw new Error(s.lastError);
    // Like batch export, automation owns the frame while the editor's idle
    // full timer is suspended. The settled live render proves parameters
    // landed; preview/export explicitly requests its own full render.
    if(s.engineSession&&s.badge!==null&&!s.developing&&!s.redecoding&&!s.pairUpdating)break;
    if(performance.now()>end)throw new Error('Timed out waiting for the finished print.');
    await new Promise(resolve=>setTimeout(resolve,40));
  }
  await flushSave(true);
}
function normalize(document:EditDocument,written:string[]):EditDocument{
  const s=state(),has=(p:string)=>written.some(k=>k===p||k.startsWith(p+'.'));
  let p=document.params;const positive=s.catalog.isPositive(p.filmStock);
  if(positive&&has('params.printStock'))throw new AgentRefusal('A slide film is scanned and takes no paper.');
  if(positive&&has('params.scanFilm')&&!p.scanFilm)throw new AgentRefusal('A slide film must stay in scan mode.');
  if(has('params.filmStock'))p=selectedFilm(p,p.filmStock,s.catalog);
  if(has('params.printStock')){
    if(!s.catalog.canPrint(p.filmStock,p.printStock))throw new AgentRefusal('The film and paper must both be colour or both monochrome.');
    p=selectedPaper(p,p.printStock,s.catalog);
  }
  if(has('params.filmFrame')||has('params.filmSide')){
    const frame=filmFrameNamed(p.filmFrame);
    if(frame.id!==FILM_FRAME_CUSTOM.id)p={...p,sideLengthMM:p.filmSide==='short'?frame.short:frame.long};
  }
  if(has('params.sideLengthMM'))p={...p,filmFrame:FILM_FRAME_CUSTOM.id};
  let decode=document.decode;
  if(has('decode')){
    if(s.frameKind!=='raw'&&(has('decode.temperature')||has('decode.tint')||decode.whiteBalance!=='As Shot'||decode.lensCorrection))
      throw new AgentRefusal('Camera white balance and lens correction require a RAW photograph.');
    if(decode.lensCorrection&&!s.metadata?.lens_profile)throw new AgentRefusal('No unambiguous measured lens calibration matches this photograph.');
    if((has('decode.temperature')||has('decode.tint'))&&!has('decode.whiteBalance'))decode={...decode,whiteBalance:'Custom'};
    else if(has('decode.whiteBalance')&&!has('decode.temperature')){
      const kelvin=WB_KELVIN[decode.whiteBalance as WhiteBalanceMode];if(kelvin)decode={...decode,temperature:kelvin,tint:0};
    }
  }
  let geometry=document.geometry;
  if(has('geometry.crop')){
    if(geometry.crop.width<=.01||geometry.crop.height<=.01)throw new AgentRefusal('Each crop side must be larger than 1% of the frame.');
    geometry={...geometry,intendedSize:{width:geometry.crop.width,height:geometry.crop.height}};
  }
  if(has('geometry')&&s.nativeSize)geometry=fitted(geometry,s.nativeSize);
  if(s.pairDocument&&(has('geometry')||has('decode')))throw new AgentRefusal('A half-frame pair has per-hole geometry and decode settings. Edit its source photographs for these fields.');
  return {...document,params:p,decode,geometry};
}
async function recipes(){return decodeRecipes(await platform().storeRead('Export','recipes.json'));}
function frame():FrameToExport{
  const s=state();if(!s.selection||!s.engineSession||!s.nativeSize)throw new Error('No developed frame is open.');
  return {path:s.selection,session:s.engineSession,params:resolvedParams(),adjustments:s.sidecar.adjustments,
    geometry:s.sidecar.geometry,native:s.nativeSize,pairDocument:s.pairDocument,pairInfo:s.pairInfo,
    pairComplete:s.pairInfo?s.pairInfo.can_export:true,dateTaken:s.metadata?.datetime_original};
}
async function preview(output?:string,longEdge=1024){
  const s=state();const path=output??joinPath((await platform().appPaths()).appData,`AgentPreviews/preview-${crypto.randomUUID()}.jpg`);
  const recipe:ExportRecipe={...DEFAULT_RECIPES[0]!,format:'jpeg',bitDepth:8,colorSpace:'sRGB',longEdge,existing:'overwrite'};
  const outcome=await exportFrame(recipe,frame(),s.catalog,s.hello?.methods,path);
  if(outcome.kind!=='written')throw new Error(outcome.kind==='failed'?outcome.message:'Preview was skipped.');
  return outcome.path;
}
async function latitude(highlight?:number,shadow?:number){
  const s=state(),sl=s.sidecar.params.sceneLatitude;
  const rect=s.pairInfo?.rects[s.pairSide==='left'?0:1];
  return host().sceneLatitude(s.engineSession!,{highlight_pull_back:highlight??sl.highlightPullBack,shadow_pull_back:shadow??sl.shadowPullBack,
    rolloff:sl.rolloff,max_lift:sl.maxLift,norm:sl.norm,shadow_percentile:sl.shadowPercentile,highlight_percentile:sl.highlightPercentile,
    ...(rect?{region:[rect[0],rect[1],rect[0]!+rect[2]!,rect[1]!+rect[3]!]}:{})});
}

export async function callAgent(name:string,input:unknown):Promise<unknown>{
  access();const args=validateArguments(name,input);
  if(['get_schema','list_stocks','edit_image'].includes(name)){
    const until=performance.now()+30_000;
    while(!state().catalog.films.length){access();if(performance.now()>until)throw new Error('The stock catalog did not load.');await new Promise(r=>setTimeout(r,40));}
  }
  const s=state();
  if(name==='get_schema')return {document:'Merge patches over {params,adjustments,geometry,decode}. Nulls, unknown/read-only fields and out-of-range values are refused atomically.',fields:agentFields(s.catalog)};
  if(name==='list_stocks')return {films:s.catalog.films.map(f=>({...f,declaredPaper:f.targetPrint})),papers:s.catalog.papers};
  if(name==='list_recipes')return {recipes:await recipes()};
  if(s.batchExporting)throw new AgentRefusal('A batch export is running. Try again when it finishes.');
  if(name==='edit_image')try{validatePatch(args.patch,s.catalog);}catch(e){throw new AgentRefusal(String(e));}
  const path=args.path as string;
  if(!await platform().pathExists(path))throw new AgentRefusal(`No photograph at ${path}.`);
  const entries=await platform().expandPaths([path]);
  if(entries.length!==1||entries[0]!.path!==path)throw new AgentRefusal('The path must identify one supported photograph.');
  access();if(state().batchExporting)throw new AgentRefusal('A batch export started while the photograph was being checked.');
  // `openPaths` admits the call synchronously; its selection door, like the
  // batch export's, remains usable while all person-facing doors are held.
  let opening:Promise<void>|null=null;
  if(state().selection!==path||!state().engineSession)opening=openPaths([path]);
  sessionStore.setState({batchExporting:true,lastError:null});
  try{
    await opening;await settled(path);access();
    let body:Record<string,unknown>;
    if(name==='get_edit')return editDocument(state().sidecar);
    if(name==='describe_image'){
      const q=state();return {file:path,raw:q.frameKind==='raw',pixels:[q.nativeSize!.width,q.nativeSize!.height],state:q.sidecar.state,
        film:q.catalog.stock(q.sidecar.params.filmStock)?.name,paper:q.catalog.stock(q.sidecar.params.printStock)?.name,
        filmIsSlide:q.catalog.isPositive(q.sidecar.params.filmStock),lensCorrectionAvailable:!!q.metadata?.lens_profile,exif:q.metadata};
    }
    if(name==='measure_latitude')return await latitude();
    if(name==='preview_image')return {preview:await preview(args.output as string|undefined,args.long_edge as number|undefined)};
    if(name==='edit_image'){
      const result=patchedDocument(editDocument(state().sidecar),args.patch,state().catalog);
      const document=normalize(result.document,result.written);access();commitEditDocument(document,true);await settled(path);
      body={written:result.written,edit:editDocument(state().sidecar)};
    }else if(name==='reset_edit'){
      const q=state(),document={params:structuredClone(FILM_PARAMS_DEFAULT),adjustments:structuredClone(ADJUSTMENTS_DEFAULT),geometry:structuredClone(GEOMETRY_DEFAULT),decode:q.sidecar.decode};
      access();commitEditDocument(document,true);await settled(path);body={edit:editDocument(state().sidecar)};
    }else if(name==='process_image'){
      access();await solveNow(true);await settled(path);body={edit:editDocument(state().sidecar)};
    }else if(name==='place_scene'){
      const measured=await latitude(args.highlight as number,args.shadow as number);
      const fit=measured.fit as {valid:boolean;issues:{message:string}[];params_delta?:Record<string,unknown>};
      if(!fit.valid||!fit.params_delta)throw new AgentRefusal(fit.issues.map(i=>i.message).join(' ')||'The Fit refused this placement.');
      const d=fit.params_delta,q=state(),sl={...q.sidecar.params.sceneLatitude,highlightPullBack:args.highlight as number,shadowPullBack:args.shadow as number};
      const map={active:'active',norm:'norm',highlight_knee:'highlightKnee',highlight_room:'highlightRoom',shadow_knee:'shadowKnee',shadow_room:'shadowRoom',rolloff:'rolloff',max_lift:'maxLift'} as const;
      for(const [wire,key]of Object.entries(map))(sl as unknown as Record<string,unknown>)[key]=d['scene_latitude_'+wire];
      access();commitEditDocument({...editDocument(q.sidecar),params:{...q.sidecar.params,sceneLatitude:sl}},true);await settled(path);body=measured;
    }else if(name==='export_image'){
      const all=await recipes(),recipe=args.recipe?all.find(r=>r.name===args.recipe):all[0];
      if(!recipe)throw new AgentRefusal('No export recipe with that name. Read list_recipes.');
      const chosen=args.folder?{...recipe,folder:{kind:'fixed' as const,path:args.folder as string}}:recipe;
      access();const result=await exportFrame(chosen,frame(),state().catalog,state().hello?.methods);
      if(result.kind==='failed')throw new Error(result.message);
      return {files:result.kind==='written'?[result.path]:[],skipped:result.kind==='skipped'?[result.path]:[]};
    }else throw new AgentRefusal(`No tool named ${name}.`);
    access();if(args.preview!==false)body.preview=await preview();return body;
  }finally{sessionStore.setState({batchExporting:false});resumeFullRender();}
}

export async function installAgentBridge(){
  const [{listen},{invoke}]=await Promise.all([import('@tauri-apps/api/event'),import('@tauri-apps/api/core')]);
  let queue=Promise.resolve();
  await listen<{id:number;tool:string;args:unknown}>('agent-request',event=>{
    queue=queue.then(async()=>{
      let reply:unknown;
      try{reply={ok:true,result:await callAgent(event.payload.tool,event.payload.args)};}
      catch(e){reply={ok:false,error:{code:e instanceof AgentRefusal?'refused':'failed',message:e instanceof Error?e.message:String(e)}};}
      await invoke('agent_reply',{id:event.payload.id,reply});
    }).catch(e=>platform().log('error',String(e)));
  });
  let accessWork=Promise.resolve();
  const sendAccess=(command:string,enabled:boolean)=>{
    accessWork=accessWork.then(()=>invoke<void>(command,{enabled})).catch(e=>{
      platform().log('error',String(e));if(settingsStore.getState().agentsEnabled)settingsStore.getState().set('agentsEnabled',false);
    });
  };
  let enabled=settingsStore.getState().agentsEnabled;
  settingsStore.subscribe(s=>{
    if(s.agentsEnabled===enabled)return;enabled=s.agentsEnabled;
    sendAccess('agent_set_access',enabled);
  });
  sendAccess('agent_ready',enabled);await accessWork;
}
