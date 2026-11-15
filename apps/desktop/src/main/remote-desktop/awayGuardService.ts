import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { release as osRelease } from 'node:os';
import { app, BrowserWindow, ipcMain, powerMonitor, powerSaveBlocker, screen } from 'electron';
import { createLogger } from '../logger';
import { t } from '../i18n.desktop';
import { onQuit } from '../lifecycle';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer';
import { requireBoolean, throwIpcError } from '../utils/ipcValidate';
import { AwayGuardController, consoleSessionLocked, parseWindowsDisplayOffMs } from './awayGuard';
import {
  verifyDesktopOwner,
  lockDesktopScreen,
  readDesktopLockState,
  readDesktopInputPermission,
  requestDesktopInputPermission,
} from './inputHost';
import { watchAwayGuardInput, type AwayGuardInputMonitor } from './privacyInput';
import { keepAwakeController } from '../device-link/power-blocker';
import { PrivacyScreen } from './privacyScreen';
import { privacyScreenHtml } from './privacyScreenHtml';
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
/** Time for the system lock screen to fade in above the masks before they are removed. */
const LOCK_SCREEN_SETTLE_MS = 1500;

export interface AwayGuardServiceDeps {
  /** Publish cover IDs to the shared remote-capture exclusion filter. */
  excludedWindows(ids: number[]): void;
  enabled(): boolean;
  /** Chosen absence before the cover; null follows the system display-sleep time. */
  delaySeconds(): AwayGuardDelaySeconds | null;
  screenLocked(): boolean;
  /** Startup lock state, used until the first lock/unlock event. */
  seedScreenLocked(locked: boolean): void;
  msSinceOwnerInput(): number | null;
  /** Work needs the screen awake (see displayDemand.ts); otherwise the system sleeps and locks. */
  needsDisplay(): boolean;
}

/**
 * The privacy screen with its native input guard: macOS 14+ and Windows 10 build 19041+,
 * the same floor as the remote desktop privacy masks. Hyprland has its own compositor
 * backend (linuxPrivacy.ts).
 */
export function supportsAwayGuard(): boolean {
  if (process.platform === 'darwin')
    return (
      typeof process.getSystemVersion === 'function' &&
      Number(process.getSystemVersion().split('.')[0]) >= 14
    );
  return (
    WINDOWS_PRIVACY_SCREEN_ENABLED &&
    process.platform === 'win32' &&
    Number(osRelease().split('.')[2]) >= 19041
  );
}

/**
 * Windows: the helper's lock and lock confirmation, the away cover, "follow system" and
 * Windows Hello verification are implemented but stay off until they are verified on
 * Windows hardware (user decision 2026-11-14, docs/product-rules/privacy-screen.md).
 * Until then Windows keeps the released behavior: only the in-session privacy screen,
 * no lock on exit and no idle lock.
 */
export const WINDOWS_PRIVACY_SCREEN_ENABLED = false;

/** The persistent cover after a remote session uses the same masks. */
export function supportsRemoteExitPrivacy(): boolean {
  return supportsAwayGuard();
}

/** Hyprland's compositor backend answered as usable (set once its plugin check resolves). */
let linuxPrivacyReady = false;
export function setLinuxPrivacyAvailable(available: boolean): void {
  linuxPrivacyReady = available && process.platform === 'linux';
  keepAwakeController.setPrivacyScreen(privacyScreenEnabled());
}

/** This computer can offer 「用隐私屏代替锁屏」: macOS, Windows or a supported Hyprland. */
export function privacyScreenAvailable(): boolean {
  return supportsAwayGuard() || linuxPrivacyReady;
}

async function readWindowsDisplayOff(): Promise<number[]> {
  const powercfg = `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\powercfg.exe`;
  try {
    const { stdout } = await exec(powercfg, ['/q', 'SCHEME_CURRENT', 'SUB_VIDEO', 'VIDEOIDLE'], {
      timeout: 5000,
      maxBuffer: 64 * 1024,
      windowsHide: true,
    });
    return [parseWindowsDisplayOffMs(stdout, powerMonitor.isOnBatteryPower())];
  } catch {
    return [0];
  }
}

let controller: AwayGuardController | null = null;
/** This computer's own privacy-screen policy, shared with remote desktop sessions. */
let hostPolicy: { enabled(): boolean; awayAfterMs(): number; needsDisplay(): boolean } | null =
  null;

