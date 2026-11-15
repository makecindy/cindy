import { AppState, Linking, Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo-modules-core';
import * as FileSystem from 'expo-file-system/legacy';
import { DownloadTask, File } from 'expo-file-system';
import * as Network from 'expo-network';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { AndroidInstallController } from './androidInstallController';

interface NativeInstaller {
  isSupported(): boolean;
  hasPermission(): Promise<boolean>;
  requestPermission(): Promise<boolean>;
  install(file: string, version: string): Promise<void>;
}
const native = Platform.OS === 'android'
  ? requireOptionalNativeModule<NativeInstaller>('CindyAppInstaller') : null;

function abortError(): Error { return new Error('Update download cancelled'); }

/** Never raise an installer over another app when a download finishes in the background. */
async function waitForForeground(signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw abortError();
  if (AppState.currentState === 'active') return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => { subscription.remove(); signal.removeEventListener('abort', abort); };
    const abort = () => { cleanup(); reject(abortError()); };
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') { cleanup(); resolve(); }
    });
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

// A dismissed sheet may immediately be opened again. Wait for the previous native
// writer to stop before inspecting its on-disk offset or reusing the same file.
let downloadTail: Promise<unknown> = Promise.resolve();
function withDownloadCache<T>(operation: () => Promise<T>): Promise<T> {
  const result = downloadTail.then(operation);
  downloadTail = result.catch(() => undefined);
  return result;
}

function downloadApk(
  url: string, signal: AbortSignal, progress: (value: number | null) => void, version: string, wifiOnly = false,
): Promise<string> {
  return withDownloadCache(() => runDownload(url, signal, progress, version, wifiOnly));
}

async function runDownload(
  url: string, signal: AbortSignal, progress: (value: number | null) => void, version: string, wifiOnly: boolean,
): Promise<string> {
  if (signal.aborted) throw abortError();
  if (!FileSystem.cacheDirectory) throw new Error('Cache unavailable');
  const directory = `${FileSystem.cacheDirectory}cindy-updates/`;
  await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
  // The identity survives process death without storing URLs or progress snapshots.
  // Different releases (even at the same URL) never share partial bytes.
  const key = bytesToHex(sha256(JSON.stringify([url, version])));
  const file = `${directory}update-resume-${key}.apk`;
  const ready = `${directory}update-ready-${key}.apk`;
  for (const name of await FileSystem.readDirectoryAsync(directory)) {
    if (signal.aborted) throw abortError();
    if (!/^update-(?:[0-9]+-[a-z0-9]+|(?:resume|ready)-[a-f0-9]{64})\.apk$/.test(name)) continue;
    const cached = `${directory}${name}`;
    if (cached === file || cached === ready) continue;
    const info = await FileSystem.getInfoAsync(cached);
    if (info.exists && !info.isDirectory) {
      // Timestamp-named files are immutable system-installer handoffs (including
      // older clients' handoffs). Retain their existing 24-hour grace period.
      if (/^update-[0-9]+-[a-z0-9]+\.apk$/.test(name)
        && Date.now() / 1000 - info.modificationTime <= 86400) continue;
      await FileSystem.deleteAsync(cached, { idempotent: true }).catch(() => undefined);
    }
  }
  if (signal.aborted) throw abortError();
  const completed = await FileSystem.getInfoAsync(ready);
  if (completed.exists && !completed.isDirectory) return ready;
  const transfer = (transferSignal: AbortSignal) => transferApk(url, file, ready, transferSignal, progress);
  return wifiOnly ? downloadOnWifi(signal, transfer) : transfer(signal);
}

/** Subscribe before reading the network, and pause the native writer on Wi-Fi loss.
 * The normal download queue still owns cleanup and the file throughout the wait. */
