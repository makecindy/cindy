import { BrowserWindow, ipcMain, shell } from 'electron';
import { createLogger } from '../logger';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer';
import {
  LOCAL_NETWORK_LOCAL,
  type LocalNetworkAccess,
  type LocalNetworkReminder,
  type LocalNetworkState,
} from '../../shared/localNetwork';
import {
  LocalNetworkAccessService,
  MAC_LOCAL_NETWORK_SETTINGS_URL,
  connectProbe,
  readMacLanGateway,
} from './access';
import { LocalNetworkReminderState } from './reminder';

const log = createLogger('local-network');

/** While System Settings is open, notice the grant even if the user never returns to Cindy. */
const SETTINGS_WATCH_INTERVAL_MS = 2_000;
const SETTINGS_WATCH_LIMIT_MS = 3 * 60_000;

const access = new LocalNetworkAccessService({
  platform: process.platform,
  lanGateway: () => readMacLanGateway(),
  connect: connectProbe,
  openSettings: () => shell.openExternal(MAC_LOCAL_NETWORK_SETTINGS_URL),
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
});
const reminder = new LocalNetworkReminderState({ now: () => Date.now() });
const grantedListeners = new Set<() => void>();
let lastAccess: LocalNetworkAccess | null = null;
let lastBroadcast = '';
let settingsWatch: ReturnType<typeof setInterval> | null = null;

function currentState(): LocalNetworkState {
  const value = lastAccess ?? 'unknown';
  return { access: value, reminder: reminder.current(value) };
}

function broadcastIfChanged(): void {
  const state = currentState();
  const key = JSON.stringify(state);
  if (key === lastBroadcast) return;
  lastBroadcast = key;
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send(LOCAL_NETWORK_LOCAL.CHANGED, state);
    } catch (error) {
      log.warn('local network broadcast failed (non-fatal)', error);
    }
  }
}

access.onChange((next, previous) => {
  lastAccess = next;
  if (previous !== null) log.info(`local network access ${previous} -> ${next}`);
  else if (next === 'denied') log.info('local network access denied');
  if (next !== 'denied') stopSettingsWatch();
  if (previous === 'denied' && next === 'granted') {
    for (const listener of grantedListeners) {
      try {
        listener();
      } catch (error) {
        log.warn('local network grant listener failed', error);
      }
    }
  }
  broadcastIfChanged();
});

function stopSettingsWatch(): void {
  if (settingsWatch) clearInterval(settingsWatch);
  settingsWatch = null;
}

function watchSettingsUntilGranted(): void {
  stopSettingsWatch();
  const started = Date.now();
  settingsWatch = setInterval(() => {
    if (Date.now() - started > SETTINGS_WATCH_LIMIT_MS) {
      stopSettingsWatch();
      return;
    }
    void access.read({ fresh: true });
  }, SETTINGS_WATCH_INTERVAL_MS);
  settingsWatch.unref?.();
}

async function readState(fresh = false): Promise<LocalNetworkState> {
  await access.read({ fresh });
  return currentState();
}

/** Device Link calls this when the user turns on control of this computer. */
export function noteLocalNetworkControlEnabled(): void {
  if (process.platform !== 'darwin') return;
  reminder.controlEnabled();
  void readState(true).then(broadcastIfChanged, () => {});
}

/**
 * Device Link reports which same-account peers are connected only through the
 * relay. Without Local Network access no LAN path can exist, so this is the
 * moment the missing permission actually costs the user.
 */
export function noteLocalNetworkRelayOnlyPeers(deviceIds: readonly string[]): void {
  if (process.platform !== 'darwin') return;
  const shouldProbe = reminder.relayOnly(deviceIds);
  if (shouldProbe) void readState().then(broadcastIfChanged, () => {});
  else broadcastIfChanged();
}

/** Restart direct connection attempts after the user grants access. */
export function onLocalNetworkGranted(listener: () => void): () => void {
  grantedListeners.add(listener);
  return () => grantedListeners.delete(listener);
}

export function registerLocalNetworkIpc(): void {
  ipcMain.handle(LOCAL_NETWORK_LOCAL.STATUS, (event) => {
    assertTrustedAppRendererEvent(event);
    return readState();
  });
  ipcMain.handle(LOCAL_NETWORK_LOCAL.REQUEST, async (event) => {
    assertTrustedAppRendererEvent(event);
    const result = await access.request();
    if (result === 'denied') watchSettingsUntilGranted();
    return currentState();
  });
}
