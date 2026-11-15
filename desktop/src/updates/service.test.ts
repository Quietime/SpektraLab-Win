// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('../mobile/bridge', () => ({ androidCall: vi.fn(), inAndroid: () => false }));
vi.mock('../host/transport', () => ({ inTauri: () => true }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

import { checkForUpdates, getUpdateStatus, initializeAutomaticUpdates, installAfterSaving, prepareUpdate } from './service';

describe('managed updates', () => {
  beforeEach(() => invoke.mockReset());
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it('reports available signed update metadata from the native command', async () => {
    invoke.mockResolvedValue({ channel: 'windows-x64', current_build: 13304, available: true, version: '1.3.3-lighttable.3', build: 13305, bytes: 240, notes: 'Light table and fixes', ready: false });
    await expect(checkForUpdates()).resolves.toMatchObject({ channel: 'windows-x64', available: true, build: 13305 });
    expect(invoke).toHaveBeenCalledWith('check_updates');
  });

  it('keeps offline status nonfatal and nonthrowing', async () => {
    invoke.mockResolvedValue({ channel: 'android-phone-arm64', current_build: 13304, available: false, ready: false, error: 'offline' });
    await expect(checkForUpdates()).resolves.toMatchObject({ available: false, error: 'offline' });
  });

  it('preserves a native network error when a staged signed update is still available', async () => {
    invoke.mockResolvedValue({ channel: 'android-phone-arm64', current_build: 13304, available: true, build: 13305, ready: true, error: 'offline' });
    await expect(checkForUpdates()).resolves.toMatchObject({ available: true, ready: true, error: 'offline' });
  });

  it('serializes check and prepare so a late check cannot overwrite staged status', async () => {
    let finishCheck!: (value: unknown) => void;
    invoke.mockImplementation((command: string) => command === 'check_updates'
      ? new Promise((resolve) => { finishCheck = resolve; })
      : Promise.resolve({ channel: 'windows-x64', available: true, build: 13305, ready: true }));
    const checking = checkForUpdates();
    const preparing = prepareUpdate();
    await vi.waitFor(() => expect(finishCheck).toBeTypeOf('function'));
    finishCheck({ channel: 'windows-x64', available: true, build: 13305, ready: false });
    await checking;
    await expect(preparing).resolves.toMatchObject({ ready: true });
    expect(invoke.mock.calls.map(([command]) => command)).toEqual(['check_updates', 'update_prepare']);
  });

  it('refuses install during batch export and flushes in required order otherwise', async () => {
    const order: string[] = [];
    const run = (exporting: boolean) => installAfterSaving({
      isBatchExporting: () => exporting,
      flushPairChanges: async () => { order.push('pair'); },
      flushSave: async () => { order.push('save'); },
      flushFrameOrder: async () => { order.push('order'); },
      saveTable: async () => { order.push('table'); },
      install: async () => { order.push('install'); },
    });
    await expect(run(true)).resolves.toMatchObject({ started: false });
    expect(order).toEqual([]);
    await expect(run(false)).resolves.toMatchObject({ started: true, installationPending: false });
    expect(order).toEqual(['pair', 'save', 'order', 'table', 'install']);
  });

  it('turns resolved native install errors into failures but preserves Android handoff as pending', async () => {
    const common = {
      isBatchExporting: () => false,
      flushPairChanges: async () => {}, flushSave: async () => {}, flushFrameOrder: async () => {}, saveTable: async () => {},
    };
    await expect(installAfterSaving({ ...common, install: async () => ({ available: true, ready: true, error: 'Allow installation from this app, then tap Install again' }) }))
      .resolves.toMatchObject({ started: false, error: expect.stringContaining('Allow installation') });
    await expect(installAfterSaving({ ...common, install: async () => ({ available: true, ready: true, installation_pending: true }) }))
      .resolves.toMatchObject({ started: true, installationPending: true });
  });

  it('checks after 24 foreground hours and reconciles canceled Android install on resume', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-11T00:00:00Z'));
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    invoke.mockResolvedValue({ channel: 'android-phone-arm64', available: true, ready: true });
    initializeAutomaticUpdates();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(invoke).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(invoke).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
    expect(invoke).toHaveBeenCalledTimes(2);
    invoke.mockResolvedValueOnce({ channel: 'android-phone-arm64', available: true, ready: true, installation_pending: true });
    await checkForUpdates();
    expect(getUpdateStatus().installation_pending).toBe(true);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(invoke).toHaveBeenCalledTimes(3);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(0);
    expect(invoke).toHaveBeenCalledTimes(4);
    expect(getUpdateStatus().installation_pending).toBeFalsy();
  });
});
