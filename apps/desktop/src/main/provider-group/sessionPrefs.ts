/**
 * 任务级的供应商组偏好(docs/product-rules/provider-groups.md §6.2「任务进行中换号」)：用户在换号提示里勾了
 * 「以后自动换，不再询问」的任务，之后用户自己发消息前直接换、不再弹窗。只对那一个任务有效。
 *
 * 记在任务所在电脑上(发送前的检查在这里跑)，按账号存放，跨重启保留：
 * `userData/owners/<账号>/provider-group-session-prefs.json`，只有任务 id 与打开的时间，不含消息、凭证或用户身份。
 * 超出容量时淘汰最久之前打开的。
 */
import { activeOwnerScopeKey, ownerScopedUserDataPath } from '../appSessionState.js';
import { desktopMakerLogger } from '../maker-host/logger-adapter.js';
import { createOverrideSettingsFile } from '../maker-host/override-settings-file.js';

interface SessionPrefsFile {
  /** 任务 id → 打开「以后自动换」的时间(unix ms)。 */
  autoRebalance: Record<string, number>;
}

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
export const MAX_PROVIDER_GROUP_SESSION_PREFS = 4000;

function prune(sessions: Record<string, number>): Record<string, number> {
  const entries = Object.entries(sessions);
  if (entries.length <= MAX_PROVIDER_GROUP_SESSION_PREFS) return sessions;
  entries.sort((a, b) => b[1] - a[1]);
  return Object.fromEntries(entries.slice(0, MAX_PROVIDER_GROUP_SESSION_PREFS));
}

function normalize(raw: unknown): SessionPrefsFile {
  const value = (raw as Partial<SessionPrefsFile> | null)?.autoRebalance;
  const out: Record<string, number> = {};
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [sessionId, at] of Object.entries(value)) {
      if (SESSION_ID_PATTERN.test(sessionId) && typeof at === 'number' && Number.isFinite(at) && at > 0) out[sessionId] = at;
    }
  }
  return { autoRebalance: prune(out) };
}

const store = createOverrideSettingsFile<SessionPrefsFile>({
  filePath: () => ownerScopedUserDataPath('provider-group-session-prefs.json'),
  scopeKey: activeOwnerScopeKey,
  defaults: { autoRebalance: {} },
  normalize,
  log: desktopMakerLogger.child('provider-group-session-prefs'),
  label: 'provider-group-session-prefs',
  maxBytes: 512 * 1024,
  preserveUnreadableFile: true,
  logLoadedValue: false,
});

/** 这个任务选过「以后自动换，不再询问」。 */
export function readProviderGroupAutoRebalance(sessionId: string): boolean {
  if (!SESSION_ID_PATTERN.test(sessionId)) return false;
  store.invalidateIfChanged();
  return store.read().autoRebalance[sessionId] !== undefined;
}

/** 记下这个任务以后自动换号。 */
export async function writeProviderGroupAutoRebalance(sessionId: string, now: number = Date.now()): Promise<void> {
  if (!SESSION_ID_PATTERN.test(sessionId)) return;
  await store.updateAtomic(({ value }) => ({ autoRebalance: prune({ ...value.autoRebalance, [sessionId]: now }) }));
}
