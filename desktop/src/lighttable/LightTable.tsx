import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Import } from '../controls/icons';
import { tz } from '../i18n';
import { useSession, sessionStore, click } from '../state/session';
import { thumbs } from '../state/thumbs';
import { rgbaToURL } from '../state/frames';
import { platform } from '../platform';
import { host } from '../host/client';
import { inAndroid } from '../mobile/bridge';
import { useOutput } from '../canvas/output';
import type { OutputImage } from '../canvas/output';
import {
  MAX_CARDS, MAX_PHOTOS, MAX_TRAYS, bound, changeTable, changeTray, closeTable,
  importTablePaths, loadTable, newTray, nextSlide, openTable, placeCard, removePhoto, returnCard,
  saveTable, tableStore, tiledCards, useTable, type Card, type Tray,
} from './model';
import './LightTable.css';

const PAGE_SIZE = 60;
const MAX_URLS = 6;
const MAX_PREVIEW_EDGE = 4096;
const CARD_MIME = 'application/x-spektralab-lighttable-card';
const outputImageIds = new WeakMap<OutputImage, number>();
let nextOutputImageId = 1;
const outputUrlCache = new Map<string, { imageId: number; url: string }>();
let thumbVersion = 0;
thumbs.onChange(() => { thumbVersion++; });

interface HighDetailEntry { url: string; references: number }
interface HighDetailLease { url: string; release(): void }
interface HighDetailRequest { token: number; key: string; path: string; edge: number; deliver(lease: HighDetailLease | null): void }
const highDetailUrls = new Map<string, HighDetailEntry>();
let highDetailToken = 0;
let activeHighDetail = false;
let latestHighDetail: HighDetailRequest | null = null;
let queuedHighDetail: HighDetailRequest | null = null;

function moveHighDetailToNewest(key: string, entry: HighDetailEntry) {
  highDetailUrls.delete(key);
  highDetailUrls.set(key, entry);
}

function leaseHighDetail(entry: HighDetailEntry): HighDetailLease {
  entry.references++;
  let released = false;
  return { url: entry.url, release: () => {
    if (released) return;
    released = true;
    entry.references = Math.max(0, entry.references - 1);
  } };
}

function retainHighDetailUrl(key: string, url: string): HighDetailEntry | null {
  let entry = highDetailUrls.get(key);
  if (entry) {
    if (entry.references > 0) return null;
    URL.revokeObjectURL(entry.url);
    entry.url = url;
    moveHighDetailToNewest(key, entry);
    return entry;
  }
  if (highDetailUrls.size >= MAX_URLS) {
    const candidate = [...highDetailUrls.entries()].find(([, value]) => value.references === 0);
    if (!candidate) return null;
    URL.revokeObjectURL(candidate[1].url);
    highDetailUrls.delete(candidate[0]);
  }
  entry = { url, references: 0 };
  highDetailUrls.set(key, entry);
  return entry;
}

async function pumpHighDetailPreview() {
  if (activeHighDetail || !queuedHighDetail) return;
  const request = queuedHighDetail;
  queuedHighDetail = null;
  activeHighDetail = true;
  try {
    const rgba = await host().thumbnail(request.path, request.edge);
    const url = await rgbaToURL(rgba, request.edge);
    if (!url) {
      if (latestHighDetail?.token === request.token) request.deliver(null);
      return;
    }
    if (latestHighDetail?.token !== request.token) {
      URL.revokeObjectURL(url);
      return;
    }
    const entry = retainHighDetailUrl(request.key, url);
    if (entry) request.deliver(leaseHighDetail(entry));
    else {
      let released = false;
      request.deliver({ url, release: () => { if (!released) { released = true; URL.revokeObjectURL(url); } } });
    }
  } catch {
    if (latestHighDetail?.token === request.token) request.deliver(null);
  } finally {
    activeHighDetail = false;
    if (queuedHighDetail) void pumpHighDetailPreview();
  }
}

