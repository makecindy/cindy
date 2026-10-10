/**
 * 任务与组内电脑的绑定(docs/product-rules/provider-groups.md §6)：哪个任务由哪个供应商组分配、
 * 当前固定在哪台组内电脑上。按账号存在本机，跨重启保留，供自动换电脑与并发统计使用。
 *
 * 任务实际运行的位置以任务记录(`sessions.agent_device_id` / `provider_id`)为准；这里只记「它属于
 * 哪个组、对应组里哪一项」，不重复保存位置。
 *
 * 两份文件：本机的组(`provider-group-bindings.json`)与同账号另一台电脑上的组
 * (`provider-group-remote-bindings.json`，多记组所在电脑)。分开存放，降级到旧版本时旧版本只读得到
 * 本机的那份，不会把另一台电脑上的组误当成本机的同名组。
 *
 * 另记一份「因组内电脑被移出或组被删除而解除过」的任务(`provider-group-released.json`)：没归过组、
 * 正用着组那一项的老任务会被纳入组(service.ts)，这些任务不纳入(§9.4)。旧版本不读它，也不改写它。
 */
import { activeOwnerScopeKey, ownerScopedUserDataPath } from '../appSessionState.js';
import { desktopMakerLogger } from '../maker-host/logger-adapter.js';
import { createOverrideSettingsFile } from '../maker-host/override-settings-file.js';
import { isProviderGroupProviderId } from '../../shared/providerGroup.js';

export interface ProviderGroupBinding {
  /** 组所属的供应商(组所在电脑上的供应商 id)。 */
  providerId: string;
  /** 组内电脑的键(ProviderGroupMember.key，组所在电脑视角)。 */
  memberKey: string;
  /** 组在同账号另一台电脑上：那台的设备 id。本机的组没有这个字段。 */
  groupDeviceId?: string;
  /** 最近一次分配 / 换电脑的时间(unix ms)，超出容量时淘汰最旧的。 */
  at: number;
}

interface BindingFile {
  sessions: Record<string, ProviderGroupBinding>;
}

/** 哪个组：组所属的供应商，组在另一台电脑上时再加那台的设备 id(本机的组为 null)。 */
export interface ProviderGroupRef {
  providerId: string;
  groupDeviceId?: string | null;
}

/** 一个任务因组内电脑被移出或组被删除而解除了哪个组的绑定。 */
export interface ProviderGroupRelease {
  providerId: string;
  groupDeviceId?: string;
  at: number;
}

interface ReleaseFile {
  sessions: Record<string, ProviderGroupRelease>;
}

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const MEMBER_KEY_PATTERN = /^[A-Za-z0-9_.:-]{1,300}$/;
const DEVICE_ID_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;
/** 只需覆盖仍可能继续的任务；超出时淘汰最久没有分配过的绑定。 */
export const MAX_PROVIDER_GROUP_BINDINGS = 4000;

function normalizeBinding(raw: unknown, remote: boolean): ProviderGroupBinding | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (!isProviderGroupProviderId(value.providerId)) return null;
  if (typeof value.memberKey !== 'string' || !MEMBER_KEY_PATTERN.test(value.memberKey)) return null;
  const at = typeof value.at === 'number' && Number.isFinite(value.at) && value.at > 0 ? value.at : 0;
  if (!remote) return { providerId: value.providerId, memberKey: value.memberKey, at };
  if (typeof value.groupDeviceId !== 'string' || !DEVICE_ID_PATTERN.test(value.groupDeviceId)) return null;
  return { providerId: value.providerId, memberKey: value.memberKey, groupDeviceId: value.groupDeviceId, at };
}

function normalizeRelease(raw: unknown): ProviderGroupRelease | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (!isProviderGroupProviderId(value.providerId)) return null;
  const at = typeof value.at === 'number' && Number.isFinite(value.at) && value.at > 0 ? value.at : 0;
  if (value.groupDeviceId === undefined) return { providerId: value.providerId, at };
  if (typeof value.groupDeviceId !== 'string' || !DEVICE_ID_PATTERN.test(value.groupDeviceId)) return null;
  return { providerId: value.providerId, groupDeviceId: value.groupDeviceId, at };
}

