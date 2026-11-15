// client.ts — the host's methods (HOST-PROTOCOL.md §3) as typed calls.
//
// Everything above this file speaks in these types; nothing above it knows
// whether the host is the C++ engine, the stdio mock or the in-page shim.

import type { FrameProjection } from '@shared/filmFrame';
import type {Rect} from '@shared/pairPresentation';
import type {
  FileMetadata,
  HelloResult,
  HostState,
  ImageInfo,
  OpenResult,
  ParamsSchema,
  ProbeResult,
  Tier,
  WireParams,
} from '@shared/protocol';
import {inAndroid} from '../mobile/bridge';
import {androidTransport} from '../mobile/transport';
import { browserTransport } from './browserShim';
import { tauriTransport } from './tauriTransport';
import { HostCallError, inTauri, type Transport } from './transport';
import { decodeTransform, type DisplayTransforms, type OutputTransform } from '@shared/colour';

export { HostCallError };

export interface CacheInfo {available:boolean;path:string;bytes:number;limit_bytes:number;entries:number;hits:number;misses:number;evictions:number}
export interface MemoryReport {total_bytes:number;pool:{free_bytes:number;live_bytes:number};persistent:{bytes?:number};pair_bitmap_cache:{bytes:number};
  system?:{total_physical_bytes:number;available_physical_bytes:number;host_resident_bytes:number;host_private_commit_bytes:number;host_peak_commit_bytes:number};
  policy?:{reserve_bytes:number;cap_bytes:number;allow_over_reserve:boolean}}

/** Top row first: native ProPhoto rgba16, or legacy/shim sRGB rgba8. */
export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8Array | Uint16Array;
  colorSpace: string;
  transforms?: DisplayTransforms;
}

export interface RenderReply extends RgbaImage {
  frame?: FrameProjection;
  pregraded?:boolean;
  pairRects?:Rect[];
  tier: Tier;
  reprinted: boolean;
  ms: number;
}

export function decodePixels(info: ImageInfo, payload: Uint8Array): RgbaImage {
  if (info.format !== 'rgba8' && info.format !== 'rgba16') throw new HostCallError('render', 'bad_request', `unknown pixels ${info.format}`);
  const bytes = info.format === 'rgba16' ? 2 : 1;
  const tight = info.width * 4 * bytes;
  if (!(Number.isSafeInteger(info.width) && Number.isSafeInteger(info.height) && info.width > 0 && info.height > 0) ||
      !Number.isSafeInteger(info.row_bytes || tight) || (info.row_bytes || tight) < tight || payload.byteLength !== (info.row_bytes || tight) * info.height)
    throw new HostCallError('render', 'bad_response', 'incomplete or invalid image payload');
  let data = payload;
  if (info.row_bytes && info.row_bytes !== tight) {
    data = new Uint8Array(tight * info.height);
    for (let y = 0; y < info.height; y++)
      data.set(payload.subarray(y * info.row_bytes, y * info.row_bytes + tight), y * tight);
  }
  let pixels: Uint8Array | Uint16Array = data;
  if (bytes === 2) {
    if (data.byteOffset % 2 === 0) pixels = new Uint16Array(data.buffer, data.byteOffset, data.byteLength / 2);
    else { const view = new DataView(data.buffer, data.byteOffset, data.byteLength); pixels = new Uint16Array(data.byteLength / 2); for (let i=0;i<pixels.length;i++) pixels[i]=view.getUint16(i*2,true); }
  }
  return { width: info.width, height: info.height, data: pixels, colorSpace: info.color_space };
}

export class Host {
  readonly transport: Transport;
  private working: Promise<boolean> | null = null;
  private displays: Promise<DisplayTransforms> | null = null;
  constructor(t: Transport) {
    this.transport = t;
  }

  get kind() {
    return this.transport.kind;
  }

  private async call<T>(method: string, params: Record<string, unknown> = {}, timeoutMs?: number) {
    const r = await this.transport.request(method, params, { timeoutMs });
    return { result: r.result as T, payload: r.payload };
  }

  state(): Promise<HostState> {
    return this.transport.state();
  }
  onState(cb: (s: HostState) => void) {
    return this.transport.onState(cb);
  }
  onEvent(cb: (e: Record<string, unknown>) => void) {
    return this.transport.onEvent(cb);
  }
  restart() {
    this.working = null; this.displays = null;
    return this.transport.restart();
  }
  diagnostics() {
    return this.transport.diagnostics();
  }