/**
 * 「用隐私屏代替锁屏」 is on and usable here. It alone decides whether a protected remote
 * exit covers or really locks (docs/product-rules/privacy-screen.md).
 */
export function privacyScreenEnabled(): boolean {
  return privacyScreenAvailable() && hostPolicy?.enabled() === true;
}

/** This computer's away time, also applied to idle remote desktop viewers. */
export function hostAwayAfterMs(): number | null {
  return hostPolicy?.awayAfterMs() ?? null;
}

/** Work currently needs this screen (running Agent task or a scheduled task about to start). */
export function displayNeededForWork(): boolean {
  return hostPolicy?.needsDisplay() === true;
}

/** True while the away cover is up (physical input cannot reach any app). */
/** Physical input is already consumed by the helper, so Agent input cannot hit the owner's work. */
export function isAwayCoverUp(): boolean {
  return controller?.inputShielded === true;
}

/** Reuse the persistent local cover; remote lease cleanup must not remove it. */
export async function coverRemoteDesktopExit(): Promise<void> {
  if (!controller) throw new Error('DESKTOP_PRIVACY_UNAVAILABLE');
  // With the privacy screen off, a protected exit is a real lock.
  if (!privacyScreenEnabled()) throw new Error('DESKTOP_PRIVACY_DISABLED');
  await controller.coverRemoteExit();
}

let holdLockFailure: (() => void) | null = null;
/**
 * A lock someone at this computer asked for was not confirmed (local privacy exit):
 * take the same persistent cover, show the lock-failed note and keep it until the OS
 * locks, exactly as when the away cover itself cannot lock.
 */
export async function coverDesktopLockFailure(): Promise<void> {
  const target = controller;
  if (!target || !holdLockFailure) throw new Error('DESKTOP_PRIVACY_UNAVAILABLE');
  await target.coverRemoteExit();
  // coverRemoteExit returns without masks only when the screen is already locked.
  if (target.inputShielded) holdLockFailure();
}

