import { androidCall, inAndroid } from './bridge';

export interface MobileDisplayInfo {
  model?: string;
  width: number;
  height: number;
  actual_hz?: number;
  requested_hz?: number;
  requested_mode?: number;
  density?: number;
  modes?: Array<{ id: number; width: number; height: number; hz: number }>;
}

export interface MobilePerformanceInfo {
  cpu_cores?: number;
  cpu_workers?: number;
  ram_mb?: number;
  available_mb?: number;
  soc?: string;
  thermal_status?: number;
  streamed_payloads?: number;
  display?: MobileDisplayInfo;
}

let profile: MobilePerformanceInfo | null = null;
let configured = false;

export const getMobilePerformance = () => profile;

/** Keep edit previews within both the user's quality setting and device headroom. */
export function effectiveMobilePreviewEdge(configuredEdge = 2560): number {
  const userEdge = Number.isFinite(configuredEdge) ? Math.max(384, Math.min(4096, configuredEdge)) : 2560;
  if (!inAndroid()) return userEdge;
  let cap = 4096;
  const available = profile?.available_mb ?? 0;
  const ram = profile?.ram_mb ?? 0;
  const thermal = profile?.thermal_status ?? 0;
  if (ram > 0 && ram <= 4096) cap = 1920;
  else if (ram > 0 && ram <= 6144) cap = 2608;
  if (available > 0 && available < 768) cap = Math.min(cap, 1080);
  else if (available > 0 && available < 1536) cap = Math.min(cap, 1920);
  if (thermal >= 4) cap = Math.min(cap, 1080);
  else if (thermal >= 3) cap = Math.min(cap, 1920);
  else if (thermal >= 2) cap = Math.min(cap, 2560);
  return Math.min(userEdge, cap, 4096);
}

function publish(next: MobilePerformanceInfo) {
  profile = next;
  const root = document.documentElement;
  const display = next.display;
  const density = display?.density ?? window.devicePixelRatio ?? 1;
  root.style.setProperty('--device-pixel-ratio', String(window.devicePixelRatio || density));
  if (display?.width && display.height) {
    root.style.setProperty('--mobile-display-width', `${display.width}px`);
    root.style.setProperty('--mobile-display-height', `${display.height}px`);
    root.dataset.displayOrientation = display.width >= display.height ? 'landscape' : 'portrait';
  }
  (window as unknown as { __spkMobilePerformance?: MobilePerformanceInfo }).__spkMobilePerformance = next;
  window.dispatchEvent(new CustomEvent('spektralab-mobile-profile', { detail: next }));
}

async function refreshProfile() {
  if (!inAndroid()) return;
  try {
    const [display, performance] = await Promise.all([
      androidCall<MobileDisplayInfo>('display_info'),
      androidCall<MobilePerformanceInfo>('performance_info'),
    ]);
    publish({ ...performance, display });
  } catch (error) {
    // Device information only tunes preview work. A missing report must never
    // prevent the editor from opening or rendering at its safe defaults.
    console.info('Android performance profile unavailable', String(error));
  }
}

export async function configureMobilePerformance() {
  if (!inAndroid()) return;
  if (!configured) {
    configured = true;
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    window.addEventListener('resize', () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => void refreshProfile(), 300);
    });
    window.addEventListener('orientationchange', () => void refreshProfile());
    window.addEventListener('spektralab-thermal', (event) => {
      const thermal = Number((event as CustomEvent<number>).detail);
      if (!profile || !Number.isFinite(thermal)) return;
      publish({ ...profile, thermal_status: thermal });
    });
  }
  await refreshProfile();
}
