/**
 * providerTopologyModel —— Agent-Net「远程供应商」拓扑的纯状态推导与三栏布局几何。
 * ---------------------------------------------------------------------------
 * 纯函数、零 DOM / 零 IPC / 零网络副作用，可直接单测。
 * 输入全部来自本机已有内存与缓存（会话列表、同账号设备、Agent-Net 链路快照、本机供应商组、
 * 已收到的跨账号分享），绝不发起额外网络探测或目录查询。
 *
 * 隐私边界（provider-sharing-hidden-computer-names.md）：
 * 跨账号分享机器一律只使用分享者显示名与匿名组台数，永不读取或展示分享者电脑名。
 */

import { isMobilePlatform } from '@cindy/maker-shared/device-list';
import type { ProviderShareReceived } from '@cindy/device-link';

import type { Session } from '@/lib/ccAgent.types';
import { getSessionDisplayTitle } from '@/features/cc-agent/lib/sessionDisplayTitle';
import { PROVIDER_SHARE_AGENT_DEVICE_PREFIX } from '../../../shared/providerShare';
import type { ProviderGroupConfig } from '../../../shared/providerGroup';
import type {
  DeviceLinkAgentNetPeerRouteView,
  DeviceLinkPeerPathPreference,
  DeviceLinkProviderShareRouteView,
} from '../../../shared/deviceLinkIpc';

import { shapeD, type LineShape } from './topologyGeometry';
import { flowOf, mergeFlows, type LinkTransport, type TopologyFlow } from './topologyModel';

/** 数据实际走哪种连接：Agent-Net 或 Device Link；还没建链或不知道时为 null。 */
export type ProviderLinkProtocol = 'agent-net' | 'device-link';

/**
 * 与设备连接拓扑同一套底层传输写法（product-rules/agent-net.md 拓扑节）：
 * Agent-Net 直连是 UDP、经中转随中转实际走法（UDP / WS）；Device Link 直连是 WebRTC、经中转是 WS。
 */
function providerLinkTransport(
  protocol: ProviderLinkProtocol | null,
  path: 'direct' | 'relay' | null,
  relayTransport: 'udp' | 'websocket' | null,
): LinkTransport | null {
  if (!path) return null;
  if (protocol === 'device-link') return path === 'direct' ? 'webrtc' : 'websocket';
  return path === 'direct' ? 'udp' : relayTransport;
}

/** 同账号电脑：开着的控制链路说了算（加密的新版连接是 Agent-Net），没有时 Agent-Net 已有路径即 Agent-Net；与设备连接页一致。 */
function ownLinkProtocol(
  path: 'direct' | 'relay' | null,
  encrypted: boolean | undefined,
): ProviderLinkProtocol | null {
  if (!path || encrypted === undefined) return null;
  return encrypted ? 'agent-net' : 'device-link';
}

export type ProviderTopologyScope = 'all' | 'running';
export type ProviderMachineKind = 'own' | 'share';
export type ProviderRelayKind = 'official' | 'self-hosted' | 'sharer-relay';
export type ProviderMachineStatus = 'direct' | 'relay' | 'connecting' | 'unlinked' | 'error' | 'offline';

/** 本机任务借用某台远程供应商机器的模型（点击后直接跳转对应会话）。 */
export interface ProviderTopologyTask {
  id: string;
  title: string;
  model: string;
  providerId: string | null;
  running: boolean;
  updatedAt: string;
  /** 仅用于导航路由解析（resolveSessionRoute），保留原始会话引用。 */
  session: Session;
}

/** 中转站节点：区分我的自建中转、官方中转（含跨区）与分享方自建中转。 */
export interface ProviderTopologyRelay {
  id: string;
  kind: ProviderRelayKind;
  name: string;
  host: string | null;
  region: string | null;
  transport: 'udp' | 'websocket' | null;
  hopRttMs: number | null;
  status: 'ok' | 'error';
}

/** 右栏活跃远程供应商机器（同账号电脑或跨账号分享入口）。 */
export interface ProviderTopologyMachine {
  id: string;
  kind: ProviderMachineKind;
  /** 同账号设备为 deviceId；跨账号分享为 shareId。 */
  targetId: string;
  /** 同账号设备为 deviceId；跨账号分享为 `share:<shareId>`。 */
  agentDeviceId: string;
  groupId: string | null;
  name: string;
  /** 仅用于头像首字回退（跨账号分享取分享者昵称而非「来自 xxx 的分享」）。 */
  avatarLabel: string;
  platform: string | null;
  isMobile: boolean;
  modelLabel: string | null;
  avatarUrl: string | null;
  shareProviderId: string | null;
  /** 跨账号分享组的台数（不暴露分享者电脑名）；非组为 null。 */
  shareGroupSize: number | null;
  /** 本机任务在这台机器上实际用到的模型/供应商集合（去重）。 */
  usedModels: string[];
  status: ProviderMachineStatus;
  routeMode: 'direct' | 'relay' | 'unlinked';
  relayId: string | null;
  protocol: ProviderLinkProtocol | null;
  transport: LinkTransport | null;
  rttMs: number | null;
  directRttMs: number | null;
  relayRttMs: number | null;
  pathPreference: DeviceLinkPeerPathPreference | null;
  flow: TopologyFlow | null;
  busy: boolean;
  online: boolean;
  errorReason: 'unresponsive' | 'paused' | 'offline' | 'needs-update' | null;
  /** 全量绑定到此机器的活跃任务（未受筛选过滤）。 */
  allTasks: ProviderTopologyTask[];
  /** 当前范围与搜索词过滤后的可见任务。 */
  visibleTasks: ProviderTopologyTask[];
}

/** 供应商组内当前未承载本机任务的其余成员摘要（支持同账号组原地展开）。 */
export interface ProviderGroupIdleMember {
  key: string;
  kind: 'own' | 'share';
  name: string;
  avatarLabel: string;
  avatarUrl: string | null;
  platform: string | null;
  online: boolean;
  paused: boolean;
  routeMode: 'direct' | 'relay' | null;
  rttMs: number | null;
}

/** 右栏视觉块：本机建的供应商组（框住多个活跃成员 + 其余成员折叠池）或单台机器。 */
export interface ProviderTopologyGroupBlock {
  kind: 'group';
  id: string;
  providerId: string;
  totalCount: number;
  machines: ProviderTopologyMachine[];
  idleMembers: ProviderGroupIdleMember[];
}

