import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { CindyRegion } from '@cindy/maker-shared/brand-identity';
import type { DevProfileKind } from './devCliFlags.js';
import { withLocalProfileMigrationStartupBarrier } from './localProfileDataMigration.js';
import { atomicWriteFileSync } from './utils/atomicWriteFile.js';

export type DesktopDevMode = 'remote' | 'local' | 'unknown';
export type DesktopDevInstanceState = 'starting' | 'ready' | 'failed';

/**
 * Runtime provenance persisted under the effective userData directory.
 * Written by dev AND packaged instances: dev/release share a userData with
 * per-flavor single-instance lock scopes, and the owner-namespace migration's
 * exclusivity guard discovers concurrent instances through this registry, so
 * packaged instances must register too. Dev tooling (desktop:whoami, startup
 * status) still only drives the dev-specific fields; a packaged record keeps
 * state 'starting' because the dev ready/failed reporting hooks are dev-only,
 * and no consumer depends on a packaged record reaching 'ready'.
 */
export interface DesktopDevInstanceRecord {
  schemaVersion: 1;
  instanceId: string;
  pid: number;
  startedAtMs: number;
  updatedAtMs: number;
  rootDir: string;
  commit: string | null;
  mode: DesktopDevMode;
  /** 构建区域；共享 userData 启动器据此拒绝跨区域 passive 预览。 */
  region: CindyRegion;
  passive: boolean;
  /** 解析后是否真的落在独立纪元沙箱。不是「有 userData 覆写」。 */
  isolated: boolean;
  /** 启动旗标是否声明了 --isolated / XDT_ISOLATED。 */
  isolationIntent?: boolean;
  /** 解析后的实际 profile 归属。 */
  profileKind?: DevProfileKind;
  userDataDir: string;
  state: DesktopDevInstanceState;
  failure?: {
    code: string;
    message: string;
    detail?: Record<string, unknown>;
  };
}

export interface BeginDesktopDevInstanceOptions {
  userDataDir: string;
  dbFilePrefix: string;
  rootDir: string;
  commit?: string | null;
  mode?: DesktopDevMode;
  region?: CindyRegion;
  passive: boolean;
  isolated: boolean;
  isolationIntent?: boolean;
  profileKind?: DevProfileKind;
  pid?: number;
  startedAtMs?: number;
  instanceId?: string;
}

let trackedInstance: { filePath: string; record: DesktopDevInstanceRecord } | null = null;
let mainWindowReady = false;
let applicationReady = false;
let startupSettled = false;

function atomicWriteJson(filePath: string, value: unknown): void {
  atomicWriteFileSync(filePath, `${JSON.stringify(value)}\n`);
}

