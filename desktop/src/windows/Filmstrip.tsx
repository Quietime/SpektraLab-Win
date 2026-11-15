// Filmstrip.tsx — one cell per frame (`Panels/Filmstrip.swift`). Each shows
// the **whole** photograph, turned and flipped, with the outside of the crop
// under an 82 % mask (Capture One's behaviour; ARCHITECTURE §7.7): the live
// geometry for the open frame, the saved one for the rest.
//
// Click opens (and collapses the picked set); Ctrl/Cmd-click toggles one
// frame in the set and leaves the canvas where it is.

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ChevronLeft, ChevronRight } from '../controls/icons';
import { click, selectRelative, useSession, createPair, moveFrame, saveFrameOrder, sessionStore } from '../state/session';
import { thumbs } from '../state/thumbs';
import { type Geometry, GEOMETRY_DEFAULT } from '@shared/geometry';
import { thumbnailGeometryPlan } from '@shared/surfaces';
import { t, tz } from '../i18n';

export function Filmstrip() {
  const frames = useSession((s) => s.frames);
  const selection = useSession((s) => s.selection);
  const picked = useSession((s) => s.picked);
  const live = useSession((s) => s.sidecar.geometry);
  const saved = useSession((s) => s.savedGeometry);
  const batch = useSession((s) => s.batchExporting);
  const folder = useSession((s) => s.folder);
  const pairAllowed=useSession(s=>!!s.folder&&s.hello?.capabilities?.backend?.pair_decode===true);
  useSyncExternalStore(
    (cb) => thumbs.onChange(cb),
    () => thumbVersion(),
  );
  const strip = useRef<HTMLDivElement>(null);
  // Pointer gestures work even when Tauri's native OS-file drop handler owns
  // HTML drag-and-drop on Windows. Do not turn that handler off to reorder.
  const drag = useRef<{ path: string; x: number; y: number; active: boolean; frames: typeof frames; folder: string | null } | null>(null);
  const suppressClick = useRef(false);
  const [dragging, setDragging] = useState<string | null>(null);
  const endDrag = (cancel = false) => {
    const d = drag.current;
    drag.current = null;
    setDragging(null);
    if (!d?.active) return;
    if (sessionStore.getState().folder !== d.folder) return;
    if (cancel && !sessionStore.getState().batchExporting) sessionStore.setState({ frames: d.frames });
    else void saveFrameOrder();
  };
  useEffect(() => {
    const el = strip.current?.querySelector('.thumb.open');
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [selection]);
  return (
    <div className="filmstrip" data-testid="filmstrip">
      <button className="strip-chevron" onClick={() => selectRelative(-1)} disabled={batch} aria-label="Previous">
        <ChevronLeft />
      </button>
      <div className="filmstrip-cells" ref={strip}
        onPointerMove={e => {
          const d = drag.current;
          if (!d || batch) return;
          if (!d.active && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 6) return;
          if (!d.active) {
            d.active = true;
            suppressClick.current = true;
            setDragging(d.path);
            e.currentTarget.setPointerCapture(e.pointerId);
          }
          const target = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('.thumb[data-path]');
          if (target && strip.current?.contains(target)) moveFrame(d.path, target.dataset.path!);
          const rect = e.currentTarget.getBoundingClientRect();
          if (e.clientX < rect.left + 36) e.currentTarget.scrollLeft -= 24;
          else if (e.clientX > rect.right - 36) e.currentTarget.scrollLeft += 24;
        }}
        onPointerUp={() => endDrag()}
        onPointerCancel={() => endDrag(true)}
        onLostPointerCapture={() => endDrag(true)}
        onClickCapture={e => { if (suppressClick.current) { e.preventDefault(); e.stopPropagation(); suppressClick.current = false; } }}
      >
        {frames.length === 0 && <span className="caption">{t('statusEmptyFilmstrip').replace('⌘O', 'Ctrl+O')}</span>}
        {frames.map((f) => (
          <div
            key={f.path}
            className={'thumb' + (f.path === selection ? ' open' : '') + (picked.includes(f.path) ? ' picked' : '')}
            onClick={(e) => click(f.path, e.ctrlKey || e.metaKey)}
            title={f.name}
            data-path={f.path}
            data-dragging={dragging === f.path || undefined}
            style={{ touchAction: 'pan-y' }}
            onPointerDown={e => {
              suppressClick.current = false;
              if (!batch && e.button === 0 && !e.ctrlKey && !e.metaKey) drag.current = { path: f.path, x: e.clientX, y: e.clientY, active: false, frames, folder };
            }}
            onDragStart={e => e.preventDefault()}
          >
            <Thumb path={f.path} geometry={f.path === selection ? live : (saved[f.path] ?? GEOMETRY_DEFAULT)} />
            <span className="thumb-name">{f.name}</span>
          </div>
        ))}
      </div>
      <button className="strip-chevron" onClick={() => selectRelative(1)} disabled={batch} aria-label="Next">
        <ChevronRight />
      </button>
      {pairAllowed&&<button className="btn" style={{margin:6,flexShrink:0}} disabled={batch} title={tz('Create a pair from up to two selected photographs.','将选中的最多两张照片组合为半格配对。')} data-testid="create-pair" onClick={()=>void createPair()}>{tz('Pair','半格配对')}</button>}
    </div>
  );
}

let version = 0;
thumbs.onChange(() => version++);
const thumbVersion = () => version;

const CELL_H = 104;

export function Thumb({ path, geometry, height = CELL_H }: { path: string; geometry: Geometry; height?: number }) {
  const framed = thumbs.isFramed(path);
  const url = thumbs.get(path);
  const ref = useRef<HTMLCanvasElement>(null);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  useEffect(() => {
    if (!url) return;
    const i = new Image();
    i.onload = () => setImg(i);
    i.src = url;
  }, [url]);
  useEffect(() => {
    const c = ref.current;
    if (!c || !img) return;
    const plan = thumbnailGeometryPlan(framed ? GEOMETRY_DEFAULT : geometry, { width: img.naturalWidth, height: img.naturalHeight }, height);
    c.width = plan.width;
    c.height = plan.height;
    const ctx = c.getContext('2d')!;
    ctx.setTransform(...plan.imageTransform);
    ctx.drawImage(img, 0, 0);
    if (plan.cropPolygon) {
      // Darken outside the crop: whole cell minus the crop polygon.
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = 'rgba(45,45,44,0.82)';
      ctx.beginPath();
      ctx.rect(0, 0, plan.width, plan.height);
      const pts = plan.cropPolygon;
      ctx.moveTo(pts[0]!.x, pts[0]!.y);
      for (const p of pts.slice(1)) ctx.lineTo(p.x, p.y);
      ctx.closePath();
      ctx.fill('evenodd');
    }
  }, [img, geometry, height, framed]);
  if (!url) return <div className="placeholder" />;
  return <canvas ref={ref} />;
}
