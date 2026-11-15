import { beforeEach, expect, it, vi } from 'vitest';
import { ADJUSTMENTS_DEFAULT } from '@shared/adjustments';
import { GEOMETRY_DEFAULT } from '@shared/geometry';
import { FILM_PARAMS_DEFAULT } from '@shared/params';
import { StockCatalog } from '@shared/stocks';
import { DEFAULT_RECIPES } from './recipes';
import { exportFrame } from './exporter';

const calls = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../host/client', () => ({ host: () => ({ transport: calls }) }));
vi.mock('../platform', () => ({
  baseName: (p: string) => p.split('/').pop()!, dirName: () => '/pictures', joinPath: (...p: string[]) => p.join('/'),
  platform: () => ({ ensureDir: async () => {}, pathExists: async () => false, log: () => {} }),
}));
beforeEach(() => {
  calls.request.mockReset();
  calls.request.mockImplementation(async (method: string, params: Record<string, unknown>) => method === 'render'
    ? { result: { image: { width: 2, height: 1, row_bytes: 16, color_space: 'ProPhoto RGB' } },
      payload: new Uint8Array(new Uint16Array([10000, 20000, 30000, 65535, 40000, 25000, 15000, 65535]).buffer) }
    : { result: { path: params.path } });
});
const frame = {
  path: '/pictures/photo.ARW', session: 's1', params: FILM_PARAMS_DEFAULT,
  adjustments: { ...ADJUSTMENTS_DEFAULT, contrast: .2, saturation: .8 },
  geometry: GEOMETRY_DEFAULT, native: { width: 2, height: 1 },
};

it('all destinations receive one ProPhoto grade, and convert only after that grade', async () => {
  const payloads: number[][] = [];
  for (const colorSpace of ['sRGB', 'display-p3', 'prophoto'] as const) {
    const recipe = { ...DEFAULT_RECIPES[0]!, colorSpace, format: 'tiff' as const, bitDepth: 16 as const };
    const result = await exportFrame(recipe, frame, new StockCatalog([]), ['write_image', 'write_working_image']);
    expect(result.kind).toBe('written');
    expect(calls.request).toHaveBeenCalledWith('render', expect.objectContaining({ format: 'rgba16', display: 'prophoto' }), expect.anything());
    const write = calls.request.mock.calls.find(([method]) => method === 'write_working_image');
    expect(write).toBeDefined();
    expect(write![1]).toMatchObject({ source_color_space: 'prophoto', color_space: colorSpace });
    payloads.push([...new Uint16Array(write![2].payload.buffer)]);
    calls.request.mockClear();
  }
  expect(payloads[0]).toEqual(payloads[1]);
  expect(payloads[1]).toEqual(payloads[2]);
  expect(payloads[0]![0]).not.toBe(10000);
});

it('an old host keeps the explicitly negotiated legacy path', async () => {
  const recipe = { ...DEFAULT_RECIPES[0]!, colorSpace: 'sRGB' as const };
  const result = await exportFrame(recipe, frame, new StockCatalog([]), ['write_image']);
  expect(result.kind).toBe('written');
  expect(calls.request).toHaveBeenCalledWith('render', expect.objectContaining({ display: 'srgb' }), expect.anything());
  expect(calls.request.mock.calls.some(([m]) => m === 'write_working_image')).toBe(false);
});
