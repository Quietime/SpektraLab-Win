// FrameOrder.swift: a folder owns its display order. New images retain
// their original neighbour; missing names and duplicate saved names are harmless.
type Frame = { path: string; name: string };

const canonical = (path: string) => path.replace(/\\/g, '/').replace(/\/+$/, '');

export function frameOrderFolder(frames: readonly Frame[]): string | null {
  const parents = new Set(frames.filter(f => !/\.spektrapair$/i.test(f.path)).map(f => {
    const path = canonical(f.path);
    return path.slice(0, path.lastIndexOf('/')) || '/';
  }));
  return parents.size === 1 ? [...parents][0]! : null;
}

export async function frameOrderKey(folder: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(folder)));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('') + '.order.json';
}

export function applyFrameOrder<T extends Frame>(listed: T[], names: unknown): T[] {
  if (!Array.isArray(names) || !names.every(n => typeof n === 'string')) return listed;
  const rank = new Map<string, number>();
  names.forEach((name: string, i) => { if (!rank.has(name)) rank.set(name, i); });
  const out = listed.filter(f => rank.has(f.name)).sort((a, b) => rank.get(a.name)! - rank.get(b.name)!);
  listed.forEach((frame, i) => {
    if (rank.has(frame.name)) return;
    const before = i > 0 ? out.findIndex(f => f.path === listed[i - 1]!.path) : -1;
    out.splice(before + 1, 0, frame);
  });
  return out;
}

export function moveFrameOnto<T extends Frame>(frames: T[], path: string, target: string): T[] {
  const from = frames.findIndex(f => f.path === path), to = frames.findIndex(f => f.path === target);
  if (from < 0 || to < 0 || from === to) return frames;
  const out = [...frames];
  const [frame] = out.splice(from, 1);
  out.splice(to, 0, frame!);
  return out;
}