function readJson(filePath: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
    return value !== null && typeof value === 'object' ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function updateExternalStartupStatus(
  state: 'window-ready' | 'ready' | 'failed',
  detail: Record<string, unknown>,
): void {
  const statusPath = process.env.XDT_DESKTOP_DEV_STARTUP_STATUS_FILE;
  if (!statusPath) return;

  try {
    const currentState = readJson(statusPath)?.state;
    const canTransition = state === 'window-ready'
      ? currentState === 'pending'
      : currentState === 'pending' || currentState === 'window-ready';
    if (!canTransition) return;
    atomicWriteJson(statusPath, { state, pid: process.pid, at: Date.now(), ...detail });
  } catch {
    // Startup reporting is diagnostic-only; never turn a report failure into the app failure.
  }
}

function updateTrackedInstance(
  state: DesktopDevInstanceState,
  failure?: DesktopDevInstanceRecord['failure'],
): void {
  if (!trackedInstance) return;
  const record: DesktopDevInstanceRecord = {
    ...trackedInstance.record,
    state,
    updatedAtMs: Date.now(),
    ...(failure ? { failure } : {}),
  };
  try {
    atomicWriteJson(trackedInstance.filePath, record);
    trackedInstance.record = record;
  } catch {
    // Runtime provenance is best-effort and must never stop the product from opening.
  }
}

/**
 * Register this Electron main process before single-instance arbitration.
 * The returned cleanup only removes the record when its random instanceId still owns it.
 */
export async function beginDesktopDevInstance(
  options: BeginDesktopDevInstanceOptions,
): Promise<() => void> {
  mainWindowReady = false;
  applicationReady = false;
  startupSettled = false;
  const pid = options.pid ?? process.pid;
  const startedAtMs = options.startedAtMs ?? Date.now();
  const record: DesktopDevInstanceRecord = {
    schemaVersion: 1,
    instanceId: options.instanceId ?? randomUUID(),
    pid,
    startedAtMs,
    updatedAtMs: startedAtMs,
    rootDir: path.resolve(options.rootDir),
    commit: options.commit ?? null,
    mode: options.mode ?? 'unknown',
    region: options.region ?? 'global',
    passive: options.passive,
    isolated: options.isolated,
    ...(options.isolationIntent !== undefined ? { isolationIntent: options.isolationIntent } : {}),
    ...(options.profileKind !== undefined ? { profileKind: options.profileKind } : {}),
    userDataDir: path.resolve(options.userDataDir),
    state: 'starting',
  };
  const filePath = path.join(record.userDataDir, '.dev-instances', `${pid}.json`);

  try {
    await withLocalProfileMigrationStartupBarrier(record.userDataDir, options.dbFilePrefix, () => {
      // Initial registration is part of the adoption safety protocol. If it
      // cannot be published, fail startup rather than continuing invisibly and
      // writing local-v1 while another process snapshots it.
      atomicWriteJson(filePath, record);
      trackedInstance = { filePath, record };
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    markDesktopDevStartupFailed('INSTANCE_REGISTRATION_FAILED', message, {
      phase: 'instance-registration',
    });
    throw error;
  }

  return () => {
    if (trackedInstance?.record.instanceId === record.instanceId) trackedInstance = null;
    try {
      if (readJson(filePath)?.instanceId === record.instanceId) {
        fs.rmSync(filePath, { force: true });
      }
    } catch {
      // A stale record is harmless: desktop:whoami verifies that the PID is alive.
    }
  };
}

function settleDesktopDevReadyIfPossible(): void {
  if (startupSettled || !mainWindowReady || !applicationReady) return;
  startupSettled = true;
  updateTrackedInstance('ready');
  updateExternalStartupStatus('ready', {
    instance: trackedInstance?.record ?? null,
  });
}

/** Record that the main BrowserWindow can render, without claiming the database is ready. */
export function markDesktopDevWindowReady(): void {
  if (startupSettled) return;
  mainWindowReady = true;
  updateExternalStartupStatus('window-ready', {
    instance: trackedInstance?.record ?? null,
  });
  settleDesktopDevReadyIfPossible();
}

/** Record that auth/database initialization no longer blocks use of the rendered app. */
export function markDesktopDevReady(): void {
  if (startupSettled) return;
  applicationReady = true;
  settleDesktopDevReadyIfPossible();
}

type DesktopDevAuthState = {
  isAuthenticated: boolean;
  user: unknown | null;
};

/**
 * Complete logged-out startup immediately only when auth is definitive. A cold-start
 * timeout is a temporary renderer fallback: keep restart pending until background auth
 * settles, so a late login still has time to report its localDb migration result.
 */
export function recordDesktopDevAuthStartupResult(
  initialState: DesktopDevAuthState,
  pendingCompletion: Promise<DesktopDevAuthState> | null,
  readCurrentState: () => DesktopDevAuthState,
): void {
  if (initialState.isAuthenticated && initialState.user !== null) return;
  if (pendingCompletion === null) {
    markDesktopDevReady();
    return;
  }

  void pendingCompletion.then(
    () => {
      // The background refresh result may be stale: a manual login increments
      // authStateEpoch and makes that old flow resolve as logged out. Consult the
      // live auth state so the new user's localDb result still owns the startup latch.
      const currentState = readCurrentState();
      if (!currentState.isAuthenticated || currentState.user === null) markDesktopDevReady();
    },
    (err) => {
      markDesktopDevStartupFailed(
        'AUTH_INIT_FAILED',
        err instanceof Error ? err.message : String(err),
        { phase: 'auth:initialize:late' },
      );
    },
  );
}

/** Bridge localDb.ensureReady's stable result shape into the dev startup contract. */
export function recordDesktopDevLocalDbStartupResult(result: {
  ready: boolean;
  error?: { code: string; message: string };
}): void {
  if (result.ready) {
    markDesktopDevReady();
  } else if (result.error) {
    markDesktopDevStartupFailed(result.error.code, result.error.message, {
      phase: 'local-db:ensure-ready',
    });
  }
}

/** Preserve the first concrete main-process startup failure for the waiting restart command. */
export function markDesktopDevStartupFailed(
  code: string,
  message: string,
  detail?: Record<string, unknown>,
): void {
  if (startupSettled) return;
  startupSettled = true;
  const failure = { code, message, ...(detail ? { detail } : {}) };
  updateTrackedInstance('failed', failure);
  updateExternalStartupStatus('failed', { code, message, ...(detail ? { detail } : {}) });
}