async function downloadOnWifi(signal: AbortSignal, transfer: (signal: AbortSignal) => Promise<string>): Promise<string> {
  let wifi = false;
  let observed = false;
  let attempt: AbortController | null = null;
  let wake: (() => void) | undefined;
  const onNetwork = (state: Network.NetworkState) => {
    observed = true;
    wifi = state.type === Network.NetworkStateType.WIFI && state.isConnected === true && state.isInternetReachable !== false;
    if (!wifi) attempt?.abort();
    wake?.();
  };
  const subscription = Network.addNetworkStateListener(onNetwork);
  const abort = () => { attempt?.abort(); wake?.(); };
  signal.addEventListener('abort', abort);
  try {
    const initial = await Network.getNetworkStateAsync();
    if (!observed) onNetwork(initial);
    for (;;) {
      if (signal.aborted) throw abortError();
      if (!wifi) {
        await new Promise<void>((resolve) => { wake = resolve; });
        wake = undefined;
        continue;
      }
      const currentAttempt = new AbortController();
      attempt = currentAttempt;
      try {
        return await transfer(currentAttempt.signal);
      } catch (error) {
        if (signal.aborted || !currentAttempt.signal.aborted) throw error;
        // A network transition paused the transfer; wait for Wi-Fi and resume disk bytes.
      } finally {
        attempt = null;
      }
    }
  } finally {
    subscription.remove();
    signal.removeEventListener('abort', abort);
  }
}

async function transferApk(
  url: string, file: string, ready: string, signal: AbortSignal, progress: (value: number | null) => void,
): Promise<string> {
  if (signal.aborted) throw abortError();
  const info = await FileSystem.getInfoAsync(file);
  let offset = info.exists && !info.isDirectory ? info.size : 0;
  for (;;) {
    if (signal.aborted) throw abortError();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let finished = false;
    const armTimeout = () => {
      clearTimeout(timer);
      timer = setTimeout(stop, 90_000);
    };
    const options = {
      onProgress: (event: { bytesWritten: number; totalBytes: number }) => {
        if (finished || signal.aborted) return;
        armTimeout();
        progress(event.totalBytes > 0
          ? Math.min(1, Math.max(0, event.bytesWritten / event.totalBytes)) : null);
      },
    };
    // Android's native resume token is the persisted file length. The current Expo
    // downloader checks HTTP status before writing and truncates when Range is
    // ignored (200), unlike the legacy downloader which blindly appends responses.
    const task = offset > 0
      ? DownloadTask.fromSavable({ url, fileUri: file, isDirectory: false, resumeData: String(offset) }, options)
      : new DownloadTask(url, new File(file), options);
    const stop = () => {
      // Pause waits for native output to close; retain the bytes even when the
      // user dismisses the sheet. Repeated abort/timeout events share one pause.
      if (task.state === 'active' && !stopping) {
        stopping = true;
        void task.pauseAsync().catch(() => undefined);
      }
    };
    let stopping = false;
    signal.addEventListener('abort', stop, { once: true });
    armTimeout();
    try {
      if (signal.aborted) throw abortError();
      const result = await (offset > 0 ? task.resumeAsync() : task.downloadAsync());
      if (signal.aborted || !result) throw abortError();
      // Keep files already handed to Android immutable, even if the user opens
      // the same update again while the system installer still holds its URI.
      await FileSystem.moveAsync({ from: file, to: ready });
      return ready;
    } catch (error) {
      // A completed/stale partial may be outside the server's range. Retry once
      // from zero; network failures and user cancellation retain usable bytes.
      if (!signal.aborted && offset > 0 && /HTTP 416\b/.test(String(error))) {
        await FileSystem.deleteAsync(file, { idempotent: true });
        offset = 0;
        continue;
      }
      throw error;
    } finally {
      finished = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', stop);
      task.release();
    }
  }
}

export const androidInstaller = new AndroidInstallController({
  supported: () => native?.isSupported() === true,
  hasPermission: () => native!.hasPermission(),
  requestPermission: () => native!.requestPermission(),
  download: downloadApk,
  waitForForeground,
  install: async (file, version, signal) => {
    await waitForForeground(signal);
    await withDownloadCache(async () => {
      if (signal.aborted) throw abortError();
      // Android may open the URI after startActivity has returned. Give it a
      // separate immutable handoff, so new-target cleanup can reclaim the cache.
      const handoff = file.replace(/[^/]+$/, `update-${Date.now()}-${Math.random().toString(36).slice(2)}.apk`);
      try {
        await FileSystem.copyAsync({ from: file, to: handoff });
        if (signal.aborted) throw abortError();
        await native!.install(handoff, version);
      } catch (error) {
        await FileSystem.deleteAsync(handoff, { idempotent: true }).catch(() => undefined);
        throw error;
      }
    });
  },
  // A rejected cached APK must finish deletion before an immediate retry can reuse it.
  remove: (file) => withDownloadCache(() => FileSystem.deleteAsync(file, { idempotent: true })),
  openBrowser: (url) => Linking.openURL(url),
});