export interface ProviderTopologyStandaloneBlock {
  kind: 'standalone';
  id: string;
  machines: [ProviderTopologyMachine];
}

export type ProviderTopologyBlock = ProviderTopologyGroupBlock | ProviderTopologyStandaloneBlock;

/** 当前无任何任务调用、但在线待命的独立远程供应商机器。 */
export interface IdleStandbyProvider {
  id: string;
  kind: ProviderMachineKind;
  targetId: string;
  name: string;
  avatarLabel: string;
  platform: string | null;
  modelLabel: string | null;
  avatarUrl: string | null;
  shareProviderId: string | null;
  routeMode: 'direct' | 'relay' | null;
  relayName: string | null;
  protocol: ProviderLinkProtocol | null;
  transport: LinkTransport | null;
  rttMs: number | null;
  directRttMs: number | null;
  relayRttMs: number | null;
  pathPreference: DeviceLinkPeerPathPreference | null;
  busy: boolean;
}

export interface ProviderTopologyStats {
  totalTasks: number;
  runningTasks: number;
  activeMachines: number;
  totalMachines: number;
  directCount: number;
  relayCount: number;
  errorCount: number;
}

export interface ProviderTopologyModel {
  blocks: ProviderTopologyBlock[];
  machines: ProviderTopologyMachine[];
  relays: ProviderTopologyRelay[];
  relayById: Map<string, ProviderTopologyRelay>;
  idleProviders: IdleStandbyProvider[];
  stats: ProviderTopologyStats;
  /** 所有活跃远程任务（不受 scope/query 过滤，供顶栏计数）。 */
  unfilteredTaskCount: number;
  unfilteredRunningCount: number;
}

export interface BuildProviderTopologyInput {
  sessions: readonly Session[];
  /** 来自 makerChatStore 的运行中会话 ID 集合（纯本机内存，零 IPC）。 */
  runningSessionIds: ReadonlySet<string>;
  devices: readonly DeviceLinkDeviceView[];
  peerLinks: DeviceLinkPeerLinksSnapshot;
  localGroups: Readonly<Record<string, ProviderGroupConfig>>;
  receivedShares: readonly ProviderShareReceived[];
  /** 由 providerShareDisplayNames 产出的合规显示名（不含分享者电脑名）。 */
  shareDisplayNames: ReadonlyMap<string, string>;
  /** 本机主连接中转名（自建名或官方中转本地化文案）。 */
  primaryRelayName: string;
  primarySelfHosted: boolean;
  officialRelayLabel: string;
  unresponsiveIds: ReadonlySet<string>;
  scope: ProviderTopologyScope;
  query: string;
  /** 无标题任务的占位文案（传给 getSessionDisplayTitle）。 */
  unnamedSessionLabel?: string;
}

/** 一台机器关联达到此任务数时，左侧自动收束为「任务束」卡片，避免几十个会话撑爆拓扑高度。 */
export const TASK_BUNDLE_THRESHOLD = 3;

function parseShareAgentDeviceId(value: string | null | undefined): string | null {
  if (!value || !value.startsWith(PROVIDER_SHARE_AGENT_DEVICE_PREFIX)) return null;
  const id = value.slice(PROVIDER_SHARE_AGENT_DEVICE_PREFIX.length);
  return id.length > 0 ? id : null;
}

function formatModelShort(model: string): string {
  const trimmed = model.trim();
  if (!trimmed) return '—';
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        const items = parsed
          .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
          .map((x) => {
            const s = x.trim();
            const idx = s.lastIndexOf('/');
            return idx >= 0 && idx < s.length - 1 ? s.slice(idx + 1) : s;
          });
        if (items.length > 0) return items.slice(0, 2).join(' · ');
      }
    } catch {
      // Fallback to raw string below
    }
  }
  const slash = trimmed.lastIndexOf('/');
  return slash >= 0 && slash < trimmed.length - 1 ? trimmed.slice(slash + 1) : trimmed;
}

function compareTasks(a: ProviderTopologyTask, b: ProviderTopologyTask): number {
  if (a.running !== b.running) return a.running ? -1 : 1;
  return b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id);
}

function peerRouteOrder(
  machine: Pick<ProviderTopologyMachine, 'routeMode' | 'relayId' | 'name'>,
  relayOrder: ReadonlyMap<string, number>,
): number {
  if (machine.routeMode === 'direct') return -1;
  if (machine.routeMode === 'relay' && machine.relayId) {
    return relayOrder.get(machine.relayId) ?? 90;
  }
  return 99;
}

