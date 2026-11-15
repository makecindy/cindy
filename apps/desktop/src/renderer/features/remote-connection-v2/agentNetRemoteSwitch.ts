/**
 * agentNetRemoteSwitch —— 在拓扑卡片里远程切换另一台电脑的连接方式(发起的这台电脑)。
 * ---------------------------------------------------------------------------
 * 规则见 docs/product-rules/agent-net.md「远程切换其他电脑的连接方式」(2026-11-12 用户确认):
 * - 先问再切：打开卡片(或批量前)向对方问一次状态。旧版 Cindy 不认识这个问题(CHANNEL_NOT_ALLOWED)
 *   就是「需要更新」；新版回答现在是否打开、能不能打开。不靠版本号猜，不轮询。
 * - 切了要真的连上：对方先回答再切换；打开时对方给出确认期限，这里在期限内反复发确认，确认请求本身会重新
 *   建起到对方的连接，只有这条连接是 Agent-Net(端到端加密)时对方才认。期限内没认，对方自己退回，这里显示已退回。
 * - 关闭不需要确认，问到对方已关闭即算完成。
 *
 * 状态放在模块里而不是组件里：关掉卡片或离开设置页，切换照常进行，结果用提示告诉用户。
 * 请求经本机命令 `selfHostedRelay.command({ type: 'peer-agent-net' })` 转给那台电脑，不改本机设置。
 */

import type { PeerAgentNetReply, PeerAgentNetRequest } from '../../../shared/selfHostedRelay';
import { isCindyApp } from '@cindy/maker-shared/device-list';
import type { TopologyNode } from './topologyModel';

export type RemoteSwitchTarget = 'agent-net' | 'device-link';
export type RemoteSwitchStep = 'request' | 'reconnect' | 'confirm' | 'revert';

export type RemoteSwitchEntry =
  | { kind: 'running'; target: RemoteSwitchTarget; step: RemoteSwitchStep }
  /** 期限内没有经 Agent-Net 连回来，对方已自己退回原来的连接方式。 */
  | { kind: 'reverted'; target: RemoteSwitchTarget }
  /** 刚切换成功(连接方式以真实链路为准)。 */
  | { kind: 'done'; target: RemoteSwitchTarget };

/** 对方的回答。unsupported:旧版 Cindy 没有这个入口；not-ready:有入口但现在打不开；unreachable:这次没问到。 */
export type PeerNotReadyReason = 'not-signed-in' | 'secure-storage' | 'relay-identity';
export type PeerDisableBlock = 'encryption-required' | 'controller-encryption-required' | 'agent-net-only-relay';
export type PeerProbe =
  | { kind: 'checking' }
  | { kind: 'ready'; disableBlock: PeerDisableBlock | null }
  | { kind: 'unsupported' }
  | { kind: 'not-ready'; reason: PeerNotReadyReason; disableBlock: PeerDisableBlock | null }
  | { kind: 'unreachable' };

export type RemoteSwitchBlock = 'mobile' | 'peer-control-off' | 'control-off';

/** 这台设备能不能在这里切换；不能时给出原因。离线、未建链和连接方式未知时不显示切换区。 */
export function remoteSwitchAvailability(node: TopologyNode): { visible: false } | { visible: true; block: RemoteSwitchBlock | null } {
  if (!isCindyApp(node.app)) return { visible: false };
  if (node.status === 'offline' || node.status === 'unlinked') return { visible: false };
  // 对方没开被控时通常也没建链(不知道它用哪种方式)，仍要说明为什么不能在这里切。
  if (node.attention === 'peer-control-off' || (!node.isMobile && !node.remoteControlEnabled)) return { visible: true, block: 'peer-control-off' };
  if (node.encrypted === undefined) return { visible: false };
  if (node.isMobile) return { visible: true, block: 'mobile' };
  if (!node.controlEnabled) return { visible: true, block: 'control-off' };
  return { visible: true, block: null };
}

/** 现在就能发起切换(不含对方的回答)。批量与卡片共用。 */
export function canAskToSwitch(node: TopologyNode, entry: RemoteSwitchEntry | null): boolean {
  const availability = remoteSwitchAvailability(node);
  return availability.visible && availability.block === null && entry?.kind !== 'running';
}

interface Snapshot {
  entries: ReadonlyMap<string, RemoteSwitchEntry>;
  probes: ReadonlyMap<string, PeerProbe>;
}

const entries = new Map<string, RemoteSwitchEntry>();
const probes = new Map<string, PeerProbe>();
const probing = new Map<string, Promise<PeerProbe>>();
let snapshot: Snapshot = { entries: new Map(), probes: new Map() };
const listeners = new Set<() => void>();

function publish(): void {
  snapshot = { entries: new Map(entries), probes: new Map(probes) };
  for (const listener of listeners) listener();
}

export const remoteSwitchStore = {
  subscribe(cb: () => void): () => void {
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  },
  getSnapshot(): Snapshot {
    return snapshot;
  },
};

