import {expect,it}from 'vitest';
import {arcTheta,arcValue}from './colorWheel';
it('maps physical atan2 angles over both arc ranges, including the left lower half',()=>{
  for(const side of ['saturation','luminance']as const)for(const fraction of [0,.1,.25,.5,.75,.9,1]){
    const theta=arcTheta(fraction,side),a=theta*Math.PI/180;
    const physical=Math.atan2(Math.sin(a),Math.cos(a))*180/Math.PI;
    expect(arcValue(physical,side)).toBeCloseTo(side==='saturation'?fraction:-1+2*fraction,12);
  }
  expect(arcValue(-115,'saturation')).toBeCloseTo(0,12);
  expect(arcValue(115,'saturation')).toBeCloseTo(1,12);
});
