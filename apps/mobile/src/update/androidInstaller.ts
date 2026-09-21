import { AppState, Linking, Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo-modules-core';
import * as FileSystem from 'expo-file-system/legacy';
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

async function downloadApk(
  url: string, signal: AbortSignal, progress: (value: number | null) => void,
): Promise<string> {
  if (!FileSystem.cacheDirectory) throw new Error('Cache unavailable');
  const directory = `${FileSystem.cacheDirectory}cindy-updates/`;
  await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
  // Android may still read the most recent handoff. Reap only our own old cache files.
  for (const name of await FileSystem.readDirectoryAsync(directory)) {
    if (!/^update-[0-9]+-[a-z0-9]+\.apk$/.test(name)) continue;
    const file = `${directory}${name}`;
    const info = await FileSystem.getInfoAsync(file);
    if (info.exists && !info.isDirectory && Date.now() / 1000 - info.modificationTime > 86400) {
      await FileSystem.deleteAsync(file, { idempotent: true }).catch(() => undefined);
    }
  }
  if (signal.aborted) throw abortError();
  const file = `${directory}update-${Date.now()}-${Math.random().toString(36).slice(2)}.apk`;
  let finished = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectStopped: (reason: Error) => void = () => undefined;
  const stopped = new Promise<never>((_, reject) => { rejectStopped = reject; });
  const task = FileSystem.createDownloadResumable(url, file, {}, (event) => {
    if (finished) return;
    armTimeout();
    progress(event.totalBytesExpectedToWrite > 0
      ? Math.min(1, Math.max(0, event.totalBytesWritten / event.totalBytesExpectedToWrite)) : null);
  });
  const stop = () => {
    rejectStopped(abortError());
    void task.cancelAsync().catch(() => undefined);
  };
  const armTimeout = () => {
    clearTimeout(timer);
    timer = setTimeout(stop, 90_000);
  };
  signal.addEventListener('abort', stop, { once: true });
  armTimeout();
  try {
    if (signal.aborted) throw abortError();
    const result = await Promise.race([task.downloadAsync(), stopped]);
    if (signal.aborted || !result || result.status !== 200) throw new Error('APK download failed');
    return file;
  } catch (error) {
    await task.cancelAsync().catch(() => undefined);
    await FileSystem.deleteAsync(file, { idempotent: true }).catch(() => undefined);
    throw error;
  } finally {
    finished = true;
    clearTimeout(timer);
    signal.removeEventListener('abort', stop);
    // Release expo-file-system's progress subscription after completion as well.
    void task.cancelAsync().catch(() => undefined);
  }
}

export const androidInstaller = new AndroidInstallController({
  supported: () => native?.isSupported() === true,
  hasPermission: () => native!.hasPermission(),
  requestPermission: () => native!.requestPermission(),
  download: downloadApk,
  install: async (file, version, signal) => {
    await waitForForeground(signal);
    if (signal.aborted) throw abortError();
    await native!.install(file, version);
  },
  remove: (file) => FileSystem.deleteAsync(file, { idempotent: true }),
  openBrowser: (url) => Linking.openURL(url),
});
