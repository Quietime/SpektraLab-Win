import { useEffect, useRef, useState } from 'react';
import { Canvas } from '../canvas/Canvas';
import { tz } from '../i18n';
import { openLightTable } from '../lighttable/LightTable';
import { LeftRail } from '../panels/LeftRail';
import { RightRail } from '../panels/RightRail';
import { editingAdjustments, openMobileLibrary, redo, renderFullNow, select, selectFilmStock, selectPrintStock, setAdjustments, setOriginal, setPages, setTool, undo, useSession } from '../state/session';
import { thumbs } from '../state/thumbs';
import { platform } from '../platform';
import { androidCall, inAndroid } from './bridge';
import { HostFailure } from '../windows/Dialogs';

const PAGE_SIZE = 24;
const LIBRARY_KEY = 'spektralab-phone-library-v1';
const adjustments = [
  { key: 'exposure', label: ['Exposure', '曝光'], min: -3, max: 3, step: 0.05 },
  { key: 'contrast', label: ['Contrast', '对比度'], min: -50, max: 50, step: 1 },
  { key: 'saturation', label: ['Saturation', '饱和度'], min: -100, max: 100, step: 1 },
] as const;

export function MobileWorkspace() {
  const frames = useSession(s => s.frames);
  const selection = useSession(s => s.selection);
  const phase = useSession(s => s.hostState.phase);
  const error = useSession(s => s.lastError);
  const status = useSession(s => s.status);
  const original = useSession(s => s.showingOriginal);
  const tool = useSession(s => s.tool);
  const [page, setPage] = useState(0);
  const [screen, setScreen] = useState<'photos' | 'edit'>('photos');
  const [panel, setPanel] = useState<'adjust' | 'film' | 'advanced' | 'advanced-film' | 'more' | null>(null);
  const [busy, setBusy] = useState(false);
  const [opening, setOpening] = useState(false);
  const [message, setMessage] = useState('');
  const [, refreshThumbs] = useState(0);
  const restored = useRef(false);
  const current = frames.find(frame => frame.path === selection);
  const pageCount = Math.max(1, Math.ceil(frames.length / PAGE_SIZE));
  const visiblePage = Math.min(page, pageCount - 1);

  useEffect(() => {
    const unsubscribe = thumbs.onChange(() => refreshThumbs(value => value + 1));
    return () => { unsubscribe(); };
  }, []);
  useEffect(() => {
    if (phase !== 'ready' || restored.current) return;
    restored.current = true;
    if (frames.length) return;
    setBusy(true);
    void (async () => {
      const paths: unknown = inAndroid()
        ? await androidCall<string[]>('list_imports')
        : JSON.parse(localStorage.getItem(LIBRARY_KEY) ?? '[]');
      if (Array.isArray(paths) && paths.length && paths.every(path => typeof path === 'string')) {
        await openMobileLibrary(paths, false);
      }
    })()
      .catch(() => setMessage(tz('Could not restore the photo library.', '无法恢复照片列表。')))
      .finally(() => setBusy(false));
  }, [phase, frames.length]);
  useEffect(() => {
    const back = (event: Event) => {
      if (panel) { event.preventDefault(); setPanel(null); }
      else if (screen === 'edit') { event.preventDefault(); setScreen('photos'); }
    };
    window.addEventListener('spektralab-mobile-back', back);
    return () => window.removeEventListener('spektralab-mobile-back', back);
  }, [screen, panel]);

  async function importPhotos() {
    setMessage('');
    setBusy(true);
    try {
      const paths = await platform().pickFiles(tz('Choose photos', '选择照片'));
      if (!paths.length) return;
      const library = await openMobileLibrary(paths);
      if (!library.length) {
        setMessage(tz('No supported photos were found.', '未找到可打开的照片。'));
        return;
      }
      try { if (!inAndroid()) localStorage.setItem(LIBRARY_KEY, JSON.stringify(library)); }
      catch { setMessage(tz('Photos are open. The library could not be saved.', '照片已导入，但无法保存照片列表。')); }
      setPage(0);
      setScreen('photos');
    } catch (failure) {
      setMessage(tz('Could not import photos. ', '无法导入照片。') + String(failure));
    } finally {
      setBusy(false);
    }
  }

  function openPhoto(path: string) {
    setMessage('');
    setOpening(true);
    setPanel(null);
    setScreen('edit');
    void select(path)
      .catch(failure => setMessage(tz('Could not open photo. ', '无法打开照片。') + String(failure)))
      .finally(() => setOpening(false));
  }

  const ready = phase === 'ready';
  return <div className="phone-workspace" data-testid="editor">
    <header className="phone-header">
      {screen === 'edit' ? <button onClick={() => { setPanel(null); setScreen('photos'); }}>{tz('‹ Photos', '‹ 照片')}</button> : <h1>{tz('Photos', '照片')}</h1>}
      {screen === 'edit' && current && <span className="phone-name">{current.name}</span>}
      <button onClick={() => setPanel(value => value === 'more' ? null : 'more')} aria-expanded={panel === 'more'}>{tz('More', '更多')}</button>
    </header>
    {(message || error) && <p className="phone-message" role="alert">{message || error}</p>}
    {screen === 'photos' ? <>
      <section className="phone-library" aria-label={tz('Photo library', '照片列表')}>
        {frames.length === 0 ? <div className="phone-empty">
          <h2>{tz('Import photos to get started', '导入照片，开始编辑')}</h2>
          <p>{tz('Choose one or more photos, then tap a photo to edit it.', '可以选择一张或多张照片。导入后，点按照片进入编辑。')}</p>
          {busy && <p role="status">{tz('Importing photos…', '正在导入照片…')}</p>}
          {!ready && <p role="status">{tz('Preparing the render engine…', '正在准备渲染引擎…')}</p>}
          {ready && !busy && status && <p role="status">{status}</p>}
        </div> : <>
          <p className="phone-library-caption">{tz('Tap a photo to edit', '点按照片进入编辑')} · {frames.length}</p>
          <div className="phone-grid">
            {frames.slice(visiblePage * PAGE_SIZE, (visiblePage + 1) * PAGE_SIZE).map(frame => {
              const thumbnail = ready ? thumbs.get(frame.path) : null;
              return <button className="phone-photo" data-testid="phone-photo" key={frame.path} onClick={() => openPhoto(frame.path)} disabled={!ready || opening}>
                <div className="phone-thumbnail">{thumbnail ? <img src={thumbnail} alt="" /> : <span>{tz('Photo', '照片')}</span>}</div>
                <span className="phone-name">{frame.name}</span>
              </button>;
            })}
          </div>
          {pageCount > 1 && <div className="phone-paging">
            <button disabled={visiblePage === 0} onClick={() => setPage(visiblePage - 1)}>{tz('Previous page', '上一页')}</button>
            <span>{visiblePage + 1} / {pageCount}</span>
            <button disabled={visiblePage + 1 >= pageCount} onClick={() => setPage(visiblePage + 1)}>{tz('Next page', '下一页')}</button>
          </div>}
        </>}
      </section>
      <footer className="phone-actions"><button className="phone-primary" disabled={!ready || busy} onClick={() => void importPhotos()}>{busy ? tz('Importing…', '正在导入…') : tz('Import photos', '导入照片')}</button></footer>
    </> : <>
      <main className="phone-preview"><Canvas /></main>
      <div className="phone-editor-status" role="status">{opening ? tz('Opening photo…', '正在打开照片…') : status}</div>
      {panel === 'adjust' && <Adjustments />}
      {panel === 'film' && <Film /> }
      {panel === 'advanced-film' && <section className="phone-panel phone-advanced" aria-label={tz('Film and paper', '胶片与相纸')}><LeftRail /></section>}
      {panel === 'advanced' && <section className="phone-panel phone-advanced" aria-label={tz('Advanced adjustments', '高级调整')}><RightRail /></section>}
      <nav className="phone-actions" aria-label={tz('Edit photo', '编辑照片')}>
        <button disabled={opening} aria-pressed={panel === 'adjust'} onClick={() => setPanel(panel === 'adjust' ? null : 'adjust')}>{tz('Adjust', '调整')}</button>
        <button disabled={opening} aria-pressed={panel === 'film'} onClick={() => setPanel(panel === 'film' ? null : 'film')}>{tz('Film', '胶片')}</button>
        <button disabled={opening} aria-pressed={original} onClick={() => setOriginal(!original)}>{tz('Original', '原图')}</button>
        <button className="phone-primary" disabled={opening || !current || !ready} onClick={() => { setPanel(null); setPages({ exportOpen: true }); }}>{tz('Export', '导出')}</button>
      </nav>
    </>}
    {panel === 'more' && <section className="phone-more" aria-label={tz('More actions', '更多操作')}>
      {screen === 'edit' && <><button onClick={() => { undo(); setPanel(null); }}>{tz('Undo', '撤销')}</button>
        <button onClick={() => { redo(); setPanel(null); }}>{tz('Redo', '重做')}</button>
        <button onClick={() => { setTool(tool === 'crop' ? 'hand' : 'crop'); setPanel(null); }}>{tool === 'crop' ? tz('Finish crop', '完成裁切') : tz('Crop', '裁切')}</button>
        <button onClick={() => { setPanel(null); void renderFullNow(); }}>{tz('Render at full size', '全尺寸渲染')}</button>
        <button onClick={() => setPanel('advanced')}>{tz('Advanced adjustments', '高级调整')}</button>
        <button onClick={() => setPanel('advanced-film')}>{tz('Advanced film settings', '高级胶片设置')}</button></>}
      <button data-testid="mobile-lighttable-open" onClick={() => { setPanel(null); openLightTable(); }}>{tz('Light table', '看片台')}</button>
      <button onClick={() => { setPanel(null); setPages({ settingsOpen: true }); }}>{tz('Settings', '设置')}</button>
    </section>}
    <HostFailure />
  </div>;
}