export function buildProviderTopology(input: BuildProviderTopologyInput): ProviderTopologyModel {
  const selfDevice = input.devices.find((d) => d.isSelf) ?? null;
  const selfId = selfDevice?.deviceId ?? null;
  const deviceById = new Map<string, DeviceLinkDeviceView>();
  for (const d of input.devices) {
    if (!d.isSelf) deviceById.set(d.deviceId, d);
  }
  const shareById = new Map<string, ProviderShareReceived>(
    input.receivedShares.map((s) => [s.shareId, s] as const),
  );
  const linkByDeviceId = new Map(input.peerLinks.links.map((l) => [l.deviceId, l] as const));
  const agentNetByDeviceId = new Map<string, DeviceLinkAgentNetPeerRouteView>(
    (input.peerLinks.agentNetRoutes ?? []).map((r) => [r.deviceId, r] as const),
  );
  const shareRouteById = new Map<string, DeviceLinkProviderShareRouteView>(
    (input.peerLinks.providerShareRoutes ?? []).map((r) => [r.shareId, r] as const),
  );

  // 1) 按目标远程机器（own deviceId 或 share:<shareId>）归集本机任务里借用别的电脑模型的活跃任务。
  //    住在别的电脑上的任务（经远程控制浏览到的，带 deviceLinkDeviceId）跑的是那台电脑自己的模型，
  const tasksByAgentDevice = new Map<string, ProviderTopologyTask[]>();
  const seenSessionIds = new Set<string>();

  for (const session of input.sessions) {
    if (session.status !== 'active' || session.hiddenAt) continue;
    if (seenSessionIds.has(session.id)) continue;
    if (session.deviceLinkDeviceId) continue;
    const agentDeviceId = session.agentDeviceId && session.agentDeviceId !== selfId ? session.agentDeviceId : null;
    if (!agentDeviceId) continue;
    seenSessionIds.add(session.id);

    const task: ProviderTopologyTask = {
      id: session.id,
      title: getSessionDisplayTitle(session, input.unnamedSessionLabel ?? session.title ?? session.id) || session.id,
      model: formatModelShort(session.model || ''),
      providerId: session.providerId ?? null,
      running: input.runningSessionIds.has(session.id),
      updatedAt: session.userSendAt || session.lastActivityAt || session.updatedAt || '',
      session,
    };

    const list = tasksByAgentDevice.get(agentDeviceId) ?? [];
    list.push(task);
    tasksByAgentDevice.set(agentDeviceId, list);
  }

  for (const list of tasksByAgentDevice.values()) {
    list.sort(compareTasks);
  }

  // 2) 建立中转站登记表（按需创建，确保同中转的机器汇聚到同一中转节点）
  const relaysMap = new Map<string, ProviderTopologyRelay>();
  const ensurePrimaryRelay = (): ProviderTopologyRelay => {
    const id = input.primarySelfHosted ? 'relay:primary:self-hosted' : 'relay:primary:official';
    let r = relaysMap.get(id);
    if (!r) {
      r = {
        id,
        kind: input.primarySelfHosted ? 'self-hosted' : 'official',
        name: input.primaryRelayName,
        host: null,
        region: null,
        transport: input.peerLinks.relayTransport ?? null,
        hopRttMs: input.peerLinks.relayRttMs ?? null,
        status: 'ok',
      };
      relaysMap.set(id, r);
    }
    return r;
  };

  const ensureShareRelay = (route: DeviceLinkProviderShareRouteView | undefined): ProviderTopologyRelay => {
    if (!route) return ensurePrimaryRelay();
    if (route.relayKind === 'self-hosted') {
      return ensurePrimaryRelay();
    }
    if (route.relayKind === 'official') {
      if (!route.region) {
        if (!input.primarySelfHosted) {
          return ensurePrimaryRelay();
        }
        const id = 'relay:official:default';
        let r = relaysMap.get(id);
        if (!r) {
          r = {
            id,
            kind: 'official',
            name: input.officialRelayLabel,
            host: null,
            region: null,
            transport: route.relayTransport ?? input.peerLinks.relayTransport ?? null,
            hopRttMs: route.relayRttMs ?? input.peerLinks.relayRttMs ?? null,
            status: 'ok',
          };
          relaysMap.set(id, r);
        }
        return r;
      }
      const id = `relay:official:${route.region}`;
      let r = relaysMap.get(id);
      if (!r) {
        r = {
          id,
          kind: 'official',
          name: `${input.officialRelayLabel} · ${route.region.toUpperCase()}`,
          host: null,
          region: route.region,
          transport: route.relayTransport ?? null,
          hopRttMs: route.relayRttMs ?? null,
          status: 'ok',
        };
        relaysMap.set(id, r);
      }
      return r;
    }
    const host = route.relayHost || 'relay';
    const id = `relay:sharer:${host}`;
    let r = relaysMap.get(id);
    if (!r) {
      r = {
        id,
        kind: 'sharer-relay',
        name: host,
        host,
        region: route.region ?? null,
        transport: route.relayTransport ?? null,
        hopRttMs: route.relayRttMs ?? null,
        status: 'ok',
      };
      relaysMap.set(id, r);
    }
    return r;
  };

  // 3) 归属本机建的供应商组：按 (agentDeviceId, providerId) 精准匹配，避免同一台电脑上不同供应商任务混入同一个组
  const groupByDeviceAndProvider = new Map<string, { groupId: string; providerId: string; config: ProviderGroupConfig }>();
  const groupIdsByAgentDevice = new Map<string, Set<string>>();
  const localGroupEntries = Object.entries(input.localGroups).filter(([, cfg]) => {
    const remoteMembers = cfg.members.filter((m) => m.kind !== 'local' && m.agentDeviceId);
    return remoteMembers.length >= 1 && cfg.members.length >= 2;
  });
  for (const [providerId, config] of localGroupEntries) {
    const groupId = `group:${providerId}`;
    for (const member of config.members) {
      if (member.kind === 'local' || !member.agentDeviceId) continue;
      groupByDeviceAndProvider.set(`${member.agentDeviceId}\0${providerId}`, { groupId, providerId, config });
      let set = groupIdsByAgentDevice.get(member.agentDeviceId);
      if (!set) {
        set = new Set();
        groupIdsByAgentDevice.set(member.agentDeviceId, set);
      }
      set.add(groupId);
    }
  }

  const resolveMachineGroup = (
    agentDeviceId: string,
    tasks: readonly ProviderTopologyTask[],
    shareProviderId: string | null,
  ): { groupId: string; providerId: string; config: ProviderGroupConfig } | null => {
    const scopedTasks = input.scope === 'running' ? tasks.filter((t) => t.running) : tasks;
    const candidateTasks = scopedTasks.length > 0 ? scopedTasks : tasks;
    const matchedGroups = new Map<string, { groupId: string; providerId: string; config: ProviderGroupConfig }>();
    let hasUngroupedProvider = false;
    for (const task of candidateTasks) {
      const pid = task.providerId ?? shareProviderId;
      if (!pid) {
        hasUngroupedProvider = true;
        continue;
      }
      const ref = groupByDeviceAndProvider.get(`${agentDeviceId}\0${pid}`);
      if (ref) matchedGroups.set(ref.groupId, ref);
      else hasUngroupedProvider = true;
    }
    if (matchedGroups.size === 1 && !hasUngroupedProvider) {
      return matchedGroups.values().next().value ?? null;
    }
    return null;
  };

  // 4) 为每个有任务绑定的远程机器构造节点
  const allMachines: ProviderTopologyMachine[] = [];
  const usedAgentDevices = new Set<string>();

  for (const [agentDeviceId, tasks] of tasksByAgentDevice.entries()) {
    usedAgentDevices.add(agentDeviceId);
    const shareId = parseShareAgentDeviceId(agentDeviceId);
    const shareMeta = shareId ? shareById.get(shareId) ?? null : null;
    const groupRef = resolveMachineGroup(agentDeviceId, tasks, shareMeta?.providerId ?? null);
    const usedModels = Array.from(new Set(tasks.map((t) => t.model).filter((m) => m && m !== '—'))).slice(0, 3);

    if (shareId) {
      const share = shareById.get(shareId) ?? null;
      const shareRoute = shareRouteById.get(shareId);
      const displayName =
        input.shareDisplayNames.get(shareId) ??
        share?.owner.displayName?.trim() ??
        shareId;

      const online = share ? share.hostOnline : Boolean(shareRoute?.path);
      let errorReason: ProviderTopologyMachine['errorReason'] = null;
      if (share && share.status !== 'active') errorReason = 'paused';
      else if (input.unresponsiveIds.has(agentDeviceId)) errorReason = 'unresponsive';
      else if (!online) errorReason = 'offline';
      else if (share && !share.hostCapable) errorReason = 'needs-update';

      const path = shareRoute?.path ?? null;
      const routeMode: ProviderTopologyMachine['routeMode'] =
        path === 'direct' ? 'direct' : path === 'relay' || shareRoute ? 'relay' : 'unlinked';

      let relayId: string | null = null;
      if (routeMode === 'relay') {
        const relay = ensureShareRelay(shareRoute);
        relayId = relay.id;
      }

      const status: ProviderMachineStatus = errorReason
        ? errorReason === 'offline'
          ? 'offline'
          : 'error'
        : path === 'direct'
          ? 'direct'
          : path === 'relay'
            ? 'relay'
            : path === 'connecting'
              ? 'connecting'
              : 'unlinked';

      const flow =
        shareRoute && (status === 'direct' || status === 'relay')
          ? flowOf({ sentAgoMs: shareRoute.sentAgoMs, receivedAgoMs: shareRoute.receivedAgoMs })
          : null;
      const shareProtocol = path === 'direct' || path === 'relay' ? shareRoute?.protocol ?? null : null;

      allMachines.push({
        id: `share:${shareId}`,
        kind: 'share',
        targetId: shareId,
        agentDeviceId,
        groupId: groupRef?.groupId ?? null,
        name: displayName,
        avatarLabel: share?.owner.displayName ?? displayName,
        platform: null,
        isMobile: false,
        modelLabel: null,
        avatarUrl: share?.owner.avatarUrl ?? null,
        shareProviderId: share?.providerId ?? null,
        shareGroupSize: null,
        usedModels,
        status,
        routeMode,
        relayId,
        protocol: shareProtocol,
        transport: providerLinkTransport(
          shareProtocol,
          routeMode === 'unlinked' ? null : routeMode,
          shareRoute?.relayTransport ?? input.peerLinks.relayTransport ?? null,
        ),
        rttMs: shareRoute?.rttMs ?? null,
        directRttMs: null,
        relayRttMs: path === 'relay' ? shareRoute?.rttMs ?? null : null,
        pathPreference: null,
        flow,
        busy: tasks.some((t) => t.running),
        online,
        errorReason,
        allTasks: tasks,
        visibleTasks: tasks,
      });
    } else {
      const device = deviceById.get(agentDeviceId) ?? null;
      const link = linkByDeviceId.get(agentDeviceId);
      const route = agentNetByDeviceId.get(agentDeviceId);
      const online = Boolean(device?.online || route !== undefined || link?.open);
      const isMobile = isMobilePlatform(device?.platform ?? null);

      const control = link?.open ? link : undefined;
      const agentNetPath = route?.path === 'connecting' ? null : route?.path ?? null;
      const activePath = control?.path ?? agentNetPath;

      let errorReason: ProviderTopologyMachine['errorReason'] = null;
      if (online && input.unresponsiveIds.has(agentDeviceId)) errorReason = 'unresponsive';
      else if (!online) errorReason = 'offline';

      const routeMode: ProviderTopologyMachine['routeMode'] =
        activePath === 'direct' ? 'direct' : activePath === 'relay' ? 'relay' : 'unlinked';

      let relayId: string | null = null;
      if (routeMode === 'relay') {
        const relay = ensurePrimaryRelay();
        relayId = relay.id;
      }

      const status: ProviderMachineStatus = !online
        ? 'offline'
        : errorReason
          ? 'error'
          : activePath ?? (route?.path === 'connecting' ? 'connecting' : 'unlinked');

      const flow =
        control && (status === 'direct' || status === 'relay')
          ? flowOf(control)
          : null;
      const ownProtocol = ownLinkProtocol(activePath, control ? control.encrypted : agentNetPath ? true : undefined);

      const ownName = device?.name ?? tasks[0]?.session.deviceLinkDeviceName ?? agentDeviceId;
      allMachines.push({
        id: `own:${agentDeviceId}`,
        kind: 'own',
        targetId: agentDeviceId,
        agentDeviceId,
        groupId: groupRef?.groupId ?? null,
        name: ownName,
        avatarLabel: ownName,
        platform: device?.platform ?? null,
        isMobile,
        modelLabel: device?.deviceInfo?.modelLabel?.trim() || null,
        avatarUrl: null,
        shareProviderId: null,
        shareGroupSize: null,
        usedModels,
        status,
        routeMode,
        relayId,
        protocol: ownProtocol,
        transport: providerLinkTransport(ownProtocol, activePath, input.peerLinks.relayTransport ?? null),
        rttMs: control ? control.rttMs : route?.rttMs ?? null,
        directRttMs: route?.directRttMs ?? null,
        relayRttMs: route?.relayRttMs ?? null,
        pathPreference: route?.pathPreference ?? null,
        flow,
        busy: Boolean(device?.busy || tasks.some((t) => t.running)),
        online,
        errorReason,
        allTasks: tasks,
        visibleTasks: tasks,
      });
    }
  }

  // 5) 统计未过滤的全量任务数（供顶部「全部关联任务 / 仅运行中」计数）
  const unfilteredTaskCount = allMachines.reduce((sum, m) => sum + m.allTasks.length, 0);
  const unfilteredRunningCount = allMachines.reduce(
    (sum, m) => sum + m.allTasks.filter((t) => t.running).length,
    0,
  );

  // 6) 应用 scope（全部 / 仅运行中）与搜索词 query 过滤
  const q = input.query.trim().toLowerCase();
  const filteredMachines: ProviderTopologyMachine[] = [];

  for (const m of allMachines) {
    const relayObj = m.relayId ? relaysMap.get(m.relayId) : null;
    const scopedTasks = input.scope === 'running' ? m.allTasks.filter((t) => t.running) : m.allTasks;
    if (scopedTasks.length === 0) continue;

    const scopedModels = Array.from(
      new Set(scopedTasks.map((t) => t.model).filter((x) => x && x !== '—')),
    ).slice(0, 3);

    const machineMatches =
      !q ||
      m.name.toLowerCase().includes(q) ||
      scopedModels.some((model) => model.toLowerCase().includes(q)) ||
      (relayObj && relayObj.name.toLowerCase().includes(q)) ||
      (m.routeMode === 'direct' && ('直连'.includes(q) || 'direct'.includes(q) || 'udp'.includes(q)));

    const visibleTasks = scopedTasks.filter((t) => {
      if (!q || machineMatches) return true;
      return t.title.toLowerCase().includes(q) || t.model.toLowerCase().includes(q);
    });

    if (visibleTasks.length > 0) {
      filteredMachines.push({
        ...m,
        usedModels: scopedModels.length > 0 ? scopedModels : m.usedModels,
        visibleTasks,
      });
    }
  }

  // 7) 聚合成右栏块（供应商组容器 + 独立机器）并按中转分组排序，最大程度避免连线交叉
  const usedRelayIds = new Set(
    filteredMachines
      .filter((m) => m.routeMode === 'relay' && m.relayId)
      .map((m) => m.relayId!),
  );
  const activeRelays = Array.from(relaysMap.values())
    .filter((r) => usedRelayIds.has(r.id))
    .sort((a, b) => {
      const rank = (k: ProviderRelayKind) => (k === 'self-hosted' ? 0 : k === 'official' ? 1 : 2);
      return rank(a.kind) - rank(b.kind) || a.name.localeCompare(b.name);
    });
  const relayOrder = new Map(activeRelays.map((r, i) => [r.id, i] as const));

  // 更新每个中转站状态：若挂载的机器全错则中转标错
  for (const r of activeRelays) {
    const attached = filteredMachines.filter((m) => m.routeMode === 'relay' && m.relayId === r.id);
    if (attached.length > 0 && attached.every((m) => m.status === 'error' || m.status === 'offline')) {
      r.status = 'error';
    }
  }

  const blocks: ProviderTopologyBlock[] = [];
  const groupBlockById = new Map<string, ProviderTopologyGroupBlock>();
  const groupConfigById = new Map<string, { providerId: string; config: ProviderGroupConfig }>(
    localGroupEntries.map(([providerId, config]) => [`group:${providerId}`, { providerId, config }] as const),
  );

  for (const m of filteredMachines) {
    if (m.groupId && groupConfigById.has(m.groupId)) {
      let blk = groupBlockById.get(m.groupId);
      if (!blk) {
        const entry = groupConfigById.get(m.groupId)!;
        const activeIdsInGroup = new Set(
          filteredMachines.filter((x) => x.groupId === m.groupId).map((x) => x.agentDeviceId),
        );
        const idleMembers: ProviderGroupIdleMember[] = [];
        for (const member of entry.config.members) {
          if (member.kind === 'local' || !member.agentDeviceId) continue;
          if (activeIdsInGroup.has(member.agentDeviceId)) continue;
          const sid = parseShareAgentDeviceId(member.agentDeviceId);
          if (sid) {
            const share = shareById.get(sid);
            const sr = shareRouteById.get(sid);
            const displayName = input.shareDisplayNames.get(sid) ?? share?.owner.displayName ?? sid;
            idleMembers.push({
              key: member.key,
              kind: 'share',
              name: displayName,
              avatarLabel: share?.owner.displayName ?? displayName,
              avatarUrl: share?.owner.avatarUrl ?? null,
              platform: null,
              online: Boolean(share?.hostOnline),
              paused: share ? share.status !== 'active' : false,
              routeMode: sr?.path === 'direct' ? 'direct' : sr?.path === 'relay' ? 'relay' : null,
              rttMs: sr?.rttMs ?? null,
            });
          } else {
            const dev = deviceById.get(member.agentDeviceId);
            const rt = agentNetByDeviceId.get(member.agentDeviceId);
            const ownName = dev?.name ?? member.label ?? member.agentDeviceId;
            idleMembers.push({
              key: member.key,
              kind: 'own',
              name: ownName,
              avatarLabel: ownName,
              avatarUrl: null,
              platform: dev?.platform ?? null,
              online: Boolean(dev?.online || rt),
              paused: false,
              routeMode: rt?.path === 'direct' ? 'direct' : rt?.path === 'relay' ? 'relay' : null,
              rttMs: rt?.rttMs ?? null,
            });
          }
        }
        blk = {
          kind: 'group',
          id: m.groupId,
          providerId: entry.providerId,
          totalCount: entry.config.members.filter((x) => x.kind !== 'local').length,
          machines: [],
          idleMembers,
        };
        groupBlockById.set(m.groupId, blk);
        blocks.push(blk);
      }
      blk.machines.push(m);
    } else {
      blocks.push({ kind: 'standalone', id: m.id, machines: [m] });
    }
  }

  for (const blk of blocks) {
    blk.machines.sort((a, b) => peerRouteOrder(a, relayOrder) - peerRouteOrder(b, relayOrder) || a.name.localeCompare(b.name));
  }
  blocks.sort((a, b) => {
    const minA = Math.min(...a.machines.map((m) => peerRouteOrder(m, relayOrder)));
    const minB = Math.min(...b.machines.map((m) => peerRouteOrder(m, relayOrder)));
    return minA - minB || a.id.localeCompare(b.id);
  });

  // 8) 汇总当前无执行中任务调用、但在线待命的独立远程供应商机器（默认折叠在底栏）
  const activeAgentDevices = new Set(filteredMachines.map((m) => m.agentDeviceId));
  const activeGroupIds = new Set(blocks.filter((b) => b.kind === 'group').map((b) => b.id));
  const hasActiveGroup = (agentDeviceId: string): boolean => {
    const ids = groupIdsByAgentDevice.get(agentDeviceId);
    if (!ids) return false;
    for (const gid of ids) {
      if (activeGroupIds.has(gid)) return true;
    }
    return false;
  };
  const idleProviders: IdleStandbyProvider[] = [];
  for (const dev of deviceById.values()) {
    if (!dev.online || isMobilePlatform(dev.platform) || !dev.remoteControlEnabled) continue;
    if (activeAgentDevices.has(dev.deviceId) || hasActiveGroup(dev.deviceId)) continue;
    const rt = agentNetByDeviceId.get(dev.deviceId);
    const lk = linkByDeviceId.get(dev.deviceId);
    const p = lk?.open ? lk.path : rt?.path === 'connecting' ? null : rt?.path ?? null;
    const idleOwnProtocol = ownLinkProtocol(p, lk?.open ? lk.encrypted : p ? true : undefined);
    idleProviders.push({
      id: `own:${dev.deviceId}`,
      kind: 'own',
      targetId: dev.deviceId,
      name: dev.name,
      avatarLabel: dev.name,
      platform: dev.platform,
      modelLabel: dev.deviceInfo?.modelLabel?.trim() || null,
      avatarUrl: null,
      shareProviderId: null,
      routeMode: p,
      relayName: p === 'relay' ? input.primaryRelayName : null,
      protocol: idleOwnProtocol,
      transport: providerLinkTransport(idleOwnProtocol, p, input.peerLinks.relayTransport ?? null),
      rttMs: lk?.open ? lk.rttMs : rt?.rttMs ?? null,
      directRttMs: rt?.directRttMs ?? null,
      relayRttMs: rt?.relayRttMs ?? null,
      pathPreference: rt?.pathPreference ?? null,
      busy: Boolean(dev.busy),
    });
  }
  for (const share of input.receivedShares) {
    const aid = `${PROVIDER_SHARE_AGENT_DEVICE_PREFIX}${share.shareId}`;
    if (share.status !== 'active' || !share.hostOnline) continue;
    if (activeAgentDevices.has(aid) || hasActiveGroup(aid)) continue;
    const sr = shareRouteById.get(share.shareId);
    const p = sr?.path === 'connecting' ? null : sr?.path ?? null;
    const displayName = input.shareDisplayNames.get(share.shareId) ?? share.owner.displayName;
    idleProviders.push({
      id: `share:${share.shareId}`,
      kind: 'share',
      targetId: share.shareId,
      name: displayName,
      avatarLabel: share.owner.displayName,
      platform: null,
      modelLabel: null,
      avatarUrl: share.owner.avatarUrl ?? null,
      shareProviderId: share.providerId ?? null,
      routeMode: p,
      relayName:
        p === 'relay'
          ? sr?.relayKind === 'sharer-relay'
            ? sr.relayHost
            : sr?.relayKind === 'self-hosted'
              ? input.primaryRelayName
              : input.officialRelayLabel
          : null,
      protocol: p ? sr?.protocol ?? null : null,
      transport: providerLinkTransport(
        p ? sr?.protocol ?? null : null,
        p,
        sr?.relayTransport ?? input.peerLinks.relayTransport ?? null,
      ),
      rttMs: sr?.rttMs ?? null,
      directRttMs: null,
      relayRttMs: p === 'relay' ? sr?.rttMs ?? null : null,
      pathPreference: null,
      busy: false,
    });
  }

  const routeRank = (m: IdleStandbyProvider['routeMode']) => (m === 'direct' ? 0 : m === 'relay' ? 1 : 2);
  idleProviders.sort(
    (a, b) =>
      (a.kind === b.kind ? 0 : a.kind === 'own' ? -1 : 1) ||
      routeRank(a.routeMode) - routeRank(b.routeMode) ||
      a.name.localeCompare(b.name),
  );

  const totalMachinesInGroups = Array.from(groupBlockById.values()).reduce((s, g) => s + g.totalCount, 0);
  const standaloneActiveCount = blocks.filter((b) => b.kind === 'standalone').length;
  const statsMachines =
    input.scope === 'running'
      ? allMachines.filter((m) => m.allTasks.some((t) => t.running))
      : allMachines;
  const statsTaskCount = input.scope === 'running' ? unfilteredRunningCount : unfilteredTaskCount;

  return {
    blocks,
    machines: filteredMachines,
    relays: activeRelays,
    relayById: new Map(activeRelays.map((r) => [r.id, r] as const)),
    idleProviders,
    stats: {
      totalTasks: statsTaskCount,
      runningTasks: unfilteredRunningCount,
      activeMachines: statsMachines.length,
      totalMachines: Math.max(statsMachines.length, totalMachinesInGroups + standaloneActiveCount),
      directCount: statsMachines.filter((m) => m.routeMode === 'direct').length,
      relayCount: new Set(statsMachines.filter((m) => m.routeMode === 'relay' && m.relayId).map((m) => m.relayId)).size,
      errorCount: statsMachines.filter((m) => m.status === 'error').length,
    },
    unfilteredTaskCount,
    unfilteredRunningCount,
  };
}

