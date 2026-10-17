/**
 * 组内电脑的实时情况：哪些电脑能加进组、组里每台现在能不能用。
 *
 * 数据都来自现有通道：同账号电脑读 device-link 设备列表 + 那台的 `maker:provider:list`
 * (只留开了「允许被远程调用」的供应商；新版在目录里带上那台用这个供应商正在运行的任务数 `runningTurns`)，
 * 分享来的读收到的分享 + `share:<id>` 的目录(新版分享者带上本账号在那台正在运行的任务数 `guestRunning`)。
 * 目录短时缓存，避免设置页刷新与连续分配时反复读远端。
 */
import type { ProviderView } from '@cindy/model-providers';
import { readProviderRunningTurns, readProviderShareGuestRunning, type ProviderShareReceived } from '@cindy/device-link';

import {
  PROVIDER_SHARE_AGENT_DEVICE_PREFIX,
  isProviderShareAgentDeviceId,
} from '../../shared/providerShare.js';
import {
  providerGroupMemberKey,
  readProviderGroupAppVersion,
  type ProviderGroupCandidate,
  type ProviderGroupConfig,
  type ProviderGroupMember,
  type ProviderGroupUnavailableReason,
} from '../../shared/providerGroup.js';
import type { DeviceLinkDeviceView } from '../../shared/deviceLinkIpc.js';
import type { ClaudeSubscriptionUsageSnapshot } from '../../shared/claudeSubscriptionUsage.js';
import { providerWeeklyQuotaSource } from '../../shared/providerQuotaSource.js';
import { isSameProvider } from './matching.js';

export interface ProviderGroupDirectoryDeps {
  /** 本机供应商(含未连接 / 停用的，便于给出原因)。 */
  listLocalProviders(): Promise<ProviderView[]>;
  /** 本机设备名。 */
  localDeviceName(): string;
  localAppVersion?(): string;
  listDevices(): Promise<readonly DeviceLinkDeviceView[]>;
  /** 那台电脑允许被远程调用的供应商；读不到时抛错(带 `[REMOTE_AGENT_SHARE_*]` 前缀时保留原因)。 */
  readDeviceProviders(agentDeviceId: string): Promise<ProviderView[]>;
  listReceivedShares(): readonly ProviderShareReceived[];
  isMobilePlatform(platform: string | null): boolean;
  /** 本机这个供应商正在运行一轮的任务数(localLoad.ts)；不提供或读不到时为 null。 */
  localRunning?(providerId: string): Promise<number | null>;
  /** Same-account subscription snapshots only; absence/failure keeps the member usable. */
  readClaudeUsage?(member: ProviderGroupMember): Promise<ClaudeSubscriptionUsageSnapshot | null>;
  invalidateUsage?(): void;
  now(): number;
}

export type ResolvedMemberState = 'ok' | 'offline' | 'unavailable';

export interface ResolvedProviderGroupMember {
  member: ProviderGroupMember;
  label: string;
  ownerName?: string;
  appVersion?: string;
  state: ResolvedMemberState;
  reason?: ProviderGroupUnavailableReason;
  /** 那台电脑上的这个供应商(state 为 ok 时一定有)。 */
  view?: ProviderView;
  /**
   * 那台电脑上这个供应商实际正在运行一轮的任务数，含不经组直接用的：本机现算；同账号电脑报来那台的总数；
   * 分享来的电脑报来本账号(每台电脑)在那里的数。那台较旧给不出时没有。
   */
  reportedRunning?: number;
  /** Internal only: never included in the group wire projection or shared with guests. */
  claudeUsage?: ClaudeSubscriptionUsageSnapshot | null;
  /**
   * 选电脑时到点还没读完(那台慢或不响应)：这次按不能用算，不代表读到了离线；读取照常在后台完成、留在缓存里。
   */
  pending?: boolean;
}

export interface ResolveMembersOptions {
  /**
   * 最多等多久：到点已经有一台 `enough` 的电脑就不再等其余的(没读完的标 `pending`)；一台都还没有时照旧等全部读完。
   * 不给 = 等全部读完。
   */
  quickMs?: number;
  enough?(resolved: ResolvedProviderGroupMember): boolean;
  /** 不用短时缓存，现读设备列表与每台的目录(试过不行之后拉最新状态)。 */
  fresh?: boolean;
}