function Adjustments() {
  const grade = useSession(editingAdjustments);
  return <section className="phone-panel phone-adjust" aria-label={tz('Basic adjustments', '基础调整')}>
    {adjustments.map(({ key, label, min, max, step }) => <label key={key}>
      <span>{tz(...label)} <output>{grade[key].toFixed(step < 1 ? 2 : 0)}</output></span>
      <input type="range" min={min} max={max} step={step} value={grade[key]} onChange={event => {
        const value = Number(event.currentTarget.value);
        setAdjustments(previous => ({ ...previous, [key]: value }), { coalesce: true });
      }} />
    </label>)}
  </section>;
}

function Film() {
  const catalog = useSession(s => s.catalog);
  const film = useSession(s => s.sidecar.params.filmStock);
  const paper = useSession(s => s.sidecar.params.printStock);
  const positive = catalog.isPositive(film);
  const films = catalog.filmGroups().flatMap(group => group.films);
  const papers = catalog.paperGroups().flatMap(group => group.papers)
    .filter(stock => catalog.canPrint(film, stock.id));
  return <section className="phone-panel phone-adjust" aria-label={tz('Film and paper', '胶片与相纸')}>
    <label>{tz('Film stock', '胶片型号')}
      <select value={film} onChange={event => selectFilmStock(event.currentTarget.value)}>
        {films.map(stock => <option key={stock.id} value={stock.id}>{stock.name}</option>)}
      </select>
    </label>
    {!positive && <label>{tz('Print paper', '相纸')}
      <select value={paper} onChange={event => selectPrintStock(event.currentTarget.value)}>
        {papers.map(stock => <option key={stock.id} value={stock.id}>{stock.name}</option>)}
      </select>
    </label>}
  </section>;
}
