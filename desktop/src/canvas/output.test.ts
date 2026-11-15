import { describe, expect, it } from 'vitest';
import { GEOMETRY_DEFAULT } from '@shared/geometry';
import { boundedOutputSize } from './output';

describe('bounded LightTable output size', () => {
  it('keeps a small available print at its native raster size', () => {
    expect(boundedOutputSize(GEOMETRY_DEFAULT, { width: 192, height: 128 })).toEqual({ width: 192, height: 128 });
  });

  it('caps large available prints at 4096 pixels without upscaling', () => {
    expect(boundedOutputSize(GEOMETRY_DEFAULT, { width: 9000, height: 6000 })).toEqual({ width: 4096, height: 2731 });
    expect(boundedOutputSize(GEOMETRY_DEFAULT, { width: 2400, height: 1600 })).toEqual({ width: 2400, height: 1600 });
  });

  it('applies crop and quarter-turn before capping, preserving output aspect', () => {
    const geometry = {
      ...GEOMETRY_DEFAULT,
      crop: { x: 0.1, y: 0.2, width: 0.5, height: 0.25 },
      quarterTurns: 1,
    };
    const size = boundedOutputSize(geometry, { width: 9000, height: 6000 });
    expect(size).toEqual({ width: 1365, height: 4096 });
    expect(size.width / size.height).toBeCloseTo(1 / 3, 3);
  });
});
