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
  type ProviderGroupCandidate,
  type ProviderGroupConfig,
  type ProviderGroupMember,
  type ProviderGroupUnavailableReason,
} from '../../shared/providerGroup.js';
import type { DeviceLinkDeviceView } from '../../shared/deviceLinkIpc.js';
import { isSameProvider } from './matching.js';

export interface ProviderGroupDirectoryDeps {
  /** 本机供应商(含未连接 / 停用的，便于给出原因)。 */
  listLocalProviders(): Promise<ProviderView[]>;
  /** 本机设备名。 */
  localDeviceName(): string;
  listDevices(): Promise<readonly DeviceLinkDeviceView[]>;
  /** 那台电脑允许被远程调用的供应商；读不到时抛错(带 `[REMOTE_AGENT_SHARE_*]` 前缀时保留原因)。 */
  readDeviceProviders(agentDeviceId: string): Promise<ProviderView[]>;
  listReceivedShares(): readonly ProviderShareReceived[];
  isMobilePlatform(platform: string | null): boolean;
  /** 本机这个供应商正在运行一轮的任务数(localLoad.ts)；不提供或读不到时为 null。 */
  localRunning?(providerId: string): Promise<number | null>;
  now(): number;
}

export type ResolvedMemberState = 'ok' | 'offline' | 'unavailable';

export interface ResolvedProviderGroupMember {
  member: ProviderGroupMember;
  label: string;
  ownerName?: string;
  state: ResolvedMemberState;
  reason?: ProviderGroupUnavailableReason;
  /** 那台电脑上的这个供应商(state 为 ok 时一定有)。 */
  view?: ProviderView;
  /**
   * 那台电脑上这个供应商实际正在运行一轮的任务数，含不经组直接用的：本机现算；同账号电脑报来那台的总数；
   * 分享来的电脑报来本账号(每台电脑)在那里的数。那台较旧给不出时没有。
   */
  reportedRunning?: number;
}

const CATALOG_TTL_MS = 15_000;
const CATALOG_FAILURE_TTL_MS = 5_000;
const DEVICES_TTL_MS = 10_000;

const SHARE_REASON = /^\[REMOTE_AGENT_SHARE_(PAUSED|REMOVED|UNAVAILABLE)\]/;

export interface ProviderGroupDirectory {
  resolveMembers(providerId: string, config: ProviderGroupConfig): Promise<ResolvedProviderGroupMember[]>;
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
  /** 忘掉缓存(换账号、组内电脑失败后需要现读)。 */
  invalidate(agentDeviceId?: string): void;
}

export function createProviderGroupDirectory(deps: ProviderGroupDirectoryDeps): ProviderGroupDirectory {
  const catalogs = new Map<string, { at: number; ok: boolean; promise: Promise<ProviderView[]> }>();
  let devices: { at: number; promise: Promise<readonly DeviceLinkDeviceView[]> } | null = null;

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
    const view = await localGroupProvider(member.providerId);
    if (!view || !view.connected || view.suspended) return { member, label, state: 'unavailable', reason: 'disconnected' };
    const reportedRunning = await deps.localRunning?.(member.providerId).catch(() => null);
    return { member, label, state: 'ok', view, ...(typeof reportedRunning === 'number' ? { reportedRunning } : {}) };
  }

  async function resolveDevice(
    member: ProviderGroupMember,
    deviceList: readonly DeviceLinkDeviceView[] | null,
  ): Promise<ResolvedProviderGroupMember> {
    const deviceId = member.agentDeviceId!;
    const device = deviceList?.find((d) => d.deviceId === deviceId);
    const label = device?.name || member.label || deviceId;
    if (!device || !isControllable(device)) return { member, label, state: 'offline' };
    let views: ProviderView[];
    try {
      views = await readCatalog(deviceId);
    } catch {
      return { member, label, state: 'offline' };
    }
    const resolved = withView(member, label, undefined, views);
    const reportedRunning = resolved.view ? readProviderRunningTurns(resolved.view) : null;
    return reportedRunning === null ? resolved : { ...resolved, reportedRunning };
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
    if (!share.hostOnline && !options?.readThroughOffline) return { member, label, ownerName, state: 'offline' };
    let views: ProviderView[];
    try {
      views = await readCatalog(agentDeviceId);
    } catch (error) {
      const reason = SHARE_REASON.exec(error instanceof Error ? error.message : '')?.[1];
      if (reason === 'PAUSED') return { member, label, ownerName, state: 'unavailable', reason: 'share-paused' };
      if (reason === 'REMOVED') return { member, label, ownerName, state: 'unavailable', reason: 'share-removed' };
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

  return {
    async resolveMembers(_providerId, config) {
      const needsDevices = config.members.some((m) => m.kind === 'device');
      const deviceList = needsDevices ? await readDevices().catch(() => null) : null;
      return Promise.all(config.members.map((member) => {
        if (member.kind === 'local') return resolveLocal(member);
        if (member.kind === 'share') return resolveShare(member);
        return resolveDevice(member, deviceList);
      }));
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
