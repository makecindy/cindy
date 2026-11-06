import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ipcMain, powerSaveBlocker, screen } from 'electron';
import { createLogger } from '../logger';
import { t } from '../i18n';
import { onQuit } from '../lifecycle';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer';
import { requireBoolean } from '../utils/ipcValidate';
import { AwayGuardController } from './awayGuard';
import {
  lockDesktopScreen,
  readDesktopInputPermission,
  requestDesktopInputPermission,
} from './inputHost';
import { watchAwayGuardInput, type AwayGuardInputMonitor } from './privacyInput';
import { PrivacyScreen } from './privacyScreen';
import {
  AWAY_GUARD_GET_STATE_CHANNEL,
  AWAY_GUARD_PREVIEW_CHANNEL,
  AWAY_GUARD_PREVIEW_DELAY_MS,
  AWAY_GUARD_SET_ENABLED_CHANNEL,
  type AwayGuardPreviewResult,
  type AwayGuardState,
} from '../../shared/awayGuard';

const log = createLogger('remote-desktop:away-guard');
const exec = promisify(execFile);
const TICK_MS = 2_000;
/** Used when the system never sleeps the display on its own. */
const DEFAULT_AWAY_MS = 10 * 60_000;
const DISPLAY_SLEEP_REFRESH_MS = 60_000;

export interface AwayGuardServiceDeps {
  enabled(): boolean;
  busy(): Promise<boolean>;
  remoteDesktopActive(): boolean;
  screenLocked(): boolean;
  msSinceOwnerInput(): number | null;
}

/** Same platform floor as the remote desktop privacy masks; the helper is macOS-only. */
export function supportsAwayGuard(): boolean {
  return (
    process.platform === 'darwin' &&
    typeof process.getSystemVersion === 'function' &&
    Number(process.getSystemVersion().split('.')[0]) >= 14
  );
}

let controller: AwayGuardController | null = null;

export function startAwayGuard(deps: AwayGuardServiceDeps): void {
  if (controller || !supportsAwayGuard()) return;
  let monitor: AwayGuardInputMonitor | null = null;
  let helperLocked = false;
  let displayAwake: number | null = null;
  let awayAfterMs = DEFAULT_AWAY_MS;
  let displaySleepReadAt = 0;
  let generation = 0;

  const refreshDisplaySleep = () => {
    if (Date.now() - displaySleepReadAt < DISPLAY_SLEEP_REFRESH_MS) return;
    displaySleepReadAt = Date.now();
    // Cover no later than the system would have: display sleep, or an earlier screen saver.
    void Promise.all([
      exec('/usr/bin/pmset', ['-g'], { timeout: 5000, maxBuffer: 64 * 1024 })
        .then(({ stdout }) => Number(/^\s*displaysleep\s+(\d+)/m.exec(stdout)?.[1]) * 60_000)
        .catch(() => 0),
      exec('/usr/bin/defaults', ['-currentHost', 'read', 'com.apple.screensaver', 'idleTime'], {
        timeout: 5000,
        maxBuffer: 1024,
      })
        .then(({ stdout }) => Number(stdout.trim()) * 1000)
        .catch(() => 0),
    ]).then((values) => {
      const set = values.filter((value) => Number.isFinite(value) && value > 0);
      awayAfterMs = set.length ? Math.min(...set) : DEFAULT_AWAY_MS;
    });
  };

  const lockNow = async () => {
    if (deps.screenLocked()) return;
    await lockDesktopScreen(() => true, AbortSignal.timeout(6000)).catch((error) =>
      log.error('away guard lock failed', error),
    );
  };

  const masks = new PrivacyScreen(
    // Nothing streams these masks; Agent screenshots read the windows behind them.
    () => {},
    // The helper or a mask ended on its own: never leave the desktop without a lock.
    async () => {
      if (!helperLocked) await lockNow();
      controller?.masksEnded();
    },
    // No local confirmation dialog: physical input goes straight to the system lock.
    async () => async () => {},
    async (_localInput, failed) => {
      helperLocked = false;
      const watched = await watchAwayGuardInput((locked) => {
        helperLocked = locked;
        if (monitor === watched) monitor = null;
        failed();
      });
      monitor = watched;
      return watched;
    },
    () => ({ status: t('awayGuard.status'), hint: t('awayGuard.hint') }),
  );

  controller = new AwayGuardController({
    enabled: deps.enabled,
    busy: deps.busy,
    remoteDesktopActive: deps.remoteDesktopActive,
    screenLocked: deps.screenLocked,
    msSinceOwnerInput: deps.msSinceOwnerInput,
    awayAfterMs: () => {
      refreshDisplaySleep();
      return awayAfterMs;
    },
    keepDisplayAwake: (awake) => {
      if (awake && displayAwake === null) {
        displayAwake = powerSaveBlocker.start('prevent-display-sleep');
      } else if (!awake && displayAwake !== null) {
        powerSaveBlocker.stop(displayAwake);
        displayAwake = null;
      }
    },
    showMasks: async () => {
      const current = ++generation;
      await masks.set(true, () => current === generation);
    },
    lockAndHideMasks: async () => {
      generation++;
      const locked = monitor ? await monitor.lock() : false;
      if (!locked) await lockNow();
      masks.stop();
    },
    hideMasks: () => {
      generation++;
      masks.stop();
    },
    now: Date.now,
    log: (event, detail) => log.info(event, detail ?? {}),
  });

  screen.on('display-added', () => void controller?.displaysChanged());
  const timer = setInterval(() => void controller?.tick(), TICK_MS);
  timer.unref();
  onQuit('away-guard', () => {
    clearInterval(timer);
    // The helper also locks on EOF; ask first so the lock does not wait for exit.
    monitor?.lockOnExit();
  });
}

