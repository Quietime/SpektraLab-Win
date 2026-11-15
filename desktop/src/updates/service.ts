import { invoke } from '@tauri-apps/api/core';
import { androidCall, inAndroid } from '../mobile/bridge';
import { inTauri } from '../host/transport';
import { flushFrameOrder, flushPairChanges, flushSave, sessionStore } from '../state/session';
import { loadTable, saveTable, tableStore } from '../lighttable/model';

export interface UpdateStatus {
  channel?: 'windows-x64' | 'android-phone-arm64' | 'android-tablet-arm64' | string;
  current_build?: number;
  available?: boolean;
  version?: string;
  build?: number;
  bytes?: number;
  notes?: string;
  error?: string;
  ready?: boolean;
  installation_pending?: boolean;
}

type Listener = (status: UpdateStatus) => void;
let status: UpdateStatus = {};
let initialized = false;
let lastAutomaticCheck = 0;
let automaticCheckRunning = false;
let updateOperation: Promise<unknown> = Promise.resolve();
let installationRunning = false;
const listeners = new Set<Listener>();

export const getUpdateStatus = () => status;
export function subscribeUpdates(listener: Listener) {
  listeners.add(listener);
  listener(status);
  return () => { listeners.delete(listener); };
}
function publish(next: UpdateStatus) {
  status = next;
  listeners.forEach((listener) => listener(status));
}

function serializeUpdateOperation<T>(operation: () => Promise<T>): Promise<T> {
  const next = updateOperation.then(operation, operation);
  updateOperation = next.then(() => undefined, () => undefined);
  return next;
}

export const canUseNativeUpdates = () => inAndroid() || inTauri();

async function callNative(method: 'check_updates' | 'update_prepare' | 'update_install'): Promise<UpdateStatus> {
  if (!canUseNativeUpdates()) throw new Error('Managed updates are available in the installed app.');
  if (inAndroid()) return androidCall<UpdateStatus>(method);
  return invoke<UpdateStatus>(method);
}

export async function checkForUpdates(): Promise<UpdateStatus> {
  return serializeUpdateOperation(async () => {
    // Android's installer can be canceled. Recheck staged state when the app
    // returns so Settings can offer Install again.
    if (status.installation_pending) publish({ ...status, installation_pending: false });
    try {
      const result = await callNative('check_updates');
      publish(result);
      return status;
    } catch (error) {
      publish({ ...status, error: String(error) });
      return status;
    }
  }).catch((error) => {
    publish({ ...status, error: String(error) });
    return status;
  });
}

export async function prepareUpdate(): Promise<UpdateStatus> {
  if (!canUseNativeUpdates()) return status;
  return serializeUpdateOperation(async () => {
    publish({ ...status, error: undefined, ready: false });
    try {
      publish(await callNative('update_prepare'));
    } catch (error) {
      publish({ ...status, ready: false, error: String(error) });
    }
    return status;
  });
}

export interface InstallFlushes {
  isBatchExporting(): boolean;
  flushPairChanges(render: false): Promise<void>;
  flushSave(force: true): Promise<void>;
  flushFrameOrder(): Promise<void>;
  saveTable(): Promise<void>;
  install(): Promise<UpdateStatus | void>;
}

export async function installAfterSaving(flushes: InstallFlushes): Promise<{ started: boolean; installationPending?: boolean; error?: string }> {
  if (flushes.isBatchExporting()) return { started: false, error: 'Finish the batch export before installing an update.' };
  if (installationRunning) return { started: false, error: 'An update installation is already in progress.' };
  installationRunning = true;
  try {
    await flushes.flushPairChanges(false);
    await flushes.flushSave(true);
    await flushes.flushFrameOrder();
    await flushes.saveTable();
    if (flushes.isBatchExporting()) return { started: false, error: 'Finish the batch export before installing an update.' };
    const response = await flushes.install();
    if (response?.error) throw new Error(response.error);
    return { started: true, installationPending: response?.installation_pending === true };
  } catch (error) {
    return { started: false, error: String(error) };
  } finally {
    installationRunning = false;
  }
}

export async function installUpdate(): Promise<{ started: boolean; installationPending?: boolean; error?: string }> {
  let nativeResult: UpdateStatus | undefined;
  const result = await installAfterSaving({
    isBatchExporting: () => sessionStore.getState().batchExporting,
    flushPairChanges,
    flushSave,
    flushFrameOrder,
    saveTable: async () => {
      await loadTable();
      await saveTable();
      if (tableStore.getState().error) throw new Error(tableStore.getState().error);
    },
    install: async () => {
      nativeResult = await callNative('update_install');
      publish(nativeResult);
      return nativeResult;
    },
  });
  if (!result.started) publish({ ...(nativeResult ?? status), error: result.error });
  return result;
}

export function initializeAutomaticUpdates() {
  if (initialized || !canUseNativeUpdates()) return;
  initialized = true;
  window.setTimeout(() => {
    if (document.visibilityState === 'visible') {
      lastAutomaticCheck = Date.now();
      automaticCheckRunning = true;
      void checkForUpdates().finally(() => { automaticCheckRunning = false; });
    }
  }, 10_000);
  const checkIfDue = () => {
    if (automaticCheckRunning || document.visibilityState !== 'visible') return;
    const due = !lastAutomaticCheck || Date.now() - lastAutomaticCheck >= 24 * 60 * 60 * 1000;
    if (!due && !status.installation_pending) return;
    lastAutomaticCheck = Date.now();
    automaticCheckRunning = true;
    void checkForUpdates().finally(() => { automaticCheckRunning = false; });
  };
  // Polling more frequently than 24 hours avoids missing the age threshold on
  // a timer tick that fires slightly early. Hidden apps check on resume.
  window.setInterval(checkIfDue, 15 * 60 * 1000);
  document.addEventListener('visibilitychange', checkIfDue);
  window.addEventListener('focus', checkIfDue);
}
