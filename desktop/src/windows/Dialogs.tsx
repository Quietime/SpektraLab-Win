// Dialogs.tsx — Settings (`Windows/SettingsWindow.swift`, the pages this port
// carries), About (licences: CC BY-SA requires the attribution be visible),
// and the engine-failure dialog.

import {androidCall,inAndroid} from '../mobile/bridge';
import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useState } from 'react';
import { PillMenu, ToggleRow,NumberField } from '../controls/controls';
import { t, tz } from '../i18n';
import { host, type CacheInfo } from '../host/client';
import { platform, joinPath, type AppPaths } from '../platform';
import { recomputeFilmFormat, requestPrint, setPages, useSession, sessionStore } from '../state/session';
import { INTERFACE_SCALES, PREVIEW_EDGES, settingsStore, useSettings, SETTINGS_DEFAULT } from '../state/settings';
import { featureGate } from '@shared/params';
import { canUseNativeUpdates, checkForUpdates, getUpdateStatus, installUpdate, prepareUpdate, subscribeUpdates, type UpdateStatus } from '../updates/service';

function Frame({ open, onClose, title, children, actions, testId }: { open: boolean; onClose: () => void; title: string; children: React.ReactNode; actions?: React.ReactNode; testId?: string }) {
  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog" data-testid={testId} aria-describedby={undefined}>
          <Dialog.Title asChild>
            <h2>{title}</h2>
          </Dialog.Title>
          {children}
          <div className="dialog-actions">
            {actions}
            <Dialog.Close asChild>
              <button className="btn primary">{tz('Done', '完成')}</button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function SettingsDialog() {
  const open = useSession((s) => s.settingsOpen);
  const page = useSettings((s) => s.settingsPage);
  const st = useSettings((s) => s);
  const hello = useSession((s) => s.hello);
  const hostState = useSession((s) => s.hostState);
  const gate = useSessionGate();
  const [paths, setPaths] = useState<AppPaths | null>(null);
  const [diag, setDiag] = useState<string>('');
  const [cache,setCache]=useState<CacheInfo|null>(null);
  const [memory,setMemory]=useState<Awaited<ReturnType<ReturnType<typeof host>['memoryReport']>>|null>(null);
  const [storageError,setStorageError]=useState('');
  const [savingDiagnostic,setSavingDiagnostic]=useState(false);
  const batchExporting = useSession((s) => s.batchExporting);
  const [updates,setUpdates]=useState<UpdateStatus>(getUpdateStatus());
  const [updateAction,setUpdateAction]=useState<'idle'|'checking'|'preparing'|'installing'>('idle');
  useEffect(()=>subscribeUpdates(setUpdates),[]);
  const checkUpdates=async()=>{setUpdateAction('checking');await checkForUpdates();setUpdateAction('idle');};
  const prepareUpdates=async()=>{setUpdateAction('preparing');await prepareUpdate();setUpdateAction('idle');};
  const installUpdates=async()=>{setUpdateAction('installing');await installUpdate();setUpdateAction('idle');};
  const saveDiagnostic=async()=>{
    if(!paths||savingDiagnostic)return;
    const path=await platform().pickSave(tz('Save diagnostics','保存诊断'),joinPath(paths.pictures,'SpektraLab-diagnostics.zip'),'zip');
    if(!path)return;setSavingDiagnostic(true);
    try{
      const report={created:new Date().toISOString(),app:paths,engine:hello,host:await host().diagnostics(),
        memory:await host().memoryReport().catch(e=>({error:String(e)})),
        settings:{previewLongEdge:st.previewLongEdge,diskCacheGiB:st.diskCacheGiB,logRetentionDays:st.logRetentionDays,interfaceScale:st.interfaceScale}};
      if(inAndroid())await androidCall('diagnostics_export',{path,report});else{const {invoke}=await import('@tauri-apps/api/core');await invoke('diagnostics_export',{path,report});}await platform().reveal(path);
    }catch(e){setDiag(String(e));}finally{setSavingDiagnostic(false);}
  };
  const bytes=(n:number)=>`${(n/1e6).toLocaleString(undefined,{maximumFractionDigits:1})} MB`;
  const configureMemory=(key:'memoryReserveMB'|'memoryCapMB'|'allowOverReserve',value:number|boolean)=>{
    if(key==='allowOverReserve')settingsStore.getState().set(key,value as boolean);
    else settingsStore.getState().set(key,value as number);
    const current=settingsStore.getState();
    void host().memoryConfigure(current.memoryReserveMB,current.memoryCapMB,current.allowOverReserve).then(setMemory).catch(e=>setStorageError(String(e)));
  };
  useEffect(()=>{
    if(!open||page!=='storage')return;
    let cancelled=false,running=false;
    const read=async()=>{
      if(running)return;running=true;
      try{
        const c=hello?.methods?.includes('cache_info')?await host().cacheInfo():null;
        const m=await host().memoryReport();
        if(!cancelled){setCache(c);setMemory(m);}
      }catch(e){if(!cancelled)setStorageError(String(e));}finally{running=false;}
    };
    void read();const timer=setInterval(()=>void read(),2000);
    return()=>{cancelled=true;clearInterval(timer);};
  },[open,page,hello]);
  useEffect(() => {
    if (open) {
      void platform().appPaths().then(setPaths);
      void host()
        .diagnostics()
        .then((d) => setDiag(JSON.stringify(d, null, 1)))
        .catch(() => {});
    }
  }, [open, page]);
  const set = settingsStore.getState().set;
  return (
    <Frame open={open} onClose={() => setPages({ settingsOpen: false })} title={tz('Settings', '设置')} testId="settings">
      <div className="tabs">
        {(['general', 'rendering', 'storage', 'diagnostics', 'agents'] as const).map((p) => (
          <button key={p} className={page === p ? 'on' : ''} onClick={() => set('settingsPage', p)}>
            {p === 'general' ? t('setTabGeneral') : p === 'rendering' ? t('setTabRendering') : p==='storage'?tz('Memory & cache','内存与缓存'):p==='agents'?'Agents':t('setTabDiagnostics')}
          </button>
        ))}
      </div>
      <div className="dialog-body rail right" style={{ background: 'transparent' }}>
        {page === 'general' && (
          <>
            <div className="settings-group">
              <h3>{t('setLanguage')}</h3>
              <PillMenu
                label={t('setLanguage')}
                value={st.language}
                options={[
                  { value: 'system', label: t('languageFollowSystem') },
                  { value: 'english', label: 'English' },
                  { value: 'simplifiedChinese', label: '简体中文 (zh-Hans)' },
                ]}
                onChange={(v) => set('language', v)}
                testId="language"
              />
              <div className="caption">{t('setLanguageCaption')}</div>
            </div>
            <div className="settings-group">
              <h3>{t('setInterface')}</h3>
              <PillMenu label={t('setScale')} value={st.interfaceScale} options={INTERFACE_SCALES.map((s) => ({ value: s, label: `${s} %` }))} onChange={(v) => set('interfaceScale', v)} />
              <div className="row">
                <button
                  className="btn"
                  onClick={() => {
                    for (const k of ['leftCollapsed', 'rightCollapsed', 'filmstripCollapsed', 'leftWidth', 'rightWidth', 'collapsedSections'] as const) set(k, SETTINGS_DEFAULT[k] as never);
                  }}
                >
                  {t('setResetLayout')}
                </button>
              </div>
            </div>
            <div className="settings-group">
              <h3>{tz('Release information','发布信息')}</h3>
              <button className="btn" disabled={!canUseNativeUpdates()||updateAction!=='idle'} onClick={()=>void checkUpdates()}>
                {updateAction==='checking'?tz('Checking…','检查中…'):tz('Check for updates','检查更新')}
              </button>
              {(updates.channel||updates.current_build!==undefined)&&<div className="caption">{updates.channel ? `${tz('Channel','渠道')}: ${updates.channel}` : ''}{updates.current_build !== undefined ? ` · ${tz('Current build','当前版本')} ${updates.current_build}` : ''}</div>}
              {updates.available&&<>
                <div className="caption">{tz('Update available','有可用更新')}: {updates.version??'—'}{updates.build!==undefined?` · build ${updates.build}`:''}{updates.bytes?` · ${(updates.bytes/1e6).toLocaleString(undefined,{maximumFractionDigits:1})} MB`:''}</div>
                {updates.notes&&<div className="caption" style={{whiteSpace:'pre-wrap'}}>{updates.notes}</div>}
                {!updates.ready&&<button className="btn" disabled={updateAction!=='idle'} onClick={()=>void prepareUpdates()}>{updateAction==='preparing'?tz('Preparing update…','正在准备更新…'):tz('Download update','下载更新')}</button>}
                {updates.ready&&updates.installation_pending&&<div className="caption">{tz('Installation is waiting for Android system confirmation. Return here if you cancel to try again.','正在等待 Android 系统确认安装。若取消，请返回此处重试。')}</div>}
                {updates.ready&&!updates.installation_pending&&<button className="btn primary" disabled={updateAction!=='idle'||batchExporting} onClick={()=>void installUpdates()}>{updateAction==='installing'?tz('Saving and installing…','正在保存并安装…'):tz('Install update','安装更新')}</button>}
              </>}
              {updates.error&&<div className="caption">{updates.error}</div>}
              {!canUseNativeUpdates()&&<div className="caption">{tz('Managed updates are available in the installed app.','托管更新仅在已安装的应用中提供。')}</div>}
              <div className="caption">{tz('Updates are checked automatically in the background. Installation starts only when you choose Install update.','应用会在后台自动检查更新；只有选择“安装更新”后才会开始安装。')}</div>
            </div>
          </>
        )}
        {page === 'rendering' && (
          <>
            <div className="settings-group">
              <h3>{tz('Preview', '预览')}</h3>
              <PillMenu
                label={tz('Preview', '预览')}
                value={st.previewLongEdge}
                options={PREVIEW_EDGES.map((e) => ({ value: e, label: `${e} px` }))}
                onChange={(v) => {
                  set('previewLongEdge', v);
                  // The live tier's size is a session parameter: send it, render.
                  const sid = sessionStore.getState().engineSession;
                  if (sid) void host().setParams(sid, { preview_long_edge: v }).then(() => requestPrint());
                }}
              />
              <div className="caption">
                {tz(
                  "The resolution every interactive edit renders at. The frame's own resolution is rendered separately once an edit settles, so this trades responsiveness while dragging against nothing in the finished picture.",
                  '每次交互编辑的渲染分辨率。编辑停下后会另外按照片本身的分辨率渲染，所以这里只是拖动时的流畅度，与最终画面无关。',
                )}
              </div>
            </div>
            <div className="settings-group">
              <h3>{tz('Film effects', '胶片效果')}</h3>
              <ToggleRow
                label={tz('Crop re-maps the frame', '裁剪重新映射画幅')}
                on={st.recalculateEffectsAfterCrop}
                onChange={(v) => {
                  set('recalculateEffectsAfterCrop', v);
                  queueMicrotask(recomputeFilmFormat);
                }}
              />
              <div className="caption">{tz('Whether cropping changes the physical scale of grain, halation and glare. Off — the default, and the physically true answer — the crop shows less of the same negative.', '裁剪是否改变颗粒、光晕与耀光的物理尺度。关闭（默认，也是物理上正确的做法）时，裁剪只是看到同一张负片的更小部分。')}</div>
              <ToggleRow label={tz('Decouple effects', '分离效果强度')} on={st.decoupleEffects} onChange={(v) => set('decoupleEffects', v)} />
              <div className="caption">{tz('Show a strength for each film effect beside its switch. The strengths belong to the frame: turning this off hides the sliders and changes no picture.', '在每个胶片效果的开关旁显示强度滑块。强度属于照片本身：关闭此项只会隐藏滑块，不会改变任何画面。')}</div>
            </div>
            <div className="settings-group">
              <h3>{tz('Digital Intermediate', '数字中间片')}</h3>
              <ToggleRow
                label={tz('Blue compensation', '蓝色补偿')}
                on={st.diBlueCompensation}
                disabled={!gate.digitalIntermediate}
                reason={tz('The Digital Intermediate is not available with this engine yet.', '此引擎暂不支持数字中间片。')}
                onChange={(v) => {
                  set('diBlueCompensation', v);
                  const s = sessionStore.getState();
                  sessionStore.setState({ gate: featureGate(s.unsupported, v) });
                }}
              />
            </div>
          </>
        )}
        {page==='agents'&&<div className="settings-group">
          <h3>{tz('Local automation','本机自动化')}</h3>
          <ToggleRow disabled={inAndroid()} label={tz('Allow CLI and MCP access','允许 CLI 和 MCP 访问')} on={st.agentsEnabled} onChange={v=>set('agentsEnabled',v)}/>
          <div className="caption">{tz('Off by default. When enabled, local agents can open photographs, save edits and export files through the same session as the editor. Turning this off revokes subsequent operations.','默认关闭。开启后，本机代理可通过与编辑器相同的会话打开照片、保存编辑及导出文件。关闭后会撤销后续操作权限。')}</div>
          <div className="caption">{inAndroid()?tz('CLI/MCP is currently available in the desktop build.','CLI/MCP 目前仅在桌面版提供。'):''}</div>
          <div className="caption mono">SpektraLab-CLI.exe status<br/>SpektraLab-CLI.exe schema<br/>SpektraLab-CLI.exe mcp</div>
        </div>}
        {page==='storage'&&<>
          <div className="settings-group">
            <h3>{tz('Engine allocations','引擎分配')}</h3>
            {memory&&<div className="caption">
              {tz('GPU allocations','GPU 分配')}: {bytes(memory.total_bytes)}<br/>
              {tz('Idle GPU pool','空闲 GPU 池')}: {bytes(memory.pool.free_bytes)}<br/>
              {tz('Pair decode cache','双拼解码缓存')}: {bytes(memory.pair_bitmap_cache.bytes)}
              {memory.system&&<><br/>{tz('Engine process resident RAM','引擎进程驻留 RAM')}: {bytes(memory.system.host_resident_bytes)}<br/>
                {tz('System available RAM','系统可用 RAM')}: {bytes(memory.system.available_physical_bytes)}</>}
            </div>}
            <div className="row"><span className="row-label">{tz('Reserve','预留')}</span>
              <NumberField value={st.memoryReserveMB} decimals={0} disabled={!hello?.methods?.includes('memory_configure')} onCommit={v=>configureMemory('memoryReserveMB',Math.min(32768,Math.max(0,Math.round(v))))}/><span>MB</span>
            </div>
            <div className="row"><span className="row-label">{tz('Working-set cap','工作集上限')}</span>
              <NumberField value={st.memoryCapMB||8192} decimals={0} disabled={!st.memoryCapMB||!hello?.methods?.includes('memory_configure')} onCommit={v=>configureMemory('memoryCapMB',Math.min(131072,Math.max(2048,Math.round(v))))}/><span>MB</span>
            </div>
            <ToggleRow label={tz('Unlimited','不限制')} on={st.memoryCapMB===0} disabled={!hello?.methods?.includes('memory_configure')} onChange={v=>configureMemory('memoryCapMB',v?0:8192)}/>
            <ToggleRow label={tz('Allow exceeding the reserve','允许超出预留')} on={st.allowOverReserve} disabled={!hello?.methods?.includes('memory_configure')} onChange={v=>configureMemory('allowOverReserve',v)}/>
            <div className="caption">{tz('The cap evicts idle engine buffers and pair bitmaps. The current frame is retained. System RAM and GPU allocations are separate resources; this is a cache target, not an operating-system process limit.','上限管理引擎空闲缓冲和双拼位图缓存，保留当前照片。系统 RAM 与 GPU 分配是不同资源；这里是缓存目标，不是操作系统的进程硬限制。')}</div>
            <button className="btn" disabled={!hello?.methods?.includes('memory_trim')}
              onClick={()=>void host().memoryTrim().then(()=>host().memoryReport()).then(setMemory).catch(e=>setStorageError(String(e)))}>
              {tz('Release idle GPU buffers','释放空闲 GPU 缓冲')}
            </button>
          </div>
          <div className="settings-group">
            <h3>{tz('Disk cache','磁盘缓存')}</h3>
            <PillMenu label={tz('Limit','上限')} value={st.diskCacheGiB} disabled={!cache?.available}
              options={[0,2,4,8,16,32,64,128,256].map(value=>({value,label:value?`${value} GiB`:tz('Off','关闭')}))}
              onChange={value=>{set('diskCacheGiB',value);void host().cacheConfigure(value*2**30).then(setCache).catch(e=>setStorageError(String(e)));}}/>
            <div className="caption">{cache?.available?`${bytes(cache.bytes)} / ${bytes(cache.limit_bytes)} · ${cache.entries} ${tz('entries','项')}`:tz('Cache unavailable','缓存不可用')}</div>
            <div className="caption">{tz('Linear decoded images are reused while the source and decode settings match. The oldest entries are removed at the limit. Clearing the cache preserves photos and edits.','原文件与解码设置一致时复用线性解码结果；达到上限后移除最旧缓存。清理缓存保留照片和编辑设置。')}</div>
            <button className="btn" disabled={!cache?.available} onClick={()=>void host().cacheClear().then(setCache).catch(e=>setStorageError(String(e)))}>{tz('Clear disk cache','清理磁盘缓存')}</button>
            {cache?.path&&<button className="btn" onClick={()=>void platform().reveal(cache.path)}>{tz('Show cache','显示缓存')}</button>}
            {storageError&&<div className="caption">{storageError}</div>}
          </div>
        </>}
        {page === 'diagnostics' && (
          <>
            <div className="settings-group">
              <h3>{tz('This session', '本次会话')}</h3>
              <div className="caption">
                {tz('App', '应用')}: {paths?.version ?? '—'} · {paths?.os ?? ''}
                <br />
                {tz('Engine', '引擎')}: {hello ? `${hello.host_version} — ${hello.build_info}` : hostState.phase}
                <br />
                GPU: {hello?.backend?.device_name ?? '—'} ({hello?.backend?.api ?? '—'}) · {tz('Render core', '渲染核心')}: {String(hello?.capabilities?.backend?.render_core ?? '—')}
                <br />
                {tz('Not available here', '此处不可用')}: {(hello?.capabilities?.backend?.unsupported_features as string[] | undefined)?.join(', ') || '—'}
              </div>
            </div>
            <div className="settings-group">
              <h3>{tz('Logs and settings', '日志与设置')}</h3>
              <PillMenu label={tz('Log retention','日志保留')} value={st.logRetentionDays}
                options={[0,7,14,30,60,90,180,365].map(value=>({value,label:value?tz(`${value} days`,`${value} 天`):tz('Keep','保留')}))}
                onChange={value=>set('logRetentionDays',value)}/>
              <div className="caption mono">
                {tz('Logs', '日志')}: {paths?.logs}
                <br />
                {tz('Sidecars', '设置文件')}: {paths?.sidecars}
              </div>
              <div className="row" style={{ gap: 8 }}>
                <button className="btn" onClick={() => paths && void platform().reveal(paths.logs)}>
                  {tz('Show logs', '显示日志')}
                </button>
                <button className="btn" onClick={() => paths && void platform().reveal(paths.sidecars)}>
                  {tz('Show sidecars', '显示设置文件')}
                </button>
                <button className="btn" onClick={() => void host().restart()}>
                  {tz('Restart engine', '重启引擎')}
                </button>
                <button className="btn" disabled={platform().kind!=='tauri'||savingDiagnostic} onClick={()=>void saveDiagnostic()}>
                  {savingDiagnostic?tz('Saving…','保存中…'):tz('Save diagnostic ZIP','保存诊断 ZIP')}
                </button>
              </div>
            </div>
            <div className="settings-group">
              <h3>{tz('Engine host', '引擎进程')}</h3>
              <div className="mono" style={{ maxHeight: 180, overflow: 'auto' }}>
                {diag}
              </div>
            </div>
          </>
        )}
      </div>
    </Frame>
  );
}

function useSessionGate() {
  return useSession((s) => s.gate);
}

export function AboutDialog() {
  const open = useSession((s) => s.aboutOpen);
  const [texts, setTexts] = useState<{ name: string; body: string }[]>([]);
  const [paths, setPaths] = useState<AppPaths | null>(null);
  useEffect(() => {
    if (!open) return;
    void platform().appPaths().then(setPaths);
    void Promise.all(
      ['SpektraLab-GPL-3.0.txt', 'Profiles-and-LUTs-CC-BY-SA-4.0.txt', 'README.txt'].map(async (name) => {
        try {
          const r = await fetch('assets/licenses/' + name);
          return { name, body: r.ok ? await r.text() : '' };
        } catch {
          return { name, body: '' };
        }
      }),
    ).then(setTexts);
  }, [open]);
  return (
    <Frame open={open} onClose={() => setPages({ aboutOpen: false })} title="SpektraLab" testId="about">
      <div className="dialog-body">
        <p>
          {tz('Version', '版本')} {paths?.version ?? '1.3.1'} — {tz('film and print emulation built on the spektrafilm engine.', '基于 spektrafilm 引擎的胶片与相纸模拟。')}
        </p>
        <p className="caption">
          {tz(
            'SpektraLab is free software under the GNU GPL, version 3 or later. The film and paper profiles are licensed CC BY-SA 4.0; their attribution follows.',
            'SpektraLab 是依据 GNU GPL 第 3 版或更新版本发布的自由软件。胶片与相纸的特性数据依据 CC BY-SA 4.0 授权，署名如下。',
          )}
        </p>
        {texts.map((x) => (
          <details key={x.name}>
            <summary>{x.name}</summary>
            <div className="mono" style={{ maxHeight: 200, overflow: 'auto' }}>
              {x.body || tz('(not bundled in this build)', '（此版本未附带）')}
            </div>
          </details>
        ))}
      </div>
    </Frame>
  );
}

/** The engine failed to start or keeps dying: say so, in words, with the log tail. */
export function HostFailure() {
  const st = useSession((s) => s.hostState);
  const [detailOpen, setDetailOpen] = useState(false);
  const [tail, setTail] = useState<string>('');
  const failed = st.phase === 'failed';
  useEffect(() => {
    if (!failed) return;
    // The host's own stderr: where a driver says what it could not do.
    void host()
      .diagnostics()
      .then((d) => setTail(((d as { stderr_tail?: string[] }).stderr_tail ?? []).join('\n')))
      .catch(() => {});
  }, [failed]);
  if (st.phase === 'restarting')
    return (
      <div className="host-banner" role="status">
        {tz('The engine stopped and is being restarted…', '引擎已停止，正在重启…')}
      </div>
    );
  if (st.phase !== 'failed') return null;
  const detail = tail || st.detail || '';
  const vulkan = /vulkan|\bvk|no .*device|GPU/i.test(st.reason + ' ' + detail);
  return (
    <Dialog.Root open>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog" data-testid="host-failure" aria-describedby={undefined}>
          <Dialog.Title asChild>
            <h2>{tz('The render engine could not start', '渲染引擎无法启动')}</h2>
          </Dialog.Title>
          <div className="dialog-body">
            <p>{st.reason}</p>
            {vulkan && (
              <p className="caption">
                {inAndroid() ? tz(
                  'SpektraLab uses the Vulkan driver built into Android. If the error persists after restarting the engine, check for a system update and include the engine log in your report.',
                  'SpektraLab 使用 Android 系统自带的 Vulkan 驱动。若重启引擎后仍报错，请检查系统更新，并在反馈时附上引擎日志。',
                ) : tz(
                  'SpektraLab renders on the GPU through Vulkan. Make sure a Vulkan driver is installed for your graphics card (on Linux: mesa-vulkan-drivers or your vendor’s driver; on Windows: the latest driver from your GPU vendor), then restart the engine.',
                  'SpektraLab 通过 Vulkan 在 GPU 上渲染。请确认已为显卡安装 Vulkan 驱动（Linux：mesa-vulkan-drivers 或厂商驱动；Windows：显卡厂商的最新驱动），然后重启引擎。',
                )}
              </p>
            )}
            {detail && (
              <details open={detailOpen} onToggle={(e) => setDetailOpen((e.target as HTMLDetailsElement).open)}>
                <summary>{tz('Engine log', '引擎日志')}</summary>
                <div className="mono" style={{ maxHeight: 220, overflow: 'auto' }}>
                  {detail}
                </div>
              </details>
            )}
          </div>
          <div className="dialog-actions">
            <button className="btn" onClick={() => void platform().appPaths().then((p) => platform().reveal(p.logs))}>
              {tz('Show logs', '显示日志')}
            </button>
            <button className="btn primary" onClick={() => void host().restart()}>
              {tz('Restart engine', '重启引擎')}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