function requestHighDetailPreview(path: string, edge: number, deliver: HighDetailRequest['deliver']) {
  const key = `${path}\u0000${edge}`;
  const cached = highDetailUrls.get(key);
  if (cached) {
    moveHighDetailToNewest(key, cached);
    deliver(leaseHighDetail(cached));
    return () => {};
  }
  const request: HighDetailRequest = { token: ++highDetailToken, key, path, edge, deliver };
  latestHighDetail = request;
  queuedHighDetail = request;
  void pumpHighDetailPreview();
  return () => {
    if (latestHighDetail?.token === request.token) latestHighDetail = null;
    if (queuedHighDetail?.token === request.token) queuedHighDetail = null;
  };
}

function useDisplayLongEdge() {
  const measure = () => Math.min(MAX_PREVIEW_EDGE, Math.max(1, Math.ceil(Math.max(window.innerWidth, window.innerHeight) * (window.devicePixelRatio || 1))));
  const [edge, setEdge] = useState(measure);
  useEffect(() => {
    let query = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    const update = () => {
      setEdge(measure());
      query.removeEventListener?.('change', update);
      query = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
      query.addEventListener?.('change', update);
    };
    window.addEventListener('resize', update);
    window.addEventListener('orientationchange', update);
    window.visualViewport?.addEventListener('resize', update);
    query.addEventListener?.('change', update);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('orientationchange', update);
      window.visualViewport?.removeEventListener('resize', update);
      query.removeEventListener?.('change', update);
    };
  }, []);
  return edge;
}

async function outputUrl(path: string, image: ReturnType<typeof useOutput>): Promise<string | null> {
  if (!image) return null;
  let imageId = outputImageIds.get(image);
  if (imageId === undefined) {
    imageId = nextOutputImageId++;
    outputImageIds.set(image, imageId);
  }
  const cached = outputUrlCache.get(path);
  if (cached?.imageId === imageId) {
    outputUrlCache.delete(path);
    outputUrlCache.set(path, cached);
    return cached.url;
  }
  const url = await rgbaToURL({ ...image, colorSpace: 'sRGB' }, 4096);
  if (!url) return null;
  if (cached) URL.revokeObjectURL(cached.url);
  outputUrlCache.set(path, { imageId, url });
  while (outputUrlCache.size > MAX_URLS) {
    const oldest = outputUrlCache.keys().next().value as string | undefined;
    if (!oldest) break;
    URL.revokeObjectURL(outputUrlCache.get(oldest)!.url);
    outputUrlCache.delete(oldest);
  }
  return url;
}

function CameraPreview({ path, label = true, highDetail = false }: { path: string; label?: boolean; highDetail?: boolean }) {
  return highDetail ? <HighDetailCameraPreview path={path} label={label} /> : <ThumbnailCameraPreview path={path} label={label} />;
}

function sourceLabel(path: string) {
  return thumbs.isFramed(path) ? tz('Editor print preview', '编辑器成片预览') : tz('Camera preview', '相机预览');
}

function ThumbnailCameraPreview({ path, label = true }: { path: string; label?: boolean }) {
  useSyncExternalStore((cb) => thumbs.onChange(cb), () => thumbVersion);
  const url = thumbs.get(path);
  return <>
    {url ? <img className="lt-photo-image" src={url} draggable={false} alt="" /> : <div className="lt-photo-loading" />}
    {label && <span className="lt-source-label">{sourceLabel(path)}</span>}
  </>;
}

function HighDetailCameraPreview({ path, label = true }: { path: string; label?: boolean }) {
  const edge = useDisplayLongEdge();
  useSyncExternalStore((cb) => thumbs.onChange(cb), () => thumbVersion);
  const lowUrl = thumbs.get(path);
  const [result, setResult] = useState<{ key: string; url: string } | null>(null);
  const leaseRef = useRef<HighDetailLease | null>(null);
  const key = `${path}\u0000${edge}`;
  useEffect(() => {
    let current = true;
    const cancel = requestHighDetailPreview(path, edge, (lease) => {
      if (!current) { lease?.release(); return; }
      leaseRef.current?.release();
      leaseRef.current = lease;
      if (lease) setResult({ key, url: lease.url });
    });
    return () => {
      current = false;
      cancel();
      leaseRef.current?.release();
      leaseRef.current = null;
    };
  }, [path, edge, key]);
  const url = result?.key === key ? result.url : lowUrl;
  return <>
    {url ? <img className="lt-photo-image" src={url} draggable={false} alt="" /> : <div className="lt-photo-loading" />}
    {label && <span className="lt-source-label">{result?.key === key ? tz('Camera preview', '相机预览') : sourceLabel(path)}</span>}
  </>;
}