// ─── 三栏零交叉布局几何（纯函数，可直接单测碰撞） ────────────────────────

export interface ProviderLineGeom {
  id: string;
  shape: LineShape;
  d: string;
  flow: TopologyFlow | null;
  status: 'ok' | 'live' | 'error' | 'muted';
  machineId: string;
  relayId: string | null;
  taskId: string | null;
}

export interface ProviderTaskBoxLayout {
  task: ProviderTopologyTask;
  x: number;
  top: number;
  w: number;
  h: number;
  cy: number;
}

export interface ProviderMachineLayout {
  machine: ProviderTopologyMachine;
  inGroup: boolean;
  groupId: string | null;
  xMachCard: number;
  wMachCard: number;
  machTop: number;
  machH: number;
  cy: number;
  useBundle: boolean;
  xTask: number;
  wTask: number;
  leftTop: number;
  leftH: number;
  taskBoxes: ProviderTaskBoxLayout[];
  joinPoint: { x: number; y: number } | null;
  /** 直连徽章：w 是放得下的最小宽度，maxW 是束点到机器卡片之间可用的最大宽度（徽章按文字撑开，不超过它）。 */
  directPillPos: { x: number; y: number; w: number; maxW: number } | null;
  /** 中转到机器那段线上的延迟标签；maxW 是中转站与机器卡片之间的可用宽度（协议标签不超过它）。 */
  branchRttPos: { x: number; y: number; w: number; maxW: number } | null;
  flow: TopologyFlow | null;
}

