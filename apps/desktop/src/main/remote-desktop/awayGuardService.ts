import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { app, BrowserWindow, ipcMain, powerMonitor, powerSaveBlocker, screen } from 'electron';
import { createLogger } from '../logger';
import { t } from '../i18n';
import { onQuit } from '../lifecycle';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer';
import { requireBoolean, throwIpcError } from '../utils/ipcValidate';
import { AwayGuardController, consoleSessionLocked } from './awayGuard';
import {
  lockDesktopScreen,
  readDesktopInputPermission,
  requestDesktopInputPermission,
} from './inputHost';
import { watchAwayGuardInput, type AwayGuardInputMonitor } from './privacyInput';
import { PrivacyScreen } from './privacyScreen';
import { awayScreenHtml } from './privacyScreenHtml';
import {
  AWAY_GUARD_GET_STATE_CHANNEL,
  AWAY_GUARD_PREVIEW_CHANNEL,
  AWAY_GUARD_PREVIEW_DELAY_MS,
  AWAY_GUARD_SET_DELAY_CHANNEL,
  AWAY_GUARD_SET_ENABLED_CHANNEL,
  isAwayGuardDelaySeconds,
  type AwayGuardDelaySeconds,
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
  /** Chosen absence before the cover; null follows the system display-sleep time. */
  delaySeconds(): AwayGuardDelaySeconds | null;
  screenLocked(): boolean;
  /** Startup lock state, used until the first lock/unlock event. */
  seedScreenLocked(locked: boolean): void;
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

/** True while the away cover is up (physical input cannot reach any app). */
/** Physical input is already consumed by the helper, so Agent input cannot hit the owner's work. */
export function isAwayCoverUp(): boolean {
  return controller?.inputShielded === true;
}

export function startAwayGuard(deps: AwayGuardServiceDeps): void {
  if (controller || !supportsAwayGuard()) return;
  let monitor: AwayGuardInputMonitor | null = null;
  let helperLocked = false;
  let displayAwake: number | null = null;
  let awayAfterMs = DEFAULT_AWAY_MS;
  let displaySleepReadAt = 0;
  let generation = 0;
  // The system lock screen takes the front; after unlock, give the owner back the
  // Cindy window they were using rather than whatever macOS picks.
  let restoreWindow: BrowserWindow | null = null;
  const restoreFront = () => {
    const window = restoreWindow;
    restoreWindow = null;
    if (!window || window.isDestroyed() || deps.screenLocked()) return;
    window.show();
    window.focus();
    app.focus({ steal: true });
  };
  powerMonitor.on('unlock-screen', restoreFront);
  // Started on a locked screen there is no lock event yet; read the console session so
  // the guard does not hold the display on behind the lock screen.
  void exec('/usr/sbin/ioreg', ['-n', 'Root', '-d1'], { timeout: 5000, maxBuffer: 1024 * 1024 })
    .then(({ stdout }) => {
      const locked = consoleSessionLocked(stdout, process.getuid?.());
      if (locked !== null) deps.seedScreenLocked(locked);
    })
    .catch(() => {});

  const refreshDisplaySleep = () => {
    if (Date.now() - displaySleepReadAt < DISPLAY_SLEEP_REFRESH_MS) return;
    displaySleepReadAt = Date.now();
    // By default cover when the system would have locked: display sleep, or an earlier
    // screen saver. Read while the guard keeps the display awake, so it never sleeps.
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

  /** True only when the screen is confirmed locked. */
  const lockNow = async (): Promise<boolean> => {
    if (deps.screenLocked()) return true;
    try {
      await lockDesktopScreen(() => true, AbortSignal.timeout(6000));
      return true;
    } catch (error) {
      log.error('away guard lock failed', error);
      return deps.screenLocked();
    }
  };

  // The lock could not be confirmed (e.g. Accessibility was revoked): never uncover an
  // unlocked desktop. The masks stay up with a way out, the controller releases the
  // display, and the masks go once macOS locks by itself or the owner locks.
  let heldUntilLocked = false;
  const holdUntilLocked = () => {
    heldUntilLocked = true;
    void masks
      .replacePage(awayScreenHtml(t('awayGuard.lockFailed.status'), t('awayGuard.lockFailed.hint'), false))
      .catch(() => {});
  };
  const releaseHeld = () => {
    if (!heldUntilLocked) return;
    heldUntilLocked = false;
    masks.stop();
  };
  powerMonitor.on('lock-screen', releaseHeld);

  const masks = new PrivacyScreen(
    // Nothing streams these masks; Agent screenshots read the windows behind them.
    () => {},
    // The helper or a mask ended on its own: never leave the desktop without a lock.
    async () => {
      const locked = helperLocked || (await lockNow());
      controller?.masksEnded();
      if (locked) return;
      holdUntilLocked();
      return false;
    },
    // No local confirmation dialog: physical input goes straight to the system lock.
    async () => async () => {},
    async (_localInput, failed) => {
      helperLocked = false;
      const watched = await watchAwayGuardInput(
        (locked) => {
          helperLocked = locked;
          if (monitor === watched) monitor = null;
          failed();
        },
        (reason) => log.info('away guard locking', { reason }),
      );
      monitor = watched;
      return watched;
    },
    {
      html: () => awayScreenHtml(t('awayGuard.status'), t('awayGuard.hint')),
      nonActivating: true,
    },
  );

  controller = new AwayGuardController({
    enabled: deps.enabled,
    screenLocked: deps.screenLocked,
    msSinceOwnerInput: deps.msSinceOwnerInput,
    awayAfterMs: () => {
      const chosen = deps.delaySeconds();
      if (chosen !== null) return chosen * 1000;
      refreshDisplaySleep();
      return awayAfterMs;
    },
    keepDisplayAwake: (requested) => {
      // While masks wait for macOS to lock by itself, the display must be free to sleep.
      const awake = requested && !heldUntilLocked;
      if (awake && displayAwake === null) {
        displayAwake = powerSaveBlocker.start('prevent-display-sleep');
      } else if (!awake && displayAwake !== null) {
        powerSaveBlocker.stop(displayAwake);
        displayAwake = null;
      }
    },
    showMasks: async () => {
      if (heldUntilLocked) {
        if (!deps.screenLocked()) throw new Error('DESKTOP_LOCK_PENDING');
        releaseHeld();
      }
      const current = ++generation;
      restoreWindow = BrowserWindow.getFocusedWindow();
      try {
        await masks.set(true, () => current === generation);
      } catch (error) {
        restoreFront();
        throw error;
      }
    },
    lockAndHideMasks: async () => {
      generation++;
      const locked = (monitor ? await monitor.lock() : false) || (await lockNow());
      if (!locked) {
        holdUntilLocked();
        throw new Error('DESKTOP_LOCK_FAILED');
      }
      masks.stop();
    },
    hideMasks: () => {
      generation++;
      masks.stop();
      restoreFront();
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

interface AwayGuardSettings {
  enabled: boolean;
  delaySeconds: AwayGuardDelaySeconds | null;
}

export async function readAwayGuardState(settings: AwayGuardSettings): Promise<AwayGuardState> {
  if (!supportsAwayGuard())
    return { available: false, enabled: false, delaySeconds: null, permission: 'unknown' };
  const status = await readDesktopInputPermission();
  return {
    available: true,
    enabled: settings.enabled,
    delaySeconds: settings.delaySeconds,
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
  read(): AwayGuardSettings;
  writeEnabled(enabled: boolean): void;
  writeDelay(delaySeconds: AwayGuardDelaySeconds | null): void;
}): void {
  ipcMain.handle(AWAY_GUARD_GET_STATE_CHANNEL, (event) => {
    assertTrustedAppRendererEvent(event);
    return readAwayGuardState(settings.read());
  });
  ipcMain.handle(AWAY_GUARD_SET_ENABLED_CHANNEL, async (event, enabled: unknown) => {
    assertTrustedAppRendererEvent(event);
    const next = requireBoolean(enabled, 'enabled');
    if (!supportsAwayGuard()) return readAwayGuardState(settings.read());
    if (next) await prepareAwayGuardPermission();
    settings.writeEnabled(next);
    // Apply now: turning it off while covered locks before the masks go.
    void controller?.tick();
    return readAwayGuardState(settings.read());
  });
  ipcMain.handle(AWAY_GUARD_SET_DELAY_CHANNEL, async (event, delaySeconds: unknown) => {
    assertTrustedAppRendererEvent(event);
    if (delaySeconds !== null && !isAwayGuardDelaySeconds(delaySeconds))
      throwIpcError('INVALID_PARAMS', 'delaySeconds must be one of the offered choices or null');
    settings.writeDelay(delaySeconds);
    return readAwayGuardState(settings.read());
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