function set(deviceId: string, entry: RemoteSwitchEntry | null): void {
  if (entry) entries.set(deviceId, entry);
  else entries.delete(deviceId);
  publish();
}

async function ask(deviceId: string, request: PeerAgentNetRequest): Promise<PeerAgentNetReply> {
  const api = window.electronAPI?.selfHostedRelay;
  if (!api) return { ok: false, code: 'NOT_CONNECTED', message: 'no host' };
  try {
    const result = await api.command({ type: 'peer-agent-net', deviceId, request });
    return result.peer ?? { ok: false, code: result.error ?? 'NOT_CONNECTED', message: '' };
  } catch (error) {
    return { ok: false, code: 'NOT_CONNECTED', message: error instanceof Error ? error.message : '' };
  }
}

const switchErrorCode = (reply: PeerAgentNetReply): string | null =>
  reply.ok ? null : (/\[(AGENT_NET_SWITCH_[A-Z_]+)\]/.exec(reply.message)?.[1] ?? null);

function readProbe(reply: PeerAgentNetReply): PeerProbe {
  if (!reply.ok) return reply.code === 'CHANNEL_NOT_ALLOWED' ? { kind: 'unsupported' } : { kind: 'unreachable' };
  const status = reply.result && typeof reply.result === 'object' ? reply.result as Record<string, unknown> : null;
  if (!status || typeof status.enabled !== 'boolean') return { kind: 'unreachable' };
  const disableBlock: PeerDisableBlock | null = status.disableBlocked === 'V2_ONLY_RELAY' || reply.controllerBlock === 'V2_ONLY_RELAY'
    ? 'agent-net-only-relay'
    : reply.controllerBlock === 'ENCRYPTION_REQUIRED' ? 'controller-encryption-required'
      : status.onlyEncrypted === true || status.disableBlocked === 'ENCRYPTION_REQUIRED' ? 'encryption-required' : null;
  if (status.blocked === 'NOT_SIGNED_IN') return { kind: 'not-ready', reason: 'not-signed-in', disableBlock };
  if (status.blocked === 'RELAY_IDENTITY_MISSING') return { kind: 'not-ready', reason: 'relay-identity', disableBlock };
  if (typeof status.blocked === 'string') return { kind: 'not-ready', reason: 'secure-storage', disableBlock };
  return { kind: 'ready', disableBlock };
}

/** 开启前提只约束打开；切回则须尊重目标电脑自己的仅加密选择。单台与批量共用。 */
export function switchProbeKind(probe: PeerProbe | undefined, target: RemoteSwitchTarget): PeerProbe['kind'] | PeerDisableBlock {
  if (!probe) return 'checking';
  if (target === 'device-link' && (probe.kind === 'ready' || probe.kind === 'not-ready')) {
    return probe.disableBlock ?? 'ready';
  }
  return probe.kind;
}

/**
 * 问对方一次：有没有这个入口、现在能不能打开 Agent-Net。只读，打开卡片或批量前问一次，不轮询；
 * 同一台设备正在问时合并。重新问时先保留上次的回答，避免卡片闪一下「正在确认」。
 */
export function probePeer(deviceId: string): Promise<PeerProbe> {
  const inFlight = probing.get(deviceId);
  if (inFlight) return inFlight;
  if (!probes.has(deviceId)) {
    probes.set(deviceId, { kind: 'checking' });
    publish();
  }
  const run = ask(deviceId, { action: 'status' }).then((reply) => {
    const answer = readProbe(reply);
    probes.set(deviceId, answer);
    probing.delete(deviceId);
    publish();
    return answer;
  });
  probing.set(deviceId, run);
  return run;
}

export type RemoteSwitchResult = 'done' | 'reverted' | 'unsupported' | 'not-ready' | PeerDisableBlock | 'busy' | 'failed';

const RETRY_MS = 1_000;
/** 关闭后等待对方明确回答开关已关闭的上限；超时不能当成完成。 */
const OFF_SETTLE_MS = 30_000;
/** 期限前留一点余量：对方的退回计时从它回答时算起。 */
const DEADLINE_MARGIN_MS = 1_500;
/** 对方先回答、约 0.4 秒后才重启连接：太早发出的确认会落在旧连接上，稍等再开始。 */
const FIRST_TRY_DELAY_MS = 1_000;

const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

function newSwitchId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

const running = new Map<string, Promise<RemoteSwitchResult>>();

function readStatus(reply: PeerAgentNetReply): Record<string, unknown> | null {
  return reply.ok && reply.result && typeof reply.result === 'object' ? reply.result as Record<string, unknown> : null;
}

function reachedState(reply: PeerAgentNetReply, enabled: boolean): boolean {
  const status = readStatus(reply);
  return status?.enabled === enabled && status.encrypted === enabled && status.pending !== true;
}