function CanvasPreview({ path, label = true }: { path: string; label?: boolean }) {
  const output = useOutput();
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void outputUrl(path, output).then((next) => { if (live) setUrl(next); });
    return () => { live = false; };
  }, [path, output]);
  return <>
    {url ? <img className="lt-photo-image" src={url} draggable={false} alt="" /> : <div className="lt-photo-loading" />}
    {label && <span className="lt-source-label current">{tz('Canvas output', '画布输出')}</span>}
  </>;
}

function LightPhoto({ path, selected, label = true, highDetail = false }: { path: string; selected: boolean; label?: boolean; highDetail?: boolean }) {
  return selected ? <CanvasPreview path={path} label={label} /> : <CameraPreview path={path} label={label} highDetail={highDetail} />;
}

interface GesturePointer { x: number; y: number }
interface Gesture {
  path: string;
  initial: Card;
  pointers: Map<number, GesturePointer>;
  origin: Map<number, GesturePointer>;
  moved: boolean;
}

function rename(tray: Tray, name: string): Tray { return { ...tray, name: name.slice(0, 80) }; }

export function LightTable() {
  const isOpen = useTable((s) => s.open);
  const ready = useTable((s) => s.ready);
  const tableDocument = useTable((s) => s.document);
  const error = useTable((s) => s.error);
  const selection = useSession((s) => s.selection);
  const frames = useSession((s) => s.frames);
  const batchExporting = useSession((s) => s.batchExporting);
  const stage = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const suppressClick = useRef(false);
  const writeFrame = useRef<number | null>(null);
  const pendingPosition = useRef<{ path: string; x: number; y: number; scale: number; rotation: number } | null>(null);
  const [page, setPage] = useState(0);
  const [slideshow, setSlideshow] = useState(false);
  const [slidePath, setSlidePath] = useState('');
  const [loupe, setLoupe] = useState<1.5 | 8>(1.5);
  const [loupePath, setLoupePath] = useState('');
  const [loupeAt, setLoupeAt] = useState<{ x: number; y: number } | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const active = tableDocument.trays.find((tray) => tray.id === tableDocument.active) ?? tableDocument.trays[0];
  const currentCards = useMemo(() => active?.cards ?? [], [active?.cards]);
  const cardPaths = useMemo(() => new Set(currentCards.map((card) => card.path)), [currentCards]);
  const pendingPhotos = useMemo(() => (active?.photos ?? []).filter((photo) => !cardPaths.has(photo.path)), [active, cardPaths]);
  const visiblePhotos = pendingPhotos.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const pages = Math.max(1, Math.ceil(pendingPhotos.length / PAGE_SIZE));
  const stageCards = useMemo(() => [...currentCards].sort((a, b) => a.z - b.z), [currentCards]);

  const savePosition = useCallback(() => {
    writeFrame.current = null;
    const next = pendingPosition.current;
    if (!next) return;
    pendingPosition.current = null;
    changeTray((tray) => ({ ...tray, cards: tray.cards.map((card) => card.path === next.path ? { ...card, x: next.x, y: next.y, scale: next.scale, rotation: next.rotation } : card) }));
  }, []);
  const schedulePosition = (next: NonNullable<typeof pendingPosition.current>) => {
    pendingPosition.current = next;
    if (writeFrame.current === null) writeFrame.current = requestAnimationFrame(savePosition);
  };

  const back = useCallback(() => {
    if (slideshow) setSlideshow(false);
    else if (globalThis.document.fullscreenElement) void globalThis.document.exitFullscreen().catch(() => {});
    else void closeTable().catch((e) => tableStore.setState({ error: String(e) }));
  }, [slideshow]);
  useEffect(() => {
    if (!isOpen) return;
    const onBack = () => back();
    const onKey = (event: Event) => {
      const key = (event as CustomEvent<string>).detail;
      if (key === 'ArrowRight' || key === 'ArrowLeft') {
        setSlidePath((current) => nextSlide(stageCards.map((card) => card.path), current, key === 'ArrowRight' ? 1 : -1) ?? current);
      }
    };
    window.addEventListener('spektralab-lighttable-back', onBack);
    window.addEventListener('spektralab-lighttable-key', onKey);
    return () => {
      window.removeEventListener('spektralab-lighttable-back', onBack);
      window.removeEventListener('spektralab-lighttable-key', onKey);
    };
  }, [isOpen, back, stageCards]);

  useEffect(() => {
    if (!isOpen || !slideshow || !currentCards.length) return;
    const order = stageCards.map((card) => card.path);
    const timer = window.setInterval(() => setSlidePath((path) => nextSlide(order, path, 1) ?? order[0] ?? ''), 3000);
    return () => window.clearInterval(timer);
  }, [isOpen, slideshow, currentCards.length, stageCards]);

  useEffect(() => {
    const onFullscreen = () => setFullscreen(!!globalThis.document.fullscreenElement);
    globalThis.document.addEventListener('fullscreenchange', onFullscreen);
    return () => globalThis.document.removeEventListener('fullscreenchange', onFullscreen);
  }, []);
  useEffect(() => () => { if (writeFrame.current !== null) cancelAnimationFrame(writeFrame.current); }, []);
  useEffect(() => { setPage(0); }, [tableDocument.active]);
  useEffect(() => { setPage((current) => Math.min(current, Math.max(0, pages - 1))); }, [pages]);
  if (!isOpen) return null;

  const importPhotos = async () => {
    const paths = await platform().pickFiles(tz('Add photographs to light table', '添加照片到灯箱'));
    if (paths.length) await importTablePaths(paths).catch((e) => tableStore.setState({ error: String(e) }));
  };
  const addCurrentRoll = () => void importTablePaths(frames.map((frame) => frame.path)).catch((e) => tableStore.setState({ error: String(e) }));
  const tile = () => {
    const rect = stage.current?.getBoundingClientRect();
    changeTray((tray) => ({ ...tray, cards: tiledCards(tray.photos, rect?.width, rect?.height) }));
  };
  const startSlideshow = () => {
    setSlidePath(stageCards[0]?.path ?? '');
    setSlideshow(true);
  };
  const importDrop = (event: React.DragEvent) => {
    const cardPath = event.dataTransfer.getData(CARD_MIME);
    if (cardPath) {
      event.preventDefault();
      const rect = stage.current?.getBoundingClientRect();
      if (!rect) return;
      changeTray((tray) => ({ ...tray, cards: tray.cards.map((card) => card.path === cardPath ? { ...card, x: bound((event.clientX - rect.left) / rect.width, .02, .98), y: bound((event.clientY - rect.top) / rect.height, .02, .98) } : card) }));
      return;
    }
    const paths = event.dataTransfer.getData('text/uri-list').split(/\r?\n/).filter(Boolean).map((path) => decodeURIComponent(path.replace(/^file:\/\//, '')));
    if (paths.length) { event.preventDefault(); void importTablePaths(paths).catch((e) => tableStore.setState({ error: String(e) })); }
  };
  const startCardDrag = (event: React.DragEvent<HTMLElement>, path: string) => {
    if ((event.target as HTMLElement).closest('button')) { event.preventDefault(); return; }
    event.dataTransfer.setData(CARD_MIME, path);
    event.dataTransfer.effectAllowed = 'move';
  };
  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    const photo = (event.target as HTMLElement).closest<HTMLElement>('[data-path]');
    const path = photo?.dataset.path;
    if (!path) return;
    const rect = stage.current?.getBoundingClientRect();
    if (!rect) return;
    stage.current?.setPointerCapture(event.pointerId);
    const existing = gesture.current;
    const card = currentCards.find((item) => item.path === path);
    if (!card) {
      changeTray((tray) => placeCard(tray, path, (event.clientX - rect.left) / rect.width, (event.clientY - rect.top) / rect.height));
      suppressClick.current = true;
      return;
    }
    const pointers = existing?.path === path ? new Map(existing.pointers) : new Map<number, GesturePointer>();
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    gesture.current = { path, initial: card, pointers, origin: new Map(pointers), moved: false };
  };
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g || !g.pointers.has(event.pointerId)) return;
    setLoupePath(g.path);
    g.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const rect = stage.current?.getBoundingClientRect();
    if (!rect) return;
    const origin = [...g.origin.values()], now = [...g.pointers.values()];
    let x = g.initial.x, y = g.initial.y, scale = g.initial.scale, rotation = g.initial.rotation;
    if (origin.length >= 2 && now.length >= 2) {
      const a = origin[0]!, b = origin[1]!, c = now[0]!, d = now[1]!;
      const distance = (p: GesturePointer, q: GesturePointer) => Math.hypot(p.x - q.x, p.y - q.y);
      const angle = (p: GesturePointer, q: GesturePointer) => Math.atan2(q.y - p.y, q.x - p.x) * 180 / Math.PI;
      const startDistance = Math.max(1, distance(a, b));
      const startCentre = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const centreNow = { x: (c.x + d.x) / 2, y: (c.y + d.y) / 2 };
      x += (centreNow.x - startCentre.x) / rect.width;
      y += (centreNow.y - startCentre.y) / rect.height;
      scale = Math.max(.4, Math.min(2.5, g.initial.scale * distance(c, d) / startDistance));
      rotation = g.initial.rotation + angle(c, d) - angle(a, b);
    } else {
      const originPoint = origin[0]!, nowPoint = now[0]!;
      x += (nowPoint.x - originPoint.x) / rect.width;
      y += (nowPoint.y - originPoint.y) / rect.height;
    }
    const movedDistance = Math.max(...now.map((point, index) => Math.hypot(point.x - origin[Math.min(index, origin.length - 1)]!.x, point.y - origin[Math.min(index, origin.length - 1)]!.y)));
    if (!g.moved && movedDistance > 3) { g.moved = true; suppressClick.current = true; }
    schedulePosition({ path: g.path, x: Math.max(.02, Math.min(.98, x)), y: Math.max(.02, Math.min(.98, y)), scale, rotation });
    setLoupeAt({ x: event.clientX, y: event.clientY });
  };
  const onPointerEnd = (event: React.PointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g) return;
    g.pointers.delete(event.pointerId);
    if (!g.pointers.size) { gesture.current = null; return; }
    if (writeFrame.current !== null) { cancelAnimationFrame(writeFrame.current); writeFrame.current = null; savePosition(); }
    const card = currentCards.find((item) => item.path === g.path) ?? g.initial;
    g.initial = card;
    g.origin = new Map(g.pointers);
  };
  const openPhoto = (path: string) => {
    if (batchExporting) return;
    if (suppressClick.current) { suppressClick.current = false; return; }
    click(path);
  };

  return <section className="lighttable" data-testid="lighttable" data-slideshow={slideshow ? 'true' : undefined} aria-label={tz('Light table', '灯箱')}>
    <header className="lt-toolbar">
      <button className="lt-close" data-testid="lt-close" aria-label={tz('Close light table', '关闭灯箱')} title={tz('Close light table (Esc)', '关闭灯箱（Esc）')} onClick={back}>×</button>
      <strong>{tz('Light table', '灯箱')}</strong>
      <div className="lt-trays" role="tablist" aria-label={tz('Trays', '底片盘')}>
        {tableDocument.trays.map((tray) => <button type="button" role="tab" data-testid="lt-tray" key={tray.id} aria-selected={tray.id === active?.id} onClick={() => changeTable((doc) => ({ ...doc, active: tray.id }))}>{tray.name}</button>)}
      </div>
      <button className="btn" data-testid="lt-new-tray" disabled={!ready || tableDocument.trays.length >= MAX_TRAYS} onClick={newTray}>+ {tz('Tray', '底片盘')}</button>
      <button className="btn" data-testid="lt-add-photos" disabled={!ready} onClick={() => void importPhotos()}><Import /> {tz('Add photos', '添加照片')}</button>
      <button className="btn" data-testid="lt-add-roll" disabled={!ready || !frames.length} onClick={addCurrentRoll}>{tz('Add current roll', '添加当前胶卷')}</button>
      <span className="lt-toolbar-spacer" />
      <button className="btn" data-testid="lt-tile" disabled={!ready || !active?.photos.length} onClick={tile}>{tz('Tile', '平铺')}</button>
      <button className={'btn' + (tableDocument.lamp ? ' on' : '')} data-testid="lt-lamp" aria-pressed={tableDocument.lamp} onClick={() => changeTable((d) => ({ ...d, lamp: !d.lamp }))}>☼</button>
      <label className="lt-brightness" title={tz('Light table brightness', '灯箱亮度')}><span>◐</span><input aria-label={tz('Light table brightness', '灯箱亮度')} type="range" min="0.1" max="1.6" step="0.05" value={tableDocument.brightness} onChange={(e) => changeTable((d) => ({ ...d, brightness: Number(e.currentTarget.value) }))} /></label>
      <button className={'btn' + (tableDocument.sleeves ? ' on' : '')} data-testid="lt-sleeves" aria-pressed={tableDocument.sleeves} onClick={() => changeTable((d) => ({ ...d, sleeves: !d.sleeves }))}>{tz('Sleeves', '胶片套')}</button>
      <button className="btn" data-testid="lt-loupe" onClick={() => setLoupe((value) => value === 1.5 ? 8 : 1.5)}>{loupe}×</button>
      <button className="btn" data-testid="lt-slideshow" disabled={!currentCards.length} onClick={slideshow ? () => setSlideshow(false) : startSlideshow}>{slideshow ? tz('Stop', '停止') : tz('Slideshow', '幻灯片')}</button>
      <button className="btn" data-testid="lt-fullscreen" aria-pressed={fullscreen} onClick={() => void platform().toggleFullscreen()}>{fullscreen ? '⛶' : '⛶'}</button>
      <button className="btn primary" data-testid="lt-save" onClick={() => void saveTable().catch(() => {})}>{tz('Save', '保存')}</button>
    </header>

    {error && <div className="lt-error" role="alert" data-testid="lt-error"><span>{error}</span><button className="btn" data-testid="lt-retry" onClick={() => void (ready ? saveTable() : loadTable()).catch((e) => tableStore.setState({ error: String(e) }))}>{tz('Retry', '重试')}</button></div>}

    {active && <div className="lt-layout">
      <div className="lt-stage-column">
        <div className={'lighttable-stage' + (tableDocument.sleeves ? ' sleeves' : '') + (tableDocument.lamp ? ' lamp-on' : '')} ref={stage}
          data-testid="lighttable-stage" style={{ filter: `brightness(${tableDocument.lamp ? tableDocument.brightness : .35})` }}
          onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerEnd} onPointerCancel={onPointerEnd}
          onPointerLeave={() => setLoupeAt(null)} onDragOver={(e) => e.preventDefault()} onDrop={importDrop}>
          <div className="lt-stage-grid" aria-hidden="true" />
          {stageCards.map((card) => <article key={card.path} draggable={!inAndroid()} className={'lt-photo-card' + (card.path === selection ? ' current' : '')} data-testid="lt-photo-card" data-path={card.path} style={{ left: `${card.x * 100}%`, top: `${card.y * 100}%`, width: card.tileW ? `${card.tileW * 100}%` : '26%', height: card.tileH ? `${card.tileH * 100}%` : '32%', zIndex: card.z, transform: `translate(-50%,-50%) rotate(${card.rotation}deg) scale(${card.scale})` }} onDragStart={(e) => startCardDrag(e, card.path)} onClick={() => openPhoto(card.path)}>
            <LightPhoto path={card.path} selected={card.path === selection} />
            <button className="lt-card-remove" data-testid="lt-remove-card" aria-label={tz('Return photo to tray', '将照片放回底片盘')} title={tz('Return to tray', '放回底片盘')} onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); changeTray((tray) => returnCard(tray, card.path)); }}>{'×'}</button>
          </article>)}
          {!stageCards.length && <div className="lt-stage-empty">{tz('Drag photos here or add them from the tray.', '将照片拖到此处，或从底片盘添加。')}</div>}
          {loupeAt && loupePath && <div className="lt-loupe" style={{ left: loupeAt.x - (stage.current?.getBoundingClientRect().left ?? 0), top: loupeAt.y - (stage.current?.getBoundingClientRect().top ?? 0), ['--loupe-scale' as string]: loupe }} aria-hidden="true"><LightPhoto path={loupePath} selected={loupePath === selection} label={false} highDetail /></div>}
        </div>
        <div className="lt-stage-footer"><span>{active.name} · {currentCards.length}/{MAX_CARDS} {tz('on table', '已摆放')} · {pendingPhotos.length}/{MAX_PHOTOS} {tz('in tray', '待摆放')}</span><input aria-label={tz('Tray name', '底片盘名称')} value={active.name} maxLength={80} onChange={(e) => changeTray((tray) => rename(tray, e.currentTarget.value))} /></div>
      </div>
      <aside className="lt-pending" aria-label={tz('Photos in tray', '底片盘中的照片')}>
        <div className="lt-pending-header"><strong>{tz('Tray photos', '底片盘照片')}</strong><span>{pendingPhotos.length}</span></div>
        <div className="lt-pending-grid">
          {visiblePhotos.map((photo) => <div key={photo.path} className="lt-pending-item">
            <button className="lt-pending-photo" data-testid="lt-pending-photo" data-path={photo.path} title={photo.name} aria-label={`${photo.name} — ${tz('Camera preview','相机预览')}`} onClick={() => changeTray((tray) => placeCard(tray, photo.path))}>
              <CameraPreview path={photo.path} /><span>{photo.name}</span>
            </button>
            <button className="lt-remove-pending" data-testid="lt-remove-photo" aria-label={tz('Remove photo from tray','从底片盘移除照片')} title={tz('Remove from tray','从底片盘移除')} onClick={() => changeTray((tray) => removePhoto(tray, photo.path))}>×</button>
          </div>)}
        </div>
        <div className="lt-pending-footer"><button className="btn" disabled={page <= 0} onClick={() => setPage((n) => Math.max(0, n - 1))}>‹</button><span>{page + 1}/{pages} · {Math.min(PAGE_SIZE, pendingPhotos.length - page * PAGE_SIZE)} / {PAGE_SIZE}</span><button className="btn" disabled={page + 1 >= pages} onClick={() => setPage((n) => Math.min(pages - 1, n + 1))}>›</button></div>
        {slideshow && <div className="lt-slideshow" role="dialog" aria-label={tz('Slideshow', '幻灯片')}><button className="btn" onClick={() => setSlidePath((path) => nextSlide(stageCards.map((card) => card.path), path, -1) ?? path)}>‹</button><div className="lt-slide-image">{slidePath && <LightPhoto path={slidePath} selected={slidePath === selection} highDetail />}</div><button className="btn" onClick={() => setSlidePath((path) => nextSlide(stageCards.map((card) => card.path), path, 1) ?? path)}>›</button><button className="btn" onClick={() => setSlideshow(false)}>{tz('Close', '关闭')}</button></div>}
      </aside>
    </div>}
    {!active && <div className="lt-error" role="alert">{tz('No tray is available.', '没有可用的底片盘。')} <button className="btn" onClick={newTray}>+ {tz('Tray', '底片盘')}</button></div>}
  </section>;
}

export function openLightTable() {
  void openTable(sessionStore.getState().frames).catch((e) => tableStore.setState({ open: true, error: String(e) }));
}
