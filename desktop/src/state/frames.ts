// frames.ts — pixels outside the reactive store (a 45 MP rgba16 frame is
// 360 MB; the store carries a version number instead).

import type { RenderReply, RgbaImage } from '../host/client';
import {GLRenderer} from '../canvas/glRenderer';
import {GEOMETRY_DEFAULT} from '@shared/geometry';
import {ADJUSTMENTS_DEFAULT} from '@shared/adjustments';

export const frameImages: {
  /** The engine's print at its rendered tier (native ProPhoto rgba16). */
  print: RenderReply | null;
  /** The decode as the camera's embedded preview shows it (Original, Before). */
  original: RgbaImage | null;
} = { print: null, original: null };

export const THUMB_EDGE = 320;
let thumbRenderer: GLRenderer | null = null;

/** Print → colour-managed small JPEG object URL (for an <img>). */
export async function rgbaToURL(img: RgbaImage, longEdge = THUMB_EDGE): Promise<string | null> {
  try {
    const s = Math.min(1, longEdge / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * s));
    const h = Math.max(1, Math.round(img.height * s));
    if (img.data instanceof Uint16Array) {
      thumbRenderer ??= new GLRenderer(new OffscreenCanvas(1,1));
      thumbRenderer.setImage(img);
      const size={width:w,height:h};
      const data=thumbRenderer.renderOutput({viewport:size,offset:{x:0,y:0},outSize:size,display:GEOMETRY_DEFAULT,
        editingCrop:null,sourceSize:img,adjustments:ADJUSTMENTS_DEFAULT,compare:0,split:.5,surround:0},w,h);
      thumbRenderer.setImage(null);
      if(!data)return null;
      const canvas=new OffscreenCanvas(w,h);canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(data),w,h),0,0);
      return URL.createObjectURL(await canvas.convertToBlob({type:'image/jpeg',quality:.85}));
    }
    const src = new ImageData(new Uint8ClampedArray(img.data.buffer as ArrayBuffer, img.data.byteOffset, img.width * img.height * 4), img.width, img.height);
    const bmp = await createImageBitmap(src, { resizeWidth: w, resizeHeight: h, resizeQuality: 'medium' });
    const canvas = new OffscreenCanvas(w, h);
    canvas.getContext('2d')!.drawImage(bmp, 0, 0);
    bmp.close();
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
    return URL.createObjectURL(blob);
  } catch {
    return null;
  }
}

export const makeThumbFromPrint = (img: RgbaImage) => rgbaToURL(img);
