// glRenderer.ts — the canvas, in WebGL2 (the Mac's `Canvas/Renderer.swift`
// + `canvasFragment` and `layer2` in Shaders.metal, folded into one pass).
//
// Native hosts hand over ProPhoto rgba16. The shader applies Layer 2 at
// source precision, resamples geometry, then uses the engine's output
// transform and Cmax table for the canvas's sRGB or Display P3 surface.
// Legacy hosts and the layout shim retain rgba8. The geometry map is `geometryMap` from the Metal
// shader, transliterated; `src/shared/geometry.ts::shaderMap` is the same
// function in TypeScript and `geometry.test.ts` pins it to the model's
// `sourcePoint`, so the canvas, the export and the navigator agree (trap 33).
//
// The same program renders the *output* (geometry + Layer 2, no viewport) to
// an offscreen target for the navigator and the histogram, so those surfaces
// show exactly the canvas's frame.

import type { FrameProjection } from '@shared/filmFrame';
import { type Adjustments, CURVE_TABLE_SIZE, SRGB_MID_GREY, PROPHOTO_MID_GREY, curveTables, layer2Uniforms } from '@shared/adjustments';
import { type Geometry, type GeometryUniform, GEOMETRY_DEFAULT, uniform } from '@shared/geometry';
import type { RgbaImage } from '../host/client';
import type { DisplayTransforms, OutputTransform } from '@shared/colour';
import { OUTPUT_COLOUR_GLSL } from './colourShader';

const VERT = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = vec2(aPos.x * 0.5 + 0.5, 0.5 - aPos.y * 0.5);
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
precision highp usampler2D;
in vec2 vUv;
out vec4 outColor;

uniform sampler2D uImage;
uniform usampler2D uImage16;
uniform bool uImageIs16;
uniform bool uWide;
uniform float oOriginalMatrix[9];
uniform sampler2D uOriginal;
uniform bool uFramed;
uniform vec3 uOriginalX;
uniform vec3 uOriginalY;
uniform vec3 uGateX;
uniform vec3 uGateY;
uniform bool uPair;
uniform vec3 uOriginalBX;
uniform vec3 uOriginalBY;
uniform vec3 uGateBX;
uniform vec3 uGateBY;
uniform sampler2D uCurves;
uniform bool uHasImage;
uniform bool uHasOriginal;

// viewport: output uv = (fragPx - offset) / size
uniform vec2 uViewport;      // device px
uniform vec2 uOffset;        // device px, top-left of the output
uniform vec2 uOutSize;       // device px of the output on screen
uniform bool uOffscreen;     // render the output itself (navigator, histogram)
uniform float uSurround;

// geometry (display) — GeometryUniform
uniform vec2 gCentre;
uniform vec2 gHalf;
uniform vec2 gCosSin;
uniform vec2 gPixelRatio;
uniform int gTurns;
uniform int gFlips;
uniform bool gActive;

// crop being edited: dim outside it
uniform bool uEditingCrop;
uniform vec2 cCentre;
uniform vec2 cHalf;
uniform vec2 cCosSin;

uniform int uCompare;        // 0 off, 1 split, 2 original only
uniform float uSplit;

// layer 2
uniform bool lEnabled;
uniform vec3 lWb;
uniform float lExposure;
uniform float lContrast;
uniform float lBrightness;
uniform float lSaturation;
uniform float lHighlights;
uniform float lShadows;
uniform float lBlack;
uniform float lWhite;
uniform vec3 lCbMaster;
uniform vec3 lCbShadows;
uniform vec3 lCbMidtones;
uniform vec3 lCbHighlights;
uniform vec4 lCbLum;
uniform float lVignetteAmount;
uniform float lVignetteMid;
uniform float lMidGrey;
uniform bool lCurves;
${OUTPUT_COLOUR_GLSL}

