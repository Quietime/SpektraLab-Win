// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { androidCall } = vi.hoisted(() => ({ androidCall: vi.fn() }));
vi.mock('./bridge', () => ({ androidCall, inAndroid: () => true }));

import { configureMobilePerformance, effectiveMobilePreviewEdge, getMobilePerformance } from './performance';

describe('Android performance profile', () => {
  beforeEach(() => androidCall.mockReset());

  it('uses actual display data and lowers preview size under memory or thermal pressure', async () => {
    androidCall.mockImplementation((method: string) => Promise.resolve(method === 'display_info'
      ? { model: 'device', width: 2800, height: 1800, actual_hz: 60, requested_hz: 60, density: 2.75 }
      : { ram_mb: 8192, available_mb: 4096, thermal_status: 0, cpu_cores: 8, soc: 'test' }));
    await configureMobilePerformance();
    expect(getMobilePerformance()?.display?.width).toBe(2800);
    expect(document.documentElement.style.getPropertyValue('--mobile-display-width')).toBe('2800px');
    expect(effectiveMobilePreviewEdge(5000)).toBe(4096);
    window.dispatchEvent(new CustomEvent('spektralab-thermal', { detail: 3 }));
    expect(effectiveMobilePreviewEdge(4096)).toBe(1920);
    window.dispatchEvent(new CustomEvent('spektralab-thermal', { detail: 4 }));
    expect(effectiveMobilePreviewEdge(4096)).toBe(1080);
    expect(getMobilePerformance()?.display?.actual_hz).toBe(60);
  });
});
