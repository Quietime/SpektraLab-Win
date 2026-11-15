// LatitudeReadout from the Mac model: measured CIE L* separation, not a
// decorative gradient. Old hosts without a ramp leave the band empty.
import type {FitMeasure} from './placement';
export interface LatitudeReply {
  medium:{shadow_ev:number;highlight_ev:number;latitude_stops:number;y_white?:number;ramp_ev?:number[];ramp_y?:number[]};
  scene:{histogram:{lo_ev:number;hi_ev:number;fractions:number[];placed_fractions?:number[]}};
  fit:FitMeasure;
}
export function latitudeReadout(reply:LatitudeReply){
  const h=reply.scene.histogram,f=h.placed_fractions??h.fractions;
  const centres=f.map((_,i)=>h.lo_ev+(i+.5)*(h.hi_ev-h.lo_ev)/Math.max(1,f.length));
  const white=Math.max(reply.medium.y_white??0,1e-9);
  const lstar=(value:number)=>{const t=Math.max(value,0)/white;return t>.008856?116*Math.pow(t,1/3)-16:903.3*t;};
  const ev=reply.medium.ramp_ev??[],y=(reply.medium.ramp_y??[]).map(lstar);
  const slopes:{ev:number;strength:number}[]=[];
  for(let i=0;i<Math.min(ev.length,y.length)-1;i++)if(ev[i+1]!>ev[i]!)slopes.push({ev:(ev[i]!+ev[i+1]!)/2,strength:Math.max(0,(y[i+1]!-y[i]!)/(ev[i+1]!-ev[i]!))});
  const peak=Math.max(0,...slopes.map(p=>p.strength)),separation=peak?slopes.map(p=>({...p,strength:p.strength/peak})):[];
  const full=separation.filter(p=>p.strength>=.5).map(p=>p.ev);
  const strength=(at:number)=>{
    if(!separation.length)return 0;
    if(at<=separation[0]!.ev)return separation[0]!.strength;
    if(at>=separation.at(-1)!.ev)return separation.at(-1)!.strength;
    const i=separation.findIndex(p=>p.ev>=at),a=separation[i-1]!,b=separation[i]!;
    return a.strength+(b.strength-a.strength)*(at-a.ev)/Math.max(b.ev-a.ev,1e-9);
  };
  return {fractions:f,centres,separation,strength,core:full.length?[Math.min(...full),Math.max(...full)]as const:null};
}