// Integer textures retain every 16-bit code value and need neither fp16
// storage nor optional float-linear filtering. Interpolate before Layer 2.
vec3 layer2(vec3 c,vec2 suv);
vec3 gradedTexel(ivec2 p,ivec2 sz) {
  ivec2 q=clamp(p,ivec2(0),sz-ivec2(1));
  vec3 c=vec3(texelFetch(uImage16,q,0).rgb)/65535.;
  // Mac stores Layer 2 in rgba16Unorm before geometry samples it.
  return floor(clamp(layer2(c,(vec2(q)+.5)/vec2(sz)),0.,1.)*65535.+.5)/65535.;
}
vec3 imageSample(vec2 uv) {
  if(!uImageIs16) return texture(uImage,uv).rgb;
  ivec2 sz=textureSize(uImage16,0);
  vec2 p=uv*vec2(sz)-.5, f=fract(p); ivec2 q=ivec2(floor(p));
  vec3 a=gradedTexel(q,sz),b=gradedTexel(q+ivec2(1,0),sz);
  vec3 c=gradedTexel(q+ivec2(0,1),sz),d=gradedTexel(q+ivec2(1,1),sz);
  return mix(mix(a,b,f.x),mix(c,d,f.x),f.y);
}
vec3 srgbToP3(vec3 c) {
  vec3 v=mix(c/12.92,pow((c+.055)/1.055,vec3(2.4)),greaterThan(c,vec3(.040449936)));
  vec3 lin=vec3(dot(vec3(oOriginalMatrix[0],oOriginalMatrix[1],oOriginalMatrix[2]),v),
                dot(vec3(oOriginalMatrix[3],oOriginalMatrix[4],oOriginalMatrix[5]),v),
                dot(vec3(oOriginalMatrix[6],oOriginalMatrix[7],oOriginalMatrix[8]),v));
  return vec3(outputEncode(lin.r),outputEncode(lin.g),outputEncode(lin.b));
}

vec2 geometryMap(vec2 uv) {
  if (!gActive) return uv;
  vec2 u = uv;
  if ((gFlips & 1) != 0) u.x = 1.0 - u.x;
  if ((gFlips & 2) != 0) u.y = 1.0 - u.y;
  if (gTurns == 1) u = vec2(u.y, 1.0 - u.x);
  else if (gTurns == 2) u = vec2(1.0 - u.x, 1.0 - u.y);
  else if (gTurns == 3) u = vec2(1.0 - u.y, u.x);
  float px = (u.x - 0.5) * 2.0 * gHalf.x;
  float py = (u.y - 0.5) * 2.0 * gHalf.y * gPixelRatio.y;
  float rx = px * gCosSin.x - py * gCosSin.y;
  float ry = px * gCosSin.y + py * gCosSin.x;
  return vec2(gCentre.x + rx, gCentre.y + ry * gPixelRatio.x);
}

bool insideCrop(vec2 suv) {
  float dx = suv.x - cCentre.x;
  float dy = (suv.y - cCentre.y) * gPixelRatio.y;
  float lx =  dx * cCosSin.x + dy * cCosSin.y;
  float ly = -dx * cCosSin.y + dy * cCosSin.x;
  return abs(lx) <= cHalf.x && abs(ly) <= cHalf.y * gPixelRatio.y;
}

float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

float tonePosition(float l, float m0) {
  float m = clamp(m0, 0.0, 1.0);
  if (m <= 0.0 || m >= 1.0) m = 0.5;
  return (l <= m) ? 0.5 * l / m : 0.5 + 0.5 * (l - m) / (1.0 - m);
}

float curve(float x, int row) {
  float q=clamp(x,0.,1.)*${CURVE_TABLE_SIZE-1}.;
  int i=int(floor(q));
  return mix(texelFetch(uCurves,ivec2(i,row),0).r,texelFetch(uCurves,ivec2(min(i+1,${CURVE_TABLE_SIZE-1}),row),0).r,fract(q));
}

