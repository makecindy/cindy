/**
 * 远程 Agent 运行服务(被控端：提供 Agent 登录、订阅与供应商的电脑)。
 *
 * 同账号另一台电脑(控制端)上的任务选择「Agent 在这台电脑上运行」时，经 `maker:remote-agent:v1`
 * 打到这里：本机用自己的 Agent 程序、登录与供应商启动 Agent，Agent 的文件、命令与 Cindy 工具
 * 请求经本次任务的隧道变成反向请求，等控制端在它那台电脑上执行后回包。
 *
 * 不变量：
 *  - 只为通过准入的控制端服务(远程控制打开、未撤销、账号未切换)，关闭或撤销后最迟一个
 *    巡检周期内结束全部任务；
 *  - 其他账号的控制端(供应商分享的受邀者，deps.controllerTrust 判定)不可信：载荷按白名单复核
 *    (guestIsolation.ts)，只开放已隔离的 Agent，只能恢复自己建立的会话；
 *  - 本机从不主动向控制端发起请求，一切经控制端拉取的事件流交付；控制端长时间不拉取视为离开；
 *  - 本机的地址、凭证与供应商配置不进事件流：事件只含 Agent 输出与反向请求；
 *  - open / call / reply / push / close 都按各自的 id 去重，poll 按游标幂等；
 *  - 同一控制端的全部任务共用一个 poll，任务再多也只占设备互联的一个在途请求。
 */
