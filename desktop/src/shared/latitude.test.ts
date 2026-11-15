import {expect,it} from 'vitest';
import {latitudeReadout,type LatitudeReply} from './latitude';
const reply={medium:{shadow_ev:-2,highlight_ev:2,latitude_stops:4,y_white:1,ramp_ev:[-2,-1,0,1],ramp_y:[0,.001,.003,.004]},
  scene:{histogram:{lo_ev:-4,hi_ev:4,fractions:[.25,.25,.25,.25],placed_fractions:[0,.5,.5,0]}},fit:{}}as LatitudeReply;
it('uses the placed population and the measured CIE L* derivative',()=>{
  const r=latitudeReadout(reply);expect(r.fractions).toEqual([0,.5,.5,0]);expect(r.centres).toEqual([-3,-1,1,3]);
  // All Y samples are in L*'s linear segment: slopes 1:2:1.
  r.separation.forEach((p,i)=>expect(p.strength).toBeCloseTo([.5,1,.5][i]!,12));
  expect(r.strength(-1)).toBeCloseTo(.75);expect(r.core).toEqual([-1.5,.5]);
});
it('does not invent a separation band when the host supplied no ramp',()=>{
  const r=latitudeReadout({...reply,medium:{shadow_ev:-2,highlight_ev:2,latitude_stops:4}});
  expect(r.separation).toEqual([]);expect(r.core).toBeNull();expect(r.strength(0)).toBe(0);
});
