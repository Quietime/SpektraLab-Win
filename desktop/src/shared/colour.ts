// The numbers belong to spk_output_transform, never a second colour library.
export interface OutputTransform {
  matrix: number[];
  source_cctf_mode: number;
  target_cctf_mode: number;
  gamut_compress: {
    algorithm: string;
    lightness_compression_active: boolean;
    m_to_xyz: number[];
    m_to_rgb: number[];
    k: number[];
    cmax_rows: number;
    cmax_cols: number;
  };
  cmax: Float32Array;
}
export interface DisplayTransforms {
  srgb: OutputTransform;
  p3: OutputTransform;
  originalP3: OutputTransform;
}
export function decodeTransform(value: unknown, payload: Uint8Array): OutputTransform {
  const t = value as OutputTransform;
  const g = t?.gamut_compress;
  const finite = (v: unknown, n: number) => Array.isArray(v) && v.length === n && v.every(x => typeof x === 'number' && Number.isFinite(x));
  if (!finite(t?.matrix, 9) || !finite(g?.m_to_xyz, 9) || !finite(g?.m_to_rgb, 9) || !finite(g?.k, 22) ||
      !Number.isInteger(g?.cmax_rows) || !Number.isInteger(g?.cmax_cols) || g.cmax_rows < 2 || g.cmax_cols < 2 ||
      payload.byteLength !== g.cmax_rows * g.cmax_cols * 4) throw new Error('Invalid output-transform constants or C_max table');
  const bytes = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const cmax = new Float32Array(payload.byteLength / 4);
  for (let i = 0; i < cmax.length; i++) {
    cmax[i] = bytes.getFloat32(i * 4, true);
    if (!Number.isFinite(cmax[i]) || cmax[i]! < 0) throw new Error('Invalid C_max sample');
  }
  return { ...t, cmax };
}