export interface ProviderRelayLayout {
  relay: ProviderTopologyRelay;
  x: number;
  top: number;
  w: number;
  h: number;
  cy: number;
  flow: TopologyFlow | null;
  /**
   * 经这台中转的机器都走同一种协议时就是它（写在中转站下面）；中转只转发，前后两段一定是同一种协议。
   * 不同机器混用 Agent-Net 与 Device Link 时为 null，并由 mixedProtocols 让各条分支各写各的。
   */
  protocol: ProviderLinkProtocol | null;
  mixedProtocols: boolean;
}

export interface ProviderGroupLayout {
  block: ProviderTopologyGroupBlock;
  x: number;
  top: number;
  w: number;
  h: number;
  footTop: number;
  footH: number;
  expanded: boolean;
  idleRows: Array<{
    member: ProviderGroupIdleMember;
    x: number;
    top: number;
    w: number;
    h: number;
  }>;
}

export interface ProviderTopologyLayout {
  w: number;
  h: number;
  taskW: number;
  machW: number;
  relayW: number;
  groups: ProviderGroupLayout[];
  machines: ProviderMachineLayout[];
  relays: ProviderRelayLayout[];
  lines: ProviderLineGeom[];
}

function cubicShape(x1: number, y1: number, x2: number, y2: number): LineShape {
  const dx = Math.abs(x2 - x1) * 0.52;
  return {
    a: { x: x1, y: y1 },
    c1: { x: x1 + dx, y: y1 },
    c2: { x: x2 - dx, y: y2 },
    k: { x: x2, y: y2 },
    b: null,
  };
}

