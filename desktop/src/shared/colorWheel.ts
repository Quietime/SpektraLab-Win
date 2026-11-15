// ColorBalanceLayout.Arc, including the left arc's atan2 seam.
export type WheelArc='saturation'|'luminance';
export function arcTheta(fraction:number,side:WheelArc){
  const f=Math.max(0,Math.min(1,fraction));return side==='saturation'?245-130*f:-65+130*f;
}
export function arcValue(theta:number,side:WheelArc){
  const bottom=arcTheta(0,side),top=arcTheta(1,side),mid=(bottom+top)/2;
  while(theta-mid>180)theta-=360;while(theta-mid< -180)theta+=360;
  const f=Math.max(0,Math.min(1,(theta-bottom)/(top-bottom)));
  return side==='saturation'?f:-1+2*f;
}
