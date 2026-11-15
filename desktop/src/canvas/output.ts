// output.ts — the canvas's output, small (geometry + Layer 2 applied), for the
// surfaces that must show the canvas's frame: the navigator (and the
// histogram, which `Canvas` computes from the same pixels).

import { useSyncExternalStore } from 'react';
import { outputSize, type Geometry, type Size } from '@shared/geometry';

export interface OutputImage {
  width: number;
  height: number;
  data: Uint8Array;
}

let current: OutputImage | null = null;
const listeners = new Set<() => void>();

/** Output pixels at the available raster resolution, capped for LightTable. */
export function boundedOutputSize(geometry: Geometry, available: Size, maxEdge = 4096): Size {
  const size = outputSize(geometry, available);
  const edge = Math.max(size.width, size.height);
  const scale = Math.min(1, maxEdge / edge);
  return { width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)) };
}

export function publishOutput(img: OutputImage | null) {
  current = img;
  for (const l of listeners) l();
}

/** Read the last published canvas pixels for diagnostics and render agreement checks. */
export function canvasOutput(): OutputImage | null { return current; }

export function useOutput(): OutputImage | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
  );
}