export async function readAwayGuardState(enabled: boolean): Promise<AwayGuardState> {
  if (!supportsAwayGuard()) return { available: false, enabled: false, permission: 'unknown' };
  const status = await readDesktopInputPermission();
  return {
    available: true,
    enabled,
    permission: status === 'granted' ? 'granted' : status === 'missing' ? 'missing' : 'unknown',
  };
}

/** Turning the guard on asks macOS for the input helper's Accessibility access once. */
export async function prepareAwayGuardPermission(): Promise<void> {
  if (!supportsAwayGuard() || (await readDesktopInputPermission()) !== 'missing') return;
  await requestDesktopInputPermission(() => true, AbortSignal.timeout(6000)).catch((error) =>
    log.warn('away guard permission request failed', error),
  );
}

/** Settings → App behavior toggle. Local app renderer only; not a device-link capability. */
export function registerAwayGuardIpc(settings: {
  read(): boolean;
  write(enabled: boolean): void;
}): void {
  ipcMain.handle(AWAY_GUARD_GET_STATE_CHANNEL, (event) => {
    assertTrustedAppRendererEvent(event);
    return readAwayGuardState(settings.read());
  });
  ipcMain.handle(AWAY_GUARD_SET_ENABLED_CHANNEL, async (event, enabled: unknown) => {
    assertTrustedAppRendererEvent(event);
    const next = requireBoolean(enabled, 'enabled');
    if (!supportsAwayGuard()) return readAwayGuardState(false);
    if (next) await prepareAwayGuardPermission();
    settings.write(next);
    // Apply now: turning it off while covered locks before the masks go.
    void controller?.tick();
    return readAwayGuardState(next);
  });
  ipcMain.handle(AWAY_GUARD_PREVIEW_CHANNEL, async (event): Promise<AwayGuardPreviewResult> => {
    assertTrustedAppRendererEvent(event);
    if (!supportsAwayGuard() || !controller) return { ok: false, reason: 'unavailable' };
    await prepareAwayGuardPermission();
    if ((await readDesktopInputPermission()) !== 'granted') return { ok: false, reason: 'permission' };
    const target = controller;
    // The click that asked for this must not count as someone touching the Mac.
    setTimeout(() => {
      void target.preview().catch((error) => log.warn('away guard preview failed', error));
    }, AWAY_GUARD_PREVIEW_DELAY_MS);
    return { ok: true };
  });
}