function prune<T extends { at: number }>(sessions: Record<string, T>): Record<string, T> {
  const entries = Object.entries(sessions);
  if (entries.length <= MAX_PROVIDER_GROUP_BINDINGS) return sessions;
  entries.sort((a, b) => b[1].at - a[1].at);
  return Object.fromEntries(entries.slice(0, MAX_PROVIDER_GROUP_BINDINGS));
}

function normalizeFile(raw: unknown, remote: boolean): BindingFile {
  const sessions = (raw as Partial<BindingFile> | null)?.sessions;
  if (!sessions || typeof sessions !== 'object' || Array.isArray(sessions)) return { sessions: {} };
  const out: Record<string, ProviderGroupBinding> = {};
  for (const [sessionId, value] of Object.entries(sessions)) {
    if (!SESSION_ID_PATTERN.test(sessionId)) continue;
    const binding = normalizeBinding(value, remote);
    if (binding) out[sessionId] = binding;
  }
  return { sessions: prune(out) };
}

const normalize = (raw: unknown) => normalizeFile(raw, false);
const normalizeRemote = (raw: unknown) => normalizeFile(raw, true);

function normalizeReleased(raw: unknown): ReleaseFile {
  const sessions = (raw as Partial<ReleaseFile> | null)?.sessions;
  if (!sessions || typeof sessions !== 'object' || Array.isArray(sessions)) return { sessions: {} };
  const out: Record<string, ProviderGroupRelease> = {};
  for (const [sessionId, value] of Object.entries(sessions)) {
    if (!SESSION_ID_PATTERN.test(sessionId)) continue;
    const release = normalizeRelease(value);
    if (release) out[sessionId] = release;
  }
  return { sessions: prune(out) };
}