vec3 layer2(vec3 c, vec2 suv) {
  if (!lEnabled) return c;
  c *= lWb;
  if (lExposure != 1.0) c = pow(pow(max(c, 0.0), vec3(2.2)) * lExposure, vec3(1.0 / 2.2));
  if (lContrast != 0.0) { float k = 1.0 + lContrast * 1.2; c = (c - lMidGrey) * k + lMidGrey; }
  if (lBrightness != 0.0) c = pow(max(c, 0.0), vec3(1.0 / (1.0 + lBrightness * 0.8)));
  float l = tonePosition(luma(c), lMidGrey);
  if (lShadows != 0.0) { float w = (1.0 - l); w = w * w; c += lShadows * 0.25 * w * (1.0 - c); }
  if (lHighlights != 0.0) { float w = l * l; c += lHighlights * 0.25 * w * (lHighlights > 0.0 ? (1.0 - c) : c); }
  c = (c - lBlack) / max(1.0 - lBlack - lWhite, 0.05);
  l = luma(c);
  c = l + (c - l) * lSaturation;
  float ls = clamp(tonePosition(l, lMidGrey), 0.0, 1.0);
  float wS = (1.0 - ls) * (1.0 - ls);
  float wH = ls * ls;
  float wM = max(1.0 - wS - wH, 0.0);
  c += lCbMaster + lCbShadows * wS + lCbMidtones * wM + lCbHighlights * wH;
  c *= 1.0 + lCbLum.x + lCbLum.y * wS + lCbLum.z * wM + lCbLum.w * wH;
  if (lCurves) {
    c = clamp(c, 0.0, 1.0);
    float ly = luma(c);
    float ly2 = curve(ly, 1);
    c *= (ly > 1e-4) ? (ly2 / ly) : 1.0;
    c = clamp(c, 0.0, 1.0);
    c = vec3(curve(c.r, 0), curve(c.g, 0), curve(c.b, 0));
    c = vec3(curve(c.r, 2), curve(c.g, 3), curve(c.b, 4));
  }
  if (lVignetteAmount != 0.0) {
    vec2 p = suv - 0.5;
    float d = length(p * 2.0);
    float fall = smoothstep(lVignetteMid * 1.2, 1.5, d);
    c *= 1.0 + lVignetteAmount * fall * 0.9;
  }
  return clamp(c, 0.0, 1.0);
}