export function startRemoteSwitch(deviceId: string, target: RemoteSwitchTarget): Promise<RemoteSwitchResult> {
  const existing = running.get(deviceId);
  if (existing) return existing;
  const task = runSwitch(deviceId, target).finally(() => running.delete(deviceId));
  running.set(deviceId, task);
  return task;
}

async function runSwitch(deviceId: string, target: RemoteSwitchTarget): Promise<RemoteSwitchResult> {
  const enabled = target === 'agent-net';
  const switchId = newSwitchId();
  set(deviceId, { kind: 'running', target, step: 'request' });
  const reply = await ask(deviceId, { action: 'set', enabled, switchId });
  if (!reply.ok) {
    set(deviceId, null);
    const code = switchErrorCode(reply);
    const disableBlock: PeerDisableBlock | null = code === 'AGENT_NET_SWITCH_ENCRYPTION_REQUIRED' ? 'encryption-required'
      : code === 'AGENT_NET_SWITCH_CONTROLLER_ENCRYPTION_REQUIRED' ? 'controller-encryption-required'
        : code === 'AGENT_NET_SWITCH_V2_ONLY_RELAY' ? 'agent-net-only-relay' : null;
    if (disableBlock) {
      probes.set(deviceId, { kind: 'ready', disableBlock });
      publish();
      return disableBlock;
    }
    if (reply.code === 'CHANNEL_NOT_ALLOWED') {
      probes.set(deviceId, { kind: 'unsupported' });
      publish();
      return 'unsupported';
    }
    if (code === 'AGENT_NET_SWITCH_NOT_READY') {
      probing.delete(deviceId);
      void probePeer(deviceId);
      return 'not-ready';
    }
    return code === 'AGENT_NET_SWITCH_BUSY' ? 'busy' : 'failed';
  }
  const accepted = reply.result && typeof reply.result === 'object' ? reply.result as Record<string, unknown> : {};
  const confirmWithinMs = typeof accepted.confirmWithinMs === 'number' && accepted.confirmWithinMs > 0 ? accepted.confirmWithinMs : null;
  const startedAt = Date.now();
  set(deviceId, { kind: 'running', target, step: 'reconnect' });
  await sleep(FIRST_TRY_DELAY_MS);

  if (!enabled || confirmWithinMs === null) {
    // 关闭(或本来就是这个状态)：不需要确认。问到对方已是这个状态即完成；它重连期间问不到就稍后再问。
    const until = startedAt + OFF_SETTLE_MS;
    let reached = false;
    while (Date.now() < until) {
      const status = await ask(deviceId, { action: 'status' });
      const probe = !enabled ? readProbe(status) : null;
      if (probe && (probe.kind === 'ready' || probe.kind === 'not-ready') && probe.disableBlock) {
        set(deviceId, null);
        probes.set(deviceId, probe);
        publish();
        return probe.disableBlock;
      }
      if (reachedState(status, enabled)) {
        reached = true;
        break;
      }
      await sleep(RETRY_MS);
    }
    if (!reached) {
      set(deviceId, null);
      return 'failed';
    }
    set(deviceId, { kind: 'done', target });
    return 'done';
  }

  // 打开：主动发确认，而不是等连接自己回来——确认请求本身会重新建起到对方的连接(这台电脑没在控制它时，
  // 连接不会自己重建)。只有这条连接是 Agent-Net 时对方才认；期限内没认，对方自己退回。
  const deadline = startedAt + confirmWithinMs - DEADLINE_MARGIN_MS;
  while (Date.now() < deadline) {
    const confirmed = await ask(deviceId, { action: 'confirm', switchId });
    if (confirmed.ok) {
      set(deviceId, { kind: 'done', target });
      return 'done';
    }
    const code = switchErrorCode(confirmed);
    // 对方已经退回，或那台电脑上的人改了开关：不再等。
    if (code === 'AGENT_NET_SWITCH_STALE') {
      // 确认已处理但回包丢失时，待确认记录已经清掉；以实际链路和最终状态核实结果。
      if (reachedState(await ask(deviceId, { action: 'status' }), true)) {
        set(deviceId, { kind: 'done', target });
        return 'done';
      }
      break;
    }
    // 已经联系上对方，只是这条连接还不是 Agent-Net。
    if (code === 'AGENT_NET_SWITCH_NOT_ON_AGENT_NET') set(deviceId, { kind: 'running', target, step: 'confirm' });
    await sleep(RETRY_MS);
  }
  set(deviceId, { kind: 'running', target, step: 'revert' });
  await sleep(1_500);
  const finalStatus = await ask(deviceId, { action: 'status' });
  if (reachedState(finalStatus, true)) {
    set(deviceId, { kind: 'done', target });
    return 'done';
  }
  const state = readStatus(finalStatus);
  if (state?.enabled !== false || state.pending === true) {
    set(deviceId, null);
    return 'failed';
  }
  set(deviceId, { kind: 'reverted', target });
  return 'reverted';
}
