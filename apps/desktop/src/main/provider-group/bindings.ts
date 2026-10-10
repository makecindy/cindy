/**
 * 任务与组内电脑的绑定(docs/product-rules/provider-groups.md §6)：哪个任务由哪个供应商组分配、
 * 当前固定在哪台组内电脑上。按账号存在本机，跨重启保留，供自动换电脑与并发统计使用。
 *
 * 任务实际运行的位置以任务记录(`sessions.agent_device_id` / `provider_id`)为准；这里只记「它属于
 * 哪个组、对应组里哪一项」，不重复保存位置。
 */
import { activeOwnerScopeKey, ownerScopedUserDataPath } from '../appSessionState.js';
import { desktopMakerLogger } from '../maker-host/logger-adapter.js';
import { createOverrideSettingsFile } from '../maker-host/override-settings-file.js';
import { isProviderGroupProviderId } from '../../shared/providerGroup.js';

export interface ProviderGroupBinding {
  /** 组所属的供应商(组所在电脑上的供应商 id)。 */
  providerId: string;
  /** 组内电脑的键(ProviderGroupMember.key)。 */
  memberKey: string;
  /** 最近一次分配 / 换电脑的时间(unix ms)，超出容量时淘汰最旧的。 */
  at: number;
}

interface BindingFile {
  sessions: Record<string, ProviderGroupBinding>;
}

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const MEMBER_KEY_PATTERN = /^[A-Za-z0-9_.:-]{1,300}$/;
/** 只需覆盖仍可能继续的任务；超出时淘汰最久没有分配过的绑定。 */
export const MAX_PROVIDER_GROUP_BINDINGS = 4000;

function normalizeBinding(raw: unknown): ProviderGroupBinding | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (!isProviderGroupProviderId(value.providerId)) return null;
  if (typeof value.memberKey !== 'string' || !MEMBER_KEY_PATTERN.test(value.memberKey)) return null;
  const at = typeof value.at === 'number' && Number.isFinite(value.at) && value.at > 0 ? value.at : 0;
  return { providerId: value.providerId, memberKey: value.memberKey, at };
}

function prune(sessions: Record<string, ProviderGroupBinding>): Record<string, ProviderGroupBinding> {
  const entries = Object.entries(sessions);
  if (entries.length <= MAX_PROVIDER_GROUP_BINDINGS) return sessions;
  entries.sort((a, b) => b[1].at - a[1].at);
  return Object.fromEntries(entries.slice(0, MAX_PROVIDER_GROUP_BINDINGS));
}

function normalize(raw: unknown): BindingFile {
  const sessions = (raw as Partial<BindingFile> | null)?.sessions;
  if (!sessions || typeof sessions !== 'object' || Array.isArray(sessions)) return { sessions: {} };
  const out: Record<string, ProviderGroupBinding> = {};
  for (const [sessionId, value] of Object.entries(sessions)) {
    if (!SESSION_ID_PATTERN.test(sessionId)) continue;
    const binding = normalizeBinding(value);
    if (binding) out[sessionId] = binding;
  }
  return { sessions: prune(out) };
}

const log = desktopMakerLogger.child('provider-group-bindings');
const store = createOverrideSettingsFile<BindingFile>({
  filePath: () => ownerScopedUserDataPath('provider-group-bindings.json'),
  scopeKey: activeOwnerScopeKey,
  defaults: { sessions: {} },
  normalize,
  log,
  label: 'provider-group-bindings',
  maxBytes: 2 * 1024 * 1024,
  logLoadedValue: false,
});

export function readProviderGroupBinding(sessionId: string): ProviderGroupBinding | null {
  if (!SESSION_ID_PATTERN.test(sessionId)) return null;
  return store.read().sessions[sessionId] ?? null;
}

export function listProviderGroupBindings(): Record<string, ProviderGroupBinding> {
  return store.read().sessions;
}

export async function writeProviderGroupBinding(
  sessionId: string,
  binding: { providerId: string; memberKey: string } | null,
  now: number = Date.now(),
): Promise<void> {
  if (!SESSION_ID_PATTERN.test(sessionId)) throw new Error('Invalid session id');
  const normalized = binding ? normalizeBinding({ ...binding, at: now }) : null;
  if (binding && !normalized) throw new Error('Invalid provider group binding');
  await store.updateAtomic(({ value }) => {
    const sessions = { ...value.sessions };
    if (normalized) sessions[sessionId] = normalized;
    else if (sessionId in sessions) delete sessions[sessionId];
    else return {};
    return { sessions: prune(sessions) };
  });
}

/**
 * 组内电脑被移出或整个组被删除后，解除指向它们的任务绑定：这些任务成为普通任务，之后即使同一台电脑
 * 重新加入、或重建同一个组，也不会恢复自动换电脑。`keepMemberKeys` 为 null 表示整个组已删除。
 */
export async function pruneProviderGroupBindings(
  providerId: string,
  keepMemberKeys: ReadonlySet<string> | null,
): Promise<void> {
  await store.updateAtomic(({ value }) => {
    const sessions = { ...value.sessions };
    let changed = false;
    for (const [sessionId, binding] of Object.entries(sessions)) {
      if (binding.providerId !== providerId) continue;
      if (keepMemberKeys?.has(binding.memberKey)) continue;
      delete sessions[sessionId];
      changed = true;
    }
    return changed ? { sessions } : {};
  });
}

export const __testing = { normalize, prune };
