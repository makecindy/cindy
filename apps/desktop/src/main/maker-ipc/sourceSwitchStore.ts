/**
 * 「用户把这个任务换到了另一个来源」的一次性记录。
 *
 * 用户主动换源后，任务的 Codex 原生线程仍属于原来源；下一次发送必须先做上下文交接，
 * 否则它会回到原来源自己的登录上去续接（登录已断开就报错）。这条意图必须在**选择落定**
 * 时写入磁盘，并在下列时机之后仍然有效：
 *  - 进程重启（冷启动后再发送）；
 *  - 挂起的换源在回合结束后才生效（`pendingCredentialSwitch`）。
 *
 * 它不是设置项，也不进任务行：一个任务一条，交接提交或记录被新选择覆盖即删除，按数量与
 * 时效裁剪。读不到文件时按「没有记录」处理，绝不因此拦住发送。
 */
import { activeOwnerScopeKey, ownerScopedUserDataPath } from '../appSessionState.js';
import { desktopMakerLogger } from '../maker-host/logger-adapter.js';
import { createOverrideSettingsFile } from '../maker-host/override-settings-file.js';

const MAX_ENTRIES = 2000;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_ID = /^[A-Za-z0-9_-]{1,80}$/;
const PROVIDER_ID = /^[A-Za-z0-9_-]{1,80}$/;

export interface SourceSwitchFile {
  switches: Record<string, { providerId: string; atMs: number }>;
}

export function normalizeSourceSwitchFile(raw: unknown): SourceSwitchFile {
  const switches = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as { switches?: unknown }).switches : undefined;
  if (!switches || typeof switches !== 'object' || Array.isArray(switches)) return { switches: {} };
  const oldest = Date.now() - MAX_AGE_MS;
  const kept = Object.entries(switches as Record<string, unknown>)
    .flatMap(([sessionId, entry]) => {
      const value = entry as { providerId?: unknown; atMs?: unknown };
      const atMs = typeof value?.atMs === 'number' && Number.isFinite(value.atMs) ? value.atMs : 0;
      return SESSION_ID.test(sessionId) && typeof value?.providerId === 'string'
        && PROVIDER_ID.test(value.providerId) && atMs >= oldest
        ? [[sessionId, { providerId: value.providerId, atMs }] as const] : [];
    })
    .sort((left, right) => right[1].atMs - left[1].atMs)
    .slice(0, MAX_ENTRIES);
  return { switches: Object.fromEntries(kept) };
}

const file = createOverrideSettingsFile<SourceSwitchFile>({
  filePath: () => ownerScopedUserDataPath('codex-source-switch.json'),
  scopeKey: activeOwnerScopeKey,
  defaults: { switches: {} },
  normalize: normalizeSourceSwitchFile,
  log: desktopMakerLogger,
  label: 'codex-source-switch',
  maxBytes: 1024 * 1024,
  // Transient intent, not user settings: a damaged file is replaced, never kept in place.
  preserveUnreadableFile: false,
  logLoadedValue: false,
});

/** Remember the source the user picked, replacing this task's previous record. */
export async function recordSourceSwitch(sessionId: string, providerId: string | null): Promise<void> {
  if (!SESSION_ID.test(sessionId) || !providerId || !PROVIDER_ID.test(providerId)) return;
  const atMs = Date.now();
  await file.updateAtomic(({ value }) => ({
    switches: { ...value.switches, [sessionId]: { providerId, atMs } },
  }));
}

/** Whether this task still waits for the source the user picked; a stale record never matches. */
export function matchesSourceSwitch(sessionId: string, providerId: string | null): boolean {
  if (!SESSION_ID.test(sessionId) || !providerId) return false;
  file.invalidateIfChanged();
  const recorded = file.read().switches[sessionId];
  return recorded?.providerId === providerId && Date.now() - recorded.atMs < MAX_AGE_MS;
}

/** The handoff that protects the transcript committed; the record has no further use. */
export async function consumeSourceSwitch(sessionId: string): Promise<void> {
  if (!SESSION_ID.test(sessionId)) return;
  await file.updateAtomic(({ value }) => {
    if (!(sessionId in value.switches)) return null;
    const switches = { ...value.switches };
    delete switches[sessionId];
    return { switches };
  });
}
