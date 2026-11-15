// settings.ts — the app's own preferences (the macOS `UserDefaults` `ui2.*`).
//
// Per-viewer conveniences live in the webview's localStorage, which Tauri
// keeps in the app's data directory. The store takes its `Storage` as an
// argument (AGENTS.md trap 24): tests inject a throwaway one and never read
// the shared store.

import { createStore, type StoreApi } from 'zustand/vanilla';
import { useStore } from 'zustand';
import type { LanguageSetting } from '../i18n';
import type { SideUnit } from '@shared/params';

export type InterfaceScale = 100 | 115 | 130;
export const INTERFACE_SCALES: InterfaceScale[] = [100, 115, 130];
export const PREVIEW_EDGES = [3840, 2560, 1920, 1080] as const;
// Original Theme.Metric panel ranges: the grip overlays the rail edge.
export const PANEL_WIDTHS = { left: { min: 232, standard: 254, max: 380 }, right: { min: 280, standard: 288, max: 364 } } as const;
export function panelWidth(side: 'left' | 'right', value: number): number {
  const r = PANEL_WIDTHS[side];
  return Number.isFinite(value) ? Math.min(r.max, Math.max(r.min, Math.round(value))) : r.standard;
}

export interface Settings {
  language: LanguageSetting;
  interfaceScale: InterfaceScale;
  previewLongEdge: number;
  sideUnit: SideUnit;
  decoupleEffects: boolean;
  recalculateEffectsAfterCrop: boolean;
  diBlueCompensation: boolean;
  parametersTab: 'preDev' | 'postDev';
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  filmstripCollapsed: boolean;
  leftWidth: number;
  rightWidth: number;
  filmEdgeBodySeed: number;
  collapsedSections: Record<string, boolean>;
  lastFolder: string | null;
  settingsPage: 'general' | 'rendering' | 'storage' | 'diagnostics' | 'agents';
  diskCacheGiB:number;
  agentsEnabled:boolean;
  logRetentionDays:number;
  exportMode:'viewer'|'grid';
  exportGridColumns:number;
  memoryReserveMB:number;
  memoryCapMB:number;
  allowOverReserve:boolean;
}

export const SETTINGS_DEFAULT: Settings = {
  language: 'system',
  interfaceScale: 115,
  previewLongEdge: 2560,
  sideUnit: 'mm',
  decoupleEffects: false,
  recalculateEffectsAfterCrop: false,
  diBlueCompensation: false,
  parametersTab: 'preDev',
  leftCollapsed: false,
  rightCollapsed: false,
  filmstripCollapsed: false,
  leftWidth: 254,
  rightWidth: 288,
  filmEdgeBodySeed: 0,
  collapsedSections: {},
  lastFolder: null,
  settingsPage: 'general',
  diskCacheGiB:8,
  agentsEnabled:false,
  logRetentionDays:30,
  exportMode:'viewer',
  exportGridColumns:5,
  memoryReserveMB:2000,
  memoryCapMB:8192,
  allowOverReserve:false,
};

const KEY = 'ui2.settings';

export function loadSettings(storage: Pick<Storage, 'getItem'> | null): Settings {
  try {
    const raw = storage?.getItem(KEY);
    if (!raw) return SETTINGS_DEFAULT;
    const o = JSON.parse(raw) as Partial<Settings>;
    const out = { ...SETTINGS_DEFAULT } as Record<string, unknown>;
    for (const k of Object.keys(SETTINGS_DEFAULT) as (keyof Settings)[]) {
      const v = o[k];
      const d = SETTINGS_DEFAULT[k];
      if (v !== undefined && (typeof v === typeof d || d === null)) out[k] = v;
    }
    const s = out as unknown as Settings;
    s.leftWidth = panelWidth('left', s.leftWidth);
    s.rightWidth = panelWidth('right', s.rightWidth);
    if (!INTERFACE_SCALES.includes(s.interfaceScale)) s.interfaceScale = SETTINGS_DEFAULT.interfaceScale;
    if (!(PREVIEW_EDGES as readonly number[]).includes(s.previewLongEdge)) s.previewLongEdge = SETTINGS_DEFAULT.previewLongEdge;
    if(!Number.isFinite(s.diskCacheGiB)||s.diskCacheGiB<0||s.diskCacheGiB>256)s.diskCacheGiB=SETTINGS_DEFAULT.diskCacheGiB;
    if(!Number.isInteger(s.logRetentionDays)||s.logRetentionDays<0||s.logRetentionDays>365)s.logRetentionDays=SETTINGS_DEFAULT.logRetentionDays;
    if(!Number.isInteger(s.exportGridColumns)||s.exportGridColumns<2||s.exportGridColumns>8)s.exportGridColumns=SETTINGS_DEFAULT.exportGridColumns;
    if(!['viewer','grid'].includes(s.exportMode))s.exportMode='viewer';
    if(!Number.isInteger(s.memoryReserveMB)||s.memoryReserveMB<0||s.memoryReserveMB>32768)s.memoryReserveMB=SETTINGS_DEFAULT.memoryReserveMB;
    if(!Number.isInteger(s.memoryCapMB)||(s.memoryCapMB!==0&&(s.memoryCapMB<2048||s.memoryCapMB>131072)))s.memoryCapMB=SETTINGS_DEFAULT.memoryCapMB;
    return s;
  } catch {
    return SETTINGS_DEFAULT;
  }
}

export interface SettingsStore extends Settings {
  set<K extends keyof Settings>(key: K, value: Settings[K]): void;
  toggleSection(key: string): void;
}

export function createSettingsStore(storage: Pick<Storage, 'getItem' | 'setItem'> | null): StoreApi<SettingsStore> {
  return createStore<SettingsStore>((set, get) => ({
    ...loadSettings(storage),
    set(key, value) {
      set({ [key]: value } as Partial<SettingsStore>);
      persist(get());
    },
    toggleSection(key) {
      const c = { ...get().collapsedSections };
      c[key] = !c[key];
      set({ collapsedSections: c });
      persist(get());
    },
  }));
  function persist(s: SettingsStore) {
    queueMicrotask(() => {
      try {
        const out: Record<string, unknown> = {};
        for (const k of Object.keys(SETTINGS_DEFAULT)) out[k] = (s as unknown as Record<string, unknown>)[k];
        storage?.setItem(KEY, JSON.stringify(out));
      } catch {
        /* private window, blocked storage: the setting lasts the session */
      }
    });
  }
}

function defaultStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

export const settingsStore = createSettingsStore(defaultStorage());

/** One body per isolated app profile, inherited by newly opened frames. */
export function filmEdgeBodySeed(store: StoreApi<SettingsStore> = settingsStore): number {
  const saved = store.getState().filmEdgeBodySeed;
  if (Number.isInteger(saved) && saved > 0 && saved <= 2147483647) return saved;
  const random = new Uint32Array(1);
  crypto.getRandomValues(random);
  const seed = random[0]! % 999 + 1;
  store.getState().set('filmEdgeBodySeed', seed);
  return seed;
}
export function useSettings<T>(sel: (s: SettingsStore) => T): T {
  return useStore(settingsStore, sel);
}