function straightShape(x1: number, y: number, x2: number): LineShape {
  const mid = (x1 + x2) / 2;
  return {
    a: { x: x1, y },
    c1: { x: mid, y },
    c2: { x: mid, y },
    k: { x: x2, y },
    b: null,
  };
}

const SINGLE_TASK_H = 44;
const BUNDLE_H = 54;
const TASK_GAP = 6;
const MACH_H = 58;
const GRP_HEAD_H = 30;
const GRP_PAD = 7;
const GRP_INNER_GAP = 8;
const GRP_FOOT_H = 28;
const IDLE_ROW_H = 30;
const BLOCK_GAP = 16;
const RELAY_H = 44;
/** 中转站下面写协议（Agent-Net / Device Link）的那一行高度。 */
const RELAY_LABEL_H = 20;

export function layoutProviderTopology(
  model: ProviderTopologyModel,
  width: number,
  expandedGroups: ReadonlySet<string>,
): ProviderTopologyLayout {
  const W = Math.max(540, Math.round(width));
  const narrow = W < 720;
  const padX = narrow ? 12 : 16;
  const taskW = Math.round(Math.max(156, Math.min(242, W * (narrow ? 0.255 : 0.268))));
  const machW = Math.round(Math.max(182, Math.min(268, W * (narrow ? 0.29 : 0.305))));
  const relayW = Math.round(Math.max(146, Math.min(192, W * (narrow ? 0.205 : 0.21))));

  const xTask = padX;
  const xTaskOut = xTask + taskW;
  const xMach = W - padX - machW;
  const midCenter = Math.round((xTaskOut + xMach) / 2);
  const xJoin = xTaskOut + Math.round(Math.max(16, (midCenter - relayW / 2 - xTaskOut) * 0.32));
  const xRelayLeft = Math.round(midCenter - relayW / 2);
  const xRelayRight = xRelayLeft + relayW;

  let cursorY = 8;
  const groups: ProviderGroupLayout[] = [];
  const machines: ProviderMachineLayout[] = [];

  for (const blk of model.blocks) {
    if (blk.kind === 'standalone') {
      const m = blk.machines[0];
      const useBundle = m.visibleTasks.length >= TASK_BUNDLE_THRESHOLD;
      const leftH = useBundle
        ? BUNDLE_H
        : m.visibleTasks.length * SINGLE_TASK_H + Math.max(0, m.visibleTasks.length - 1) * TASK_GAP;
      const bandH = Math.max(leftH, MACH_H);
      const cy = cursorY + bandH / 2;
      const leftTop = cy - leftH / 2;

      const taskBoxes: ProviderTaskBoxLayout[] = useBundle
        ? []
        : m.visibleTasks.map((task, idx) => {
            const top = leftTop + idx * (SINGLE_TASK_H + TASK_GAP);
            return { task, x: xTask, top, w: taskW, h: SINGLE_TASK_H, cy: top + SINGLE_TASK_H / 2 };
          });

      machines.push({
        machine: m,
        inGroup: false,
        groupId: null,
        xMachCard: xMach,
        wMachCard: machW,
        machTop: cy - MACH_H / 2,
        machH: MACH_H,
        cy,
        useBundle,
        xTask,
        wTask: taskW,
        leftTop,
        leftH,
        taskBoxes,
        joinPoint: !useBundle && m.visibleTasks.length > 1 ? { x: xJoin, y: Math.round(cy) } : null,
        directPillPos: null,
        branchRttPos: null,
        flow: m.flow,
      });
      cursorY += bandH + BLOCK_GAP;
    } else {
      const expanded = expandedGroups.has(blk.id);
      let innerY = cursorY + GRP_HEAD_H + GRP_PAD;

      for (let i = 0; i < blk.machines.length; i += 1) {
        const m = blk.machines[i];
        const useBundle = m.visibleTasks.length >= TASK_BUNDLE_THRESHOLD;
        const leftH = useBundle
          ? BUNDLE_H
          : m.visibleTasks.length * SINGLE_TASK_H + Math.max(0, m.visibleTasks.length - 1) * TASK_GAP;
        const rowH = Math.max(leftH, MACH_H);
        const cy = innerY + rowH / 2;
        const leftTop = cy - leftH / 2;

        const taskBoxes: ProviderTaskBoxLayout[] = useBundle
          ? []
          : m.visibleTasks.map((task, idx) => {
              const top = leftTop + idx * (SINGLE_TASK_H + TASK_GAP);
              return { task, x: xTask, top, w: taskW, h: SINGLE_TASK_H, cy: top + SINGLE_TASK_H / 2 };
            });

        machines.push({
          machine: m,
          inGroup: true,
          groupId: blk.id,
          xMachCard: xMach + GRP_PAD,
          wMachCard: machW - GRP_PAD * 2,
          machTop: cy - MACH_H / 2,
          machH: MACH_H,
          cy,
          useBundle,
          xTask,
          wTask: taskW,
          leftTop,
          leftH,
          taskBoxes,
          joinPoint: !useBundle && m.visibleTasks.length > 1 ? { x: xJoin, y: Math.round(cy) } : null,
          directPillPos: null,
          branchRttPos: null,
          flow: m.flow,
        });
        innerY += rowH + (i < blk.machines.length - 1 ? GRP_INNER_GAP : 0);
      }

      innerY += GRP_PAD;

      const idleRows: ProviderGroupLayout['idleRows'] = [];
      if (expanded && blk.idleMembers.length > 0) {
        innerY += 4;
        for (const member of blk.idleMembers) {
          idleRows.push({
            member,
            x: xMach + GRP_PAD,
            top: innerY,
            w: machW - GRP_PAD * 2,
            h: IDLE_ROW_H,
          });
          innerY += IDLE_ROW_H + 5;
        }
        innerY += 2;
      }

      const footTop = innerY;
      const footH = blk.idleMembers.length > 0 ? GRP_FOOT_H : 0;
      const groupBottom = footTop + footH;
      groups.push({
        block: blk,
        x: xMach,
        top: cursorY,
        w: machW,
        h: groupBottom - cursorY,
        footTop,
        footH,
        expanded,
        idleRows,
      });
      cursorY = groupBottom + BLOCK_GAP;
    }
  }

  let h = Math.max(140, cursorY - BLOCK_GAP + 10);

  // 计算每台中转站垂直位置（同中转机器均值 + 垂直碰撞避让；中转站下面留出写协议的一行）
  const relays: ProviderRelayLayout[] = [];
  const relayLayoutById = new Map<string, ProviderRelayLayout>();
  for (const relay of model.relays) {
    const attached = machines.filter((ml) => ml.machine.routeMode === 'relay' && ml.machine.relayId === relay.id);
    if (attached.length === 0) continue;
    let cy = (attached[0].cy + attached[attached.length - 1].cy) / 2;
    for (const prev of relays) {
      if (Math.abs(cy - prev.cy) < RELAY_H + RELAY_LABEL_H + 10) {
        cy = prev.cy + RELAY_H + RELAY_LABEL_H + 10;
      }
    }
    const flow = mergeFlows(attached.map((ml) => ml.flow));
    const protocols = new Set(attached.map((ml) => ml.machine.protocol).filter((p): p is ProviderLinkProtocol => p !== null));
    const protocol = protocols.size === 1 ? [...protocols][0] : null;
    const mixedProtocols = protocols.size > 1;
    const relayDisplay: ProviderTopologyRelay = protocol === 'device-link' || mixedProtocols
      ? { ...relay, transport: mixedProtocols ? null : 'websocket', hopRttMs: null }
      : relay;
    const rl: ProviderRelayLayout = {
      relay: relayDisplay,
      x: xRelayLeft,
      top: Math.round(cy - RELAY_H / 2),
      w: relayW,
      h: RELAY_H,
      cy,
      flow,
      protocol,
      mixedProtocols,
    };
    relays.push(rl);
    relayLayoutById.set(relay.id, rl);
    h = Math.max(h, rl.top + RELAY_H + (rl.protocol ? RELAY_LABEL_H : 0) + 10);
  }

  const lines: ProviderLineGeom[] = [];

  for (const ml of machines) {
    const m = ml.machine;
    const isErr = m.status === 'error';
    const isMuted = m.status === 'offline' || m.status === 'unlinked' || m.status === 'connecting';
    const isLive = Boolean(ml.flow) && !isErr && !isMuted;
    const lineStatus: ProviderLineGeom['status'] = isErr
      ? 'error'
      : isMuted
        ? 'muted'
        : isLive
          ? 'live'
          : 'ok';

    // 1) 左侧：任务 / 任务束 -> 束点
    if (ml.useBundle) {
      const shape = straightShape(xTaskOut, Math.round(ml.cy), xJoin);
      lines.push({
        id: `bundle:${m.id}`,
        shape,
        d: shapeD(shape),
        flow: isLive ? ml.flow : null,
        status: lineStatus,
        machineId: m.id,
        relayId: m.relayId,
        taskId: null,
      });
    } else {
      for (const tb of ml.taskBoxes) {
        const shape = cubicShape(xTaskOut, tb.cy, xJoin, ml.cy);
        lines.push({
          id: `task:${m.id}:${tb.task.id}`,
          shape,
          d: shapeD(shape),
          flow: isLive && tb.task.running ? ml.flow : null,
          status: lineStatus,
          machineId: m.id,
          relayId: m.relayId,
          taskId: tb.task.id,
        });
      }
    }

    // 2) 中段：直连 / 未建链直线 vs 经中转站两段曲线
    const xTargetIn = ml.xMachCard;
    if (m.routeMode === 'relay' && m.relayId && relayLayoutById.has(m.relayId)) {
      const rl = relayLayoutById.get(m.relayId)!;
      const inShape = cubicShape(xJoin, ml.cy, xRelayLeft, rl.cy);
      lines.push({
        id: `in:${m.id}`,
        shape: inShape,
        d: shapeD(inShape),
        flow: isLive ? ml.flow : null,
        status: lineStatus,
        machineId: m.id,
        relayId: m.relayId,
        taskId: null,
      });

      const outShape = cubicShape(xRelayRight, rl.cy, xTargetIn, ml.cy);
      lines.push({
        id: `out:${m.id}`,
        shape: outShape,
        d: shapeD(outShape),
        flow: isLive ? ml.flow : null,
        status: lineStatus,
        machineId: m.id,
        relayId: m.relayId,
        taskId: null,
      });

      const rttW = 50;
      if (xTargetIn - xRelayRight >= rttW + 8) {
        ml.branchRttPos = {
          x: Math.round((xRelayRight + xTargetIn) / 2),
          y: Math.round((rl.cy + ml.cy) / 2),
          w: rttW,
          maxW: xTargetIn - xRelayRight - 6,
        };
      }
    } else {
      const directShape = straightShape(xJoin, Math.round(ml.cy), xTargetIn);
      lines.push({
        id: `direct:${m.id}`,
        shape: directShape,
        d: shapeD(directShape),
        flow: isLive ? ml.flow : null,
        status: lineStatus,
        machineId: m.id,
        relayId: null,
        taskId: null,
      });

      const pillW = 122;
      if (m.routeMode === 'direct' && xTargetIn - xJoin >= pillW + 12) {
        ml.directPillPos = {
          x: midCenter,
          y: Math.round(ml.cy),
          w: pillW,
          maxW: Math.max(pillW, 2 * Math.min(midCenter - xJoin, xTargetIn - midCenter) - 12),
        };
      }
    }
  }

  return { w: W, h, taskW, machW, relayW, groups, machines, relays, lines };
}