const CATALOG_TTL_MS = 15_000;
const CATALOG_FAILURE_TTL_MS = 5_000;
const DEVICES_TTL_MS = 10_000;
const LOCAL_LOAD_TIMEOUT_MS = 1_000;

const SHARE_REASON = /^\[REMOTE_AGENT_SHARE_(PAUSED|REMOVED|UNAVAILABLE)\]/;

export interface ProviderGroupDirectory {
  resolveMembers(
    providerId: string,
    config: ProviderGroupConfig,
    options?: ResolveMembersOptions,
  ): Promise<ResolvedProviderGroupMember[]>;
  listCandidates(providerId: string, config: ProviderGroupConfig | null): Promise<ProviderGroupCandidate[]>;
  /** 那台电脑允许被远程调用的供应商(与组内电脑状态共用同一份短时缓存)；读不到时抛错。 */
  readDeviceCatalog(agentDeviceId: string): Promise<ProviderView[]>;
  /**
   * 本机现在连不连得上那台电脑上的这个供应商：不用缓存，现读设备列表与那台的目录(同账号电脑、分享来的电脑；
   * `agentDeviceId` 用任务记录里的写法)。自动换电脑前等那台恢复时用。
   */
  probe(agentDeviceId: string, providerId: string): Promise<ResolvedMemberState>;
  /**
   * 组员给人看的名字(换电脑的活动记录用)：分享来的电脑只用分享者的昵称，不用电脑名
   * (provider-sharing.md §6)，读不到这条分享时为空；其余沿用加入时的快照。
   */
  memberLabel(member: ProviderGroupMember): string;
  /**
   * 同账号那台电脑已经离线多久(按设备列表里的最后在线时间)：在线、读不到或不是同账号电脑时为 null。
   * 用来判断「已经确认用不了」还是「刚断开」(§6.1)；不提供 = 不知道。
   */
  offlineForMs?(agentDeviceId: string): Promise<number | null>;
  /** 忘掉缓存(换账号、组内电脑失败后需要现读)。 */
  invalidate(agentDeviceId?: string): void;
}