import { createHash, randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';

import {
  REMOTE_AGENT_MAX_PAYLOAD_BYTES,
  REMOTE_AGENT_MAX_RUNS_PER_CONTROLLER,
  REMOTE_AGENT_METHODS,
  REMOTE_AGENT_POLL_MAX_BYTES,
  REMOTE_AGENT_READ_MAX_BYTES,
  REMOTE_AGENT_READ_WAIT_MS,
  REMOTE_AGENT_UPLOAD_CHUNK_BYTES,
  REMOTE_AGENT_VERSION,
  parseRemoteAgentReply,
  parseRemoteAgentRequest,
  type RemoteAgentCaps,
  type RemoteAgentErrorInfo,
  type RemoteAgentKind,
  type RemoteAgentMethod,
  type RemoteAgentPayload,
  type RemoteAgentPollResult,
  type RemoteAgentReply,
  type RemoteAgentReverseRequest,
  type RemoteAgentTeardownReason,
} from '@cindy/device-link';
import type { AgentEvent, AgentSessionHandle, DeviceHostedLinkActivity, InteractionRequest } from '@cindy/maker-core';

import { RemoteAgentRunClient, type RemoteAgentInvoke, type RemoteAgentPoller } from '../controller/runClient';
import { EventLog, waitForAny } from '../eventLog';
import { createGuestUsageMeter, type GuestUsageSample } from './guestUsage';
import {
  GROUP_SWITCH_STATE_KEY,
  newGroupSwitchToken,
  RELAY_UNAVAILABLE_ERROR,
  relayConnId,
  relayErrorForGuest,
  relayErrorInfoFrom,
  relayKeyFor,
  relayMemberConnId,
  relayRunFailureOf,
  relaySessionIdFor,
  type RelayRunFailure,
} from './groupRelay';
import { PROVIDER_GROUP_LOCAL_MEMBER_KEY } from '../../../shared/providerGroup';
import { projectPathText } from '../executor/workspace';
import {
  MAX_ANCESTOR_LEVELS,
  PROJECT_INSTRUCTION_FILES,
  decodeOpenPayload,
  decodeSendOptions,
  decodeUserMessage,
  type RemoteAgentOpenPayload,
  type RemoteAgentWireStartOptions,
  type RemoteAgentWireWorkspace,
} from '../wire';
import {
  GUEST_SUPPORTED_AGENTS,
  confineGuestDirs,
  neutralizeExternalImports,
  sanitizeGuestOpenPayload,
  sanitizeGuestVendorOptions,
  type RemoteAgentControllerTrust,
} from './guestIsolation';
import { createRunTunnel, type RunTunnel, type TunnelHttpRequest, type TunnelHttpResponse } from './tunnel';

const gunzipAsync = promisify(gunzip);

/** 控制端不读时最多替它缓存的未读事件字节；超出说明它已跟不上或离开，结束任务。 */
export const REMOTE_AGENT_HOST_UNREAD_BYTES = 64 * 1024 * 1024;
/** 运行中的任务超过这么久没有被读取，视为控制端已离开。 */
export const REMOTE_AGENT_HOST_IDLE_MS = 3 * 60_000;
/** 结束后保留一段时间供控制端读完收尾事件。 */
export const REMOTE_AGENT_HOST_RETAIN_MS = 60_000;
/**
 * 供应商组的组所在电脑(同账号控制端)替多个受邀者中转过来时，它在本机的任务按受邀者(relay)各算
 * REMOTE_AGENT_MAX_RUNS_PER_CONTROLLER；这个控制端合计不超过这里。受邀者控制端填的 relay 不放宽额度。
 */
export const REMOTE_AGENT_MAX_RELAYED_RUNS_PER_CONTROLLER = REMOTE_AGENT_MAX_RUNS_PER_CONTROLLER * 4;
/** 「需要换一台」凭证多久内有效(受邀者那边交接通常几秒内完成，重开时带回)。 */
export const GROUP_SWITCH_TOKEN_TTL_MS = 10 * 60_000;
/** 距上一次换电脑超过这么久算新的一轮(与供应商组本机任务的一轮同一口径)。 */
const GROUP_SWITCH_ROUND_MS = 30 * 60_000;
/** 打开的结果不明(超时、断链)时，换下一台之前最多等多久请那台关掉同一个任务。 */
const RELAY_CLOSE_WAIT_MS = 5_000;
/** 删除受邀者时没通知到的组内电脑(离线等)，多久后再试一次。 */
const FORGET_RETRY_MS = 10 * 60_000;
/** 那台上的任务以这些原因结束是正常收尾，不算失败。 */
const NORMAL_RELAY_CLOSE_REASONS = new Set(['closed', 'detached', 'ended', 'superseded']);
const UPLOAD_IDLE_MS = 2 * 60_000;
const MAX_STAGED_BYTES_PER_CONTROLLER = REMOTE_AGENT_MAX_PAYLOAD_BYTES * 2;
const MAX_DECOMPRESSED_BYTES = 128 * 1024 * 1024;
const SWEEP_INTERVAL_MS = 5_000;
const STATE_INTERVAL_MS = 2_000;
const MAX_REMEMBERED_CALLS = 256;

export interface HostedStartInput {
  kind: RemoteAgentKind;
  /** 本机侧的任务 id(由控制端与任务 id 派生，恢复同一任务时不变)。 */
  hostSessionId: string;
  /** 影子目录：只放项目说明类文件，作为 Agent 进程的工作目录。 */
  shadowDir: string;
  /** Agent 主机上的 opaque 虚拟工作区根。 */
  mirrorRoot: string;
  /** 虚拟附加目录，与 workspace.extraDirs 按顺序对应。 */
  extraDirs?: string[];
  /** 虚拟可写目录，与 workspace.writableDirs 按顺序对应。 */
  writableDirs?: string[];
  virtualWorkspace?: boolean;
  /** 控制端的个人说明(写进给 Agent 的环境说明)。 */
  personalInstructions?: string;
  options: RemoteAgentWireStartOptions;
  workspace: RemoteAgentWireWorkspace;
  /** linkActivity：隧道上的往来记录，Codex 据此判断慢启动是否仍在推进。 */
  tunnel: { url: string; token: string; linkActivity?: () => DeviceHostedLinkActivity };
  mcpServers: string[];
  onInvalidResumeSession?: (expectedSdkSessionId: string) => Promise<boolean>;
  /** 控制端是其他账号(供应商分享的受邀者)：Agent 不加载本机的个人化配置与可执行配置。 */
  guest?: boolean;
  /**
   * 受邀者专用目录(按控制端分开，跨任务保留)：Codex 的 CODEX_HOME 与 Pi 的会话文件放在这里，
   * 分享删除时整体清理。只对受邀者提供。
   */
  guestHome?: string;
  /**
   * 受邀者任务的供应商边界(只对受邀者提供)：任务只能经这个供应商出站。routeToken 是本机 proxy
   * 认出这条任务请求的令牌，modelIds 是该供应商为本 Agent 提供的模型。
   */
  guestProvider?: { providerId: string; modelIds: string[]; routeToken: string };
}

/** 一次受邀者任务的出站登记(见 RemoteAgentHostDeps.bindGuestProviderRoute)。 */
export interface GuestProviderRouteBinding {
  routeToken: string;
  modelIds: string[];
  release(): void;
}

export interface RemoteAgentHostDeps {
  isAgentAvailable(kind: RemoteAgentKind): boolean;
  startHosted(input: HostedStartInput): Promise<AgentSessionHandle>;
  /** 本机仍允许该控制端远程控制(总开关打开且未撤销)。 */
  isControllerAuthorized(controller: string): boolean;
  /**
   * 控制端是否是本机同账号的设备。不提供 = 全部按同账号处理(现有接线)。返回 guest 时：
   * 载荷按白名单复核、只开放已隔离的 Agent、只能恢复自己建立的会话。
   */
  controllerTrust?(controller: string): RemoteAgentControllerTrust;
  /**
   * 清理指定本机侧任务留在本机 Agent 目录里的会话记录(受邀者的分享删除时调用)。nativeIds 是
   * 这些任务用过的 Agent 会话 id(按 id 存放的附属记录据此精确删除)。
   */
  purgeHostedTranscripts?(hostSessionIds: readonly string[], nativeIds: readonly string[]): Promise<void>;
  /** 记录受邀者每一轮的用量(分享者的管理页按人、按模型展示)。只对 guest 调用。 */
  recordGuestUsage?(controller: string, usage: { kind: RemoteAgentKind; providerId: string | null; samples: GuestUsageSample[] }): void;
  /**
   * 「允许被远程调用」(供应商级授权，默认关)。不提供 = 不做供应商级限制(测试 / 旧接线)。
   *  - resolve：把对方要用的来源落到本机已开放的供应商上。providerId 是字符串时只核对它是否开放；
   *    null / 缺省时在已开放的供应商里按本机默认规则挑一个。返回 null = 没有开放的供应商可用。
   *  - isAllowed：进行中的任务每次发消息前复核(用户可能刚把它关掉)。
   * 两者都带上控制端：供应商分享的受邀者只能用分享给它的那个供应商。
   */
  providerAccess?: {
    resolve(kind: RemoteAgentKind, model: string, providerId: string | null | undefined, controller: string): Promise<string | null>;
    isAllowed(providerId: string, controller: string): boolean;
  };
  /**
   * 受邀者任务的出站边界(只对 guest 调用；不提供 = 不接受受邀者)。启动前登记任务用的供应商：本机
   * proxy 只让这条任务的请求经这个供应商、用它提供的模型。release 在任务结束时调用。
   * 登记前 `isCurrent()` 为 false(这次启动已被同一任务的新实例取代或已关闭)时不登记、返回 null：
   * 迟到的旧登记会顶掉新实例的登记，旧实例随后撤销时把新实例的出站边界也清掉。
   */
  bindGuestProviderRoute?(input: {
    kind: RemoteAgentKind;
    hostSessionId: string;
    providerId: string;
    isCurrent(): boolean;
  }): Promise<GuestProviderRouteBinding | null>;
  /**
   * 供应商组(本机是组所在电脑，docs/product-rules/provider-groups.md §4)：受邀者的新任务按组策略交给
   * 组内电脑运行，本机中转。不提供 = 受邀者的任务一律在本机运行(现有接线)。
   */
  groupRelay?: RemoteAgentGroupRelayDeps;
  captureOwner(): unknown;
  isOwnerCurrent(owner: unknown): boolean;
  /** 本机存放影子目录与附件的根目录。 */
  runsRoot: string;
  now?: () => number;
  log?: {
    info(message: string, meta?: Record<string, unknown>): void;
    warn(message: string, meta?: Record<string, unknown>): void;
  };
}

/** 受邀者任务交给的组内电脑(组所在电脑视角)。 */
export interface GroupRelayMember {
  memberKey: string;
  agentDeviceId: string;
  /** 那台电脑上这个供应商的 id。 */
  providerId: string;
  /** 同账号电脑：要求它声明 guestRelay(按受邀者隔离)。分享来的电脑本来就把本机当受邀者。 */
  sameAccount: boolean;
}

/** 组里的本机这一台(受邀者的任务直接在本机运行时用来冷却与避开它)。 */
function localGroupMember(providerId: string): GroupRelayMember {
  return { memberKey: PROVIDER_GROUP_LOCAL_MEMBER_KEY, agentDeviceId: '', providerId, sameAccount: false };
}

/** 计入某台组内电脑负载的一个受邀者任务(按它是否正在运行一轮)；任务结束时 release。 */
export interface GroupRelayLoad {
  setRunning(running: boolean): void;
  release(): void;
}

export type GroupRelayPlan =
  /** 组里选中了本机。`load`：要求预占时已计入本机这一台的负载。 */
  | { kind: 'local'; load?: GroupRelayLoad }
  | ({ kind: 'member'; load?: GroupRelayLoad } & GroupRelayMember)
  /** 组里没有能接这个任务的电脑。 */
  | { kind: 'unavailable' };

export interface RemoteAgentGroupRelayDeps {
  /**
   * 受邀者的新任务该交给谁；这个供应商没有组返回 null(照常在本机运行)。`reserve`：选中的同一步就计入那台的负载
   * (返回的 `load`)，同时来的几个任务不会全落到同一台；只是问问有没有能接的电脑时不预占。
   */
  plan(input: {
    kind: RemoteAgentKind;
    model: string;
    providerId: string;
    exclude: ReadonlySet<string>;
    reserve?: boolean;
  }): Promise<GroupRelayPlan | null>;
  /** 经设备互联连某台组内电脑的远程 Agent 通道(与本机作为控制端共用拉取器)。 */
  connect(agentDeviceId: string): { invoke: RemoteAgentInvoke; poller: RemoteAgentPoller };
  /** 那台在启动阶段没能接下任务(连不上、登录失效等)：按组的口径冷却。 */
  noteStartFailure(providerId: string, member: GroupRelayMember, error: unknown): void;
  /**
   * 那台上的任务运行中失败(终态错误，或一轮进行中任务意外结束)：问题出在那台电脑本身时按组的口径冷却它，组设置
   * 允许自动换电脑时返回 true(可以换一台)；用户停止、上下文超限等换到哪台都一样的失败返回 false。
   */
  noteRunFailure(providerId: string, member: GroupRelayMember, failure: RelayRunFailure): boolean;
  /** 计入那台组内电脑的负载(按它是否正在运行一轮)。 */
  trackRun(providerId: string, memberKey: string): GroupRelayLoad;
  /** 删掉受邀者后，请接过它任务的组内电脑清掉留下的会话记录与目录。 */
  forget(agentDeviceId: string, relay: string): Promise<void>;
}

/** 本机作为组所在电脑把受邀者的任务转给组内电脑时的后端(代替本机的 Agent 会话)。 */
interface RelayBackend {
  client: RemoteAgentRunClient;
  member: GroupRelayMember;
  /** 第几次启动尝试(WebSocket 连接编号的前缀)。 */
  attempt: number;
  /** 那台已经开始运行(启动阶段失败才能换下一台)。 */
  started: boolean;
  /** 那台上正在运行一轮(按它报来的状态)。 */
  turnRunning: boolean;
  /** 推帧按任务串行，保证 Codex exec-server 帧的顺序。 */
  pushChain: Promise<void>;
  model?: string;
  load: GroupRelayLoad;
}

interface Upload {
  controller: string;
  chunks: Array<Buffer | undefined>;
  bytes: number;
  touchedAt: number;
}

interface PendingReverse {
  resolve(reply: RemoteAgentReply): void;
  reject(error: Error): void;
}

interface Run {
  id: string;
  controller: string;
  trust: RemoteAgentControllerTrust;
  /** 本机侧任务 id：影子目录按它存放，同一任务多次打开共用。 */
  hostSessionId?: string;
  owner: unknown;
  kind: RemoteAgentKind;
  log: EventLog;
  lastReadAt: number;
  closedAt?: number;
  closing: boolean;
  handle?: AgentSessionHandle;
  tunnel?: RunTunnel;
  attachmentsDir: string;
  /** 影子工作区根(按 hostSessionId 复用，任务收尾后清理)。 */
  workspaceDir?: string;
  virtualRoot?: string;
  pending: Map<string, PendingReverse>;
  calls: Map<string, 'running' | 'done'>;
  pushSeq: Set<number>;
  /** 拼接中的分段 WebSocket 消息(按连接)。 */
  pushParts: Map<string, string>;
  /** 这个任务正在用的本机供应商(已核对开放)；没接供应商授权时为空。 */
  providerId?: string;
  /** 受邀者任务的出站登记，任务结束时撤销。 */
  guestRoute?: GuestProviderRouteBinding;
  usageMeter?: ReturnType<typeof createGuestUsageMeter>;
  lastState?: string;
  stateTimer?: ReturnType<typeof setInterval>;
  /**
   * 组所在电脑替受邀者中转过来的任务(本机是组内电脑)：组所在电脑为这个受邀者取的键。按受邀者隔离，
   * 会话索引、受邀者目录与运行数都按(控制端, relay)分开。
   */
  relayKey?: string;
  /** 本机是组所在电脑、把这个受邀者任务转给了组内电脑。 */
  relay?: RelayBackend;
  /**
   * 本机是组所在电脑、这是受邀者自己的任务(不是被中转来的)，受邀者声明了支持「需要换一台」：在本机或组内电脑上
   * 运行中失败时可以发凭证。
   */
  acceptsGroupSwitch?: boolean;
  /** 本机是组所在电脑、组选中了本机这一台来运行受邀者的任务：计入本机这一台的负载。 */
  groupLoad?: GroupRelayLoad;
  /** 本机 Agent 上一次报来的「正在运行一轮」。 */
  turnRunning?: boolean;
}

/** 控制端真实路径 → 影子目录里逐级镜像的目录名(去掉本机文件系统不允许的字符)。 */
export function mirrorSegments(realPath: string): string[] {
  const parts = realPath.split(/[\\/]+/).filter(Boolean);
  return parts.slice(-(MAX_ANCESTOR_LEVELS + 1)).map((part) => {
    const cleaned = part
      .replace(/^([A-Za-z]):$/, '$1')
      // eslint-disable-next-line no-control-regex -- 控制字符是显式清洗目标
      .replace(/[<>:"|?*\u0000-\u001f]/g, '_')
      .replace(/[. ]+$/, '')
      .slice(0, 64);
    return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : '_';
  });
}

/** 个人权限规则并入项目 local 设置(保留项目里已有的规则)。 */
async function mergeLocalPermissions(
  file: string,
  personal: { allow?: string[]; deny?: string[]; ask?: string[] },
): Promise<void> {
  let current: { permissions?: Record<string, unknown> } = {};
  try {
    current = JSON.parse(await fsp.readFile(file, 'utf8')) as typeof current;
  } catch {
    current = {};
  }
  const merged: Record<string, string[]> = {};
  for (const key of ['allow', 'deny', 'ask'] as const) {
    const existing = Array.isArray(current.permissions?.[key])
      ? (current.permissions![key] as unknown[]).filter((item): item is string => typeof item === 'string')
      : [];
    const rules = [...new Set([...existing, ...(personal[key] ?? [])])];
    if (rules.length) merged[key] = rules;
  }
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify({ permissions: merged }, null, 2));
}

function fail(code: string, message: string): never {
  throw new Error(`[${code}] ${message}`);
}

function failProviderNotAllowed(): never {
  fail('REMOTE_AGENT_PROVIDER_NOT_ALLOWED', 'this provider is not allowed for remote use on this computer');
}

export function remoteAgentErrorInfo(error: unknown): RemoteAgentErrorInfo {
  const err = error instanceof Error ? error : new Error(String(error));
  const rawCode = (err as unknown as { code?: unknown }).code;
  const code = /^\[([A-Z][A-Z0-9_]+)\]/.exec(err.message)?.[1]
    ?? (typeof rawCode === 'string' && rawCode ? rawCode : 'AGENT_ERROR');
  return { code: code.slice(0, 128), message: err.message.slice(0, 2048), name: err.name };
}

/** 本机侧的任务 id：控制端设备 + 控制端任务 id 派生，避免与本机自己的任务撞 id。 */
export function hostSessionIdFor(controller: string, sessionId: string): string {
  const hex = createHash('sha256').update(`${controller}\0${sessionId}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function safeCall<T>(fn: (() => T) | undefined): T | undefined {
  if (!fn) return undefined;
  try {
    return fn();
  } catch {
    return undefined;
  }
}

/** 控制端镜像同步读取的会话状态。 */
export function snapshotHandleState(handle: AgentSessionHandle): Record<string, unknown> {
  const state: Record<string, unknown> = {
    id: handle.id,
    model: handle.model,
    usage: safeCall(() => handle.getUsageSnapshot()),
    turnRunning: safeCall(handle.isTurnRunning?.bind(handle)),
    preparing: safeCall(handle.isPreparingUserTurn?.bind(handle)),
    currentTurnId: safeCall(handle.getCurrentTurnId?.bind(handle)),
    planMode: safeCall(handle.getPlanMode?.bind(handle)),
    executionPlanMode: safeCall(handle.getExecutionPlanMode?.bind(handle)),
    fastMode: safeCall(handle.getFastMode?.bind(handle)),
    effort: safeCall(handle.getEffort?.bind(handle)),
    backgroundTasks: safeCall(handle.listBackgroundTasks?.bind(handle)),
    pendingWake: safeCall(handle.countPendingWakeContinuations?.bind(handle)),
    requestSessionId: handle.requestSessionId,
    codexThreadModelProviderId: handle.codexThreadModelProviderId,
    codexThreadMayHaveRollout: handle.codexThreadMayHaveRollout,
    disabledSkillPaths: handle.disabledSkillPaths,
  };
  for (const key of Object.keys(state)) if (state[key] === undefined) delete state[key];
  return JSON.parse(JSON.stringify(state)) as Record<string, unknown>;
}

/** 启动结果里给控制端的会话描述(静态部分 + 支持哪些可选方法)。 */
function describeHandle(handle: AgentSessionHandle, shadowDir: string, mirrorRoot: string, extraDirs: readonly string[], writableDirs: readonly string[], virtualWorkspace: boolean): Record<string, unknown> {
  const methods = REMOTE_AGENT_METHODS.filter((method) => typeof (handle as unknown as Record<string, unknown>)[method] === 'function');
  return {
    id: handle.id,
    agentKind: handle.agentKind,
    model: handle.model,
    shadowDir,
    mirrorRoot,
    extraDirs,
    writableDirs,
    virtualWorkspace,
    methods,
    ...(handle.requestSessionId ? { requestSessionId: handle.requestSessionId } : {}),
    ...(handle.codexProxyActive !== undefined ? { codexProxyActive: handle.codexProxyActive } : {}),
    ...(handle.codexHostKey ? { codexHostKey: handle.codexHostKey } : {}),
    ...(handle.codexCindyRemoteCompactionCompatible !== undefined
      ? { codexCindyRemoteCompactionCompatible: handle.codexCindyRemoteCompactionCompatible }
      : {}),
    ...(handle.codexProductPromptDelivery ? { codexProductPromptDelivery: handle.codexProductPromptDelivery } : {}),
    state: snapshotHandleState(handle),
  };
}

export function createRemoteAgentHost(deps: RemoteAgentHostDeps) {
  const now = deps.now ?? Date.now;
  const runs = new Map<string, Run>();
  const uploads = new Map<string, Upload>();
  /** 发给受邀者的「需要换一台」凭证 → 发给了谁的哪个任务、重新打开时要避开哪些台。一次性，过期作废。 */
  const groupSwitchTokens = new Map<string, { controller: string; hostSessionId: string; exclude: string[]; expiresAt: number }>();
  /**
   * 受邀者任务这一轮已经因为电脑本身的原因换下来的组内电脑(控制端 + 本机侧任务 id → 那几台)：同一轮每台最多
   * 试一次，都试过就不再发凭证，受邀者照常看到原来的错误。那台上一轮正常结束或 30 分钟没再换算新的一轮。
   */
  const groupSwitchRounds = new Map<string, { tried: Set<string>; at: number }>();
  /** 影子目录重建按 hostSessionId 串行：同一任务的两次打开不并发争用同一个目录。 */
  const shadowLocks = new Map<string, Promise<unknown>>();
  let sweepTimer: ReturnType<typeof setInterval> | null = null;
  const key = (controller: string, id: string) => `${controller}\0${id}`;
  const trustOf = (controller: string): RemoteAgentControllerTrust => deps.controllerTrust?.(controller) ?? 'owner';
  /** 按控制端分开存放的目录名(影子工作区、附件与受邀者目录)。 */
  const controllerDir = (controller: string) => createHash('sha256').update(controller).digest('hex').slice(0, 16);
  /**
   * 受邀者隔离的作用域：一般就是控制端；组所在电脑替受邀者中转过来的任务再按 relay 分开(同一个组所在
   * 电脑替不同受邀者中转，彼此不能接回对方的会话、不共用受邀者目录)。
   */
  const guestScopeOf = (controller: string, relay: string | undefined) =>
    (relay ? `${controller}\0relay:${relay}` : controller);
  /** 受邀者目录：Codex / Pi 的会话历史与 Codex 的运行目录，按作用域跨任务保留，清理时整体删除。 */
  const guestHomeFor = (scope: string) => path.join(deps.runsRoot, 'guest-homes', controllerDir(scope));

  /**
   * 受邀者在本机建立过的会话：恢复与分叉只能接回自己的会话(不能凭 id 接上本机用户自己的
   * 会话)；分享删除时据此清理本机留下的会话记录。落盘，重启后仍然有效。
   */
  interface GuestSessionRecord {
    /** 控制端 key(供应商分享的本地 peer key，含分享与成员，不是秘密)，按成员清理时据此匹配。 */
    controller: string;
    /** 组所在电脑替受邀者中转过来的任务：那个受邀者的 relay 键。 */
    relay?: string;
    hostSessionIds: string[];
    nativeIds: string[];
    /**
     * 本机是组所在电脑、把这个受邀者的任务转给了组内电脑：原生会话 id → 在哪台。续接只能回到那台
     * (会话记录在那里)；那台被移出组后也照样回到那台。
     */
    members?: Record<string, GroupRelayMember>;
    /**
     * 本机是组所在电脑：交过这个受邀者任务的组内电脑(发打开之前先记)。那台在启动 Agent 之前就会建受邀者目录与
     * 会话记录，启动失败、还没有原生会话 id 时也要能在删除受邀者时请它清掉。
     */
    relayDevices?: string[];
    /**
     * 受邀者已删除、本机的数据已清掉，只剩这几台组内电脑还没通知到(当时离线等)：之后每次清理时再试。
     */
    forgetPending?: string[];
  }
  const guestIndexFile = path.join(deps.runsRoot, 'guest-sessions.json');
  const guestDigest = (scope: string) => createHash('sha256').update(scope).digest('hex').slice(0, 32);
  let guestIndex: Promise<Map<string, GuestSessionRecord>> | null = null;
  let guestIndexWrite: Promise<void> = Promise.resolve();

  function readRelayMembers(value: unknown): Record<string, GroupRelayMember> | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const out: Record<string, GroupRelayMember> = {};
    for (const [nativeId, raw] of Object.entries(value as Record<string, unknown>)) {
      const item = raw as Partial<GroupRelayMember> | null;
      if (!item || typeof item.memberKey !== 'string' || typeof item.agentDeviceId !== 'string' || typeof item.providerId !== 'string') continue;
      out[nativeId] = { memberKey: item.memberKey, agentDeviceId: item.agentDeviceId, providerId: item.providerId, sameAccount: item.sameAccount === true };
    }
    return Object.keys(out).length ? out : undefined;
  }

  function loadGuestIndex(): Promise<Map<string, GuestSessionRecord>> {
    guestIndex ??= fsp.readFile(guestIndexFile, 'utf8')
      .then((raw) => {
        const parsed = JSON.parse(raw) as Record<string, Partial<GuestSessionRecord>>;
        const map = new Map<string, GuestSessionRecord>();
        for (const [digest, record] of Object.entries(parsed)) {
          const list = (value: unknown) => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);
          if (typeof record?.controller !== 'string') continue;
          const members = readRelayMembers(record.members);
          const relayDevices = list(record.relayDevices);
          const forgetPending = list(record.forgetPending);
          map.set(digest, {
            controller: record.controller,
            ...(typeof record.relay === 'string' ? { relay: record.relay } : {}),
            hostSessionIds: list(record?.hostSessionIds),
            nativeIds: list(record?.nativeIds),
            ...(members ? { members } : {}),
            ...(relayDevices.length ? { relayDevices } : {}),
            ...(forgetPending.length ? { forgetPending } : {}),
          });
        }
        return map;
      })
      .catch(() => new Map<string, GuestSessionRecord>());
    return guestIndex;
  }

  function persistGuestIndex(map: Map<string, GuestSessionRecord>): Promise<void> {
    guestIndexWrite = guestIndexWrite.then(async () => {
      await fsp.mkdir(deps.runsRoot, { recursive: true });
      const tmp = `${guestIndexFile}.${randomUUID()}.tmp`;
      await fsp.writeFile(tmp, JSON.stringify(Object.fromEntries(map)));
      await fsp.rename(tmp, guestIndexFile);
    }).catch((error) => {
      deps.log?.warn('remote agent guest session index write failed', { error: String(error) });
    });
    return guestIndexWrite;
  }

  async function recordGuestSession(
    controller: string,
    relay: string | undefined,
    hostSessionId: string,
    nativeIds: ReadonlyArray<string | undefined>,
    member?: GroupRelayMember,
  ): Promise<void> {
    const map = await loadGuestIndex();
    const digest = guestDigest(guestScopeOf(controller, relay));
    const record = map.get(digest) ?? { controller, ...(relay ? { relay } : {}), hostSessionIds: [], nativeIds: [] };
    let changed = !map.has(digest) || reviveForgottenRecord(record);
    if (!record.hostSessionIds.includes(hostSessionId)) {
      record.hostSessionIds.push(hostSessionId);
      changed = true;
    }
    for (const id of nativeIds) {
      if (id && !record.nativeIds.includes(id)) {
        record.nativeIds.push(id);
        changed = true;
      }
      if (id && member && record.members?.[id]?.memberKey !== member.memberKey) {
        record.members = { ...record.members, [id]: { ...member } };
        changed = true;
      }
    }
    if (!changed) return;
    map.set(digest, record);
    await persistGuestIndex(map);
  }

  /**
   * 同一个受邀者作用域又用起来了，而上次删除时还有组内电脑没通知到：这些电脑并回「交过任务的电脑」，下次删除时
   * 一起清，不单独再去清(否则会清掉它刚在那台留下的新数据)。返回记录是否有变。
   */
  function reviveForgottenRecord(record: GuestSessionRecord): boolean {
    if (!record.forgetPending?.length) return false;
    record.relayDevices = [...new Set([...(record.relayDevices ?? []), ...record.forgetPending])];
    delete record.forgetPending;
    return true;
  }

  /** 本机是组所在电脑：发打开之前先记下要交给哪台组内电脑(见 GuestSessionRecord.relayDevices)。 */
  async function recordRelayDevice(controller: string, hostSessionId: string, agentDeviceId: string): Promise<void> {
    const map = await loadGuestIndex();
    const digest = guestDigest(controller);
    const record = map.get(digest) ?? { controller, hostSessionIds: [], nativeIds: [] };
    let changed = !map.has(digest) || reviveForgottenRecord(record);
    if (!record.hostSessionIds.includes(hostSessionId)) {
      record.hostSessionIds.push(hostSessionId);
      changed = true;
    }
    if (!record.relayDevices?.includes(agentDeviceId)) {
      record.relayDevices = [...(record.relayDevices ?? []), agentDeviceId];
      changed = true;
    }
    if (!changed) return;
    map.set(digest, record);
    await persistGuestIndex(map);
  }

  async function guestOwnsSession(controller: string, relay: string | undefined, nativeId: string): Promise<boolean> {
    const map = await loadGuestIndex();
    return map.get(guestDigest(guestScopeOf(controller, relay)))?.nativeIds.includes(nativeId) ?? false;
  }

  /** 组所在电脑：受邀者的这个会话当初转给了哪台组内电脑；在本机运行的返回 null。 */
  async function relayMemberOf(controller: string, nativeId: string): Promise<GroupRelayMember | null> {
    const map = await loadGuestIndex();
    return map.get(guestDigest(controller))?.members?.[nativeId] ?? null;
  }

  function withShadowLock<T>(hostSessionId: string, fn: () => Promise<T>): Promise<T> {
    const prev = shadowLocks.get(hostSessionId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    shadowLocks.set(hostSessionId, next.then(() => undefined, () => undefined));
    return next;
  }

  function ensureSweep(): void {
    if (sweepTimer) return;
    sweepTimer = setInterval(sweep, SWEEP_INTERVAL_MS);
    (sweepTimer as { unref?: () => void }).unref?.();
  }

  function stopSweepIfIdle(): void {
    if (sweepTimer && runs.size === 0 && uploads.size === 0) {
      clearInterval(sweepTimer);
      sweepTimer = null;
    }
  }

  function sweep(): void {
    const t = now();
    for (const [uploadKey, upload] of uploads) {
      if (t - upload.touchedAt > UPLOAD_IDLE_MS) uploads.delete(uploadKey);
    }
    for (const run of runs.values()) {
      if (run.closedAt !== undefined) {
        if (t - run.closedAt > REMOTE_AGENT_HOST_RETAIN_MS) void disposeRun(run);
        continue;
      }
      if (!deps.isControllerAuthorized(run.controller)) {
        void finishRun(run, 'access-revoked', 'navigation');
      } else if (!deps.isOwnerCurrent(run.owner)) {
        void finishRun(run, 'account-changed', 'account-boundary');
      } else if (t - run.lastReadAt > REMOTE_AGENT_HOST_IDLE_MS) {
        void finishRun(run, 'controller-gone', 'navigation');
      }
    }
    stopSweepIfIdle();
  }

  function stagedBytes(controller: string): number {
    let total = 0;
    for (const upload of uploads.values()) if (upload.controller === controller) total += upload.bytes;
    return total;
  }

  async function resolvePayload(controller: string, payload: RemoteAgentPayload): Promise<unknown> {
    if ('json' in payload) return payload.json;
    const uploadKey = key(controller, payload.uploadId);
    const upload = uploads.get(uploadKey);
    if (!upload || upload.chunks.length !== payload.chunks) fail('REMOTE_AGENT_EXPIRED', 'upload is missing or expired');
    for (let index = 0; index < payload.chunks; index += 1) {
      if (!upload.chunks[index]) fail('REMOTE_AGENT_EXPIRED', 'upload is incomplete');
    }
    const gz = Buffer.concat(upload.chunks as Buffer[]);
    if (gz.length !== payload.bytes) fail('REMOTE_AGENT_INVALID', 'upload size mismatch');
    uploads.delete(uploadKey);
    const raw = await gunzipAsync(gz, { maxOutputLength: MAX_DECOMPRESSED_BYTES });
    return JSON.parse(raw.toString('utf8')) as unknown;
  }

  /**
   * 去重路径上的载荷丢弃：重复 / 过期 op 的上传载荷若不取走，会一直占着暂存配额到过期，
   * 歧义交付下反复重试的大载荷会把无关上传挡在门外。
   */
  function discardPayload(controller: string, payload: RemoteAgentPayload): void {
    if ('json' in payload) return;
    uploads.delete(key(controller, payload.uploadId));
    stopSweepIfIdle();
  }

  function append(run: Run, item: unknown): void {
    if (run.log.append(item)) return;
    if (!run.closing) {
      deps.log?.warn('remote agent event log overflow; ending run', { runId: run.id });
      void finishRun(run, 'overflow', 'navigation');
    }
  }

  function emitState(run: Run): void {
    if (!run.handle || run.closing) return;
    const state = snapshotHandleState(run.handle);
    if (typeof state.turnRunning === 'boolean') {
      run.turnRunning = state.turnRunning;
      run.groupLoad?.setRunning(state.turnRunning);
    }
    const serialized = JSON.stringify(state);
    if (serialized === run.lastState) return;
    run.lastState = serialized;
    append(run, { t: 'state', state });
    // 会话 id 可能在任务中途换新(清空上下文等)，受邀者能恢复的会话随之登记。
    if (run.trust === 'guest' && run.hostSessionId) {
      void recordGuestSession(run.controller, run.relayKey, run.hostSessionId, [
        typeof state.id === 'string' ? state.id : undefined,
        typeof state.requestSessionId === 'string' ? state.requestSessionId : undefined,
      ]);
    }
  }

  /** 经事件流向控制端发一个反向请求，等它回包；signal 中止时通知控制端放弃执行。 */
  function reverse(run: Run, request: RemoteAgentReverseRequest, signal?: AbortSignal): Promise<RemoteAgentReply> {
    if (run.closing) return Promise.reject(new Error('[REMOTE_AGENT_EXPIRED] task has ended'));
    if (signal?.aborted) return Promise.reject(new Error('aborted'));
    const requestId = randomUUID();
    return new Promise<RemoteAgentReply>((resolve, reject) => {
      const onAbort = () => {
        if (!run.pending.delete(requestId)) return;
        append(run, { t: 'cancel', requestId });
        reject(new Error('aborted'));
      };
      run.pending.set(requestId, {
        resolve: (reply) => {
          signal?.removeEventListener('abort', onAbort);
          resolve(reply);
        },
        reject: (error) => {
          signal?.removeEventListener('abort', onAbort);
          reject(error);
        },
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      append(run, { t: 'request', requestId, request });
    });
  }

  async function reverseHttp(run: Run, request: TunnelHttpRequest, signal: AbortSignal): Promise<TunnelHttpResponse> {
    const reply = await reverse(run, {
      type: 'http',
      method: request.method,
      path: request.path,
      headers: request.headers,
      ...(request.body ? { body: request.body.toString('base64') } : {}),
    }, signal);
    if (reply.type === 'http') {
      return {
        status: reply.status,
        headers: reply.headers,
        ...(reply.body ? { body: Buffer.from(reply.body, 'base64') } : {}),
      };
    }
    if (reply.type === 'error') {
      return {
        status: 502,
        headers: [['content-type', 'application/json']],
        body: Buffer.from(JSON.stringify({ error: reply.error })),
      };
    }
    return { status: 502, headers: [] };
  }

  async function writeAttachment(run: Run, data: Buffer, ext: string): Promise<string> {
    await fsp.mkdir(run.attachmentsDir, { recursive: true });
    const file = path.join(run.attachmentsDir, `${createHash('sha256').update(data).digest('hex').slice(0, 24)}.${ext}`);
    await fsp.writeFile(file, data);
    return file;
  }

  /** 影子工作目录根：`<会话根>/fs/<控制端镜像>` 的上级，按控制端 + 本机侧任务 id 定址。 */
  function shadowSessionRoot(controller: string, hostSessionId: string): string {
    return path.join(deps.runsRoot, 'workspaces', controllerDir(controller), hostSessionId);
  }

  /**
   * 影子目录：`<会话根>/fs/<控制端真实路径逐级镜像>`。逐级镜像让上级目录里的说明文件落在对应的
   * 上级目录，Agent 照本机方式沿目录向上加载；路径对同一任务固定(恢复会话依赖工作目录不变)。
   * 个人说明放在会话根(最外层，最先加载、优先级最低)。每次打开都按控制端当前内容重建。
   */
  async function prepareShadow(
    controller: string,
    payload: RemoteAgentOpenPayload,
    hostSessionId: string,
    trust: RemoteAgentControllerTrust,
  ): Promise<{ shadowDir: string; mirrorRoot: string; sessionRoot: string; extraDirs: string[]; writableDirs: string[]; projectText(text: string): string }> {
    const sessionRoot = shadowSessionRoot(controller, hostSessionId);
    /** 受邀者的说明文件：指向会话目录之外的 `@` 引用不再被当作导入(否则会在本机读文件)。 */
    const instructionBytes = (data: Buffer, fileDir: string): Buffer => (
      trust === 'guest'
        ? Buffer.from(neutralizeExternalImports(data.toString('utf8'), fileDir, sessionRoot), 'utf8')
        : data
    );
    // 受邀者的 Markdown(与导入的纯文本)一律按说明文件处理：命令、子代理、规则里的 `@文件` 同样会被 Claude Code 读进上下文，
    // 指向会话目录之外(本机用户的文件)的引用要断开。
    const markdownBytes = (data: Buffer, file: string): Buffer => (
      /\.(?:md|markdown|txt)$/i.test(file) ? instructionBytes(data, path.dirname(file)) : data
    );
    const mirrorRoot = path.join(sessionRoot, 'fs');
    // 固定短层级承载最多 MAX_ANCESTOR_LEVELS 个上级说明文件，不带控制端目录名。
    const segments = payload.virtualWorkspace
      ? ['workspace', ...Array.from({ length: MAX_ANCESTOR_LEVELS }, () => 'p')]
      : mirrorSegments(payload.workspace.workingDir);
    const shadowDir = path.join(mirrorRoot, ...segments);
    await fsp.rm(sessionRoot, { recursive: true, force: true });
    await fsp.mkdir(shadowDir, { recursive: true });
    if (payload.virtualWorkspace) await Promise.all(['home', 'tmp'].map((name) => fsp.mkdir(path.join(mirrorRoot, name), { recursive: true })));
    const foreignPath = payload.workspace.platform === 'win32' ? path.win32 : path.posix;
    const realWorkspace = foreignPath.resolve(payload.workspace.workingDir);
    const virtualByReal = new Map<string, string>();
    const virtualFor = (raw: string, index: number): string => {
      const resolved = foreignPath.resolve(raw);
      const key = payload.workspace.platform === 'win32' ? resolved.toLowerCase() : resolved;
      const existing = virtualByReal.get(key);
      if (existing) return existing;
      const relative = foreignPath.relative(realWorkspace, resolved);
      const insideWorkspace = relative === '' || (!relative.startsWith('..') && !foreignPath.isAbsolute(relative));
      const virtual = insideWorkspace
        ? path.join(shadowDir, ...relative.split(/[\\/]+/).filter(Boolean))
        : path.join(mirrorRoot, 'additional', 'dir-' + index);
      virtualByReal.set(key, virtual);
      return virtual;
    };
    const virtualAll = [...payload.workspace.extraDirs, ...payload.workspace.writableDirs]
      .map((dir, index) => payload.virtualWorkspace ? virtualFor(dir, index) : dir);
    if (payload.virtualWorkspace) await Promise.all([...new Set(virtualAll)].map((dir) => fsp.mkdir(dir, { recursive: true })));
    const extraCount = payload.workspace.extraDirs.length;
    const pathAliases = [{ from: payload.workspace.workingDir, to: shadowDir }];
    if (payload.virtualWorkspace && payload.workspace.homeDir) {
      pathAliases.push({ from: payload.workspace.homeDir, to: path.join(mirrorRoot, 'home') });
    }
    let realParent = payload.workspace.workingDir;
    let virtualParent = shadowDir;
    for (let up = 1; up <= MAX_ANCESTOR_LEVELS; up += 1) {
      const nextReal = foreignPath.dirname(realParent);
      if (nextReal === realParent) break;
      realParent = nextReal;
      virtualParent = path.dirname(virtualParent);
      pathAliases.push({ from: realParent, to: virtualParent });
    }
    [...payload.workspace.extraDirs, ...payload.workspace.writableDirs].forEach((from, index) => {
      pathAliases.push({ from, to: virtualAll[index] });
    });
    const projectText = (text: string) => payload.virtualWorkspace ? projectPathText(text, pathAliases) : text;
    const projectBytes = (data: Buffer): Buffer => {
      // Skill 目录允许随包携带非文本资源；只投影有效的文本字节，避免 UTF-8 转换损坏二进制。
      if (!payload.virtualWorkspace || data.includes(0)) return data;
      const text = data.toString('utf8');
      if (!Buffer.from(text, 'utf8').equals(data)) return data;
      const projected = projectText(text);
      return projected === text ? data : Buffer.from(projected, 'utf8');
    };
    const inside = (target: string, root: string) => target.startsWith(`${root}${path.sep}`);
    const writeNew = async (target: string, data: Buffer) => {
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, data, { flag: 'wx' }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
      });
    };
    for (const file of payload.projectFiles) {
      const target = path.join(shadowDir, ...file.path.split('/'));
      if (!inside(target, shadowDir)) continue;
      await fsp.mkdir(path.dirname(target), { recursive: true });
      const data = projectBytes(Buffer.from(file.data, 'base64'));
      const isInstruction = (PROJECT_INSTRUCTION_FILES as readonly string[]).includes(file.path);
      await fsp.writeFile(target, isInstruction ? instructionBytes(data, path.dirname(target)) : markdownBytes(data, target));
    }
    for (const file of payload.ancestorFiles) {
      if (file.up > segments.length - 1) continue;
      let dir = shadowDir;
      for (let level = 0; level < file.up; level += 1) dir = path.dirname(dir);
      if (!inside(dir, mirrorRoot)) continue;
      await writeNew(path.join(dir, file.name), instructionBytes(projectBytes(Buffer.from(file.data, 'base64')), dir));
    }
    const { personal } = payload;
    if (personal.memory) {
      await writeNew(path.join(sessionRoot, 'CLAUDE.md'), instructionBytes(Buffer.from(projectText(personal.memory), 'utf8'), sessionRoot));
    }
    // 项目里已有同名文件时以项目为准(只写不存在的)。
    for (const file of personal.files) {
      const target = path.join(shadowDir, ...file.path.split('/'));
      if (!inside(target, shadowDir)) continue;
      await writeNew(target, markdownBytes(projectBytes(Buffer.from(file.data, 'base64')), target));
    }
    // 说明文件里 `@` 导入的文件：workspace 相对影子目录(可落在上级目录的镜像里)，session 相对会话目录
    // (个人说明旁边，不进虚拟工作区)。已有同名文件的不覆盖。
    for (const file of payload.importFiles ?? []) {
      const base = file.base === 'workspace' ? shadowDir : sessionRoot;
      const target = path.resolve(base, ...file.path.split('/'));
      const allowed = file.base === 'workspace'
        ? inside(target, mirrorRoot)
        : inside(target, sessionRoot) && target !== mirrorRoot && !inside(target, mirrorRoot);
      if (!allowed) continue;
      await writeNew(target, markdownBytes(projectBytes(Buffer.from(file.data, 'base64')), target));
    }
    if (personal.permissions) await mergeLocalPermissions(path.join(shadowDir, '.claude', 'settings.local.json'), Object.fromEntries(Object.entries(personal.permissions).map(([key, rules]) => [key, rules?.map(projectText)])));
    return { shadowDir, mirrorRoot, sessionRoot, extraDirs: virtualAll.slice(0, extraCount), writableDirs: virtualAll.slice(extraCount), projectText };
  }

  async function startRun(run: Run, payload: RemoteAgentOpenPayload): Promise<void> {
    try {
      // 中转过来的任务按(控制端, relay)派生：不同受邀者即使任务 id 相同也不会共用本机侧任务。
      const hostSessionId = hostSessionIdFor(guestScopeOf(run.controller, run.relayKey), payload.sessionId);
      run.hostSessionId = hostSessionId;
      let guestHome: string | undefined;
      if (run.trust === 'guest') {
        // 先登记再启动：启动中途失败时，受邀者目录与会话记录也能在分享删除时被找到并清理。
        await recordGuestSession(run.controller, run.relayKey, hostSessionId, []);
        guestHome = guestHomeFor(guestScopeOf(run.controller, run.relayKey));
        await fsp.mkdir(guestHome, { recursive: true, mode: 0o700 });
      }
      const { shadowDir, mirrorRoot, sessionRoot, extraDirs, writableDirs, projectText } = await withShadowLock(hostSessionId, async () => {
        // 断线后旧实例还没清理就重新打开同一任务时，新旧实例共用同一个影子目录：
        // 先结束旧实例再重建，避免删掉旧 Agent 还在使用的目录，或两个实例争用重建后的目录。
        for (const other of runs.values()) {
          if (other !== run && other.controller === run.controller && other.hostSessionId === hostSessionId && !other.closing) {
            await finishRun(other, 'superseded', 'navigation');
          }
        }
        return prepareShadow(run.controller, payload, hostSessionId, run.trust);
      });
      run.workspaceDir = sessionRoot;
      run.virtualRoot = payload.virtualWorkspace ? mirrorRoot : undefined;
      const tunnel = await createRunTunnel({
        http: (request, signal) => reverseHttp(run, request, signal),
        wsOpen: (connId, wsPath) => append(run, { t: 'ws', connId, kind: 'open', path: wsPath }),
        wsMessage: (connId, data) => append(run, { t: 'ws', connId, kind: 'message', data }),
        wsClose: (connId) => append(run, { t: 'ws', connId, kind: 'close' }),
      });
      run.tunnel = tunnel;
      if (run.closing) return;
      // 必须先发布映射，再启动 Agent。Codex startSession 会在 started 之前读取 exec-server 环境。
      if (payload.virtualWorkspace) append(run, { t: 'state', state: {
        workspaceProjection: { shadowDir, mirrorRoot, extraDirs, writableDirs, virtualWorkspace: true },
      } });
      // 受邀者：先登记出站边界(本机 proxy 只让这条任务经分享的供应商出站)，再启动 Agent。
      let guestProvider: HostedStartInput['guestProvider'];
      if (run.trust === 'guest') {
        if (!deps.bindGuestProviderRoute || !run.providerId) failProviderNotAllowed();
        const binding = await deps.bindGuestProviderRoute({
          kind: run.kind,
          hostSessionId,
          providerId: run.providerId,
          isCurrent: () => !run.closing,
        });
        if (!binding) {
          if (!run.closing) failProviderNotAllowed();
          return;
        }
        run.guestRoute = binding;
        if (run.closing) {
          binding.release();
          return;
        }
        guestProvider = { providerId: run.providerId, modelIds: [...binding.modelIds], routeToken: binding.routeToken };
      }
      const handle = await deps.startHosted({
        kind: run.kind,
        hostSessionId,
        shadowDir,
        mirrorRoot,
        extraDirs,
        writableDirs,
        virtualWorkspace: payload.virtualWorkspace === true,
        ...(payload.personal.instructions ? { personalInstructions: projectText(payload.personal.instructions) } : {}),
        options: Object.fromEntries(Object.entries(payload.options).map(([key, value]) => [key, typeof value === 'string' ? projectText(value) : value])) as unknown as RemoteAgentWireStartOptions,
        workspace: payload.workspace,
        tunnel: { url: tunnel.url, token: tunnel.token, linkActivity: () => tunnel.linkActivity() },
        mcpServers: payload.mcpServers,
        ...(run.trust === 'guest' ? { guest: true, ...(guestHome ? { guestHome } : {}), ...(guestProvider ? { guestProvider } : {}) } : {}),
        ...(payload.options.invalidResumeCallback
          ? {
              onInvalidResumeSession: async (expected: string) => {
                const reply = await reverse(run, { type: 'callback', name: 'onInvalidResumeSession', args: [expected] });
                return reply.type === 'callback' && reply.value === true;
              },
            }
          : {}),
      });
      if (run.closing) {
        await handle.close({ reason: 'navigation' }).catch(() => undefined);
        return;
      }
      run.handle = handle;
      if (run.trust === 'guest') await recordGuestSession(run.controller, run.relayKey, hostSessionId, [handle.id, handle.requestSessionId]);
      handle.setInteractionResolver(async (request: InteractionRequest) => {
        const reply = await reverse(run, { type: 'interaction', request });
        if (reply.type === 'interaction') return reply.result as Awaited<ReturnType<Parameters<AgentSessionHandle['setInteractionResolver']>[0]>>;
        throw new Error(reply.type === 'error' ? reply.error.message : 'interaction failed');
      });
      append(run, { t: 'started', handle: describeHandle(handle, shadowDir, mirrorRoot, extraDirs, writableDirs, payload.virtualWorkspace === true) });
      run.lastState = JSON.stringify(snapshotHandleState(handle));
      run.stateTimer = setInterval(() => emitState(run), STATE_INTERVAL_MS);
      (run.stateTimer as { unref?: () => void }).unref?.();
      void pumpEvents(run, handle);
    } catch (error) {
      append(run, { t: 'start-failed', error: remoteAgentErrorInfo(error) });
      await finishRun(run, 'start-failed', 'navigation', false);
    }
  }

  async function pumpEvents(run: Run, handle: AgentSessionHandle): Promise<void> {
    /** 供应商组：本机这一台上这一轮出过终态错误。 */
    let groupTurnFailed = false;
    let lastEventType: string | undefined;
    let streamError: unknown;
    let streamFailed = false;
    try {
      for await (const event of handle.events()) {
        if (run.closing) break;
        lastEventType = event.type;
        if (run.trust === 'guest') meterGuestUsage(run, handle.model, event);
        if (run.acceptsGroupSwitch) {
          // 受邀者的任务按组分到了本机这一台：本机运行中失败时同样可以换一台(凭证排在错误前面)。
          const failure = relayRunFailureOf(event);
          if (failure) {
            groupTurnFailed = true;
            const token = await groupSwitchOfferFor(run, localGroupMember(run.providerId!), failure, handle.model)
              .catch(() => null);
            if (run.closing) break;
            if (token) append(run, { t: 'state', state: { [GROUP_SWITCH_STATE_KEY]: token } });
          } else if (event.type === 'done') {
            noteGroupSwitchTurnEnded(run, groupTurnFailed);
            groupTurnFailed = false;
          }
        }
        append(run, { t: 'event', event });
        emitState(run);
      }
    } catch (error) {
      streamFailed = true;
      streamError = error;
    }
    // 受邀者的任务按组分到了本机这一台、一轮进行中本机的 Agent 意外结束(进程退出、事件流中断)：与组内电脑上的
    // 任务意外结束一样可以换一台——凭证排在收尾前面，收尾按出错处理，受邀者那边才会把这一轮当作失败。
    const midTurn = run.turnRunning === true && lastEventType !== 'done';
    if (run.acceptsGroupSwitch && !run.closing && midTurn && !groupTurnFailed) {
      const info = streamFailed ? remoteAgentErrorInfo(streamError) : RELAY_UNAVAILABLE_ERROR;
      const token = await groupSwitchOfferFor(run, localGroupMember(run.providerId!), {
        reason: 'remote_agent_closed',
        message: info.message,
      }, handle.model).catch(() => null);
      if (!run.closing) {
        if (token) append(run, { t: 'state', state: { [GROUP_SWITCH_STATE_KEY]: token } });
        append(run, { t: 'closed', reason: 'error', error: info });
        await finishRun(run, 'error', 'navigation', false, true);
        return;
      }
    }
    if (streamFailed) {
      append(run, { t: 'closed', reason: 'error', error: remoteAgentErrorInfo(streamError) });
      await finishRun(run, 'error', 'navigation', false, true);
      return;
    }
    await finishRun(run, 'ended', 'navigation', false);
  }

  function meterGuestUsage(run: Run, model: string | undefined, event: AgentEvent): void {
    if (!deps.recordGuestUsage || event.type !== 'done') return;
    run.usageMeter ??= createGuestUsageMeter(run.kind);
    try {
      const samples = run.usageMeter.observe(event, model ?? '');
      if (samples.length > 0) deps.recordGuestUsage(run.controller, { kind: run.kind, providerId: run.providerId ?? null, samples });
    } catch (error) {
      deps.log?.warn('remote agent guest usage record failed', { runId: run.id, error: String(error) });
    }
  }

  // ─── 供应商组：本机是组所在电脑，把受邀者的任务转给组内电脑 ─────────────────

  /** 转给组内电脑的打开载荷：已按受邀者复核过；来源换成那台上的供应商，带防转圈标记与受邀者的 relay 键。 */
  function relayedOpenPayload(run: Run, payload: RemoteAgentOpenPayload, member: GroupRelayMember): RemoteAgentOpenPayload {
    // 「需要换一台」只在受邀者与本机之间：组内电脑不认识也不需要。
    const { acceptsGroupSwitch: _accepts, groupSwitchToken: _token, ...rest } = payload;
    return {
      ...rest,
      sessionId: relaySessionIdFor(run.controller, payload.sessionId),
      groupAssigned: true,
      relay: relayKeyFor(run.controller),
      options: { ...payload.options, providerId: member.providerId },
    };
  }

  /** 这个受邀者任务这一轮换下来的组内电脑，记上刚出问题的这台，返回要避开的全部。 */
  function noteGroupSwitchTried(run: Run, failed: GroupRelayMember): Set<string> {
    const at = now();
    for (const [roundKey, round] of groupSwitchRounds) {
      if (at - round.at > GROUP_SWITCH_ROUND_MS) groupSwitchRounds.delete(roundKey);
    }
    const roundKey = key(run.controller, run.hostSessionId!);
    const round = groupSwitchRounds.get(roundKey) ?? { tried: new Set<string>(), at };
    round.tried.add(failed.memberKey);
    round.at = at;
    groupSwitchRounds.set(roundKey, round);
    return new Set(round.tried);
  }

  /**
   * 受邀者任务在组内电脑(含本机这一台)上运行中失败：问题出在那台时按组的口径冷却它；受邀者声明了支持、组里还有
   * 能接的电脑(这一轮换下来的不算)时返回一张「需要换一台」凭证，调用方把它排在那次错误前面送出。
   */
  async function groupSwitchOfferFor(
    run: Run,
    member: GroupRelayMember,
    failure: RelayRunFailure,
    model: string,
  ): Promise<string | null> {
    const relayDeps = deps.groupRelay;
    if (!relayDeps || !run.providerId || !run.hostSessionId) return null;
    if (!relayDeps.noteRunFailure(run.providerId, member, failure)) return null;
    // 旧版受邀者不认识这个状态：照旧只转出原来的错误。
    if (!run.acceptsGroupSwitch) return null;
    const exclude = noteGroupSwitchTried(run, member);
    const next = await relayDeps.plan({ kind: run.kind, model, providerId: run.providerId, exclude }).catch(() => null);
    const canMove = next?.kind === 'member' || (next?.kind === 'local' && deps.isAgentAvailable(run.kind));
    if (!canMove || run.closing) return null;
    deps.log?.info('remote agent: offered the shared user another computer in the provider group', {
      runId: run.id,
      from: member.memberKey,
      tried: exclude.size,
    });
    return issueGroupSwitchToken(run, exclude);
  }

  /**
   * 受邀者亲自接手(发消息、重试、换模型)后的这次发送：这个任务这一轮已经换下来的电脑清零(§6.1「一轮的边界」)，
   * 之前因故换下、现在已恢复的电脑又能接手。标记只在本机读，去掉后再交给 Agent 或转给组内电脑。
   */
  function takeGroupNewRound(run: Run, method: RemoteAgentMethod, args: unknown[]): unknown[] {
    const opts = args[1];
    if (method !== 'send' || !opts || typeof opts !== 'object' || Array.isArray(opts) || !('groupNewRound' in opts)) return args;
    const { groupNewRound, ...rest } = opts as Record<string, unknown>;
    if (groupNewRound === true && run.hostSessionId) groupSwitchRounds.delete(key(run.controller, run.hostSessionId));
    return [args[0], rest, ...args.slice(2)];
  }

  /** 那台上一轮的结果：正常结束则这个任务的换电脑记录重新从头算。 */
  function noteGroupSwitchTurnEnded(run: Run, failed: boolean): void {
    if (!failed && run.hostSessionId) groupSwitchRounds.delete(key(run.controller, run.hostSessionId));
  }

  /** 发一张「需要换一台」凭证：只认发给的这个受邀者的这个任务，过期作废。 */
  function issueGroupSwitchToken(run: Run, exclude: ReadonlySet<string>): string {
    const at = now();
    for (const [token, entry] of groupSwitchTokens) {
      if (entry.expiresAt <= at) groupSwitchTokens.delete(token);
    }
    const token = newGroupSwitchToken();
    groupSwitchTokens.set(token, {
      controller: run.controller,
      hostSessionId: run.hostSessionId!,
      exclude: [...exclude],
      expiresAt: at + GROUP_SWITCH_TOKEN_TTL_MS,
    });
    return token;
  }

  /** 受邀者交接后重新打开时带回的凭证：有效则用掉，返回要避开的那几台；无效(别人的、过期、用过)返回空。 */
  function takeGroupSwitchToken(controller: string, hostSessionId: string, token: string | undefined): string[] {
    if (!token) return [];
    const entry = groupSwitchTokens.get(token);
    if (!entry || entry.controller !== controller || entry.hostSessionId !== hostSessionId) return [];
    groupSwitchTokens.delete(token);
    return entry.expiresAt > now() ? entry.exclude : [];
  }

  /**
   * 启动中转任务。全新任务在那台没接下(还没开始运行)时换组里下一台，受邀者无感；每台最多试一次，组里能接的
   * 都试过才报错(组的电脑数不设上限)。续接只能回到原来那台。组里选回本机时改在本机运行。
   */
  async function startRelay(
    run: Run,
    payload: RemoteAgentOpenPayload,
    first: GroupRelayMember,
    /**
     * `avoid`：「需要换一台」后重新打开时，这一轮已经换下来的组内电脑，启动阶段换台也不回到它们。
     * `load`：选第一台时已经预占的负载。
     */
    options: { fresh: boolean; avoid?: readonly string[]; load?: GroupRelayLoad },
  ): Promise<void> {
    const relayDeps = deps.groupRelay!;
    const groupProviderId = run.providerId!;
    const tried = new Set<string>(options.avoid ?? []);
    let member: GroupRelayMember | null = first;
    /** 选这台时已经计入它的负载(没有则开始这一次尝试时再计)。 */
    let reserved: GroupRelayLoad | undefined = options.load;
    let lastError: unknown = null;
    // 换下来的都记进 tried、不会再选到，组里选不出新的就停。
    for (let attempt = 1; member && !run.closing; attempt += 1) {
      const current: GroupRelayMember = member;
      member = null;
      const connection = relayDeps.connect(current.agentDeviceId);
      const load = reserved ?? relayDeps.trackRun(groupProviderId, current.memberKey);
      reserved = undefined;
      const backend: RelayBackend = {
        client: undefined as unknown as RemoteAgentRunClient,
        member: current,
        attempt,
        started: false,
        turnRunning: false,
        pushChain: Promise.resolve(),
        load,
      };
      const wsOpened = new Set<string>();
      // 「需要换一台」(§6.1 分享的人)：那台运行中失败时先问组里还有没有能接的电脑，期间那台转来的后续内容
      // 按原顺序暂存，凭证排在错误前面送达；受邀者那边据此自动交接后重新打开。
      let held: Array<() => void> | null = null;
      const emit = (deliver: () => void) => {
        if (held) held.push(deliver);
        else deliver();
      };
      /** 这一轮在那台出过终态错误(这一轮结束时不算「正常结束」)。 */
      let turnFailed = false;
      /** 失败时先(异步)判定要不要发凭证，期间那台转来的内容暂存，凭证排在错误前面。 */
      const holdForGroupSwitch = (failure: RelayRunFailure, deliver: () => void): void => {
        const queue: Array<() => void> = [deliver];
        held = queue;
        void groupSwitchOfferFor(run, current, failure, backend.model ?? payload.options.model)
          .catch(() => null)
          .then((token) => {
            if (token && !run.closing && run.relay === backend) {
              append(run, { t: 'state', state: { [GROUP_SWITCH_STATE_KEY]: token } });
            }
          })
          .finally(() => {
            held = null;
            for (const fn of queue) fn();
          });
      };
      /** 那台上的任务开始运行之后结束了：这个任务也结束。 */
      const relayClosed = (reason: string, error?: RemoteAgentErrorInfo) => {
        const finish = () => {
          if (run.closing) return;
          run.log.append({ t: 'closed', reason, ...(error ? { error: relayErrorForGuest(error) } : {}) });
          void finishRun(run, reason, 'navigation', false, true);
        };
        // 一轮进行中那台的任务意外结束(离线、崩溃等)：与终态错误一样可以换一台。
        const unexpected = backend.turnRunning && !NORMAL_RELAY_CLOSE_REASONS.has(reason);
        if (unexpected && !held) {
          holdForGroupSwitch({ reason: 'remote_agent_closed', ...(error?.message ? { message: error.message } : {}) }, finish);
          return;
        }
        emit(finish);
      };
      /**
       * 还没报启动成功那台就结束了：同一次拉取可能同时带回启动与结束(很快结束的任务)，先记下，打开返回后再按
       * 运行中结束处理；启动失败时由下面的 catch 处理(可能换下一台)。
       */
      let closedEarly: { reason: string; error?: RemoteAgentErrorInfo } | null = null;
      /** 打开已经发出(那台可能已经建了目录、启动了 Agent)。 */
      let openSent = false;
      backend.client = new RemoteAgentRunClient(randomUUID(), connection.poller, {
        onEvent: (event) => {
          if (run.closing || run.relay !== backend) return;
          meterGuestUsage(run, backend.model, event as AgentEvent);
          const deliver = () => {
            if (!run.closing) append(run, { t: 'event', event });
          };
          const failure = relayRunFailureOf(event);
          if (failure) {
            turnFailed = true;
            if (!held) {
              holdForGroupSwitch(failure, deliver);
              return;
            }
          }
          if ((event as { type?: unknown }).type === 'done') {
            noteGroupSwitchTurnEnded(run, turnFailed);
            turnFailed = false;
          }
          emit(deliver);
        },
        onState: (state) => {
          if (run.closing || run.relay !== backend) return;
          const projection = state.workspaceProjection as { mirrorRoot?: unknown } | undefined;
          if (typeof projection?.mirrorRoot === 'string') run.virtualRoot = projection.mirrorRoot;
          if (typeof state.model === 'string') backend.model = state.model;
          if (typeof state.turnRunning === 'boolean') {
            backend.turnRunning = state.turnRunning;
            backend.load.setRunning(state.turnRunning);
          }
          if (run.hostSessionId) {
            void recordGuestSession(run.controller, undefined, run.hostSessionId, [
              typeof state.id === 'string' ? state.id : undefined,
              typeof state.requestSessionId === 'string' ? state.requestSessionId : undefined,
            ], current);
          }
          // 组内电脑不能替本机发凭证。
          const { [GROUP_SWITCH_STATE_KEY]: _forged, ...forwarded } = state;
          emit(() => {
            if (!run.closing) append(run, { t: 'state', state: forwarded });
          });
        },
        onRequest: (request, signal) => reverse(run, request, signal),
        onWs: (item) => {
          if (run.closing || run.relay !== backend) return;
          const connId = relayConnId(attempt, item.connId);
          if (item.kind === 'open') wsOpened.add(connId);
          emit(() => {
            if (!run.closing) append(run, { ...item, connId });
          });
        },
        onClosed: (reason, error) => {
          if (run.relay !== backend || run.closing) return;
          if (!backend.started) {
            closedEarly = { reason, ...(error ? { error } : {}) };
            return;
          }
          relayClosed(reason, error);
        },
      }, randomUUID, deps.log);
      run.relay = backend;
      try {
        const caps = await RemoteAgentRunClient.caps(connection.invoke);
        if (caps.virtualWorkspace !== true || (current.sameAccount && caps.guestRelay !== true)) {
          throw new Error('[REMOTE_AGENT_PEER_TOO_OLD] the computer in the provider group cannot take shared tasks yet');
        }
        // 等 caps 期间任务已经结束(撤权、受邀者关闭)：不再打开(收尾已经放掉了这次尝试的负载)。
        if (run.closing) return;
        // 发打开之前先记下这台：它在启动 Agent 之前就会建受邀者目录与会话记录，启动失败、还没有原生会话 id
        // 时，删除受邀者也要能请它清掉。
        if (run.hostSessionId) await recordRelayDevice(run.controller, run.hostSessionId, current.agentDeviceId);
        if (run.closing) return;
        openSent = true;
        const started = await backend.client.open(run.kind, relayedOpenPayload(run, payload, current));
        if (run.closing) {
          await backend.client.close('close', 'navigation').catch(() => undefined);
          return;
        }
        backend.started = true;
        append(run, { t: 'started', handle: started });
        const nativeIds = [started.id, started.requestSessionId].map((id) => (typeof id === 'string' ? id : undefined));
        if (run.hostSessionId) await recordGuestSession(run.controller, undefined, run.hostSessionId, nativeIds, current);
        deps.log?.info('remote agent run relayed to the provider group', { runId: run.id, member: current.memberKey });
        const early = closedEarly as { reason: string; error?: RemoteAgentErrorInfo } | null;
        if (early && run.relay === backend) relayClosed(early.reason, early.error);
        return;
      } catch (error) {
        lastError = error;
        run.relay = undefined;
        if (openSent && !backend.client.isClosed) {
          // 打开的结果不明(超时、断链)时那台可能已经启动了 Agent：换下一台之前先用同一个任务 id 请它关掉；
          // 关不到时，那台上没人拉取的任务也会在空闲超时后自行结束(删除受邀者时按上面记下的这台清理)。
          await Promise.race([
            backend.client.close('close', 'navigation').catch(() => undefined),
            new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, RELAY_CLOSE_WAIT_MS);
              (timer as { unref?: () => void }).unref?.();
            }),
          ]);
        }
        backend.client.abandon('start-failed');
        load.release();
        // 这次尝试里受邀者那边已经打开的连接全部关掉，下一次尝试的连接编号不同。
        for (const connId of wsOpened) append(run, { t: 'ws', connId, kind: 'close' });
        if (run.closing || !options.fresh) break;
        tried.add(current.memberKey);
        relayDeps.noteStartFailure(groupProviderId, current, error);
        deps.log?.warn('remote agent: provider group computer did not take the shared task; trying the next one', {
          runId: run.id,
          member: current.memberKey,
          error: String(error),
        });
        const next = await relayDeps.plan({
          kind: run.kind,
          model: payload.options.model,
          providerId: groupProviderId,
          exclude: tried,
          reserve: true,
        }).catch(() => null);
        if (next?.kind === 'local' && deps.isAgentAvailable(run.kind) && !run.closing) {
          if (next.load) run.groupLoad = next.load;
          await startRun(run, payload);
          return;
        }
        if (next?.kind === 'member') {
          const { memberKey, agentDeviceId, providerId, sameAccount } = next;
          member = { memberKey, agentDeviceId, providerId, sameAccount };
          reserved = next.load;
        } else if (next?.kind === 'local') {
          next.load?.release();
        }
      }
    }
    reserved?.release();
    if (run.closing) return;
    append(run, { t: 'start-failed', error: relayErrorInfoFrom(lastError ?? new Error('[REMOTE_AGENT_UNAVAILABLE] no computer can run this task right now')) });
    await finishRun(run, 'start-failed', 'navigation', false);
  }

  /** 受邀者对中转任务的方法调用：按受邀者复核后用同一个 callId 转给组内电脑；载荷不解码、不落盘。 */
  async function relayCall(run: Run, relay: RelayBackend, callId: string, method: RemoteAgentMethod, payload: RemoteAgentPayload): Promise<void> {
    try {
      const raw = await resolvePayload(run.controller, payload);
      const args = takeGroupNewRound(run, method, Array.isArray(raw) ? raw : []);
      let callArgs: unknown[] = args;
      if (method === 'setVendorOptions') callArgs = [sanitizeGuestVendorOptions(args[0])];
      if (method === 'setExtraDirs') {
        const library = confineGuestDirs([args[1]], run.virtualRoot)[0] ?? null;
        callArgs = [confineGuestDirs(args[0], run.virtualRoot), library];
      }
      if (method === 'setWritableDirs') callArgs = [confineGuestDirs(args[0], run.virtualRoot)];
      const access = deps.providerAccess;
      if (access && method === 'send' && run.providerId && !access.isAllowed(run.providerId, run.controller)) {
        failProviderNotAllowed();
      }
      if (method === 'setModel') {
        // 来源钉在分享的供应商上(本机按分享的那个供应商核对模型)，转给那台时换成那台上的这个供应商。
        const opts = args[1] && typeof args[1] === 'object' && !Array.isArray(args[1]) ? args[1] as Record<string, unknown> : {};
        if (access) {
          const resolved = await access.resolve(run.kind, typeof args[0] === 'string' ? args[0] : '', run.providerId ?? null, run.controller);
          if (!resolved) failProviderNotAllowed();
        }
        callArgs = [args[0], { ...opts, providerId: relay.member.providerId }, ...args.slice(2)];
      }
      const value = await relay.client.callWithId(callId, method, callArgs);
      append(run, { t: 'result', callId, ok: true, ...(value !== undefined ? { value: JSON.parse(JSON.stringify(value)) } : {}) });
    } catch (error) {
      append(run, { t: 'result', callId, ok: false, error: relayErrorInfoFrom(error) });
    } finally {
      run.calls.set(callId, 'done');
      if (run.calls.size > MAX_REMEMBERED_CALLS) {
        for (const [id, status] of run.calls) {
          if (run.calls.size <= MAX_REMEMBERED_CALLS) break;
          if (status === 'done') run.calls.delete(id);
        }
      }
    }
  }

  /** 结束任务：关掉 Agent 与隧道，拒掉未完成的反向请求，写收尾事件。 */
  async function finishRun(
    run: Run,
    reason: string,
    teardown: RemoteAgentTeardownReason,
    closeHandle = true,
    skipClosedEvent = false,
    mode: 'close' | 'detach' = 'close',
  ): Promise<void> {
    if (run.closing) return;
    run.closing = true;
    if (run.stateTimer) clearInterval(run.stateTimer);
    for (const pending of run.pending.values()) pending.reject(new Error('[REMOTE_AGENT_EXPIRED] task has ended'));
    run.pending.clear();
    if (closeHandle && run.handle) {
      try {
        if (mode === 'detach' && run.handle.detach) await run.handle.detach({ reason: teardown });
        else await run.handle.close({ reason: teardown });
      } catch (error) {
        deps.log?.warn('remote agent close failed', { runId: run.id, error: String(error) });
      }
    }
    // 中转任务：结束组内电脑上的那个任务(撤权、受邀者离开、关闭都走这里)，并放掉它占的负载。
    const relay = run.relay;
    if (relay) {
      if (closeHandle && !relay.client.isClosed) {
        await relay.client.close(mode, teardown).catch((error) => {
          deps.log?.warn('remote agent relay close failed', { runId: run.id, error: String(error) });
        });
      } else {
        relay.client.abandon(reason);
      }
      relay.load.release();
    }
    run.groupLoad?.release();
    // Agent 已关：撤销受邀者的出站登记，之后这条任务的请求一律被本机 proxy 拒绝。
    run.guestRoute?.release();
    run.guestRoute = undefined;
    await run.tunnel?.close().catch(() => undefined);
    // 收尾事件绕过 closing 判断直接写入。
    if (!skipClosedEvent) run.log.append({ t: 'closed', reason });
    run.log.end();
    run.closedAt = now();
    deps.log?.info('remote agent run finished', { runId: run.id, reason });
  }

  async function disposeRun(run: Run): Promise<void> {
    runs.delete(key(run.controller, run.id));
    await fsp.rm(run.attachmentsDir, { recursive: true, force: true }).catch(() => undefined);
    // 影子工作区(项目说明类文件的副本)在任务收尾后一并清理，不长期留在本机；同一任务的
    // 新旧实例共用同一份目录，只有没有其它实例还在用时才删，避免删掉新实例正在用的目录。
    await cleanupShadow(run);
    stopSweepIfIdle();
  }

  /**
   * 影子工作区里是同步过去的项目与个人说明副本，任务收尾后没有恢复价值，留着只会把
   * 敏感项目上下文堆到下一个任务、退出登录与换账号之后。删除与 prepareShadow 共用同一把
   * 影子锁，且同一(控制端, 本机侧任务)还有实例在时保留：否则「扫描到没人用 → 删目录」
   * 与「替换实例重建目录」之间存在竞态，可能删掉替换实例刚建好的目录。
   */
  async function cleanupShadow(run: Run): Promise<void> {
    const hostSessionId = run.hostSessionId;
    if (!hostSessionId) return;
    const workspaceDir = run.workspaceDir ?? shadowSessionRoot(run.controller, hostSessionId);
    await withShadowLock(hostSessionId, async () => {
      for (const other of runs.values()) {
        if (other !== run && other.controller === run.controller && other.hostSessionId === hostSessionId) return;
      }
      await fsp.rm(workspaceDir, { recursive: true, force: true }).catch(() => undefined);
    });
  }

  function requireRun(controller: string, runId: string): Run {
    const run = runs.get(key(controller, runId));
    if (!run) fail('REMOTE_AGENT_NOT_FOUND', 'task is not running on this computer');
    return run;
  }

  async function call(run: Run, callId: string, method: RemoteAgentMethod, payload: RemoteAgentPayload): Promise<void> {
    if (run.relay?.started) return relayCall(run, run.relay, callId, method, payload);
    const handle = run.handle;
    try {
      if (!handle) fail('REMOTE_AGENT_UNAVAILABLE', 'agent has not started');
      const raw = await resolvePayload(run.controller, payload);
      const args = takeGroupNewRound(run, method, Array.isArray(raw) ? raw : []);
      const target = (handle as unknown as Record<string, unknown>)[method];
      if (typeof target !== 'function') fail('REMOTE_AGENT_UNSUPPORTED', `${method} is not supported by this agent`);
      let callArgs: unknown[] = args;
      if (run.trust === 'guest') {
        // 受邀者：协同 / 定时任务以外的 vendorOptions 丢弃；附加 / 可写目录只能落在虚拟工作区内。
        if (method === 'setVendorOptions') callArgs = [sanitizeGuestVendorOptions(args[0])];
        if (method === 'setExtraDirs') {
          const library = confineGuestDirs([args[1]], run.virtualRoot)[0] ?? null;
          callArgs = [confineGuestDirs(args[0], run.virtualRoot), library];
        }
        if (method === 'setWritableDirs') callArgs = [confineGuestDirs(args[0], run.virtualRoot)];
      }
      if (run.virtualRoot && (method === 'setExtraDirs' || method === 'setWritableDirs')) {
        const dirs = Array.isArray(callArgs[0]) ? callArgs[0] : [];
        await Promise.all(dirs.filter((dir): dir is string => typeof dir === 'string').map(async (dir) => {
          const relative = path.relative(run.virtualRoot!, dir);
          if (!relative.startsWith('..') && !path.isAbsolute(relative)) await fsp.mkdir(dir, { recursive: true });
        }));
      }
      // 供应商授权：新一轮对话前复核(关掉后不再开始新的一轮，进行中的这一轮照常结束)；
      // 换模型时显式换来源(含 null = 默认)要落到开放的供应商上，只换模型则沿用当前来源。
      // 受邀者每次换模型都复核：来源钉在分享的供应商上(没带来源也显式带上)，且它要提供这个模型。
      let nextProviderId: string | undefined;
      const access = deps.providerAccess;
      if (access && method === 'send' && run.providerId && !access.isAllowed(run.providerId, run.controller)) {
        failProviderNotAllowed();
      }
      if (access && method === 'setModel') {
        const opts = args[1];
        const optsObject = opts && typeof opts === 'object' && !Array.isArray(opts) ? opts : undefined;
        const explicitProvider = optsObject !== undefined && 'providerId' in optsObject;
        if (explicitProvider || run.trust === 'guest') {
          const requested = explicitProvider ? (optsObject as { providerId?: unknown }).providerId : run.providerId;
          const resolved = await access.resolve(
            run.kind,
            typeof args[0] === 'string' ? args[0] : '',
            typeof requested === 'string' ? requested : null,
            run.controller,
          );
          if (!resolved) failProviderNotAllowed();
          nextProviderId = resolved;
          callArgs = [args[0], { ...(optsObject ?? {}), providerId: resolved }, ...args.slice(2)];
        }
      }
      if (method === 'send' || method === 'steer') {
        const message = await decodeUserMessage(args[0], (data, ext) => writeAttachment(run, data, ext));
        const opts = await decodeSendOptions(args[1], {
          onTranscriptUserEntry: async (entryId) => {
            await reverse(run, { type: 'callback', name: 'onTranscriptUserEntry', args: [callId, entryId] }).catch(() => undefined);
          },
          onInteractionStateChange: (state) => {
            void reverse(run, { type: 'callback', name: 'onInteractionStateChange', args: [callId, state] }).catch(() => undefined);
          },
          writeAttachment: (data, ext) => writeAttachment(run, data, ext),
        });
        callArgs = [message, opts];
      }
      const value = await (target as (...a: unknown[]) => unknown).apply(handle, callArgs);
      if (nextProviderId) run.providerId = nextProviderId;
      append(run, { t: 'result', callId, ok: true, ...(value !== undefined ? { value: JSON.parse(JSON.stringify(value)) } : {}) });
    } catch (error) {
      append(run, { t: 'result', callId, ok: false, error: remoteAgentErrorInfo(error) });
    } finally {
      run.calls.set(callId, 'done');
      if (run.calls.size > MAX_REMEMBERED_CALLS) {
        for (const [id, status] of run.calls) {
          if (run.calls.size <= MAX_REMEMBERED_CALLS) break;
          if (status === 'done') run.calls.delete(id);
        }
      }
      emitState(run);
    }
  }

  /** 轮流决定 poll 从哪个任务开始取数据，避免积压多的任务一直挤占前面的额度。 */
  let pollRotation = 0;

  async function poll(
    controller: string,
    wanted: ReadonlyArray<{ runId: string; cursor: number }>,
    waitMs: number,
    signal?: AbortSignal,
  ): Promise<RemoteAgentPollResult> {
    const touch = () => {
      const t = now();
      for (const { runId } of wanted) {
        const run = runs.get(key(controller, runId));
        if (run) run.lastReadAt = t;
      }
    };
    const live = () => wanted.flatMap(({ runId, cursor }) => {
      const run = runs.get(key(controller, runId));
      return run && run.log.isValidCursor(cursor) ? [{ run, cursor }] : [];
    });
    touch();
    const initial = live();
    const anyReady = initial.length < wanted.length || initial.some(({ run, cursor }) => run.log.isReady(cursor));
    if (!anyReady && waitMs > 0) await waitForAny(initial.map(({ run }) => run.log), waitMs, signal);
    touch();
    const out: RemoteAgentPollResult = { runs: [] };
    let budget = REMOTE_AGENT_POLL_MAX_BYTES;
    const start = wanted.length ? pollRotation++ % wanted.length : 0;
    for (let index = 0; index < wanted.length; index += 1) {
      const { runId, cursor } = wanted[(start + index) % wanted.length];
      const run = runs.get(key(controller, runId));
      // 不存在或游标超出已写范围(对端状态与本机不一致)：控制端按任务丢失处理。
      if (!run || !run.log.isValidCursor(cursor)) {
        out.runs.push({ runId, cursor, missing: true });
        continue;
      }
      const result = run.log.readNow(cursor, Math.min(REMOTE_AGENT_READ_MAX_BYTES, budget));
      if (!result.data?.length && !result.done) continue;
      budget -= result.data?.length ?? 0;
      out.runs.push({
        runId,
        ...(result.from !== cursor ? { from: result.from } : {}),
        cursor: result.cursor,
        ...(result.data?.length ? { data: result.data.toString('base64') } : {}),
        ...(result.done ? { done: true as const } : {}),
      });
    }
    return out;
  }

  /**
   * 结束并清理受邀者在本机留下的东西：任务、影子工作区与附件、受邀者目录、本机 Agent 目录里的会话记录。
   * wholeController = 整个控制端都清(受邀者的分享删除)；否则只清选中的作用域(组所在电脑请本机
   * 忘掉某个受邀者，同一个控制端的其他任务不受影响)。本机是组所在电脑时，顺带请接过这个受邀者
   * 任务的组内电脑也清掉。
   */
  async function purgeGuests(
    runMatch: (run: Run) => boolean,
    recordMatch: (record: GuestSessionRecord) => boolean,
    wholeController: boolean,
  ): Promise<void> {
    const owned = [...runs.values()].filter(runMatch);
    await Promise.all(owned.map((run) => finishRun(run, 'access-revoked', 'navigation')));
    await Promise.all(owned.map((run) => disposeRun(run)));
    const map = await loadGuestIndex();
    const records = [...map.entries()].filter(([, record]) => recordMatch(record));
    const scopes = new Set([
      ...owned.map((run) => guestScopeOf(run.controller, run.relayKey)),
      ...records.map(([, record]) => guestScopeOf(record.controller, record.relay)),
    ]);
    const controllers = wholeController
      ? new Set([...owned.map((run) => run.controller), ...records.map(([, record]) => record.controller)])
      : new Set<string>();
    // 受邀者目录里是它的 Codex / Pi 会话历史；Windows 上刚退出的 Agent 可能还占着文件，重试几次。
    const targets = [
      ...[...controllers].flatMap((controller) => ['workspaces', 'attachments'].map((dir) => path.join(deps.runsRoot, dir, controllerDir(controller)))),
      ...[...scopes].map((scope) => guestHomeFor(scope)),
    ];
    await Promise.all(targets.map((target) => (
      fsp.rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => undefined)
    )));
    if (!records.length) return;
    // 接过这些受邀者任务的组内电脑(含启动失败、还没有原生会话 id 的)：先记成待通知再逐台通知，通知到才划掉，
    // 当时离线的之后再试——不能因为一次没通知到就丢了「要通知哪台」。
    let forgets = false;
    for (const [, record] of records) {
      const devices = new Set([
        ...Object.values(record.members ?? {}).map((member) => member.agentDeviceId),
        ...(record.relayDevices ?? []),
        ...(record.forgetPending ?? []),
      ]);
      if (!devices.size || !deps.groupRelay) continue;
      record.forgetPending = [...devices];
      forgets = true;
    }
    try {
      await deps.purgeHostedTranscripts?.(
        records.flatMap(([, record]) => record.hostSessionIds),
        records.flatMap(([, record]) => record.nativeIds),
      );
    } catch (error) {
      // 留着登记，下次清理重试。
      deps.log?.warn('remote agent transcript purge failed', { error: String(error) });
      if (forgets) {
        await persistGuestIndex(map);
        void retryPendingForgets();
      }
      return;
    }
    for (const [digest, record] of records) {
      // 本机这边清完了，只留下还没通知到的组内电脑。
      if (record.forgetPending?.length) {
        map.set(digest, {
          controller: record.controller,
          ...(record.relay ? { relay: record.relay } : {}),
          hostSessionIds: [],
          nativeIds: [],
          forgetPending: record.forgetPending,
        });
      } else {
        map.delete(digest);
      }
    }
    await persistGuestIndex(map);
    if (forgets) void retryPendingForgets();
  }

  let forgetRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let forgetRetrying: Promise<void> | null = null;
  let forgetRetryAgain = false;
  let disposed = false;

  /**
   * 逐台请组内电脑忘掉已删除的受邀者(见 GuestSessionRecord.forgetPending)：通知到的划掉，都通知到的登记删掉；
   * 还有没通知到的，过一阵再试。同一个受邀者作用域期间又用起来时(待通知的已并回交过任务的电脑)不再动它。
   */
  function retryPendingForgets(): Promise<void> {
    if (forgetRetrying) {
      forgetRetryAgain = true;
      return forgetRetrying;
    }
    if (forgetRetryTimer) {
      clearTimeout(forgetRetryTimer);
      forgetRetryTimer = null;
    }
    forgetRetrying = (async () => {
      const relayDeps = deps.groupRelay;
      const map = await loadGuestIndex();
      if (!relayDeps) return;
      let changed = false;
      for (const [digest, record] of [...map]) {
        for (const agentDeviceId of [...(record.forgetPending ?? [])]) {
          if (disposed || map.get(digest) !== record || !record.forgetPending?.includes(agentDeviceId)) continue;
          try {
            await relayDeps.forget(agentDeviceId, relayKeyFor(record.controller));
          } catch (error) {
            deps.log?.warn('remote agent: asking a provider group computer to forget a shared user failed', { error: String(error) });
            continue;
          }
          if (map.get(digest) !== record || !record.forgetPending?.includes(agentDeviceId)) continue;
          record.forgetPending = record.forgetPending.filter((id) => id !== agentDeviceId);
          changed = true;
        }
        if (map.get(digest) === record && record.forgetPending && !record.forgetPending.length) {
          delete record.forgetPending;
          const empty = !record.hostSessionIds.length && !record.nativeIds.length && !record.members && !record.relayDevices?.length;
          if (empty) map.delete(digest);
        }
      }
      if (changed) await persistGuestIndex(map);
    })().catch((error) => {
      deps.log?.warn('remote agent: retrying provider group forget failed', { error: String(error) });
    }).finally(() => {
      forgetRetrying = null;
      if (disposed) return;
      if (forgetRetryAgain) {
        forgetRetryAgain = false;
        void retryPendingForgets();
        return;
      }
      void scheduleForgetRetry();
    });
    return forgetRetrying;
  }

  /** 还有没通知到的组内电脑时，过一阵再试。 */
  async function scheduleForgetRetry(): Promise<void> {
    if (disposed || forgetRetryTimer || forgetRetrying || !deps.groupRelay) return;
    const map = await loadGuestIndex();
    if (disposed || forgetRetryTimer || forgetRetrying) return;
    if (![...map.values()].some((record) => record.forgetPending?.length)) return;
    forgetRetryTimer = setTimeout(() => {
      forgetRetryTimer = null;
      void retryPendingForgets();
    }, FORGET_RETRY_MS);
    (forgetRetryTimer as { unref?: () => void }).unref?.();
  }

  /** 组所在电脑请本机忘掉它替某个受邀者中转过来的任务(只清调用方自己的 relay)。 */
  function forgetRelay(controller: string, relay: string): Promise<void> {
    return purgeGuests(
      (run) => run.controller === controller && run.relayKey === relay,
      (record) => record.controller === controller && record.relay === relay,
      false,
    );
  }

  async function handle(controller: string, raw: unknown, signal?: AbortSignal): Promise<unknown> {
    const request = parseRemoteAgentRequest(raw);
    if (!deps.isControllerAuthorized(controller)) fail('REMOTE_AGENT_UNAVAILABLE', 'remote control is not allowed');
    switch (request.op) {
      case 'caps': {
        const guest = trustOf(controller) === 'guest';
        const caps: RemoteAgentCaps = {
          version: REMOTE_AGENT_VERSION,
          agents: (['claude-code', 'codex', 'pi'] as const).map((kind) => ({
            kind,
            available: deps.isAgentAvailable(kind) && (!guest || GUEST_SUPPORTED_AGENTS.has(kind)),
          })),
          maxRuns: REMOTE_AGENT_MAX_RUNS_PER_CONTROLLER,
          uploadChunkBytes: REMOTE_AGENT_UPLOAD_CHUNK_BYTES,
          maxPayloadBytes: REMOTE_AGENT_MAX_PAYLOAD_BYTES,
          virtualWorkspace: true,
          // 能按受邀者隔离运行(供应商级授权与出站边界都已接上)，才接受组所在电脑中转过来的受邀者任务。
          ...(deps.providerAccess && deps.bindGuestProviderRoute ? { guestRelay: true } : {}),
        };
        return caps;
      }
      case 'forget':
        // 组所在电脑删掉了某个受邀者：清掉替它运行过的任务。只作用于调用方自己的 relay。
        await forgetRelay(controller, request.relay);
        return {};
      case 'upload': {
        const uploadKey = key(controller, request.uploadId);
        let upload = uploads.get(uploadKey);
        const chunk = Buffer.from(request.data, 'base64');
        // 配额对每个新 chunk 都重查，不只是建 uploadId 时：否则可以先建很多 uploadId
        // 各带一小片，再往每个里追加大段数据，绕开只在首次检查的配额、无上限占内存。
        if (!upload?.chunks[request.index] && stagedBytes(controller) + chunk.length > MAX_STAGED_BYTES_PER_CONTROLLER) {
          fail('REMOTE_AGENT_BUSY', 'too much staged data');
        }
        if (!upload) {
          upload = { controller, chunks: [], bytes: 0, touchedAt: now() };
          uploads.set(uploadKey, upload);
          ensureSweep();
        }
        if (!upload.chunks[request.index]) {
          upload.chunks[request.index] = chunk;
          upload.bytes += chunk.length;
        }
        upload.touchedAt = now();
        return {};
      }
      case 'open': {
        const existing = runs.get(key(controller, request.runId));
        if (existing) {
          discardPayload(controller, request.payload);
          return {};
        }
        const controllerTrust = trustOf(controller);
        const guestUnsupported = !GUEST_SUPPORTED_AGENTS.has(request.agentKind) || !deps.providerAccess || !deps.bindGuestProviderRoute;
        if (controllerTrust === 'guest' && guestUnsupported) {
          discardPayload(controller, request.payload);
          fail('REMOTE_AGENT_UNSUPPORTED', `${request.agentKind} is not available to shared users on this computer`);
        }
        let payload = decodeOpenPayload(await resolvePayload(controller, request.payload));
        // 供应商组的组所在电脑替受邀者中转过来的任务：不论那台是不是同账号，都按受邀者隔离运行。
        const relayKey = payload.relay;
        const trust: RemoteAgentControllerTrust = relayKey ? 'guest' : controllerTrust;
        if (relayKey && guestUnsupported) {
          fail('REMOTE_AGENT_UNSUPPORTED', `${request.agentKind} is not available to shared users on this computer`);
        }
        // 运行数按受邀者作用域各算一份；同一控制端替多个受邀者中转时另有合计上限。只有同账号控制端(组所在电脑)
        // 的 relay 才各算一份：受邀者自己填的 relay 只把它的数据分开存放，不能用来绕开它的运行数上限。
        const active = [...runs.values()].filter((run) => run.controller === controller && run.closedAt === undefined);
        const scope = guestScopeOf(controller, relayKey);
        const scoped = controllerTrust === 'guest'
          ? active.length
          : active.filter((run) => guestScopeOf(run.controller, run.relayKey) === scope).length;
        if (scoped >= REMOTE_AGENT_MAX_RUNS_PER_CONTROLLER || active.length >= REMOTE_AGENT_MAX_RELAYED_RUNS_PER_CONTROLLER) {
          fail('REMOTE_AGENT_BUSY', 'too many tasks are running from this computer');
        }
        if (trust === 'guest') {
          // 受邀者必须用虚拟工作区：本机 Agent 只看到会话目录内的路径，附加目录也映射在其中。
          if (payload.virtualWorkspace !== true) {
            fail('REMOTE_AGENT_UNSUPPORTED', 'shared users need the virtual workspace; update Cindy on the other computer');
          }
          payload = sanitizeGuestOpenPayload(payload);
          // 只能接回自己在本机建立过的会话：会话 id 不能用来接上本机用户自己的会话。
          const resumeId = payload.options.resumeSessionId;
          if (resumeId && !(await guestOwnsSession(controller, relayKey, resumeId))) {
            fail('REMOTE_AGENT_INVALID', 'this conversation cannot be resumed on this computer');
          }
        }
        // 供应商授权：来源落到本机已开放的供应商上，并以显式来源启动(核对的就是实际用的)。
        let providerId: string | undefined;
        if (deps.providerAccess) {
          const resolved = await deps.providerAccess.resolve(
            request.agentKind,
            payload.options.model,
            payload.options.providerId,
            controller,
          );
          if (!resolved) failProviderNotAllowed();
          providerId = resolved;
          payload = { ...payload, options: { ...payload.options, providerId: resolved } };
        }
        // 供应商组(本机是组所在电脑)：受邀者的任务按组分给组内电脑，本机中转。被中转过来的任务(带 relay)
        // 与已由供应商组分配的任务(防转圈)直接在本机运行。续接只能回到当初运行它的那台。
        let relayTo: GroupRelayMember | null = null;
        /** 受邀者因「需要换一台」交接后重新打开：这一轮已经换下来的组内电脑(凭证只认这个受邀者的这个任务)。 */
        let avoid: string[] = [];
        /** 选电脑的同一步已计入那台(或本机这一台)的负载，交给任务；任务没建起来时放掉。 */
        let reserved: GroupRelayLoad | undefined;
        const groupRouted = controllerTrust === 'guest' && !relayKey && !payload.groupAssigned && !!deps.groupRelay && !!providerId;
        if (groupRouted && deps.groupRelay && providerId) {
          const resumeId = payload.options.resumeSessionId;
          if (resumeId) {
            relayTo = await relayMemberOf(controller, resumeId);
            // 在本机运行过的会话接着在本机运行：计入本机这一台的负载。
            if (!relayTo) reserved = deps.groupRelay.trackRun(providerId, PROVIDER_GROUP_LOCAL_MEMBER_KEY);
          } else {
            avoid = takeGroupSwitchToken(
              controller,
              hostSessionIdFor(controller, payload.sessionId),
              payload.groupSwitchToken,
            );
            const plan = await deps.groupRelay.plan({
              kind: request.agentKind,
              model: payload.options.model,
              providerId,
              exclude: new Set(avoid),
              reserve: true,
            });
            if (plan?.kind === 'unavailable') fail('REMOTE_AGENT_UNAVAILABLE', 'no computer can run this task right now');
            if (plan?.kind === 'member' || plan?.kind === 'local') reserved = plan.load;
            if (plan?.kind === 'member') {
              const { memberKey, agentDeviceId, providerId: memberProviderId, sameAccount } = plan;
              relayTo = { memberKey, agentDeviceId, providerId: memberProviderId, sameAccount };
            }
          }
        }
        if (!relayTo && !deps.isAgentAvailable(request.agentKind)) {
          reserved?.release();
          fail('REMOTE_AGENT_UNSUPPORTED', `${request.agentKind} is not available on this computer`);
        }
        // 上面有等待：同一个 runId 的重发可能已经先登记了。
        if (runs.has(key(controller, request.runId))) {
          reserved?.release();
          return {};
        }
        const run: Run = {
          id: request.runId,
          controller,
          trust,
          ...(relayKey ? { relayKey } : {}),
          owner: deps.captureOwner(),
          kind: request.agentKind,
          log: new EventLog(REMOTE_AGENT_HOST_UNREAD_BYTES),
          lastReadAt: now(),
          closing: false,
          // runId 由控制端取，按控制端分目录：不同控制端的同名 runId 不会共用、互删附件。
          attachmentsDir: path.join(deps.runsRoot, 'attachments', controllerDir(controller), request.runId),
          pending: new Map(),
          calls: new Map(),
          pushSeq: new Set(),
          pushParts: new Map(),
          ...(providerId ? { providerId } : {}),
          ...(groupRouted && payload.acceptsGroupSwitch === true ? { acceptsGroupSwitch: true } : {}),
          ...(reserved && !relayTo ? { groupLoad: reserved } : {}),
        };
        runs.set(key(controller, request.runId), run);
        ensureSweep();
        deps.log?.info('remote agent run opened', { runId: run.id, agent: run.kind, ...(relayTo ? { relayed: true } : {}) });
        if (relayTo) {
          const member = relayTo;
          // 先登记再中转：中转中途失败时，分享删除也能找到并清理(含通知那台组内电脑)。
          run.hostSessionId = hostSessionIdFor(controller, payload.sessionId);
          const load = reserved;
          void recordGuestSession(controller, undefined, run.hostSessionId, [])
            .then(() => startRelay(run, payload, member, { fresh: !payload.options.resumeSessionId, avoid, ...(load ? { load } : {}) }))
            .catch(async (error) => {
              load?.release();
              append(run, { t: 'start-failed', error: relayErrorInfoFrom(error) });
              await finishRun(run, 'start-failed', 'navigation', false);
            });
        } else {
          void startRun(run, payload);
        }
        return {};
      }
      case 'call': {
        const run = requireRun(controller, request.runId);
        if (run.closing) fail('REMOTE_AGENT_EXPIRED', 'task has ended');
        if (run.calls.has(request.callId)) {
          discardPayload(controller, request.payload);
          return {};
        }
        run.calls.set(request.callId, 'running');
        void call(run, request.callId, request.method, request.payload);
        return {};
      }
      case 'poll':
        return poll(controller, request.runs, request.waitMs ?? REMOTE_AGENT_READ_WAIT_MS, signal);
      case 'reply': {
        const run = requireRun(controller, request.runId);
        const pending = run.pending.get(request.requestId);
        if (!pending) {
          // 重复 / 已取消的回包：载荷要显式丢掉，不能留在暂存区占配额到过期。
          discardPayload(controller, request.payload);
          return {};
        }
        const reply = parseRemoteAgentReply(await resolvePayload(controller, request.payload));
        run.pending.delete(request.requestId);
        pending.resolve(reply);
        return {};
      }
      case 'push': {
        const run = requireRun(controller, request.runId);
        if (run.pushSeq.has(request.seq)) return {};
        run.pushSeq.add(request.seq);
        if (run.pushSeq.size > 1024) run.pushSeq.delete(run.pushSeq.values().next().value as number);
        const relay = run.relay;
        if (relay) {
          // 中转任务：帧原样转给组内电脑(不拼接)，按任务串行发出以保持顺序；只认当前这次启动尝试的连接。
          const frames = request.frames.flatMap((frame) => {
            const connId = relayMemberConnId(relay.attempt, frame.connId);
            return connId ? [{ ...frame, connId }] : [];
          });
          if (frames.length) {
            relay.pushChain = relay.pushChain
              .then(() => relay.client.push(frames))
              .catch((error) => {
                deps.log?.warn('remote agent relay push failed', { runId: run.id, error: String(error) });
                // 转发不上：两边都关掉这些连接，Agent 那边按连接断开处理。
                for (const frame of frames) append(run, { t: 'ws', connId: relayConnId(relay.attempt, frame.connId), kind: 'close' });
                void relay.client.push(frames.map((frame) => ({ connId: frame.connId, kind: 'close' as const }))).catch(() => undefined);
              });
          }
          return {};
        }
        for (const frame of request.frames) {
          if (frame.kind === 'message' && frame.data !== undefined) {
            const joined = (run.pushParts.get(frame.connId) ?? '') + frame.data;
            if (frame.more) {
              // 单条消息拼接上限与反向请求载荷一致，防止无限累积。
              if (joined.length > REMOTE_AGENT_MAX_PAYLOAD_BYTES) {
                run.pushParts.delete(frame.connId);
                run.tunnel?.closeWs(frame.connId);
              } else run.pushParts.set(frame.connId, joined);
              continue;
            }
            run.pushParts.delete(frame.connId);
            run.tunnel?.sendWs(frame.connId, joined);
          } else {
            run.pushParts.delete(frame.connId);
            run.tunnel?.closeWs(frame.connId);
          }
        }
        return {};
      }
      case 'close': {
        const run = runs.get(key(controller, request.runId));
        if (!run) return {};
        await finishRun(run, request.mode === 'detach' ? 'detached' : 'closed', request.reason, true, false, request.mode);
        return {};
      }
    }
  }

  // 上次运行时删除受邀者、还没通知到的组内电脑：过一阵再试。
  void scheduleForgetRetry();

  return {
    handle,
    /** 远程控制关闭 / 退出时结束全部任务。 */
    async abortAll(reason: RemoteAgentTeardownReason = 'navigation'): Promise<void> {
      await Promise.all([...runs.values()].map((run) => finishRun(run, 'aborted', reason)));
    },
    /** 立即结束某个控制端的全部任务(例如分享被关闭)，不等巡检周期。 */
    async abortControllers(match: (controller: string) => boolean): Promise<void> {
      await Promise.all([...runs.values()]
        .filter((run) => match(run.controller))
        .map((run) => finishRun(run, 'access-revoked', 'navigation')));
    },
    /**
     * 受邀者的分享删除后：结束匹配控制端(同一成员的每台设备)的任务，删除它们的影子工作区与
     * 附件，以及本机 Agent 目录里它们的会话记录。
     */
    async purgeControllers(match: (controller: string) => boolean): Promise<void> {
      await purgeGuests((run) => match(run.controller), (record) => match(record.controller), true);
    },
    /** 有进行中任务的控制端(分享管理页显示「几个任务运行中」)。 */
    activeControllers(): string[] {
      return [...runs.values()].filter((run) => run.closedAt === undefined && !run.closing).map((run) => run.controller);
    },
    /**
     * 正在运行一轮的任务的控制端(每个任务一项)：受邀者读分享目录时据此告诉它自己在本机跑着几个(供应商组的
     * 「N 个任务运行中」)。本机 Agent 的任务现问会话；转给组内电脑的按那台报来的状态。
     */
    turnRunningControllers(): string[] {
      return [...runs.values()]
        .filter((run) => run.closedAt === undefined && !run.closing)
        .filter((run) => (run.relay
          ? run.relay.turnRunning
          : (safeCall(run.handle?.isTurnRunning?.bind(run.handle)) ?? run.turnRunning) === true))
        .map((run) => run.controller);
    },
    /**
     * 在本机 Agent 上正在运行一轮的任务用的本机供应商(每个任务一项)：组所在电脑据此显示组里这台在跑几个。
     * 转给组内电脑的不算(在那台运行，由那台报)；没接供应商授权、不知道用哪个供应商的不算。
     */
    turnRunningProviders(): string[] {
      return [...runs.values()]
        .filter((run) => run.closedAt === undefined && !run.closing && !run.relay && run.providerId)
        .filter((run) => (safeCall(run.handle?.isTurnRunning?.bind(run.handle)) ?? run.turnRunning) === true)
        .map((run) => run.providerId!);
    },
    /** 测试与诊断用。 */
    runCount(): number {
      return [...runs.values()].filter((run) => run.closedAt === undefined).length;
    },
    dispose(): void {
      if (sweepTimer) clearInterval(sweepTimer);
      sweepTimer = null;
      disposed = true;
      if (forgetRetryTimer) clearTimeout(forgetRetryTimer);
      forgetRetryTimer = null;
      // 退出前尽力收尾：影子工作目录含同步过去的项目与个人说明，不能留到下次启动。
      for (const run of runs.values()) void finishRun(run, 'aborted', 'app-quit').then(() => disposeRun(run));
    },
  };
}

export type RemoteAgentHost = ReturnType<typeof createRemoteAgentHost>;