void main() {
  vec2 ouv;
  if (uOffscreen) {
    ouv = vUv;
  } else {
    vec2 px = vUv * uViewport;
    ouv = (px - uOffset) / uOutSize;
    if (ouv.x < 0.0 || ouv.y < 0.0 || ouv.x > 1.0 || ouv.y > 1.0) {
      outColor = vec4(vec3(uSurround), 1.0);
      return;
    }
  }
  vec2 suv = geometryMap(ouv);
  if (suv.x < 0.0 || suv.y < 0.0 || suv.x > 1.0 || suv.y > 1.0) {
    outColor = vec4(vec3(uSurround), 1.0);
    return;
  }
  bool before = uCompare == 2 || (uCompare == 1 && ouv.x < uSplit);
  vec3 c;
  vec2 originalUV = uFramed ? vec2(dot(uOriginalX, vec3(suv, 1.0)), dot(uOriginalY, vec3(suv, 1.0))) : suv;
  vec2 gateUV = uFramed ? vec2(dot(uGateX, vec3(suv, 1.0)), dot(uGateY, vec3(suv, 1.0))) : suv;
  bool onPicture = !uFramed || (all(greaterThanEqual(gateUV, vec2(0.0))) && all(lessThanEqual(gateUV, vec2(1.0))));
  if(uPair&&!onPicture) {
    vec2 b=vec2(dot(uGateBX,vec3(suv,1.0)),dot(uGateBY,vec3(suv,1.0)));
    onPicture=all(greaterThanEqual(b,vec2(0.0)))&&all(lessThanEqual(b,vec2(1.0)));
    if(onPicture) originalUV=vec2(dot(uOriginalBX,vec3(suv,1.0)),dot(uOriginalBY,vec3(suv,1.0)));
  }
  if (before && uHasOriginal && onPicture) {
    c = texture(uOriginal, originalUV).rgb;
    if(uWide) c=srgbToP3(c);
  } else if (uHasImage) {
    c = uImageIs16 ? imageSample(suv) : layer2(imageSample(suv), suv);
    if(uImageIs16) c=outputColour(floor(clamp(c,0.,1.)*65535.+.5)/65535.);
  } else {
    c = vec3(uSurround);
  }
  if (uEditingCrop && !insideCrop(suv)) c *= 0.4;
  outColor = vec4(c, 1.0);
}`;

export interface DrawState {
  /** Device px of the canvas. */
  viewport: { width: number; height: number };
  /** Device px: where the output's top-left is and how big it is on screen. */
  offset: { x: number; y: number };
  outSize: { width: number; height: number };
  /** The geometry used to map output → source (identity-crop while cropping). */
  display: Geometry;
  /** The crop being edited (dims outside), or null. */
  editingCrop: Geometry | null;
  /** The source's size in pixels (the native frame's; the texture may be smaller). */
  sourceSize: { width: number; height: number };
  adjustments: Adjustments;
  compare: 0 | 1 | 2;
  frame?: FrameProjection;
  split: number;
  surround: number;
}

export class GLRenderer {
  readonly gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private loc = new Map<string, WebGLUniformLocation | null>();
  private image: WebGLTexture;
  private image16: WebGLTexture;
  private cmax: WebGLTexture;
  private imageIs16 = false;
  private transforms?: DisplayTransforms;
  private loadedTransform?: OutputTransform;
  private wide = false;
  private preferWide: boolean;
  private original: WebGLTexture;
  private curves: WebGLTexture;
  private hasImage = false;
  private hasOriginal = false;
  private curvesKey = '';
  private fbo: WebGLFramebuffer | null = null;
  private fboTex: WebGLTexture | null = null;
  private fboSize = { width: 0, height: 0 };
  readonly maxTexture: number;

  constructor(canvas: HTMLCanvasElement | OffscreenCanvas) {
    const gl = canvas.getContext('webgl2', { antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: true }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error('WebGL2 is not available in this webview');
    this.gl = gl;
    this.preferWide = 'ownerDocument' in canvas && typeof matchMedia === 'function' && matchMedia('(color-gamut: p3)').matches;
    this.maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    this.program = this.link();
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const a = gl.getAttribLocation(this.program, 'aPos');
    gl.enableVertexAttribArray(a);
    gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0);
    this.image = this.texture(gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA8,1,1,0,gl.RGBA,gl.UNSIGNED_BYTE,new Uint8Array([0,0,0,255]));
    this.image16 = this.texture(gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA16UI,1,1,0,gl.RGBA_INTEGER,gl.UNSIGNED_SHORT,new Uint16Array([0,0,0,65535]));
    this.cmax = this.texture(gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.R32F,1,1,0,gl.RED,gl.FLOAT,new Float32Array([0]));
    this.original = this.texture(gl.LINEAR);
    this.curves = this.texture(gl.NEAREST);
  }

  private link(): WebGLProgram {
    const gl = this.gl;
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('shader: ' + gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VERT));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('program: ' + gl.getProgramInfoLog(p));
    return p;
  }

  private texture(filter: number): WebGLTexture {
    const gl = this.gl;
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  private u(name: string) {
    if (!this.loc.has(name)) this.loc.set(name, this.gl.getUniformLocation(this.program, name));
    return this.loc.get(name)!;
  }

  /** Upload rgba8 (top row first). A frame larger than the GPU allows is refused. */
  private upload(tex: WebGLTexture, img: { width: number; height: number; data: Uint8Array } | null): boolean {
    if (!img) return false;
    if (img.width > this.maxTexture || img.height > this.maxTexture) return false;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, img.width, img.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, img.data);
    return true;
  }

  setImage(img: Pick<RgbaImage,'width'|'height'|'data'> & Partial<Pick<RgbaImage,'transforms'|'colorSpace'>> | null) {
    if(!img){
      const gl=this.gl;
      gl.bindTexture(gl.TEXTURE_2D,this.image16);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA16UI,1,1,0,gl.RGBA_INTEGER,gl.UNSIGNED_SHORT,null);
      gl.bindTexture(gl.TEXTURE_2D,this.image);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA8,1,1,0,gl.RGBA,gl.UNSIGNED_BYTE,null);
    }
    this.imageIs16 = img?.data instanceof Uint16Array;
    this.transforms = img?.transforms;
    this.wide = false;
    if ('drawingBufferColorSpace' in this.gl) {
      try { this.gl.drawingBufferColorSpace = this.preferWide && this.imageIs16 && this.transforms ? 'display-p3' : 'srgb'; this.wide = this.gl.drawingBufferColorSpace === 'display-p3'; } catch { this.gl.drawingBufferColorSpace='srgb'; }
    }
    if (img?.data instanceof Uint16Array) {
      if (!img.transforms || !/prophoto/i.test(img.colorSpace??'')) throw new Error('16-bit working image has no ProPhoto output transform');
      if(img.width>this.maxTexture||img.height>this.maxTexture)throw new Error('Working image exceeds the GPU texture limit');
      const gl=this.gl;gl.bindTexture(gl.TEXTURE_2D,this.image16);gl.pixelStorei(gl.UNPACK_ALIGNMENT,1);
      gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA16UI,img.width,img.height,0,gl.RGBA_INTEGER,gl.UNSIGNED_SHORT,img.data);
      this.hasImage = true;
    } else this.hasImage = this.upload(this.image, img as {width:number;height:number;data:Uint8Array}|null);
  }
  setOriginal(img: Pick<RgbaImage,'width'|'height'|'data'> | null) {
    if (img?.data instanceof Uint16Array) throw new Error('Original camera preview must be sRGB rgba8');
    this.hasOriginal = this.upload(this.original, img as {width:number;height:number;data:Uint8Array}|null);
  }

  private setCurves(a: Adjustments) {
    const key = JSON.stringify(a.curves);
    if (key === this.curvesKey) return;
    this.curvesKey = key;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.curves);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, CURVE_TABLE_SIZE, 5, 0, gl.RED, gl.FLOAT, curveTables(a.curves));
  }

  private setGeometry(prefix: 'g', u: GeometryUniform) {
    const gl = this.gl;
    gl.uniform2f(this.u(prefix + 'Centre'), u.centre[0], u.centre[1]);
    gl.uniform2f(this.u(prefix + 'Half'), u.halfExtent[0], u.halfExtent[1]);
    gl.uniform2f(this.u(prefix + 'CosSin'), u.cosSin[0], u.cosSin[1]);
    gl.uniform2f(this.u(prefix + 'PixelRatio'), u.pixelRatio[0], u.pixelRatio[1]);
    gl.uniform1i(this.u(prefix + 'Turns'), u.quarterTurns);
    gl.uniform1i(this.u(prefix + 'Flips'), u.flips);
    gl.uniform1i(this.u(prefix + 'Active'), u.active ? 1 : 0);
  }

  private bind(s: DrawState, offscreen: boolean) {
    const gl = this.gl;
    gl.useProgram(this.program);
    this.setCurves(s.adjustments);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.image);
    gl.uniform1i(this.u('uImage'), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.original);
    gl.uniform1i(this.u('uOriginal'), 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.curves);
    gl.uniform1i(this.u('uCurves'), 2);
    gl.activeTexture(gl.TEXTURE3);gl.bindTexture(gl.TEXTURE_2D,this.image16);gl.uniform1i(this.u('uImage16'),3);
    gl.activeTexture(gl.TEXTURE4);gl.bindTexture(gl.TEXTURE_2D,this.cmax);gl.uniform1i(this.u('oCmax'),4);
    const transform=this.transforms?.[!offscreen&&this.wide?'p3':'srgb'];
    if(transform){
      const g=transform.gamut_compress;
      if(this.loadedTransform!==transform){
        gl.texImage2D(gl.TEXTURE_2D,0,gl.R32F,g.cmax_cols,g.cmax_rows,0,gl.RED,gl.FLOAT,transform.cmax);
        this.loadedTransform=transform;
      }
      gl.uniform1fv(this.u('oMatrix[0]'),transform.matrix);gl.uniform1fv(this.u('oM2X[0]'),g.m_to_xyz);
      gl.uniform1fv(this.u('oM2R[0]'),g.m_to_rgb);gl.uniform1fv(this.u('oK[0]'),g.k);
      gl.uniform1i(this.u('oRows'),g.cmax_rows);gl.uniform1i(this.u('oCols'),g.cmax_cols);
      gl.uniform1i(this.u('oActive'),g.algorithm==='off'?0:1);gl.uniform1i(this.u('oLightness'),g.lightness_compression_active?1:0);
      gl.uniform1fv(this.u('oOriginalMatrix[0]'),this.transforms!.originalP3.matrix);
    }
    gl.uniform1i(this.u('oIdentity'),this.imageIs16?0:1);
    gl.uniform1i(this.u('uImageIs16'),this.imageIs16?1:0);gl.uniform1i(this.u('uWide'),!offscreen&&this.wide?1:0);
    gl.uniform1i(this.u('uHasImage'), this.hasImage ? 1 : 0);
    gl.uniform1i(this.u('uHasOriginal'), this.hasOriginal ? 1 : 0);
    gl.uniform1i(this.u('uFramed'), s.frame ? 1 : 0);
    gl.uniform1i(this.u('uPair'),s.frame?.second?1:0);
    for (const [prefix, m] of [['uOriginal', s.frame?.original], ['uGate', s.frame?.gate],['uOriginalB',s.frame?.second?.original],['uGateB',s.frame?.second?.gate]] as const) {
      const a = m ?? [1, 0, 0, 1, 0, 0];
      gl.uniform3f(this.u(prefix + 'X'), a[0]!, a[2]!, a[4]!);
      gl.uniform3f(this.u(prefix + 'Y'), a[1]!, a[3]!, a[5]!);
    }
    gl.uniform2f(this.u('uViewport'), s.viewport.width, s.viewport.height);
    gl.uniform2f(this.u('uOffset'), s.offset.x, s.offset.y);
    gl.uniform2f(this.u('uOutSize'), s.outSize.width, s.outSize.height);
    gl.uniform1i(this.u('uOffscreen'), offscreen ? 1 : 0);
    gl.uniform1f(this.u('uSurround'), s.surround);
    this.setGeometry('g', uniform(s.display, s.sourceSize));
    const crop = s.editingCrop ? uniform(s.editingCrop, s.sourceSize) : uniform(GEOMETRY_DEFAULT, s.sourceSize);
    gl.uniform1i(this.u('uEditingCrop'), s.editingCrop && !offscreen ? 1 : 0);
    gl.uniform2f(this.u('cCentre'), crop.centre[0], crop.centre[1]);
    gl.uniform2f(this.u('cHalf'), crop.halfExtent[0], crop.halfExtent[1]);
    gl.uniform2f(this.u('cCosSin'), crop.cosSin[0], crop.cosSin[1]);
    gl.uniform1i(this.u('uCompare'), offscreen ? 0 : s.compare);
    gl.uniform1f(this.u('uSplit'), s.split);
    const l = layer2Uniforms(s.adjustments, this.imageIs16 ? PROPHOTO_MID_GREY : SRGB_MID_GREY);
    gl.uniform1i(this.u('lEnabled'), l.enabled ? 1 : 0);
    gl.uniform3f(this.u('lWb'), ...l.wbGain);
    gl.uniform1f(this.u('lExposure'), l.exposureGain);
    gl.uniform1f(this.u('lContrast'), l.contrast);
    gl.uniform1f(this.u('lBrightness'), l.brightness);
    gl.uniform1f(this.u('lSaturation'), l.saturation);
    gl.uniform1f(this.u('lHighlights'), l.highlights);
    gl.uniform1f(this.u('lShadows'), l.shadows);
    gl.uniform1f(this.u('lBlack'), l.blackPoint);
    gl.uniform1f(this.u('lWhite'), l.whitePoint);
    gl.uniform3f(this.u('lCbMaster'), ...l.cbMaster);
    gl.uniform3f(this.u('lCbShadows'), ...l.cbShadows);
    gl.uniform3f(this.u('lCbMidtones'), ...l.cbMidtones);
    gl.uniform3f(this.u('lCbHighlights'), ...l.cbHighlights);
    gl.uniform4f(this.u('lCbLum'), ...l.cbLum);
    gl.uniform1f(this.u('lVignetteAmount'), l.vignetteAmount);
    gl.uniform1f(this.u('lVignetteMid'), l.vignetteMidpoint);
    gl.uniform1f(this.u('lMidGrey'), l.midGrey);
    gl.uniform1i(this.u('lCurves'), l.curvesActive ? 1 : 0);
  }

  draw(s: DrawState) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, s.viewport.width, s.viewport.height);
    this.bind(s, false);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  /**
   * The output (geometry + Layer 2, no viewport, no compare) at `width` ×
   * `height`, read back as rgba8 top row first: the navigator's and the
   * histogram's picture.
   */
  renderOutput(s: DrawState, width: number, height: number): Uint8Array | null {
    if (!this.hasImage) return null;
    const gl = this.gl;
    if (!this.fbo || this.fboSize.width !== width || this.fboSize.height !== height) {
      if (this.fbo) gl.deleteFramebuffer(this.fbo);
      if (this.fboTex) gl.deleteTexture(this.fboTex);
      this.fboTex = this.texture(gl.NEAREST);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      this.fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.fboTex, 0);
      this.fboSize = { width, height };
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, width, height);
    this.bind({ ...s, viewport: { width, height } }, true);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    const out = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, out);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    // GL's rows are bottom-up; the vertex shader's uv is top-down, so row 0
    // of the framebuffer is the output's *bottom*. Flip into top-first.
    const row = width * 4;
    const flipped = new Uint8Array(out.length);
    for (let y = 0; y < height; y++) flipped.set(out.subarray((height - 1 - y) * row, (height - y) * row), y * row);
    return flipped;
  }
}
