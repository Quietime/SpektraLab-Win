import { describe, expect, it } from 'vitest';
import { applyFrameOrder, frameOrderFolder, frameOrderKey, moveFrameOnto } from './frameOrder';

const frames = ['A', 'B', 'C', 'D'].map(name => ({ name, path: `/roll/${name}` }));
const names = (items: typeof frames) => items.map(f => f.name);

describe('Mac FrameOrder rules', () => {
  it('moves onto the target in both directions without changing the input', () => {
    expect(names(moveFrameOnto(frames, '/roll/A', '/roll/C'))).toEqual(['B', 'C', 'A', 'D']);
    expect(names(moveFrameOnto(frames, '/roll/D', '/roll/B'))).toEqual(['A', 'D', 'B', 'C']);
    expect(names(frames)).toEqual(['A', 'B', 'C', 'D']);
    expect(moveFrameOnto(frames, 'absent', '/roll/A')).toBe(frames);
  });
  it('keeps newly added frames after their original neighbour, handles stale and duplicate names', () => {
    expect(names(applyFrameOrder(frames, ['D', 'B', 'B', 'gone']))).toEqual(['A', 'D', 'B', 'C']);
    expect(applyFrameOrder(frames, { invalid: true })).toBe(frames);
  });
  it('persists only single-folder sets, excluding stored pairs', () => {
    expect(frameOrderFolder([...frames, { name: 'pair', path: '/app/Pairs/a.spektrapair' }])).toBe('/roll');
    expect(frameOrderFolder([...frames, { name: 'other', path: '/other/E' }])).toBeNull();
    expect(frameOrderFolder([{ name: 'a', path: 'C:\\照片\\a.NEF' }])).toBe('C:/照片');
  });
  it('hashes the whole canonical folder, with a path-safe store name', async () => {
    expect(await frameOrderKey('C:\\照片\\旅行\\')).toBe(await frameOrderKey('C:/照片/旅行'));
    expect(await frameOrderKey('/one/roll')).not.toBe(await frameOrderKey('/two/roll'));
    expect(await frameOrderKey('C:\\照片')).toMatch(/^[a-f0-9]{64}\.order\.json$/);
  });
});