function sameGroup(release: ProviderGroupRelease, group: ProviderGroupRef): boolean {
  return release.providerId === group.providerId && (release.groupDeviceId ?? null) === (group.groupDeviceId ?? null);
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
const remoteStore = createOverrideSettingsFile<BindingFile>({
  filePath: () => ownerScopedUserDataPath('provider-group-remote-bindings.json'),
  scopeKey: activeOwnerScopeKey,
  defaults: { sessions: {} },
  normalize: normalizeRemote,
  log,
  label: 'provider-group-remote-bindings',
  maxBytes: 2 * 1024 * 1024,
  logLoadedValue: false,
});
const releasedStore = createOverrideSettingsFile<ReleaseFile>({
  filePath: () => ownerScopedUserDataPath('provider-group-released.json'),
  scopeKey: activeOwnerScopeKey,
  defaults: { sessions: {} },
  normalize: normalizeReleased,
  log,
  label: 'provider-group-released',
  maxBytes: 2 * 1024 * 1024,
  logLoadedValue: false,
});

/** 这个任务的绑定(本机的组或另一台电脑上的组，至多一个)。 */
export function readProviderGroupBinding(sessionId: string): ProviderGroupBinding | null {
  if (!SESSION_ID_PATTERN.test(sessionId)) return null;
  return store.read().sessions[sessionId] ?? remoteStore.read().sessions[sessionId] ?? null;
}

/** 本机的组的绑定(本机分配器据此统计各组内电脑上正在运行的任务)。 */
export function listProviderGroupBindings(): Record<string, ProviderGroupBinding> {
  return store.read().sessions;
}

/** 另一台电脑上的组的绑定(据此向组所在电脑报告正在运行的任务)。 */
export function listRemoteProviderGroupBindings(): Record<string, ProviderGroupBinding> {
  return remoteStore.read().sessions;
}

async function writeIn(
  target: typeof store,
  sessionId: string,
  binding: ProviderGroupBinding | null,
): Promise<void> {
  await target.updateAtomic(({ value }) => {
    const sessions = { ...value.sessions };
    if (binding) sessions[sessionId] = binding;
    else if (sessionId in sessions) delete sessions[sessionId];
    else return {};
    return { sessions: prune(sessions) };
  });
}

/**
 * 写入(或解除)一个任务的绑定。带 `groupDeviceId` 写进另一台电脑的那份，并清掉本机那份里的同一任务，
 * 反之亦然：一个任务只属于一个组。
 */
export async function writeProviderGroupBinding(
  sessionId: string,
  binding: { providerId: string; memberKey: string; groupDeviceId?: string | null } | null,
  now: number = Date.now(),
): Promise<void> {
  if (!SESSION_ID_PATTERN.test(sessionId)) throw new Error('Invalid session id');
  const remote = typeof binding?.groupDeviceId === 'string';
  const normalized = binding ? normalizeBinding({ ...binding, at: now }, remote) : null;
  if (binding && !normalized) throw new Error('Invalid provider group binding');
  await writeIn(remote ? remoteStore : store, sessionId, normalized);
  await writeIn(remote ? store : remoteStore, sessionId, null);
  // 重新由同一个组分配(例如清空后当作新任务)：之前解除过的记录作废。
  const release = normalized ? releasedStore.read().sessions[sessionId] : undefined;
  if (normalized && release && sameGroup(release, normalized)) {
    await releasedStore.updateAtomic(({ value }) => {
      const current = value.sessions[sessionId];
      if (!current || !sameGroup(current, normalized)) return {};
      const sessions = { ...value.sessions };
      delete sessions[sessionId];
      return { sessions };
    });
  }
}

/** 这个任务曾因组内电脑被移出或这个组被删除而解除过这个组的绑定：不再自动纳入这个组(§9.4)。 */
export function isProviderGroupReleased(sessionId: string, group: ProviderGroupRef): boolean {
  if (!SESSION_ID_PATTERN.test(sessionId)) return false;
  const release = releasedStore.read().sessions[sessionId];
  return release !== undefined && sameGroup(release, group);
}

async function writeReleases(sessionIds: readonly string[], group: ProviderGroupRef, now: number): Promise<void> {
  const release = normalizeRelease({ ...group, groupDeviceId: group.groupDeviceId ?? undefined, at: now });
  const ids = sessionIds.filter((id) => SESSION_ID_PATTERN.test(id));
  if (!release || ids.length === 0) return;
  await releasedStore.updateAtomic(({ value }) => {
    const sessions = { ...value.sessions };
    for (const id of ids) sessions[id] = release;
    return { sessions: prune(sessions) };
  });
}

/** 记下这个任务因组内电脑被移出或组被删除而解除了这个组的绑定。 */
export async function markProviderGroupReleased(
  sessionId: string,
  group: ProviderGroupRef,
  now: number = Date.now(),
): Promise<void> {
  await writeReleases([sessionId], group, now);
}

/**
 * 组内电脑被移出或整个组被删除后，解除指向它们的任务绑定：这些任务成为普通任务，之后即使同一台电脑
 * 重新加入、或重建同一个组，也不会恢复自动换电脑。`keepMemberKeys` 为 null 表示整个组已删除。
 * 只作用于本机的组。
 */
export async function pruneProviderGroupBindings(
  providerId: string,
  keepMemberKeys: ReadonlySet<string> | null,
  now: number = Date.now(),
): Promise<void> {
  const released: string[] = [];
  await store.updateAtomic(({ value }) => {
    const sessions = { ...value.sessions };
    released.length = 0;
    for (const [sessionId, binding] of Object.entries(sessions)) {
      if (binding.providerId !== providerId) continue;
      if (keepMemberKeys?.has(binding.memberKey)) continue;
      delete sessions[sessionId];
      released.push(sessionId);
    }
    return released.length > 0 ? { sessions } : {};
  });
  await writeReleases(released, { providerId }, now);
}

export const __testing = { normalize, normalizeRemote, normalizeReleased, prune };