  async hello(): Promise<HelloResult> {
    return (await this.call<HelloResult>('hello')).result;
  }
  private workingPixels() {
    return this.working ??= this.hello().then(h => h.methods?.includes('output_transform') === true);
  }
  async outputTransform(source: string, target: string, colorimetric=false): Promise<OutputTransform> {
    const r = await this.call('output_transform', { source, target, colorimetric });
    return decodeTransform(r.result, r.payload);
  }
  async displayTransforms(): Promise<DisplayTransforms> {
    return this.displays ??= Promise.all([
      this.outputTransform('prophoto','srgb'), this.outputTransform('prophoto','display-p3'),
      this.outputTransform('srgb','display-p3',true),
    ]).then(([srgb,p3,originalP3])=>({srgb,p3,originalP3}));
  }
  async paramsSchema(): Promise<ParamsSchema> {
    return (await this.call<ParamsSchema>('params_schema')).result;
  }
  async cacheInfo():Promise<CacheInfo>{return (await this.call<CacheInfo>('cache_info')).result;}
  async cacheConfigure(bytes:number):Promise<CacheInfo>{return (await this.call<CacheInfo>('cache_configure',{limit_bytes:bytes})).result;}
  async cacheClear():Promise<CacheInfo>{return (await this.call<CacheInfo>('cache_clear')).result;}
  async memoryTrim(){await this.call('memory_trim');}
  async memoryConfigure(reserveMB:number,capMB:number,allowOverReserve:boolean):Promise<MemoryReport>{
    return (await this.call<MemoryReport>('memory_configure',{reserve_bytes:Math.round(reserveMB*1e6),cap_bytes:Math.round(capMB*1e6),allow_over_reserve:allowOverReserve})).result;
  }
  async memoryReport():Promise<MemoryReport>{
    return (await this.call<MemoryReport>('memory_report')).result;
  }
  async probe(path: string): Promise<ProbeResult> {
    return (await this.call<ProbeResult>('probe', { path })).result;
  }
  async neutralPoint(path:string,x:number,y:number,lensCorrection=false):Promise<{temperature_k:number;tint:number}> {
    return (await this.call<{temperature_k:number;tint:number}>('neutral_point',{path,x,y,lens_correction:lensCorrection},300_000)).result;
  }
  async thumbnail(path: string, longEdge: number): Promise<RgbaImage> {
    const r = await this.call<{ image: ImageInfo; orientation?: number }>('thumbnail', { path, long_edge: longEdge }, 60_000);
    return decodePixels(r.result.image, r.payload);
  }
  async open(path: string, params: WireParams, decode?: object | null): Promise<OpenResult> {
    const pair=path.toLowerCase().endsWith('.spektrapair');
    return (await this.call<OpenResult>('open', {path,params,...(decode?{decode}:{}),...(pair?{pair_presentation:'client'}:{})}, 300_000)).result;
  }
  async renderLayer(session:string,tier:Tier,delta:WireParams):Promise<RgbaImage> {
    const working = await this.workingPixels();
    const r=await this.call<{image:ImageInfo}>('render_layer',{session,tier,delta,format:working?'rgba16':'rgba8',display:working?'prophoto':'srgb'},900_000);
    return { ...decodePixels(r.result.image,r.payload), ...(working?{transforms:await this.displayTransforms()}:{}) };
  }
  /** Decode the session's file again with other decode settings; params are kept (R2). */
  async redecode(session: string, decode: object): Promise<OpenResult> {
    return (await this.call<OpenResult>('redecode', { session, decode }, 300_000)).result;
  }
  async close(session: string): Promise<void> {
    await this.call('close', { session });
  }
  async setParams(session: string, delta: WireParams): Promise<WireParams> {
    return (await this.call<{ params: WireParams }>('set_params', { session, delta })).result.params;
  }
  async solve(session: string, target = 'both'): Promise<Record<string, unknown>> {
    return (await this.call<Record<string, unknown>>('solve', { session, target }, 120_000)).result;
  }
  async render(session: string, tier: Tier, opts: { reprint?: boolean; progressId?: string } = {}): Promise<RenderReply> {
    const t0 = performance.now();
    const working = await this.workingPixels();
    const r = await this.call<{ image: ImageInfo; tier: Tier; reprinted: boolean }>(
      'render',
      { session, tier, reprint: opts.reprint ?? false, format: working?'rgba16':'rgba8', display: working?'prophoto':'srgb', progress_id: opts.progressId },
      tier === 'full' ? 900_000 : 180_000,
    );
    return { ...decodePixels(r.result.image, r.payload), ...(working?{transforms:await this.displayTransforms()}:{}), tier: r.result.tier ?? tier, reprinted: !!r.result.reprinted, ms: performance.now() - t0 };
  }
  async sceneLatitude(session: string, request: Record<string, unknown>): Promise<Record<string, unknown>> {
    return (await this.call<Record<string, unknown>>('scene_latitude', { session, request })).result;
  }
  /** True when the request carrying `progressId` was running (else it is refused when it reaches the worker). */
  async cancel(session: string, progressId: string): Promise<boolean> {
    return !!(await this.call<{ was_running?: boolean }>('cancel', { session, progress_id: progressId })).result?.was_running;
  }
  async exportImage(params: {
    session: string;
    path: string;
    format: 'tiff16' | 'tiff8' | 'jpeg' | 'png' | 'png16';
    quality?: number;
    color_space?: 'sRGB' | 'display-p3' | 'prophoto' | 'adobe-rgb' | 'rec2020';
    long_edge?: number;
    overwrite?: boolean;
  }): Promise<{ path: string; width: number; height: number; bytes: number }> {
    return (await this.call<{ path: string; width: number; height: number; bytes: number }>('export_image', params, 1_800_000)).result;
  }
  async exportCube(printStock: string, path: string, size?: number): Promise<{ path: string }> {
    return (await this.call<{ path: string }>('export_cube', { print_stock: printStock, path, size }, 600_000)).result;
  }
  async exportDi(session: string, printStock: string, path: string): Promise<{ path: string }> {
    return (await this.call<{ path: string }>('export_di', { session, print_stock: printStock, path }, 1_800_000)).result;
  }
  async exportCineon(session: string, path: string, geometry: object, overwrite: boolean): Promise<{ path: string; width: number; height: number; view_luts: string[] }> {
    return (await this.call<{ path: string; width: number; height: number; view_luts: string[] }>(
      'export_cineon', { session, path, geometry, overwrite }, 1_800_000)).result;
  }
}

export type { FileMetadata };

let instance: Host | null = null;
/** The one host connection for this webview. */
export function host(): Host {
  if (!instance) instance = new Host(inAndroid()?androidTransport():inTauri() ? tauriTransport() : browserTransport());
  return instance;
}
