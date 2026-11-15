// Mac 1.3.3's AgentSchema, extracted by scripts/gen-agent-fields.py.
import extracted from './fields.json';
import {EXPOSURE_METHODS,FILM_FRAMES,FILM_EDGE_FORMATS} from '@shared/params';
import {WB_MODES} from '@shared/whiteBalance';
import type {StockCatalog} from '@shared/stocks';
import type {Sidecar} from '@shared/sidecar';

export type EditDocument=Pick<Sidecar,'params'|'adjustments'|'geometry'|'decode'>;
export interface AgentField {path:string;doc:string;type:string;min?:number;max?:number;enum?:string[];readOnly?:string;choiceSource?:string}
const choices:Record<string,readonly string[]>={
  'params.autoExposureMethod':EXPOSURE_METHODS,'params.filmFrame':FILM_FRAMES.map(f=>f.id),
  'params.filmSide':['long','short'],'params.filmEdge.format':FILM_EDGE_FORMATS,
  'params.filmEdge.view':['strip','filed'],'params.filmEdge.gate':['auto','square','rounded','eared','shouldered','kicked'],
  'params.filmEdge.holes':['white','black'],'params.dateBack.face':['lcd','dots','data'],
  'params.dateBack.order':['us','japan'],'params.dateBack.placement':['frame','rebate'],
  'params.dateBack.corner':['br','bl','tr','tl'],'params.dateBack.camera':['135','135_half','120_645'],
  'geometry.aspect':['free','original','originalPortrait','square','r3x2','r2x3','r4x3','r3x4','r16x9','r9x16','r5x4','r4x5','r7x5','r5x7'],
  'decode.whiteBalance':WB_MODES,
};
export function agentFields(catalog:StockCatalog):AgentField[]{
  return (extracted as AgentField[]).map(f=>{
    const row={...f};
    if(f.choiceSource){
      if(!choices[f.path])throw new Error(`Missing Mac agent choices for ${f.path}`);
      row.enum=[...choices[f.path]!];delete row.choiceSource;
    }
    if(f.type==='film'||f.type==='paper')row.enum=(f.type==='film'?catalog.films:catalog.papers).map(s=>s.id);
    if(['choice','film','paper'].includes(f.type))row.type='string';
    if(f.type==='bool')row.type='boolean';
    return row;
  });
}
export function editDocument(sidecar:Sidecar):EditDocument {
  return structuredClone({params:sidecar.params,adjustments:sidecar.adjustments,geometry:sidecar.geometry,decode:sidecar.decode});
}
export const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
export function validatePatch(patch:unknown,catalog:StockCatalog):string[]{
  if(!object(patch))throw new Error('An edit must be a JSON object.');
  const fields=new Map(agentFields(catalog).map(f=>[f.path,f]));
  const branches=new Set<string>();for(const path of fields.keys()){
    const parts=path.split('.');while(parts.length>1){parts.pop();branches.add(parts.join('.'));}
  }
  const written:string[]=[];
  const walk=(v:unknown,path:string)=>{
    const field=fields.get(path);
    if(!field){
      if(!branches.has(path))throw new Error(`${path} is not an editable field. Read get_schema.`);
      if(!object(v))throw new Error(`${path} must be an object.`);
      for(const key of Object.keys(v).sort())walk(v[key],`${path}.${key}`);
      return;
    }
    if(field.readOnly)throw new Error(`${path} is read-only: ${field.readOnly}`);
    const no=()=>{throw new Error(`${path} must match ${JSON.stringify(field)}.`);};
    if(field.type==='number'||field.type==='integer'){
      if(typeof v!=='number'||!Number.isFinite(v)||v<field.min!||v>field.max!||
        (field.type==='integer'&&!Number.isInteger(v)))no();
    }else if(field.type==='boolean'){if(typeof v!=='boolean')no();}
    else if(field.type==='string'){if(typeof v!=='string'||!field.enum?.includes(v))no();}
    else if(field.type==='points'){
      if(!Array.isArray(v)||v.length<2)no();
      const points=v as unknown[];let previous=-1;
      for(const p of points){
        if(!Array.isArray(p)||p.length!==2||p.some(n=>typeof n!=='number'||!Number.isFinite(n)||n<0||n>1)||p[0]<=previous)no();
        previous=(p as number[])[0]!;
      }
      if((points[0] as number[])[0]!==0||(points.at(-1) as number[])[0]!==1)no();
    }else no();
    written.push(path);
  };
  for(const key of Object.keys(patch).sort())walk(patch[key],key);
  return written;
}
export function patchedDocument(current:EditDocument,patch:unknown,catalog:StockCatalog):{document:EditDocument;written:string[]}{
  const written=validatePatch(patch,catalog);
  const merge=(a:unknown,b:unknown):unknown=>{
    if(!object(b))return structuredClone(b);
    const out={...(object(a)?a:{})};for(const [key,value] of Object.entries(b))out[key]=merge(out[key],value);return out;
  };
  return {document:merge(current,patch) as EditDocument,written};
}