export function createProviderGroupDirectory(deps: ProviderGroupDirectoryDeps): ProviderGroupDirectory {
  const catalogs = new Map<string, { at: number; ok: boolean; promise: Promise<ProviderView[]> }>();
  let devices: { at: number; promise: Promise<readonly DeviceLinkDeviceView[]> } | null = null;
  /**
   * 分享来的电脑从什么时候起被看到离线(分享列表的 hostOnline 快照)：分享没有最后在线时刻，按本机第一次看到离线
   * 算，只会少算不会多算。用于「离线已久就不再等它恢复」(与同账号电脑同一条规则)。
   */
  const shareOfflineSince = new Map<string, number>();

  function noteShareOnline(shareId: string, online: boolean): void {
    if (online) shareOfflineSince.delete(shareId);
    else if (!shareOfflineSince.has(shareId)) shareOfflineSince.set(shareId, deps.now());
  }

  function readCatalog(agentDeviceId: string): Promise<ProviderView[]> {
    const now = deps.now();
    const cached = catalogs.get(agentDeviceId);
    if (cached && now - cached.at < (cached.ok ? CATALOG_TTL_MS : CATALOG_FAILURE_TTL_MS)) return cached.promise;
    const entry = { at: now, ok: true, promise: deps.readDeviceProviders(agentDeviceId) };
    entry.promise.catch(() => {
      entry.ok = false;
    });
    catalogs.set(agentDeviceId, entry);
    return entry.promise;
  }

  function readDevices(): Promise<readonly DeviceLinkDeviceView[]> {
    const now = deps.now();
    if (devices && now - devices.at < DEVICES_TTL_MS) return devices.promise;
    const entry = { at: now, promise: deps.listDevices() };
    entry.promise.catch(() => {
      if (devices === entry) devices = null;
    });
    devices = entry;
    return entry.promise;
  }

  function isControllable(device: DeviceLinkDeviceView): boolean {
    return device.online && device.remoteControlEnabled && device.controlEnabled && !device.isSelf
      && !deps.isMobilePlatform(device.platform);
  }

  async function localGroupProvider(providerId: string): Promise<ProviderView | null> {
    const views = await deps.listLocalProviders();
    return views.find((view) => view.id === providerId) ?? null;
  }

  async function resolveLocal(member: ProviderGroupMember): Promise<ResolvedProviderGroupMember> {
    const label = deps.localDeviceName();
    const appVersion = readProviderGroupAppVersion(deps.localAppVersion?.());
    const base = { member, label, ...(appVersion ? { appVersion } : {}) };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const running = Promise.race([
        deps.localRunning?.(member.providerId).catch(() => null),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), LOCAL_LOAD_TIMEOUT_MS);
        }),
      ]);
      const view = await localGroupProvider(member.providerId);
      if (!view || !view.connected || view.suspended) return { ...base, state: 'unavailable', reason: 'disconnected' };
      const reportedRunning = await running;
      return { ...base, state: 'ok', view, ...(typeof reportedRunning === 'number' ? { reportedRunning } : {}) };
    } finally {
      clearTimeout(timer);
    }
  }

  async function resolveDevice(
    member: ProviderGroupMember,
    deviceList: readonly DeviceLinkDeviceView[] | null,
  ): Promise<ResolvedProviderGroupMember> {
    const deviceId = member.agentDeviceId!;
    const device = deviceList?.find((d) => d.deviceId === deviceId);
    const label = device?.name || member.label || deviceId;
    const appVersion = readProviderGroupAppVersion(device?.appVersion);
    const version = appVersion ? { appVersion } : {};
    if (!device || !isControllable(device)) return { member, label, ...version, state: 'offline' };
    let views: ProviderView[];
    try {
      views = await readCatalog(deviceId);
    } catch {
      return { member, label, ...version, state: 'offline' };
    }
    const resolved = withView(member, label, undefined, views);
    const reportedRunning = resolved.view ? readProviderRunningTurns(resolved.view) : null;
    return { ...resolved, ...version, ...(reportedRunning === null ? {} : { reportedRunning }) };
  }

  async function resolveShare(
    member: ProviderGroupMember,
    /** 不信分享列表里定时刷新的 hostOnline 快照，照样去读那台的目录(等它恢复时用)。 */
    options?: { readThroughOffline?: boolean },
  ): Promise<ResolvedProviderGroupMember> {
    const agentDeviceId = member.agentDeviceId!;
    const shareId = agentDeviceId.slice(PROVIDER_SHARE_AGENT_DEVICE_PREFIX.length);
    const share = deps.listReceivedShares().find((s) => s.shareId === shareId);
    // 分享来的电脑只用分享者的昵称称呼，不用电脑名(provider-sharing.md §6)：服务端仍存着旧链接的电脑名，
    // 旧版本加入时的快照(member.label)也可能是电脑名，都不再用。
    if (!share) return { member, label: '', state: 'unavailable', reason: 'share-removed' };
    const ownerName = share.owner.displayName;
    const label = ownerName;
    if (share.status === 'paused') return { member, label, ownerName, state: 'unavailable', reason: 'share-paused' };
    noteShareOnline(shareId, share.hostOnline);
    if (!share.hostOnline && !options?.readThroughOffline) return { member, label, ownerName, state: 'offline' };
    let views: ProviderView[];
    try {
      views = await readCatalog(agentDeviceId);
    } catch (error) {
      const reason = SHARE_REASON.exec(error instanceof Error ? error.message : '')?.[1];
      if (reason === 'PAUSED') return { member, label, ownerName, state: 'unavailable', reason: 'share-paused' };
      if (reason === 'REMOVED') return { member, label, ownerName, state: 'unavailable', reason: 'share-removed' };
      // 分享者电脑拒绝了(对方关了远程控制或这个供应商的「允许被远程调用」)：那台在线，只是现在不接，
      // 不是连不上，不用等它恢复(与同账号电脑关了远程调用同一口径)。
      if (reason === 'UNAVAILABLE') return { member, label, ownerName, state: 'unavailable', reason: 'provider-off' };
      return { member, label, ownerName, state: 'offline' };
    }
    const resolved = withView(member, label, ownerName, views);
    const reportedRunning = resolved.view ? readProviderShareGuestRunning(resolved.view) : null;
    return reportedRunning === null ? resolved : { ...resolved, reportedRunning };
  }

  function withView(
    member: ProviderGroupMember,
    label: string,
    ownerName: string | undefined,
    views: readonly ProviderView[],
  ): ResolvedProviderGroupMember {
    const base = { member, label, ...(ownerName ? { ownerName } : {}) };
    const view = views.find((v) => v.id === member.providerId);
    if (!view) return { ...base, state: 'unavailable', reason: 'provider-off' };
    if (!view.connected || view.suspended) return { ...base, state: 'unavailable', reason: 'disconnected' };
    return { ...base, state: 'ok', view };
  }

  /** 到点还没读完的那台：这次按不能用算(不是读到了离线)。 */
  function pendingMember(member: ProviderGroupMember): ResolvedProviderGroupMember {
    // 分享来的电脑只用分享者的昵称称呼(provider-sharing.md §6)，这里读不到，留空。
    const label = member.kind === 'share' ? '' : member.label || member.key;
    return { member, label, state: 'offline', pending: true };
  }

  /**
   * 到点已经有一台够用的电脑就不再等其余的；一台都还没有时等全部读完，不会因为慢就误报都不能用。
   */
  async function settleQuickly(
    members: readonly ProviderGroupMember[],
    reads: readonly Promise<ResolvedProviderGroupMember>[],
    partialReads: readonly Promise<ResolvedProviderGroupMember>[],
    options: ResolveMembersOptions,
  ): Promise<ResolvedProviderGroupMember[]> {
    const settled: Array<ResolvedProviderGroupMember | undefined> = new Array(reads.length);
    const partial: Array<ResolvedProviderGroupMember | undefined> = new Array(partialReads.length);
    reads.forEach((read, index) => {
      void read.then((value) => {
        settled[index] = value;
      }, () => undefined);
    });
    partialReads.forEach((read, index) => {
      void read.then((value) => {
        partial[index] = value;
      }, () => undefined);
    });
    const all = Promise.all(reads);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), options.quickMs);
    });
    try {
      const done = await Promise.race([all, deadline]);
      if (done) return done;
    } finally {
      clearTimeout(timer);
    }
    const enough = options.enough;
    const resolved = members.map((member, index) => settled[index] ?? partial[index] ?? pendingMember(member));
    if (!enough || !resolved.some(enough)) return all;
    return resolved;
  }

  return {
    async resolveMembers(_providerId, config, options) {
      if (options?.fresh) {
        devices = null;
        deps.invalidateUsage?.();
        for (const member of config.members) if (member.agentDeviceId) catalogs.delete(member.agentDeviceId);
      }
      const needsDevices = config.members.some((m) => m.kind === 'device');
      // 设备列表读取不在这里 await：要跟各成员读取一样被下面的 settleQuickly 三秒快速选择
      // 窗口管到(settleQuickly 的计时器在 reads 数组建好、传进去之后才启动)，否则设备列表慢或
      // 无响应时选电脑会等它的完整网络超时，而不是三秒后继续(chatgpt-codex-connector P2,
      // PR #5792 review)。
      const deviceListPromise = needsDevices ? readDevices().catch(() => null) : Promise.resolve(null);
      // 额度补充读取可能慢于快速选路窗口：保留基础目录结果，避免已知可用的成员被误判成待定或离线。
      const partialReads = config.members.map((member) => {
        if (member.kind === 'local') return resolveLocal(member);
        if (member.kind === 'share') return resolveShare(member);
        return deviceListPromise.then((deviceList) => resolveDevice(member, deviceList));
      });
      const reads = partialReads.map(async (read, index) => {
        const member = config.members[index]!;
        const resolved = await read;
        if (member.kind === 'share' || resolved.state !== 'ok' || !resolved.view?.auth
          || providerWeeklyQuotaSource(resolved.view) !== 'claude' || !deps.readClaudeUsage) return resolved;
        const claudeUsage = await deps.readClaudeUsage(member).catch(() => null);
        return { ...resolved, claudeUsage };
      });
      if (options?.quickMs === undefined) return Promise.all(reads);
      return settleQuickly(config.members, reads, partialReads, options);
    },

    async offlineForMs(agentDeviceId) {
      if (isProviderShareAgentDeviceId(agentDeviceId)) {
        const shareId = agentDeviceId.slice(PROVIDER_SHARE_AGENT_DEVICE_PREFIX.length);
        const share = deps.listReceivedShares().find((s) => s.shareId === shareId);
        if (!share) return null;
        noteShareOnline(shareId, share.hostOnline);
        const since = shareOfflineSince.get(shareId);
        return since === undefined ? null : Math.max(0, deps.now() - since);
      }
      const deviceList = await readDevices().catch(() => null);
      const device = deviceList?.find((d) => d.deviceId === agentDeviceId);
      if (!device || device.online || !device.lastSeenAt) return null;
      const lastSeen = Date.parse(device.lastSeenAt);
      return Number.isFinite(lastSeen) ? Math.max(0, deps.now() - lastSeen) : null;
    },

    async listCandidates(providerId, config) {
      const local = await localGroupProvider(providerId);
      if (!local) return [];
      const memberKeys = new Set(config?.members.map((m) => m.key) ?? []);
      const candidates: ProviderGroupCandidate[] = [];
      const deviceList = await readDevices().catch(() => [] as readonly DeviceLinkDeviceView[]);
      const deviceReads = deviceList.filter(isControllable).map(async (device) => {
        const views = await readCatalog(device.deviceId).catch(() => [] as ProviderView[]);
        for (const view of views) {
          if (!view.connected || view.suspended || !isSameProvider(local, view)) continue;
          const key = providerGroupMemberKey(device.deviceId, view.id);
          candidates.push({
            key,
            kind: 'device',
            agentDeviceId: device.deviceId,
            providerId: view.id,
            label: device.name || device.deviceId,
            providerName: view.name,
            ...(memberKeys.has(key) ? { blocked: 'member' as const } : {}),
          });
        }
      });
      const shareReads = deps.listReceivedShares().map(async (share) => {
        const agentDeviceId = `${PROVIDER_SHARE_AGENT_DEVICE_PREFIX}${share.shareId}`;
        const key = providerGroupMemberKey(agentDeviceId, share.providerId);
        const base = {
          key,
          kind: 'share' as const,
          agentDeviceId,
          providerId: share.providerId,
          // 加入组时存下的快照也只用分享者的昵称，不用电脑名(provider-sharing.md §6)。
          label: share.owner.displayName,
          providerName: share.providerLabel,
          ownerName: share.owner.displayName,
          // 同一个人从同一台电脑分享的几个账号按一台电脑展示(不显示，也不用于连接)。
          hostDeviceId: share.hostDeviceId,
        };
        if (memberKeys.has(key)) {
          candidates.push({ ...base, blocked: 'member' });
          return;
        }
        if (share.status !== 'active' || !share.hostOnline) return;
        const views = await readCatalog(agentDeviceId).catch(() => [] as ProviderView[]);
        const view = views.find((v) => v.id === share.providerId);
        if (!view || !view.connected || view.suspended || !isSameProvider(local, view)) return;
        candidates.push({ ...base, providerName: view.name });
      });
      await Promise.all([...deviceReads, ...shareReads]);
      // 同账号电脑在前，分享来的在后；各自按名称排序，结果稳定。
      return candidates.sort((a, b) =>
        a.kind === b.kind ? a.label.localeCompare(b.label) : a.kind === 'device' ? -1 : 1);
    },

    readDeviceCatalog: readCatalog,

    async probe(agentDeviceId, providerId) {
      catalogs.delete(agentDeviceId);
      const share = isProviderShareAgentDeviceId(agentDeviceId);
      const member: ProviderGroupMember = {
        key: providerGroupMemberKey(agentDeviceId, providerId),
        kind: share ? 'share' : 'device',
        agentDeviceId,
        providerId,
        limit: 1,
        weight: 1,
        paused: false,
      };
      // 分享来的电脑：hostOnline 是定时刷新的快照，等它恢复时不只看它，直接读那台的目录。
      if (share) return (await resolveShare(member, { readThroughOffline: true })).state;
      devices = null;
      const deviceList = await readDevices().catch(() => null);
      const device = deviceList?.find((d) => d.deviceId === agentDeviceId);
      // 在线却关了远程控制或远程调用：是有意的设置，不是断线，不用等它恢复。
      if (device?.online && !isControllable(device)) return 'unavailable';
      return (await resolveDevice(member, deviceList)).state;
    },

    memberLabel(member) {
      if (member.kind !== 'share') return member.label ?? member.key;
      const shareId = member.agentDeviceId?.slice(PROVIDER_SHARE_AGENT_DEVICE_PREFIX.length) ?? '';
      return deps.listReceivedShares().find((s) => s.shareId === shareId)?.owner.displayName ?? '';
    },

    invalidate(agentDeviceId) {
      deps.invalidateUsage?.();
      if (agentDeviceId === undefined) {
        catalogs.clear();
        devices = null;
        return;
      }
      catalogs.delete(agentDeviceId);
      if (!isProviderShareAgentDeviceId(agentDeviceId)) devices = null;
    },
  };
}
