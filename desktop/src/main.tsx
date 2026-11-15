// main.tsx — boot: theme, language, interface scale, keys, menu, session.

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/theme.css';
import './mobile/mobile.css';
import './mobile/compat';
import {inAndroid,androidCall} from './mobile/bridge';
import { setLanguage } from './i18n';
import { settingsStore } from './state/settings';
import { boot,flushSave,flushPairChanges,flushFrameOrder,setPages,sessionStore,requestPrint } from './state/session';
import { EditorWindow } from './windows/EditorWindow';
import { installKeys } from './windows/keys';
import { MENU_CHORDS, installMenu } from './windows/menus';
import { inTauri } from './host/transport';
import { useSettings } from './state/settings';
import { saveTable,tableStore,loadTable } from './lighttable/model';
import { initializeAutomaticUpdates } from './updates/service';
import { UpdateNotice } from './updates/UpdateNotice';
import { configureMobilePerformance,effectiveMobilePreviewEdge } from './mobile/performance';
import { host } from './host/client';

if(inAndroid()){
 document.documentElement.dataset.mobile='true';
 const saveMobile=async()=>{await flushPairChanges(false);await flushSave(true);await flushFrameOrder();await saveTable();};
 window.addEventListener('spektralab-pause',()=>{void saveMobile().catch(console.error);});
 window.addEventListener('spektralab-close',()=>{
  const state=sessionStore.getState(),settings=settingsStore.getState();if(state.batchExporting)return;
  if(tableStore.getState().open){window.dispatchEvent(new Event('spektralab-lighttable-back'));return;}
  if(state.exportOpen||state.settingsOpen||state.aboutOpen){setPages({exportOpen:false,settingsOpen:false,aboutOpen:false});return;}
  if(!settings.leftCollapsed||!settings.rightCollapsed){settings.set('leftCollapsed',true);settings.set('rightCollapsed',true);return;}
  void saveMobile().then(()=>androidCall('finish')).catch(console.error);
 });
 if(!localStorage.getItem('spektralab-mobile-defaults')){
  const set=settingsStore.getState().set;
  set('previewLongEdge',1080);set('memoryCapMB',1024);set('memoryReserveMB',768);set('diskCacheGiB',1);
  set('leftCollapsed',true);set('rightCollapsed',true);set('interfaceScale',115);
  localStorage.setItem('spektralab-mobile-defaults','1');
 }
}
let lastRetention=-1;

function applySettings() {
  const s = settingsStore.getState();
  setLanguage(s.language);
  document.documentElement.style.setProperty('--ui-scale', String(s.interfaceScale / 100));
  if(inTauri()&&s.logRetentionDays!==lastRetention){
    lastRetention=s.logRetentionDays;
    void import('@tauri-apps/api/core').then(({invoke})=>invoke('logs_retention',{days:s.logRetentionDays})).catch(e=>console.error('log retention',e));
  }
}
applySettings();

let lastLanguage = settingsStore.getState().language;
settingsStore.subscribe((s) => {
  applySettings();
  if (s.language !== lastLanguage) {
    lastLanguage = s.language;
    if (inTauri()) void installMenu().catch((e) => console.error('menu', e));
  }
});

installKeys(inTauri() ? MENU_CHORDS : new Set());
if (inTauri()) void installMenu().catch((e) => console.error('menu', e));
// A native close must await recipe writes; beforeunload cannot keep IPC alive.
if(inTauri()) void import('@tauri-apps/api/window').then(async({getCurrentWindow})=>{
  const win=getCurrentWindow();let savedClose=false,closing=false;
  await win.onCloseRequested(e=>{
    if(savedClose)return;
    e.preventDefault();
    if(closing||sessionStore.getState().batchExporting)return;
    closing=true;
    void import('./state/session').then(async({flushPairChanges,flushSave,flushFrameOrder})=>{
      await flushPairChanges(false);await flushSave(true);await flushFrameOrder();await saveTable();savedClose=true;await win.close();
    }).catch(e=>console.error('Cannot close before saving the recipe',e)).finally(()=>{closing=false;});
  });
});

// The webview's own context menu (Reload / Inspect) is not the app's.
if (import.meta.env.PROD) window.addEventListener('contextmenu', (e) => e.preventDefault());

function App() {
  // Re-render everything on a language change: strings are looked up at render.
  useSettings((s) => s.language);
  return <><EditorWindow /><UpdateNotice /></>;
}

window.addEventListener('spektralab-open-update-settings',()=>{settingsStore.getState().set('settingsPage','general');setPages({settingsOpen:true});});
window.addEventListener('spektralab-mobile-profile',()=>{
 const sid=sessionStore.getState().engineSession;if(!sid)return;
 void host().setParams(sid,{preview_long_edge:effectiveMobilePreviewEdge(settingsStore.getState().previewLongEdge)})
  .then(()=>requestPrint()).catch(e=>console.warn('Mobile preview profile update',e));
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

void boot();
void loadTable().catch(e=>console.error('Cannot load light table',e));
initializeAutomaticUpdates();
void configureMobilePerformance();
if(inTauri())void import('./agent/workspace').then(m=>m.installAgentBridge()).catch(e=>console.error('agent bridge',e));

// For the layout harness and for debugging from the webview inspector.
import { frameImages } from './state/frames';
(window as unknown as Record<string, unknown>).__spk = { sessionStore, settingsStore, frameImages };