export function startAwayGuard(deps: AwayGuardServiceDeps): void {
  if (controller || hostPolicy) return;
  if (process.platform === 'linux') {
    // Hyprland's compositor draws and guards the cover (index.ts startLinuxAwayCover);
    // only the policy lives here. "Follow system" has no readable system time there.
    hostPolicy = {
      enabled: deps.enabled,
      awayAfterMs: () => (deps.delaySeconds() ?? DEFAULT_AWAY_MS / 1000) * 1000,
      needsDisplay: deps.needsDisplay,
    };
    keepAwakeController.setPrivacyScreen(privacyScreenEnabled());
    return;
  }
  if (!supportsRemoteExitPrivacy()) return;
  let monitor: AwayGuardInputMonitor | null = null;
  let helperLocked = false;
  let displayAwake: number | null = null;
  let awayAfterMs = DEFAULT_AWAY_MS;
  let displaySleepReadAt = 0;
  let generation = 0;
  let lockTransition = 0;
  let coverLockTransition = 0;
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
  // The system marks the session locked before its lock screen has faded in; removing the
  // masks at that instant showed the desktop for a moment (real-device test 2026-11-15).
  // The lock screen draws above the masks, so they stay until it is up, or until unlock.
  let lockScreenUp = false;
  let settleTimer: ReturnType<typeof setTimeout> | null = null;
  const stopMasksUnderLockScreen = () => {
    if (settleTimer) return;
    settleTimer = setTimeout(() => {
      settleTimer = null;
      masks.stop();
    }, LOCK_SCREEN_SETTLE_MS);
    settleTimer.unref?.();
  };
  powerMonitor.on('unlock-screen', () => {
    lockScreenUp = false;
    // An OS unlock also ends a held cover (#10665); with the owner back, uncover now.
    releaseHeld();
    if (settleTimer) {
      clearTimeout(settleTimer);
      settleTimer = null;
      masks.stop();
    }
    restoreFront();
  });
  // Started on a locked screen there is no lock event yet; read the console session so
  // the guard does not hold the display on behind the lock screen.
  if (process.platform === 'darwin') {
    void exec('/usr/sbin/ioreg', ['-n', 'Root', '-d1'], { timeout: 5000, maxBuffer: 1024 * 1024 })
      .then(({ stdout }) => {
        const locked = consoleSessionLocked(stdout, process.getuid?.());
        if (locked !== null) deps.seedScreenLocked(locked);
      })
      .catch(() => {});
  } else {
    void readDesktopLockState().then((state) => {
      if (state !== 'unavailable') deps.seedScreenLocked(state === 'locked');
    });
  }

  const refreshDisplaySleep = () => {
    if (Date.now() - displaySleepReadAt < DISPLAY_SLEEP_REFRESH_MS) return;
    displaySleepReadAt = Date.now();
    // By default cover when the system would have locked: display sleep, or an earlier
    // screen saver. Read while the guard keeps the display awake, so it never sleeps.
    void (process.platform === 'win32' ? readWindowsDisplayOff() : Promise.all([
      exec('/usr/bin/pmset', ['-g'], { timeout: 5000, maxBuffer: 64 * 1024 })
        .then(({ stdout }) => Number(/^\s*displaysleep\s+(\d+)/m.exec(stdout)?.[1]) * 60_000)
        .catch(() => 0),
      exec('/usr/bin/defaults', ['-currentHost', 'read', 'com.apple.screensaver', 'idleTime'], {
        timeout: 5000,
        maxBuffer: 1024,
      })
        .then(({ stdout }) => Number(stdout.trim()) * 1000)
        .catch(() => 0),
    ])).then((values) => {
      const set = values.filter((value) => Number.isFinite(value) && value > 0);
      awayAfterMs = set.length ? Math.min(...set) : DEFAULT_AWAY_MS;
    });
  };

  /** True only when the screen is confirmed locked. */
  const lockNow = async (): Promise<boolean> => {
    if (deps.screenLocked()) return true;
    try {
      // The helper tries the system lock, then the shortcut (about 5 s at worst).
      await lockDesktopScreen(() => true, AbortSignal.timeout(9000));
      return true;
    } catch (error) {
      log.error('away guard lock failed', error);
      return deps.screenLocked();
    }
  };

  // The lock could not be confirmed: never uncover an unlocked desktop, and never shut the
  // owner out (docs/product-rules/privacy-screen.md 「锁屏与锁不上时」). The masks stay with a
  // note and catch clicks, the controller releases the display, and the system's own
  // owner verification (Touch ID / password, Windows Hello / PIN) uncovers them. Cancelled
  // or unavailable: input is watched again, so the next touch retries the lock first. The
  // masks also go once the system locks by itself or the owner locks.
  let heldUntilLocked = false;
  let verifying = false;
  const verifyOwnerOrRetry = async () => {
    if (verifying || !heldUntilLocked) return;
    verifying = true;
    try {
      // The prompt needs the owner's typing; the input guard would swallow it.
      await masks.releaseInput();
      masks.lowerForSystemPrompt(true);
      const result = await verifyDesktopOwner(t('awayGuard.verifyReason'), masks.nativeWindowHandle());
      masks.lowerForSystemPrompt(false);
      if (!heldUntilLocked) return; // The system locked meanwhile.
      log.info('away guard owner verification', { result });
      if (result === 'verified') {
        heldUntilLocked = false;
        masks.stop();
        controller?.masksEnded();
        restoreFront();
        return;
      }
      await masks.rearmInput().catch((error) => log.warn('away guard input re-arm failed', error));
    } finally {
      verifying = false;
    }
  };
  const holdUntilLocked = () => {
    heldUntilLocked = true;
    masks.holdInput();
    void masks
      .replacePage(privacyScreenHtml(
        t('awayGuard.lockFailed.status'),
        t(process.platform === 'win32' ? 'awayGuard.lockFailed.hintWindows' : 'awayGuard.lockFailed.hint'),
      ))
      .catch(() => {});
    void verifyOwnerOrRetry();
  };
  const releaseHeld = () => {
    // An OS unlock also proves the owner passed the system lock. Remember both
    // transitions so a late failed lock attempt cannot put its old cover back.
    lockTransition++;
    if (!heldUntilLocked) return;
    heldUntilLocked = false;
    stopMasksUnderLockScreen();
  };
  powerMonitor.on('lock-screen', () => {
    lockScreenUp = true;
    releaseHeld();
    controller?.screenLockedNow();
  });
  holdLockFailure = holdUntilLocked;

  const masks = new PrivacyScreen(
    // Persistent covers must also be excluded when a viewer reconnects.
    deps.excludedWindows,
    // The helper or a mask ended on its own: never leave the desktop without a lock.
    async (): Promise<false | void> => {
      const transition = coverLockTransition;
      const locked = helperLocked || transition !== lockTransition || (await lockNow());
      controller?.masksEnded();
      // The system unlocked meanwhile: the owner passed it, so uncover now (#10665).
      if (transition !== lockTransition && !lockScreenUp) return;
      if (locked) {
        stopMasksUnderLockScreen();
        return false;
      }
      holdUntilLocked();
      return false;
    },
    // No local confirmation dialog: physical input goes straight to the system lock.
    async () => async () => {},
    async (_localInput, failed, pointer) => {
      helperLocked = false;
      const watched = await watchAwayGuardInput(
        (locked, failure) => {
          helperLocked = locked;
          if (failure) log.warn('away guard helper lock not confirmed', { reason: failure });
          if (monitor === watched) monitor = null;
          failed();
        },
        (reason) => log.info('away guard locking', { reason }),
        undefined,
        pointer,
      );
      monitor = watched;
      return watched;
    },
    {
      html: () => privacyScreenHtml(
        t('awayGuard.status'),
        t(process.platform === 'win32' ? 'awayGuard.hintWindows' : 'awayGuard.hint'),
      ),
      nonActivating: true,
      // No new UI or native permission: the held mask already catches local clicks.
      // If the helper cannot re-arm, the next click still retries lock + verification.
      heldInput: () => {
        if (verifying || !heldUntilLocked) return;
        verifying = true;
        void lockNow().then((locked) => {
          verifying = false;
          if (!heldUntilLocked) return;
          if (locked) releaseHeld();
          else void verifyOwnerOrRetry();
        });
      },
    },
  );

  function currentAwayAfterMs(): number {
    const chosen = deps.delaySeconds();
    if (chosen !== null) return chosen * 1000;
    refreshDisplaySleep();
    return awayAfterMs;
  }
  hostPolicy = { enabled: deps.enabled, awayAfterMs: currentAwayAfterMs, needsDisplay: deps.needsDisplay };
  // AI must be able to use this computer at any time: the privacy screen includes 「保持电脑唤醒」.
  keepAwakeController.setPrivacyScreen(privacyScreenEnabled());

  controller = new AwayGuardController({
    enabled: () => supportsAwayGuard() && deps.enabled(),
    screenLocked: deps.screenLocked,
    msSinceOwnerInput: deps.msSinceOwnerInput,
    awayAfterMs: currentAwayAfterMs,
    needsDisplay: deps.needsDisplay,
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
      coverLockTransition = lockTransition;
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
      const transition = coverLockTransition;
      // Do not send another lock shortcut after an intervening OS unlock.
      const locked =
        transition !== lockTransition ||
        (monitor ? await monitor.lock() : false) ||
        transition !== lockTransition ||
        (await lockNow());
      if (!locked && transition === lockTransition) {
        holdUntilLocked();
        throw new Error('DESKTOP_LOCK_FAILED');
      }
      // Unlocked in between (#10665): no lock screen will cover the desktop, uncover now.
      if (transition !== lockTransition && !lockScreenUp) return masks.stop();
      stopMasksUnderLockScreen();
    },
    hideMasks: () => {
      generation++;
      // Locked by other means (Touch ID / power key, the system): uncover under the lock
      // screen. Otherwise (a preview ran out) the owner was here: uncover now.
      if (lockScreenUp || deps.screenLocked()) return stopMasksUnderLockScreen();
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
  if (!privacyScreenAvailable())
    return { available: false, enabled: false, delaySeconds: null, permission: 'unknown' };
  const status = await readDesktopInputPermission();
  return {
    available: true,
    enabled: settings.enabled,
    delaySeconds: settings.delaySeconds,
    // Windows needs no Accessibility-style grant for the input guard.
    permission:
      status === 'granted' || status === 'notRequired'
        ? 'granted'
        : status === 'missing'
          ? 'missing'
          : 'unknown',
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
    if (!privacyScreenAvailable()) return readAwayGuardState(settings.read());
    if (next) await prepareAwayGuardPermission();
    settings.writeEnabled(next);
    keepAwakeController.setPrivacyScreen(privacyScreenEnabled());
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
    const permission = await readDesktopInputPermission();
    if (permission !== 'granted' && permission !== 'notRequired')
      return { ok: false, reason: 'permission' };
    const target = controller;
    // The click that asked for this must not count as someone touching the Mac.
    setTimeout(() => {
      void target.preview().catch((error) => log.warn('away guard preview failed', error));
    }, AWAY_GUARD_PREVIEW_DELAY_MS);
    return { ok: true };
  });
}
