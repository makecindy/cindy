import type { GeneratedImageUpstream } from '../../cindy-media/generatedImageJournal';
import { remoteAgentStartupTiming } from '../startupTiming';
import { parseProviderSharePeer, providerShareGuestPeer } from '@cindy/device-link';
import { DEFAULT_REMOTE_AGENT_LIMITS, type RemoteAgentLimits, type RemoteAgentLimitUsage } from '../../../shared/remoteAgentLimits.js';
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
 *  - 任务不忙且闲置满主人设置的时长(远程任务数量里的「闲置收回」)就结束它的 Agent 进程，事件流以带
 *    idleReclaimed 的 `closed` 收尾，控制端再要它干活时带原来的会话 id 重新打开；
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
  REMOTE_AGENT_METHODS,
  REMOTE_AGENT_POLL_MAX_BYTES,
  REMOTE_AGENT_READ_MAX_BYTES,
  REMOTE_AGENT_READ_WAIT_MS,
  REMOTE_AGENT_UPLOAD_CHUNK_BYTES,
  REMOTE_AGENT_VERSION,
  parseRemoteAgentReply,
  parseRemoteAgentRequest,
  parseRemoteAgentForkResult,
  remoteAgentErrorCode,
  type RemoteAgentForkResult,
  type RemoteAgentCaps,
  type RemoteAgentErrorInfo,
  type RemoteAgentKind,
  type RemoteAgentMethod,
  type RemoteAgentPayload,
  type RemoteAgentPollResult,
  type RemoteAgentReply,
  type RemoteAgentRequest,
  type RemoteAgentReshareBatch,
  type RemoteAgentReshareEntry,
  type RemoteAgentReshareResult,
  type RemoteAgentReverseRequest,
  type RemoteAgentTeardownReason,
} from '@cindy/device-link';
import type { AgentEvent, AgentSessionHandle, DeviceHostedLinkActivity, InteractionRequest, ForkSdkSessionOptions, ForkSdkSessionResult } from '@cindy/maker-core';

import { EXEC_SERVER_WS_PATH } from '../controller/execServerRelay';
import { RemoteAgentRunClient, type RemoteAgentInvoke, type RemoteAgentPoller } from '../controller/runClient';
import { EventLog, waitForAny } from '../eventLog';
import { createExecServerShortcut, type ExecServerShortcutLayout } from './execServerShortcut';
import { createExecServerStartupBatch } from './execServerStartupBatch';
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
  reshareKeyForGuest,
  type RelayRunFailure,
} from './groupRelay';
import { PROVIDER_GROUP_LOCAL_MEMBER_KEY } from '../../../shared/providerGroup';
import { isAccountUsageLimitError } from '../../maker-ipc/usageLimitAutoResume';
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
import { hostSessionIdFor } from './sessionIdentity.js';
export { hostSessionIdFor } from './sessionIdentity.js';

const gunzipAsync = promisify(gunzip);

/** 控制端不读时最多替它缓存的未读事件字节；超出说明它已跟不上或离开，结束任务。 */
export const REMOTE_AGENT_HOST_UNREAD_BYTES = 64 * 1024 * 1024;
/** 运行中的任务超过这么久没有被读取，视为控制端已离开。 */
export const REMOTE_AGENT_HOST_IDLE_MS = 3 * 60_000;
/**
 * 控制端在 poll 里报「这边还有工作在进行」(hold)后，在控制端存活窗口内按忙处理；后续 poll 不带 hold 就解除。
 * 组所在电脑据此在拉取组内电脑时接着报 hold。大量任务按批轮转可能超过最短的 1 分钟闲置设置。
 */
const REMOTE_HOLD_FRESH_MS = REMOTE_AGENT_HOST_IDLE_MS;
/** 结束后保留一段时间供控制端读完收尾事件。 */
export const REMOTE_AGENT_HOST_RETAIN_MS = 60_000;
/** 「需要换一台」凭证多久内有效(受邀者那边交接通常几秒内完成，重开时带回)。 */
export const GROUP_SWITCH_TOKEN_TTL_MS = 10 * 60_000;
/** 距上一次换电脑超过这么久算新的一轮(与供应商组本机任务的一轮同一口径)。 */
const GROUP_SWITCH_ROUND_MS = 30 * 60_000;
/** 打开的结果不明(超时、断链)时，换下一台之前最多等多久请那台关掉同一个任务。 */
const RELAY_CLOSE_WAIT_MS = 5_000;
/**
 * 中转任务的一批帧从收到到推给组内电脑完成超过这么久算慢(每个 Codex 文件请求的回包都要经过这里，
 * 与控制端中继的慢回推同一口径)。每个任务只记第一次，带排队与推送两段耗时。
 */
const RELAY_SLOW_PUSH_MS = 2_000;
/** 删除受邀者时没通知到的组内电脑(离线等)，多久后再试一次。 */
const FORGET_RETRY_MS = 10 * 60_000;
/** 那台上的任务以这些原因结束是正常收尾，不算失败。 */
const NORMAL_RELAY_CLOSE_REASONS = new Set(['closed', 'detached', 'ended', 'superseded', 'controller-disconnected']);
const UPLOAD_IDLE_MS = 2 * 60_000;
const MAX_STAGED_BYTES_PER_CONTROLLER = REMOTE_AGENT_MAX_PAYLOAD_BYTES * 2;
const MAX_DECOMPRESSED_BYTES = 128 * 1024 * 1024;
const SWEEP_INTERVAL_MS = 5_000;
const STATE_INTERVAL_MS = 2_000;
const MAX_REMEMBERED_CALLS = 256;

export interface HostedStartInput {
  /** Host-derived path, scoped to controller/relay/application; never from wire. */
  localApplicationStorage?: string;
  groupProviderId?: string;
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
  receiptMetering?: boolean;
  modelDenial?(model: string): { code: string; message: string } | null;
  routeToken: string;
  modelIds: string[];
  allowsModel?(model: string): Promise<boolean>;
  release(): void;
}

/** 同账号托管任务的来源登记；仅当前运行能更新或撤销它。 */
export interface OwnerProviderRouteBinding {
  setProvider(providerId: string): void;
  release(): void;
}

export interface RemoteAgentHostDeps {
  nativeHistory?(scope: string, command: unknown, workingDir: string, assertCurrent: () => void): Promise<unknown>;
  fastPolicy?(controller: string, command: import('@cindy/device-link').RemoteAgentFastPolicy): Promise<unknown>;
  /** Prepare native bytes; retain recovery ownership only for receipted controllers. */
  prepareImageEvent?(hostSessionId: string, event: AgentEvent, upstream: GeneratedImageUpstream | undefined, retainForRecovery: boolean): Promise<AgentEvent>;
  imageArtifacts?(hostSessionId: string, request: Extract<RemoteAgentRequest, { op: 'images' }>): Promise<unknown>;
  readLimits?(): RemoteAgentLimits;
  isAgentAvailable(kind: RemoteAgentKind): boolean;
  startHosted(input: HostedStartInput): Promise<AgentSessionHandle>;
  forkHosted?(kind: RemoteAgentKind, options: ForkSdkSessionOptions): Promise<ForkSdkSessionResult>;
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
  /**
   * 记录受邀者每一轮的用量(分享者的管理页按人、按模型、按组内电脑展示)。只对 guest 调用。
   * memberKey：这一轮在哪台组内电脑运行——转给组内电脑的是那台的键，在本机运行的是 `local`。
   */
  recordGuestUsage?(controller: string, usage: RunUsageRecord, sessionId?: string): void;
  /** 记录同账号其他电脑每一轮的用量(远程与分享页按使用方展示)。只对 owner 调用。 */
  recordOwnerUsage?(controller: string, usage: RunUsageRecord): void;
  /**
   * 「允许被远程调用」(供应商级授权，默认关)。不提供 = 不做供应商级限制(测试 / 旧接线)。
   *  - resolve：把对方要用的来源落到本机已开放的供应商上。providerId 是字符串时只核对它是否开放；
   *    null / 缺省时在已开放的供应商里按本机默认规则挑一个。返回 null = 没有开放的供应商可用。
   *  - isAllowed：进行中的任务每次发消息前复核(用户可能刚把它关掉)。
   * 两者都带上控制端：供应商分享的受邀者只能用分享给它的那个供应商。
   */
  providerAccess?: {
    resolve(kind: RemoteAgentKind, model: string, providerId: string | null | undefined, controller: string,
      sessionId?: string): Promise<string | null>;
    isAllowed(providerId: string, controller: string, model?: string, sessionId?: string): boolean;
    models?(kind: RemoteAgentKind, providerId: string, controller: string, sessionId?: string): Promise<string[]>;
    restricted?(providerId: string, controller: string, sessionId?: string): boolean;
  };
  /** 同账号任务在启动前登记来源和逐请求的实时模型授权，子代理同样受此约束。 */
  bindOwnerProviderRoute?(hostSessionId: string, providerId: string, allowsModel?: (providerId: string, model: string) => boolean): OwnerProviderRouteBinding;
  /** Resolve an owner native request's actual catalog identity before checking its live grant. */
  ownerModelAllowed?(hostSessionId: string, providerId: string, kind: RemoteAgentKind, model: string): boolean;
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
    controller: string;
    sessionId: string;
    isCurrent(): boolean;
    relayModelAccess?: { models: string[]; allows(model: string): Promise<boolean> };
  }): Promise<GuestProviderRouteBinding | null>;
  /**
   * 供应商组(本机是组所在电脑，docs/product-rules/provider-groups.md §4)：受邀者的新任务按组策略交给
   * 组内电脑运行，本机中转。不提供 = 受邀者的任务一律在本机运行(现有接线)。
   */
  groupRelay?: RemoteAgentGroupRelayDeps;
  /** Group owner chooses an executor; executor accepts a bounded grant from its authenticated owner peer. */
  directGuestExecution?: {
    ownerScope(): string;
    locate?(controller: string, request: Extract<RemoteAgentRequest, { op: 'direct-locate' }>): Promise<{ deviceId: string } | null>;
    /** O accepts fresh relay history; native history must stay on its recorded M. */
    acceptRelay?(controller: string, sessionId: string, hasNativeHistory: boolean): Promise<void>;
    allocate(controller: string, request: Extract<RemoteAgentRequest, { op: 'allocate' }>): Promise<{ deviceId: string; generation: string; leaseDurationMs?: number } | null>;
    status(controller: string, request: Extract<RemoteAgentRequest, { op: 'direct-status' }>): void;
    release(controller: string, request: Extract<RemoteAgentRequest, { op: 'direct-release' }>): Promise<void>;
    switch(controller: string, request: Extract<RemoteAgentRequest, { op: 'direct-switch' }>): Promise<{ token?: string }>;
    switched?(controller: string, sessionId: string, token: string): Promise<void>;
    sessionAllowed(controller: string, sessionId: string): boolean;
    /** Unlike sessionAllowed, true only for a current, local G→M delegation. */
    sessionDelegated(controller: string, sessionId: string): boolean;
    usage(controller: string, request: Extract<RemoteAgentRequest, { op: 'direct-usage' }>): Promise<void> | void;
    delegate(controller: string, request: Extract<RemoteAgentRequest, { op: 'delegate' }>): Promise<boolean>;
    forget(ownerDeviceId: string, guestPeer: string, cleanupEpoch: number,
      confirmedOwnership?: boolean): boolean;
  };
  /**
   * 转分享(本机是分享者，docs/product-rules/provider-sharing.md §4.3)：受邀者把这里分享的供应商放进了它自己的
   * 供应商组又分享给了别人。组所在电脑(受邀者)经 op `reshare` 报上它分享的人，本机记下等主人逐人同意；组转来的
   * 受邀者任务(带 relay)只在主人同意过的人上运行。不提供 = 不接受 op `reshare`、也不核对(测试 / 旧接线)。
   */
  reshare?: {
    /** Delegated G→M access never owns the original share's consent list. */
    canUse?(controller: string): boolean;
    sync(controller: string, entries: readonly RemoteAgentReshareEntry[], batch?: RemoteAgentReshareBatch): Promise<RemoteAgentReshareResult>;
    allows(controller: string, reshareKey: string | undefined): boolean;
  };
  captureOwner(): unknown;
  isOwnerCurrent(owner: unknown): boolean;
  /** 本机存放影子目录与附件的根目录。 */
  runsRoot: string;
  now?: () => number;
  log?: {
    debug?(message: string, meta?: Record<string, unknown>): void;
    info(message: string, meta?: Record<string, unknown>): void;
    warn(message: string, meta?: Record<string, unknown>): void;
  };
}

/** 受邀者任务交给的组内电脑(组所在电脑视角)。 */
/** 一轮的用量(`meterRunUsage` 交给 recordGuestUsage / recordOwnerUsage)。 */
export interface RunUsageRecord {
  kind: RemoteAgentKind;
  providerId: string | null;
  memberKey: string;
  samples: GuestUsageSample[];
}

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
  bindFastPolicy?(input: { group: string; deviceId?: string | null; sessionId: string; relay?: string }): Promise<void>;
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
    /**
     * 这个受邀者的转分享键(provider-sharing.md §4.3)：分享来的组内电脑只在它的主人同意过这个人时才选；
     * 没有时一律不选分享来的电脑。
     */
    reshareKey?: string;
  }): Promise<GroupRelayPlan | null>;
  /** 分享来的那台拒绝了这个受邀者(主人没同意或已撤回)：组所在电脑据此重新核对同意情况。 */
  noteReshareDenied?(agentDeviceId: string, reshareKey: string): void;
  /** 经设备互联连某台组内电脑的远程 Agent 通道(与本机作为控制端共用拉取器)。 */
  connect(agentDeviceId: string): { invoke: RemoteAgentInvoke; poller: RemoteAgentPoller };
  /**
   * 那台在启动阶段没能接下任务：按组的口径判定(provider-group/failurePolicy)，那台账号的问题冷却它。返回 true =
   * 可以换下一台；false = 换到哪台都一样(模型停用、请求无效等)，照原来的错误报给受邀者。
   */
  noteStartFailure(providerId: string, member: GroupRelayMember, error: unknown, model?: string): boolean;
  /**
   * 那台上的任务运行中失败(终态错误，或一轮进行中任务意外结束)：问题出在那台电脑本身时按组的口径冷却它，组设置
   * 允许自动换电脑时返回 true(可以换一台)；用户停止、上下文超限等换到哪台都一样的失败返回 false。
   */
  noteRunFailure(providerId: string, member: GroupRelayMember, failure: RelayRunFailure, model?: string): boolean;
  /** 计入那台组内电脑的负载(按它是否正在运行一轮)。 */
  trackRun(providerId: string, memberKey: string): GroupRelayLoad;
  /** 删掉受邀者后，请接过它任务的组内电脑清掉留下的会话记录与目录。 */
  forget(agentDeviceId: string, relay: string): Promise<void>;
}

/** 本机作为组所在电脑把受邀者的任务转给组内电脑时的后端(代替本机的 Agent 会话)。 */
interface RelayBackend {
  modelAccess?: boolean;
  client: RemoteAgentRunClient;
  member: GroupRelayMember;
  /** 第几次启动尝试(WebSocket 连接编号的前缀)。 */
  attempt: number;
  /** 那台已经开始运行(启动阶段失败才能换下一台)。 */
  started: boolean;
  /** 那台上正在运行一轮(按它报来的状态)。 */
  turnRunning: boolean;
  /** 那台报来的忙闲状态(在准备回合、后台任务、待唤醒续跑)：本机按闲置收回时与本机 Agent 同一判据。 */
  activity: Record<string, unknown>;
  /** 推帧按任务串行，保证 Codex exec-server 帧的顺序。 */
  pushChain: Promise<void>;
  /** 已记过一次转发慢(排队加推送超过 RELAY_SLOW_PUSH_MS)。 */
  slowPushLogged?: boolean;
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
  groupProviderId?: string;
  id: string;
  sessionId?: string;
  controller: string;
  trust: RemoteAgentControllerTrust;
  /** 本机侧任务 id：影子目录按它存放，同一任务多次打开共用。 */
  hostSessionId?: string;
  /** 分叉历史中仍可能出现的祖先任务影子目录。 */
  forkWorkspaceIds?: string[];
  imageDeliveryEpoch?: number;
  acceptsImageDeliveryReceipts?: boolean;
  owner: unknown;
  kind: RemoteAgentKind;
  log: EventLog;
  lastReadAt: number;
  /**
   * 最后一次活动(闲置收回从这里算起)：打开、控制端的调用 / 回包 / 推帧、写进事件流的非状态行、控制端报 hold，
   * 以及巡检时看到它还忙。只被拉取(poll)不算：闲着的任务控制端也一直在拉。
   */
  activeAt: number;
  /** 控制端最近一次在 poll 里报 hold 的时间(中转时接着报给组内电脑)。 */
  heldAt?: number;
  /** 回到某条消息后、下一轮跑完前：Claude Code 要到下一次发送才截断对话，结束进程会丢掉这次回退。 */
  rewindPending?: boolean;
  /** 按闲置收回结束(收尾的 `closed` 行带 idleReclaimed)。 */
  idleReclaimed?: boolean;
  closedAt?: number;
  closing: boolean;
  handle?: AgentSessionHandle;
  tunnel?: RunTunnel;
  execStartupBatches?: Map<string, ReturnType<typeof createExecServerStartupBatch>>;
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
  /** Last authorized model, independent of delayed Agent state frames. */
  authorizedModel?: string;
  /** 受邀者任务的出站登记，任务结束时撤销。 */
  guestRoute?: GuestProviderRouteBinding;
  ownerRoute?: OwnerProviderRouteBinding;
  /** 换模型/来源串行，避免失败回滚覆盖后一次选择。 */
  modelChange?: Promise<void>;
  usageMeter?: ReturnType<typeof createGuestUsageMeter>;
  lastState?: string;
  stateTimer?: ReturnType<typeof setInterval>;
  /**
   * 组所在电脑替受邀者中转过来的任务(本机是组内电脑)：组所在电脑为这个受邀者取的键。按受邀者隔离，
   * 会话索引、受邀者目录与运行数都按(控制端, relay)分开。
   */
  relayKey?: string;
  /**
   * 受邀者(本机的分享成员)的组转来的、它分享的那个人的任务：那个人的转分享键。主人撤回对这个人的同意时
   * 按它结束任务(abortReshare)。
   */
  reshareKey?: string;
  /** 本机是组所在电脑、把这个受邀者任务转给了组内电脑。 */
  relay?: RelayBackend;
  /**
   * 本机是组所在电脑、这是受邀者自己的任务(不是被中转来的)，受邀者声明了支持「需要换一台」：在本机或组内电脑上
   * 运行中失败时可以发凭证。
   */
  acceptsGroupSwitch?: boolean;
  /** 本机是组所在电脑、组选中了本机这一台来运行受邀者的任务：计入本机这一台的负载。 */
  groupLoad?: GroupRelayLoad;
  /**
   * 本机是组所在电脑、组为受邀者的全新任务(不是续接)选中了本机这一台：本机 Agent 没能启动时与组内电脑一样换下一台
   * (`avoid` = 这一轮已经试过、不再回去的组内电脑)。
   */
  groupFreshStart?: { avoid: readonly string[] };
  /**
   * 本机是组所在电脑、受邀者续接一个经组运行过的任务：续接只能回到原来那台(会话在那台上)。那台接不下时给声明了
   * 支持的受邀者发「需要换一台」凭证，它交接(带上上下文)后作为全新任务重新打开，组再换一台(§6.1)。
   */
  groupResumed?: boolean;
  /** 本机这次运行经隧道告诉了控制端已打开、还没关掉的 WebSocket 连接(换去中转时补发关闭)。 */
  localWs?: Set<string>;
  /** 本机 Agent 上一次报来的「正在运行一轮」。 */
  turnRunning?: boolean;
  /** 同一次发送的限额 RPC 失败与终态事件共用一次交付，下一次发送时作废。 */
  quotaFailure?: { delivery: Promise<void>; deliver?: () => void };
  lastSendCallId?: string;
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

/**
 * 状态里还有放不下的事：在跑或在准备的回合、后台任务、待唤醒续跑。与控制端判断能否让出名额同一判据
 * (controller/proxyHandle.ts isQuiet)。
 */
function activityBusy(state: Record<string, unknown>): boolean {
  return state.turnRunning === true
    || state.preparing === true
    || (Array.isArray(state.backgroundTasks) && state.backgroundTasks.length > 0)
    || (typeof state.pendingWake === 'number' && state.pendingWake > 0);
}

function handleActivity(handle: AgentSessionHandle): Record<string, unknown> {
  return {
    turnRunning: safeCall(handle.isTurnRunning?.bind(handle)),
    preparing: safeCall(handle.isPreparingUserTurn?.bind(handle)),
    backgroundTasks: safeCall(handle.listBackgroundTasks?.bind(handle)),
    pendingWake: safeCall(handle.countPendingWakeContinuations?.bind(handle)),
  };
}

/** 启动结果里给控制端的会话描述(静态部分 + 支持哪些可选方法)。 */
function describeHandle(handle: AgentSessionHandle, shadowDir: string, mirrorRoot: string, extraDirs: readonly string[], writableDirs: readonly string[], virtualWorkspace: boolean, previousMirrorRoots: readonly string[] = []): Record<string, unknown> {
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
    ...(previousMirrorRoots.length ? { previousMirrorRoots } : {}),
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
  const limitDeviceOf = (controller: string) => parseProviderSharePeer(controller)?.deviceId ?? controller;
  function usageByDevice(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const run of runs.values()) {
      // 清理完成前仍占名额，包括正在关闭的实例。
      if (run.closedAt !== undefined) continue;
      const device = limitDeviceOf(run.controller);
      counts.set(device, (counts.get(device) ?? 0) + 1);
    }
    return counts;
  }
  function assertRunCapacity(controller: string): void {
    const limits = deps.readLimits?.() ?? DEFAULT_REMOTE_AGENT_LIMITS;
    const counts = usageByDevice();
    if ((counts.get(limitDeviceOf(controller)) ?? 0) >= limits.perDevice) {
      fail('REMOTE_AGENT_BUSY', '[DEVICE_LIMIT] remote task limit for this device reached');
    }
    if ([...counts.values()].reduce((sum, count) => sum + count, 0) >= limits.total) {
      fail('REMOTE_AGENT_BUSY', '[TOTAL_LIMIT] remote task limit for the provider computer reached');
    }
  }
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
    /** Direct/relay run IDs whose attachment subdirs may outlive a failed shutdown. */
    attachmentRunIds?: string[];
    /** 原生分叉会话 → 历史涉及的祖先任务目录；同账号远程任务也使用此索引。 */
    forkWorkspaces?: Record<string, string[]>;
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
    /** M's verified O for direct G→M tasks; retained after the short-lived delegation expires. */
    directOwnerDeviceId?: string;
    directOwnerScopeKey?: string;
    cleanupEpoch?: number;
    /** Completed deletion ID is retained so a lost ACK cannot purge a rejoined guest. */
    lastDirectForgetId?: string;
  }
  const guestIndexFile = path.join(deps.runsRoot, 'guest-sessions.json');
  const guestDigest = (scope: string) => createHash('sha256').update(scope).digest('hex').slice(0, 32);
  let guestIndex: Promise<Map<string, GuestSessionRecord>> | null = null;
  let guestIndexWrite: Promise<void> = Promise.resolve();
  const runStarts = new WeakMap<Run, Promise<void>>();
  const runDisposals = new Map<Run, Promise<void>>();
  const directGuestLocks = new Map<string, {
    tail: Promise<void>;
    forgets: Map<string, Promise<unknown>>;
  }>();
  let directGuestOperations = 0;

  /** M serializes direct mutations per local account + guest, never across relay scopes.
   * O's device identity stays in the ownership check and dedupe key: another O
   * cannot inherit a successful forget ACK. Settled queues are removed; queued
   * work is bounded even when a native startup or filesystem operation stalls.
   */
  function withDirectGuestLock(peer: string, fn: () => Promise<unknown>,
    forget?: { controller: string; forgetId: string; cleanupEpoch: number }): Promise<unknown> {
    const ownerScope = deps.directGuestExecution?.ownerScope();
    if (!ownerScope) fail('REMOTE_AGENT_INVALID', 'direct guest account is unavailable');
    const scope = JSON.stringify([ownerScope, peer]);
    const forgetKey = forget && JSON.stringify([forget.controller, forget.forgetId, forget.cleanupEpoch]);
    const previous = directGuestLocks.get(scope);
    const duplicate = forgetKey ? previous?.forgets.get(forgetKey) : undefined;
    if (duplicate) return duplicate;
    if (directGuestOperations >= 256) fail('REMOTE_AGENT_BUSY', 'too many pending shared task operations');
    const queue = previous ?? { tail: Promise.resolve(), forgets: new Map<string, Promise<unknown>>() };
    const owner = deps.captureOwner();
    directGuestOperations += 1;
    const work = queue.tail.then(() => {
      if (disposed || !deps.isOwnerCurrent(owner) || deps.directGuestExecution?.ownerScope() !== ownerScope) {
        fail('REMOTE_AGENT_UNAVAILABLE', 'direct guest account changed');
      }
      return fn();
    });
    const tail = work.then(() => undefined, () => undefined).finally(() => {
      directGuestOperations -= 1;
      if (forgetKey) queue.forgets.delete(forgetKey);
      if (queue.tail === tail) directGuestLocks.delete(scope);
    });
    queue.tail = tail;
    if (forgetKey) queue.forgets.set(forgetKey, work);
    directGuestLocks.set(scope, queue);
    return work;
  }

  function parseGuestIndex(raw: string): Map<string, GuestSessionRecord> {
    const invalid = (): never => { throw new Error('Remote agent guest session index is invalid'); };
    const object = (value: unknown): value is Record<string, unknown> =>
      !!value && typeof value === 'object' && !Array.isArray(value);
    const nonempty = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
    const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f-]{36}$/.test(value);
    const list = (value: unknown, valid: (item: unknown) => boolean = nonempty): string[] => {
      if (value === undefined) return [];
      if (!Array.isArray(value) || !value.every(valid)) invalid();
      return value as string[];
    };
    const parsed: unknown = JSON.parse(raw);
    if (!object(parsed)) invalid();
    const map = new Map<string, GuestSessionRecord>();
    for (const [digest, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!object(value)) invalid();
      const record = value as Record<string, unknown>;
      if (!nonempty(record.controller) || (record.relay !== undefined && !nonempty(record.relay))) invalid();
      if (digest !== guestDigest(guestScopeOf(record.controller as string, record.relay as string | undefined))) invalid();
      list(record.hostSessionIds, uuid);
      list(record.nativeIds);
      list(record.attachmentRunIds, uuid);
      list(record.relayDevices);
      list(record.forgetPending);
      if (record.forkWorkspaces !== undefined) {
        if (!object(record.forkWorkspaces)) invalid();
        for (const [nativeId, ids] of Object.entries(record.forkWorkspaces as Record<string, unknown>)) {
          if (!nativeId || ids === undefined) invalid();
          list(ids, uuid);
        }
      }
      if (record.members !== undefined) {
        if (!object(record.members)) invalid();
        for (const [nativeId, member] of Object.entries(record.members as Record<string, unknown>)) {
          if (!nativeId || !object(member)) return invalid();
          if (!nonempty(member.memberKey)
            || (!nonempty(member.agentDeviceId) && !(member.agentDeviceId === ''
              && member.memberKey === PROVIDER_GROUP_LOCAL_MEMBER_KEY)) || !nonempty(member.providerId)
            || (member.sameAccount !== undefined && typeof member.sameAccount !== 'boolean')) invalid();
          member.sameAccount ??= false;
        }
      }
      if (record.directOwnerDeviceId !== undefined
        && (!nonempty(record.directOwnerDeviceId) || record.directOwnerDeviceId.length > 128)) invalid();
      if (record.directOwnerScopeKey !== undefined
        && (!nonempty(record.directOwnerScopeKey) || record.directOwnerScopeKey.length > 512)) invalid();
      if (record.cleanupEpoch !== undefined
        && (!Number.isSafeInteger(record.cleanupEpoch) || (record.cleanupEpoch as number) < 0)) invalid();
      if (record.lastDirectForgetId !== undefined && !uuid(record.lastDirectForgetId)) invalid();
      if (record.directOwnerDeviceId !== undefined || record.directOwnerScopeKey !== undefined
        || record.cleanupEpoch !== undefined || record.lastDirectForgetId !== undefined) {
        if (record.relay !== undefined || parseProviderSharePeer(record.controller as string)?.role !== 'guest') invalid();
      }
      // Validate the entire file before publishing anything. Optional fields in
      // older indexes stay optional; never trim ownership or cleanup evidence.
      map.set(digest, { ...record, hostSessionIds: list(record.hostSessionIds),
        nativeIds: list(record.nativeIds) } as unknown as GuestSessionRecord);
    }
    return map;
  }

  function loadGuestIndex(): Promise<Map<string, GuestSessionRecord>> {
    guestIndex ??= fsp.readFile(guestIndexFile, 'utf8').then(parseGuestIndex, (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return new Map<string, GuestSessionRecord>();
      throw error;
    }).catch((error) => {
      // A transient read/parse failure must not become a cached empty index.
      // The next request can retry after the original file is readable again.
      guestIndex = null;
      throw error;
    });
    return guestIndex;
  }

  function applyGuestIndexUpdates(map: Map<string, GuestSessionRecord>,
    updates: ReadonlyMap<string, GuestSessionRecord | undefined>): void {
    for (const [digest, record] of updates) {
      if (record) map.set(digest, record);
      else map.delete(digest);
    }
  }

  function persistGuestIndex(map: Map<string, GuestSessionRecord>, strict = false,
    updates?: ReadonlyMap<string, GuestSessionRecord | undefined>
      | ((current: Map<string, GuestSessionRecord>) => ReadonlyMap<string, GuestSessionRecord | undefined>)): Promise<void> {
    const commit = guestIndexWrite.then(async () => {
      const pending = typeof updates === 'function' ? updates(map) : updates;
      if (pending?.size === 0) return;
      await fsp.mkdir(deps.runsRoot, { recursive: true });
      const tmp = `${guestIndexFile}.${randomUUID()}.tmp`;
      // Merge into the latest shared index when this write reaches the queue.
      // A direct tombstone is not visible to idempotent ACKs until rename wins;
      // unrelated guests can keep updating their own entries in the meantime.
      const next = pending ? new Map(map) : map;
      if (pending) applyGuestIndexUpdates(next, pending);
      try {
        await fsp.writeFile(tmp, JSON.stringify(Object.fromEntries(next)));
        await fsp.rename(tmp, guestIndexFile);
        if (pending) applyGuestIndexUpdates(map, pending);
      } finally {
        await fsp.rm(tmp, { force: true }).catch(() => undefined);
      }
    });
    guestIndexWrite = commit.catch((error) => {
      deps.log?.warn('remote agent guest session index write failed', { error: String(error) });
    });
    return strict ? commit : guestIndexWrite;
  }

  /** Store O's identity only after M has validated its server-backed delegation. */
  async function recordDirectGuestOwner(ownerDeviceId: string,
    guest: { shareId: string; memberId: string; guestDeviceId: string; cleanupEpoch?: number }): Promise<void> {
    const peer = providerShareGuestPeer(guest.shareId, guest.memberId, guest.guestDeviceId);
    const map = await loadGuestIndex();
    const digest = guestDigest(peer);
    await persistGuestIndex(map, true, (current) => {
      const existing = current.get(digest);
      const ownerScopeKey = deps.directGuestExecution?.ownerScope();
      if (!ownerScopeKey) fail('REMOTE_AGENT_INVALID', 'direct guest account is unavailable');
      if (existing?.relay || (existing?.directOwnerDeviceId && existing.directOwnerDeviceId !== ownerDeviceId)
        || (existing?.directOwnerScopeKey && existing.directOwnerScopeKey !== ownerScopeKey)) {
        fail('REMOTE_AGENT_INVALID', 'direct guest ownership does not match this computer');
      }
      return new Map([[digest, {
        ...(existing ?? { controller: peer, hostSessionIds: [], nativeIds: [] }),
        directOwnerDeviceId: ownerDeviceId,
        directOwnerScopeKey: ownerScopeKey,
        cleanupEpoch: Math.max(existing?.cleanupEpoch ?? 0, guest.cleanupEpoch ?? 0),
      }]]);
    });
  }

  async function recordGuestSession(
    controller: string,
    relay: string | undefined,
    hostSessionId: string,
    nativeIds: ReadonlyArray<string | undefined>,
    member?: GroupRelayMember,
    forkWorkspaceIds?: readonly string[],
    attachmentRunId?: string,
  ): Promise<void> {
    const map = await loadGuestIndex();
    const digest = guestDigest(guestScopeOf(controller, relay));
    const update = (current: Map<string, GuestSessionRecord>) => {
      const existing = current.get(digest);
      const record = existing ? { ...existing, hostSessionIds: [...existing.hostSessionIds],
        nativeIds: [...existing.nativeIds] }
        : { controller, ...(relay ? { relay } : {}), hostSessionIds: [], nativeIds: [] };
      let changed = !current.has(digest) || reviveForgottenRecord(record);
      if (!record.hostSessionIds.includes(hostSessionId)) {
        record.hostSessionIds.push(hostSessionId);
        changed = true;
      }
      if (attachmentRunId && !record.attachmentRunIds?.includes(attachmentRunId)) {
        record.attachmentRunIds = [...(record.attachmentRunIds ?? []), attachmentRunId];
        changed = true;
      }
      for (const id of nativeIds) {
        if (id && !record.nativeIds.includes(id)) {
          record.nativeIds.push(id);
          changed = true;
        }
        if (id && forkWorkspaceIds?.length) {
          const ancestors = [...new Set([...(record.forkWorkspaces?.[id] ?? []), ...forkWorkspaceIds])];
          if (ancestors.length !== record.forkWorkspaces?.[id]?.length) {
            record.forkWorkspaces = { ...record.forkWorkspaces, [id]: ancestors };
            changed = true;
          }
        }
        if (id && member && record.members?.[id]?.memberKey !== member.memberKey) {
          record.members = { ...record.members, [id]: { ...member } };
          changed = true;
        }
      }
      return changed ? new Map([[digest, record]]) : new Map<string, GuestSessionRecord>();
    };
    if (!relay && map.get(digest)?.directOwnerDeviceId) {
      await persistGuestIndex(map, true, update);
    } else {
      // Legacy relay state events publish synchronously for the next resume.
      const pending = update(map);
      if (!pending.size) return;
      applyGuestIndexUpdates(map, pending);
      await persistGuestIndex(map);
    }
  }

  async function forkWorkspacesFor(scope: string, nativeId: string | undefined): Promise<string[]> {
    if (!nativeId) return [];
    return (await loadGuestIndex()).get(guestDigest(scope))?.forkWorkspaces?.[nativeId] ?? [];
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

  /** 主人设置的闲置收回时长(分钟，0 = 不收回)；caps 声明的与巡检用的是同一个值。 */
  function idleReclaimMinutes(): number {
    return (deps.readLimits?.() ?? DEFAULT_REMOTE_AGENT_LIMITS).idleMinutes ?? 0;
  }

  /**
   * 不能按闲置收回：有在等控制端回包的反向请求(权限确认、执行器 / MCP 请求)、在执行的方法调用、待生效的回退，
   * 还没启动好，或 Agent 那边还有放不下的事(中转任务按组内电脑报来的状态)。
   */
  function busyForReclaim(run: Run): boolean {
    if (run.heldAt !== undefined && now() - run.heldAt < REMOTE_HOLD_FRESH_MS) return true;
    if (run.pending.size > 0 || run.rewindPending) return true;
    for (const status of run.calls.values()) if (status === 'running') return true;
    if (run.relay) return !run.relay.started || activityBusy(run.relay.activity);
    return !run.handle || activityBusy(handleActivity(run.handle));
  }

  function sweep(): void {
    const t = now();
    for (const [uploadKey, upload] of uploads) {
      if (t - upload.touchedAt > UPLOAD_IDLE_MS) uploads.delete(uploadKey);
    }
    let reclaimMs = 0;
    try {
      reclaimMs = idleReclaimMinutes() * 60_000;
    } catch (error) {
      // 换账号途中读不到设置：这一轮不收回。
      deps.log?.warn('remote agent: idle reclaim setting unavailable', { error: String(error) });
    }
    for (const run of runs.values()) {
      if (run.closedAt !== undefined) {
        // 闲置收回的通知必须覆盖控制端 2 分钟的断链重试；否则恢复后只读到 missing，会误关本机部分。
        const retainMs = run.idleReclaimed ? REMOTE_AGENT_HOST_IDLE_MS : REMOTE_AGENT_HOST_RETAIN_MS;
        if (t - run.closedAt > retainMs) void disposeRun(run);
        continue;
      }
      if (!deps.isControllerAuthorized(run.controller) || !delegatedRunAllowed(run)) {
        void finishRun(run, 'access-revoked', 'navigation');
      } else if (!deps.isOwnerCurrent(run.owner)) {
        void finishRun(run, 'account-changed', 'account-boundary');
      } else if (t - run.lastReadAt > REMOTE_AGENT_HOST_IDLE_MS) {
        void finishRun(run, 'controller-gone', 'navigation');
      } else if (run.closing) {
        continue;
      } else if (busyForReclaim(run)) {
        // 忙到哪一刻，闲置就从哪一刻算起(后台任务跑得再久，结束后也要再闲置满设置的时长)。
        run.activeAt = t;
      } else if (reclaimMs > 0 && t - run.activeAt >= reclaimMs) {
        deps.log?.info('remote agent: reclaiming an idle run', { runId: run.id, idleMinutes: reclaimMs / 60_000 });
        // 原因写旧控制端也认识的 `ended`(静默收起，下次发消息重建并接回)；新控制端按 idleReclaimed 保留本机部分。
        run.idleReclaimed = true;
        void finishRun(run, 'ended', 'navigation');
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

  const imagePreparation = new WeakMap<Run, Promise<void>>();

  function append(run: Run, item: unknown, upstream?: GeneratedImageUpstream): void {
    let stream = item as { t?: string; event?: AgentEvent };
    if (stream.t === 'event' && stream.event?.type === 'image' && stream.event.source === 'codex') {
      const data = stream.event.data as Record<string, unknown> | null;
      if (data?.kind === 'generation') {
        stream = { ...stream, event: { ...stream.event, data: { ...data, deliveryEpoch: run.imageDeliveryEpoch } } };
        item = stream;
      }
    }
    const prepare = stream.t === 'event' && stream.event?.type === 'image'
      && stream.event.source === 'codex' && deps.prepareImageEvent && run.hostSessionId;
    const previous = imagePreparation.get(run);
    if (prepare || previous) {
      const pending = (previous ?? Promise.resolve()).then(async () => {
        let next = item;
        if (prepare) {
          try {
            next = { ...stream, event: await deps.prepareImageEvent!(run.hostSessionId!, stream.event!, upstream, run.acceptsImageDeliveryReceipts === true) };
          } catch {
            // Even a failed adapter must not advertise the source path as controller-local.
            const data = stream.event!.data as Record<string, unknown> | null;
            if (data?.kind === 'generation') {
              const { path: _path, ...metadata } = data;
              next = { ...stream, event: { ...stream.event!, data: { ...metadata, pathOrigin: 'remote-agent' } } };
            }
          }
        }
        if (deps.isOwnerCurrent(run.owner) && deps.isControllerAuthorized(run.controller)) appendPrepared(run, next);
      });
      imagePreparation.set(run, pending);
      const settled = () => { if (imagePreparation.get(run) === pending) imagePreparation.delete(run); };
      void pending.then(settled, settled);
      return;
    }
    appendPrepared(run, item);
  }

  function appendPrepared(run: Run, item: unknown): void {
    const line = item as { t?: unknown; event?: { type?: unknown } };
    // 状态行在闲着时也可能有变化(用量等)，不算活动；忙闲由巡检直接看。
    if (line.t !== 'state') run.activeAt = now();
    if (line.t === 'event' && line.event?.type === 'done') run.rewindPending = false;
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
    if ((run.trust === 'guest' || run.forkWorkspaceIds?.length) && run.hostSessionId) {
      void recordGuestSession(run.controller, run.relayKey, run.hostSessionId, [
        typeof state.id === 'string' ? state.id : undefined,
        typeof state.requestSessionId === 'string' ? state.requestSessionId : undefined,
      ], undefined, run.forkWorkspaceIds).catch((error) => {
        deps.log?.warn('remote agent guest session index update failed', { error: String(error) });
      });
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
  ): Promise<{ shadowDir: string; mirrorRoot: string; shortcutLayout: ExecServerShortcutLayout; sessionRoot: string; extraDirs: string[]; writableDirs: string[]; projectText(text: string): string }> {
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
    /** 控制端有对应目录的各级上级目录在影子里的位置(下标 = 向上几级)。 */
    const mappedAncestors: string[] = [];
    const taskAncestors: string[] = [payload.workspace.workingDir];
    for (let up = 1; up <= MAX_ANCESTOR_LEVELS; up += 1) {
      const nextReal = foreignPath.dirname(realParent);
      if (nextReal === realParent) break;
      realParent = nextReal;
      virtualParent = path.dirname(virtualParent);
      mappedAncestors[up] = virtualParent;
      taskAncestors[up] = realParent;
      pathAliases.push({ from: realParent, to: virtualParent });
    }
    // 控制端报来的各级上级目录里不存在的标记名(只认有对应目录的级别；通往工作区的那一级目录名不算)。
    const ancestorAbsence = payload.virtualWorkspace && payload.ancestorMarkers
      ? payload.ancestorMarkers.levels.flatMap(({ up, present }) => {
          const dir = mappedAncestors[up];
          const towardWorkspace = path.basename(up === 1 ? shadowDir : mappedAncestors[up - 1] ?? '');
          const absent = payload.ancestorMarkers!.names.filter((name) => !present.includes(name) && name !== towardWorkspace);
          return dir && absent.length ? [{ dir, absent: new Set(absent) }] : [];
        })
      : [];
    // 镜像外的绝对路径原样交给任务电脑：只复用它已确认不存在的标记，不猜这台电脑上级目录里隐藏文件的存在性。
    // Windows 与 POSIX 的路径格式不同，不能拿一边的绝对路径直接匹配另一边的 file URI。
    const samePathFormat = (payload.workspace.platform === 'win32') === (process.platform === 'win32');
    const taskAncestorAbsence = payload.virtualWorkspace && payload.ancestorMarkers && samePathFormat
      ? payload.ancestorMarkers.levels.flatMap(({ up, present }) => {
          const dir = taskAncestors[up];
          const towardWorkspace = foreignPath.basename(taskAncestors[up - 1] ?? '');
          const absent = payload.ancestorMarkers!.names.filter((name) => !present.includes(name) && name !== towardWorkspace);
          return dir && absent.length ? [{ dir, absent: new Set(absent) }] : [];
        })
      : [];
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
    // virtualParent 停在控制端有对应目录的最上一级(与控制端 shadowAliases 逐级映射的范围一致)。
    const shortcutLayout: ExecServerShortcutLayout = { mirrorRoot, mappedRoot: virtualParent, ancestorAbsence, taskAncestorAbsence };
    return { shadowDir, mirrorRoot, shortcutLayout, sessionRoot, extraDirs: virtualAll.slice(0, extraCount), writableDirs: virtualAll.slice(extraCount), projectText };
  }

  async function startRun(run: Run, payload: RemoteAgentOpenPayload): Promise<void> {
    run.imageDeliveryEpoch = payload.imageDeliveryEpoch;
    const timing = remoteAgentStartupTiming(deps.log, {
      side: 'host',
      kind: run.kind,
      sessionId: payload.sessionId,
      runId: run.id,
    });
    let status: 'ok' | 'failed' = 'failed';
    let startupComplete = false;
    const execServerStats = {
      shortcutEnabled: false,
      ancestorLevels: payload.ancestorMarkers?.levels.length ?? 0,
      connections: 0,
      answered: 0,
      forwarded: 0,
    };
    try {
      // 中转过来的任务按(控制端, relay)派生：不同受邀者即使任务 id 相同也不会共用本机侧任务。
      const hostSessionId = hostSessionIdFor(guestScopeOf(run.controller, run.relayKey), payload.sessionId);
      run.hostSessionId = hostSessionId;
      run.forkWorkspaceIds = await timing.measure('resume-workspaces', () =>
        forkWorkspacesFor(guestScopeOf(run.controller, run.relayKey), payload.options.resumeSessionId),
      );
      const previousMirrorRoots = run.forkWorkspaceIds.map((id) => path.join(shadowSessionRoot(run.controller, id), 'fs'));
      let guestHome: string | undefined;
      if (run.trust === 'guest') {
        // 先登记再启动：启动中途失败时，受邀者目录与会话记录也能在分享删除时被找到并清理。
        await timing.measure('guest-registration', () =>
          recordGuestSession(run.controller, run.relayKey, hostSessionId, [], undefined, undefined, run.id),
        );
        guestHome = guestHomeFor(guestScopeOf(run.controller, run.relayKey));
        await fsp.mkdir(guestHome, { recursive: true, mode: 0o700 });
      }
      const { shadowDir, mirrorRoot, shortcutLayout, sessionRoot, extraDirs, writableDirs, projectText } = await timing.measure('shadow-workspace', () =>
        withShadowLock(hostSessionId, async () => {
          // 断线后旧实例还没清理就重新打开同一任务时，新旧实例共用同一个影子目录：
          // 先结束旧实例再重建，避免删掉旧 Agent 还在使用的目录，或两个实例争用重建后的目录。
          for (const other of runs.values()) {
            if (other !== run && other.controller === run.controller && other.hostSessionId === hostSessionId && !other.closing) {
              await finishRun(other, 'superseded', 'navigation');
            }
          }
          return prepareShadow(run.controller, payload, hostSessionId, run.trust);
        }),
      );
      run.workspaceDir = sessionRoot;
      run.virtualRoot = payload.virtualWorkspace ? mirrorRoot : undefined;
      // 虚拟工作区里注定不存在的路径查询由本机直接回答，不再逐条跨设备往返(见 execServerShortcut)。
      const shortcut = payload.virtualWorkspace ? createExecServerShortcut(shortcutLayout) : null;
      execServerStats.shortcutEnabled = shortcut !== null;
      const execConns = new Set<string>();
      const tunnel = await timing.measure('tunnel-prepare', () =>
        createRunTunnel({
          http: async (request, signal) => {
            // Pi API-key providers keep their native transports. Their adapter
            // checks this authenticated, run-local endpoint before opening a stream.
            if (request.path === '/cindy/model-access') {
              let model: unknown;
              let providerId: unknown;
              try { ({ model, providerId } = JSON.parse(request.body?.toString('utf8') ?? '{}')); } catch {
                /* deny */
              }
              const current = () => !run.closing && !signal.aborted && deps.isOwnerCurrent(run.owner)
                && deps.isControllerAuthorized(run.controller);
              let allowed = false;
              try {
                if (request.method === 'POST' && current() && typeof model === 'string' && model && model.length <= 512) {
                  allowed = run.trust === 'guest'
                    ? (providerId === undefined || providerId === run.providerId) && await run.guestRoute?.allowsModel?.(model) === true
                    : typeof providerId === 'string' && !!providerId && providerId.length <= 512 && !!run.ownerRoute
                      && deps.ownerModelAllowed?.(hostSessionId, providerId, run.kind, model) === true;
                  allowed = allowed && current();
                }
              } catch {
                /* Failed authorization must never open a native stream. */
              }
              const denial = !allowed && typeof model === 'string' ? run.guestRoute?.modelDenial?.(model) : null;
              return { status: 200, headers: [['content-type', 'application/json']], body: Buffer.from(JSON.stringify({ allowed, ...(denial ? { code: denial.code } : {}) })) };
            }
            return reverseHttp(run, request, signal);
          },
          wsOpen: (connId, wsPath) => {
            (run.localWs ??= new Set()).add(connId);
            if (wsPath.split('?')[0] === EXEC_SERVER_WS_PATH) {
              execConns.add(connId);
              if (!startupComplete) execServerStats.connections += 1;
              if (!startupComplete && shortcut) {
                (run.execStartupBatches ??= new Map()).set(connId, createExecServerStartupBatch({
                  shortcut,
                  forward: data => {
                    if (!startupComplete) execServerStats.forwarded += 1;
                    append(run, { t: 'ws', connId, kind: 'message', data });
                  },
                  answer: data => {
                    if (!startupComplete) execServerStats.answered += 1;
                    run.tunnel?.sendWs(connId, data);
                  },
                }));
              }
            }
            append(run, { t: 'ws', connId, kind: 'open', path: wsPath });
          },
          wsMessage: (connId, data) => {
            const local = shortcut && execConns.has(connId) ? shortcut(data) : null;
            if (local !== null) {
              if (!startupComplete) execServerStats.answered += 1;
              run.tunnel?.sendWs(connId, local);
              return;
            }
            if (run.execStartupBatches?.get(connId)?.request(data)) return;
            if (!startupComplete && execConns.has(connId)) execServerStats.forwarded += 1;
            append(run, { t: 'ws', connId, kind: 'message', data });
          },
          wsClose: (connId) => {
            run.localWs?.delete(connId);
            execConns.delete(connId);
            run.execStartupBatches?.delete(connId);
            append(run, { t: 'ws', connId, kind: 'close' });
          },
        }),
      );
      run.tunnel = tunnel;
      if (run.closing) return;
      // 必须先发布映射，再启动 Agent。Codex startSession 会在 started 之前读取 exec-server 环境。
      if (payload.virtualWorkspace) append(run, { t: 'state', state: {
        workspaceProjection: { shadowDir, mirrorRoot, extraDirs, writableDirs, virtualWorkspace: true, ...(previousMirrorRoots.length ? { previousMirrorRoots } : {}) },
      } });
      // 受邀者：先登记出站边界(本机 proxy 只让这条任务经分享的供应商出站)，再启动 Agent。
      let guestProvider: HostedStartInput['guestProvider'];
      if (run.trust === 'guest') {
        if (!deps.bindGuestProviderRoute || !run.providerId) failProviderNotAllowed();
        const checkRelayModel = async (model?: string): Promise<unknown> => {
          const reply = await reverse(run, { type: 'model-access', ...(model ? { model } : {}) }, AbortSignal.timeout(10_000));
          const value = reply.type === 'callback' ? reply.value : undefined;
          if (value && typeof value === 'object' && !Array.isArray(value)
            && (value as { code?: unknown }).code === 'REMOTE_AGENT_MEMBER_BUDGET_PAUSED') {
            throw new Error('[REMOTE_AGENT_MEMBER_BUDGET_PAUSED] This model has reached your shared-provider model limit.');
          }
          return value;
        };
        let relayModelAccess: { models: string[]; allows(model: string): Promise<boolean> } | undefined;
        if (run.relayKey && payload.relayModelAccess) {
          const models = await checkRelayModel();
          if (!Array.isArray(models) || !models.every(model => typeof model === 'string')) failProviderNotAllowed();
          relayModelAccess = { models, allows: async model => await checkRelayModel(model) === true };
        }
        const binding = await timing.measure('provider-route', () =>
          deps.bindGuestProviderRoute!({
            kind: run.kind,
            hostSessionId,
            providerId: run.providerId!,
            controller: run.controller,
            sessionId: payload.sessionId,
            isCurrent: () => !run.closing && deps.isOwnerCurrent(run.owner),
            ...(relayModelAccess ? { relayModelAccess } : {}),
          }),
        );
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
      } else if (run.providerId) {
        run.ownerRoute = deps.bindOwnerProviderRoute?.(hostSessionId, run.providerId, deps.providerAccess
          ? (providerId, model) => !run.closing && deps.isControllerAuthorized(run.controller)
            && deps.providerAccess!.isAllowed(providerId, run.controller, model, run.sessionId)
          : undefined);
      }
      const handle = await timing.measure('agent-session', () =>
        deps.startHosted({
          ...(run.groupProviderId ? { groupProviderId: run.groupProviderId } : {}),
          kind: run.kind,
          hostSessionId,
          shadowDir,
          mirrorRoot,
          extraDirs,
          writableDirs,
          virtualWorkspace: payload.virtualWorkspace === true,
          ...(payload.personal.instructions ? { personalInstructions: projectText(payload.personal.instructions) } : {}),
          // 恢复标识属于提供方；Pi 的标识即使是文件路径，也不能按控制端路径投影。
          options: Object.fromEntries(Object.entries(payload.options).map(([key, value]) => [
            key,
            typeof value === 'string' && key !== 'resumeSessionId' ? projectText(value) : value,
          ])) as unknown as RemoteAgentWireStartOptions,
          workspace: payload.workspace,
          tunnel: { url: tunnel.url, token: tunnel.token, linkActivity: () => tunnel.linkActivity() },
          mcpServers: payload.mcpServers,
          ...(payload.options.localApplication ? { localApplicationStorage: path.join(guestHomeFor(guestScopeOf(run.controller, run.relayKey)),
            'local-applications', payload.options.localApplication.storageKey, run.kind) } : {}),
          ...(run.trust === 'guest' ? { guest: true, ...(guestHome ? { guestHome } : {}), ...(guestProvider ? { guestProvider } : {}) } : {}),
          ...(payload.options.invalidResumeCallback
            ? {
                onInvalidResumeSession: async (expected: string) => {
                  const reply = await reverse(run, { type: 'callback', name: 'onInvalidResumeSession', args: [expected] });
                  return reply.type === 'callback' && reply.value === true;
                },
              }
            : {}),
        }),
      );
      if (run.closing) {
        await handle.close({ reason: 'navigation' }).catch(() => undefined);
        return;
      }
      run.handle = handle;
      if (run.trust === 'guest' || run.forkWorkspaceIds.length) {
        await timing.measure('session-registration', () =>
          recordGuestSession(run.controller, run.relayKey, hostSessionId, [handle.id, handle.requestSessionId], undefined, run.forkWorkspaceIds),
        );
      }
      handle.setInteractionResolver(async (request: InteractionRequest) => {
        const reply = await reverse(run, { type: 'interaction', request });
        if (reply.type === 'interaction') return reply.result as Awaited<ReturnType<Parameters<AgentSessionHandle['setInteractionResolver']>[0]>>;
        throw new Error(reply.type === 'error' ? reply.error.message : 'interaction failed');
      });
      append(run, { t: 'started', handle: describeHandle(handle, shadowDir, mirrorRoot, extraDirs, writableDirs, payload.virtualWorkspace === true, previousMirrorRoots) });
      run.lastState = JSON.stringify(snapshotHandleState(handle));
      run.stateTimer = setInterval(() => emitState(run), STATE_INTERVAL_MS);
      (run.stateTimer as { unref?: () => void }).unref?.();
      void pumpEvents(run, handle);
      status = 'ok';
    } catch (error) {
      if (await relayAfterLocalStartFailure(run, payload, error)) return;
      if (run.groupResumed && run.providerId) {
        await offerSwitchAfterResumeFailure(run, localGroupMember(run.providerId), error, payload.options.model);
      }
      append(run, { t: 'start-failed', error: remoteAgentErrorInfo(error) });
      await finishRun(run, 'start-failed', 'navigation', false);
    } finally {
      startupComplete = true;
      for (const batch of run.execStartupBatches?.values() ?? []) batch.finish();
      timing.finish(status, execServerStats);
    }
  }

  /**
   * 续接回到原来那台、那台却接不下：与运行中失败同一个判定，那台的问题时给声明了支持的受邀者发凭证(排在启动失败
   * 前面)。受邀者那边据此交接后作为全新任务重新打开，组换一台；不发凭证时受邀者照原来看到启动失败。
   */
  async function offerSwitchAfterResumeFailure(run: Run, member: GroupRelayMember, error: unknown, model: string): Promise<void> {
    if (!run.acceptsGroupSwitch || run.closing) return;
    const message = error instanceof Error ? error.message : String(error);
    const token = await groupSwitchOfferFor(run, member, { message }, model, 'start').catch(() => null);
    if (token && !run.closing) append(run, { t: 'state', state: { [GROUP_SWITCH_STATE_KEY]: token } });
  }

  /**
   * 组为受邀者的全新任务选中了本机这一台，本机 Agent 却没能启动：与组内电脑接不下一样(同一个判定)换组里下一台，
   * 受邀者无感。放掉本机这次尝试占的出站登记、隧道与负载后交给中转；没有下一台或不该换时返回 false，照常报错。
   */
  async function relayAfterLocalStartFailure(run: Run, payload: RemoteAgentOpenPayload, error: unknown): Promise<boolean> {
    const relayDeps = deps.groupRelay;
    const start = run.groupFreshStart;
    if (!relayDeps || !start || !run.providerId || run.closing || run.handle) return false;
    run.groupFreshStart = undefined;
    const local = localGroupMember(run.providerId);
    if (!relayDeps.noteStartFailure(run.providerId, local, error, payload.options.model)) return false;
    const tried = new Set<string>([...start.avoid, local.memberKey]);
    const next = await relayDeps.plan({
      kind: run.kind,
      model: payload.options.model,
      providerId: run.providerId,
      exclude: tried,
      reserve: true,
      reshareKey: reshareKeyForGuest(run.controller),
    }).catch(() => null);
    if (next?.kind !== 'member' || run.closing) {
      if (next && next.kind !== 'unavailable') next.load?.release();
      return false;
    }
    deps.log?.warn('remote agent: this computer did not start the shared task; trying the next computer in the provider group', {
      runId: run.id,
      to: next.memberKey,
      error: String(error),
    });
    run.groupLoad?.release();
    run.groupLoad = undefined;
    run.guestRoute?.release();
    run.guestRoute = undefined;
    run.ownerRoute?.release();
    run.ownerRoute = undefined;
    await run.tunnel?.close().catch(() => undefined);
    run.execStartupBatches?.clear();
    await imagePreparation.get(run);
    run.tunnel = undefined;
    // 本机这次尝试里已告诉受邀者打开的连接一并关掉(隧道关闭不会逐个回调)；中转的连接编号带尝试前缀，不会撞上。
    for (const connId of run.localWs ?? []) append(run, { t: 'ws', connId, kind: 'close' });
    run.localWs = undefined;
    const { memberKey, agentDeviceId, providerId, sameAccount } = next;
    await startRelay(run, payload, { memberKey, agentDeviceId, providerId, sameAccount }, {
      fresh: true,
      avoid: [...tried],
      ...(next.load ? { load: next.load } : {}),
    });
    return true;
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
        meterRunUsage(run, handle.model, event);
        const failure = relayRunFailureOf(event);
        if (failure && isAccountUsageLimitError(failure)) {
          groupTurnFailed = true;
          await deliverQuotaFailure(run, localGroupMember(run.providerId ?? ''), failure, handle.model, () => {
            append(run, { t: 'event', event });
          });
          continue;
        }
        // 受邀者的任务按组分到了本机这一台：本机运行中失败时同样按组的口径冷却(旧版受邀者也一样)，声明了支持的
        // 还可以换一台(凭证排在错误前面)。
        if (run.acceptsGroupSwitch || run.groupLoad) {
          if (failure) {
            groupTurnFailed = true;
            const token = await groupSwitchOfferFor(run, localGroupMember(run.providerId!), failure, handle.model)
              .catch(() => null);
            if (run.closing) break;
            if (token) append(run, { t: 'state', state: { [GROUP_SWITCH_STATE_KEY]: token } });
          } else if (event.type === 'done') {
            noteGroupSwitchTurnEnded(run, groupTurnFailed || !!run.quotaFailure);
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
    // Native close can end this stream. Its caller owns teardown; the event pump
    // must not join that finish and become part of a close -> pump -> close wait.
    if (run.closing) return;
    // RPC 的限额拒绝可能先到、没有原生终态；流结束或抛错都不能抢先作废切换入口。
    await waitForQuotaFailureDelivery(run).catch(error => {
      if (!streamFailed) streamError = error;
      streamFailed = true;
    });
    // 受邀者的任务按组分到了本机这一台、一轮进行中本机的 Agent 意外结束(进程退出、事件流中断)：与组内电脑上的
    // 任务意外结束一样可以换一台——凭证排在收尾前面，收尾按出错处理，受邀者那边才会把这一轮当作失败。
    const midTurn = run.turnRunning === true && lastEventType !== 'done';
    if (run.acceptsGroupSwitch && !run.closing && midTurn && !groupTurnFailed && !run.quotaFailure) {
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

  function meterRunUsage(run: Run, model: string | undefined, event: AgentEvent): void {
    const record = run.trust === 'guest' ? deps.recordGuestUsage : deps.recordOwnerUsage;
    // 换了账号之后迟到的这一轮不记：用量账本按账号存放，记进去会落到新账号名下。
    if (!record || (event.type !== 'done' && event.type !== 'status') || !deps.isOwnerCurrent(run.owner)) return;
    run.usageMeter ??= createGuestUsageMeter(run.kind);
    try {
      const observed = run.usageMeter.observe(event, model ?? '');
      // Native proxy receipts already include root and child tokens. Terminal events only count turns.
      const samples = run.guestRoute?.receiptMetering ? observed.filter(sample => sample.turns > 0).map(sample => ({
        ...sample, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0, sdkCostUsd: 0,
      })) : observed;
      if (samples.length === 0) return;
      // 转给组内电脑的记在那台名下；在本机运行的(含组里选回本机)记为本机。
      const memberKey = run.relay?.member.memberKey ?? PROVIDER_GROUP_LOCAL_MEMBER_KEY;
      record(run.controller, { kind: run.kind, providerId: run.providerId ?? null, memberKey, samples }, run.sessionId);
    } catch (error) {
      deps.log?.warn('remote agent usage record failed', { runId: run.id, error: String(error) });
    }
  }

  // ─── 供应商组：本机是组所在电脑，把受邀者的任务转给组内电脑 ─────────────────

  /** 转给组内电脑的打开载荷：已按受邀者复核过；来源换成那台上的供应商，带防转圈标记与受邀者的 relay 键。 */
  function relayedOpenPayload(run: Run, payload: RemoteAgentOpenPayload, member: GroupRelayMember): RemoteAgentOpenPayload {
    // 「需要换一台」只在受邀者与本机之间：组内电脑不认识也不需要。受邀者自己填的转分享键不转发。
    const { acceptsGroupSwitch: _accepts, groupSwitchToken: _token, reshareKey: _reshare, relayModelAccess: _modelAccess, ...rest } = payload;
    // 分享来的组内电脑按这个人的转分享键核对它的主人是否同意过(provider-sharing.md §4.3)。
    const reshareKey = member.sameAccount ? undefined : reshareKeyForGuest(run.controller);
    return {
      ...rest,
      sessionId: relaySessionIdFor(run.controller, payload.sessionId),
      groupAssigned: true,
      relay: relayKeyFor(run.controller),
      ...(run.relay?.modelAccess ? { relayModelAccess: true } : {}),
      ...(reshareKey ? { reshareKey } : {}),
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
   * 受邀者任务在组内电脑(含本机这一台)上失败：按启动或运行阶段的同一判定，问题出在那台时按组的口径冷却它；受邀者声明了支持、组里还有
   * 能接的电脑(这一轮换下来的不算)时返回一张「需要换一台」凭证，调用方把它排在那次错误前面送出。
   */
  async function groupSwitchOfferFor(
    run: Run,
    member: GroupRelayMember,
    failure: RelayRunFailure,
    model: string,
    phase: 'start' | 'run' = 'run',
  ): Promise<string | null> {
    const relayDeps = deps.groupRelay;
    if (!relayDeps || !run.providerId || !run.hostSessionId) return null;
    const canSwitch = phase === 'start'
      ? relayDeps.noteStartFailure(run.providerId, member, failure.message ?? '', model)
      : relayDeps.noteRunFailure(run.providerId, member, failure, model);
    if (!canSwitch) return null;
    // 旧版受邀者不认识这个状态：照旧只转出原来的错误。
    if (!run.acceptsGroupSwitch) return null;
    const exclude = noteGroupSwitchTried(run, member);
    const next = await relayDeps.plan({
      kind: run.kind,
      model,
      providerId: run.providerId,
      exclude,
      reshareKey: reshareKeyForGuest(run.controller),
    }).catch(() => null);
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
   * SDK 的限额终态与 send() 拒绝可能按任意顺序到达。先交付凭证与唯一一次终态，再返回 RPC 失败，
   * 控制端才能在 active turn 仍在时接管；迟到的同次终态不再触发第二次交接或续跑。
   */
  function deliverQuotaFailure(
    run: Run,
    member: GroupRelayMember,
    failure: RelayRunFailure,
    model: string,
    deliver?: () => void,
  ): Promise<void> {
    if (run.quotaFailure) {
      // 选下一台期间原生终态到了，优先保留它的结构化字段与事件来源。
      if (deliver) run.quotaFailure.deliver = deliver;
      return run.quotaFailure.delivery;
    }
    const pending = { delivery: Promise.resolve(), deliver };
    run.quotaFailure = pending;
    pending.delivery = Promise.resolve().then(async () => {
      const token = run.relay || run.acceptsGroupSwitch || run.groupLoad
        ? await groupSwitchOfferFor(run, member, failure, model).catch(() => null)
        : null;
      if (run.closing || run.quotaFailure !== pending) return;
      if (token) append(run, { t: 'state', state: { [GROUP_SWITCH_STATE_KEY]: token } });
      if (pending.deliver) pending.deliver();
      else append(run, {
        t: 'event',
        event: { type: 'error', source: run.kind, data: { ...failure, isTerminal: true, usageLimit: true } },
      });
      emitState(run);
    });
    return pending.delivery;
  }

  /** 只供被动结束等待；显式关闭仍直接走 finishRun，不等待组选下一台。 */
  async function waitForQuotaFailureDelivery(run: Run): Promise<void> {
    let pending = run.quotaFailure;
    while (!run.closing && pending) {
      await pending.delivery;
      if (run.quotaFailure === pending) return;
      pending = run.quotaFailure;
    }
  }

  /**
   * 受邀者亲自接手(发消息、重试、换模型)后的这次发送：这个任务这一轮已经换下来的电脑清零(§6.1「一轮的边界」)，
   * 之前因故换下、现在已恢复的电脑又能接手。标记只在本机读，去掉后再交给 Agent 或转给组内电脑。
   */
  function takeGroupNewRound(run: Run, callId: string, method: RemoteAgentMethod, args: unknown[]): unknown[] {
    if (method === 'send') {
      run.quotaFailure = undefined;
      run.lastSendCallId = callId;
    }
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
  function issueGroupSwitchTokenFor(controller: string, hostSessionId: string, exclude: ReadonlySet<string>): string {
    const at = now();
    for (const [token, entry] of groupSwitchTokens) {
      if (entry.expiresAt <= at) groupSwitchTokens.delete(token);
    }
    const token = newGroupSwitchToken();
    groupSwitchTokens.set(token, {
      controller,
      hostSessionId,
      exclude: [...exclude],
      expiresAt: at + GROUP_SWITCH_TOKEN_TTL_MS,
    });
    return token;
  }

  function issueGroupSwitchToken(run: Run, exclude: ReadonlySet<string>): string {
    return issueGroupSwitchTokenFor(run.controller, run.hostSessionId!, exclude);
  }

  /** 受邀者交接后重新打开时带回的凭证：短期内幂等，失败重开仍避开原电脑。只认同一受邀者和任务。 */
  function takeGroupSwitchToken(controller: string, hostSessionId: string, token: string | undefined): string[] {
    if (!token) return [];
    const entry = groupSwitchTokens.get(token);
    if (!entry || entry.controller !== controller || entry.hostSessionId !== hostSessionId) return [];
    if (entry.expiresAt > now()) return entry.exclude;
    groupSwitchTokens.delete(token);
    return [];
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
        activity: {},
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
        const quota = isAccountUsageLimitError(failure);
        if (quota && held) {
          void deliverQuotaFailure(run, current, failure, backend.model ?? payload.options.model, deliver);
          return;
        }
        const queue: Array<() => void> = quota ? [] : [deliver];
        held = queue;
        const delivery = quota
          ? deliverQuotaFailure(run, current, failure, backend.model ?? payload.options.model, deliver)
          : groupSwitchOfferFor(run, current, failure, backend.model ?? payload.options.model);
        void delivery
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
      /**
       * 那台上的任务开始运行之后结束了：这个任务也结束。那台按闲置收回的(idleReclaimed)原样转告受邀者，
       * 它连回时组所在电脑按会话记录回到同一台。
       */
      const relayClosed = (reason: string, error?: RemoteAgentErrorInfo, idleReclaimed = false) => {
        const finish = () => {
          if (run.closing) return;
          if (idleReclaimed) run.idleReclaimed = true;
          append(run, {
            t: 'closed',
            reason,
            ...(error ? { error: relayErrorForGuest(error) } : {}),
            ...(idleReclaimed ? { idleReclaimed: true } : {}),
          });
          void finishRun(run, reason, 'navigation', false, true);
        };
        if (run.quotaFailure) {
          void waitForQuotaFailureDelivery(run).then(() => emit(finish), finish);
          return;
        }
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
          meterRunUsage(run, backend.model, event as AgentEvent);
          const deliver = () => {
            if (!run.closing) append(run, { t: 'event', event }, {
              agentDeviceId: current.agentDeviceId,
              sessionId: relaySessionIdFor(run.controller, payload.sessionId),
              relay: relayKeyFor(run.controller),
            });
          };
          const failure = relayRunFailureOf(event);
          if (failure) {
            turnFailed = true;
            if (!held || isAccountUsageLimitError(failure)) {
              holdForGroupSwitch(failure, deliver);
              return;
            }
          }
          if ((event as { type?: unknown }).type === 'done') {
            noteGroupSwitchTurnEnded(run, turnFailed || !!run.quotaFailure);
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
          for (const field of ['turnRunning', 'preparing', 'backgroundTasks', 'pendingWake'] as const) {
            if (field in state) backend.activity[field] = state[field];
          }
          if (run.hostSessionId) {
            void recordGuestSession(run.controller, undefined, run.hostSessionId, [
              typeof state.id === 'string' ? state.id : undefined,
              typeof state.requestSessionId === 'string' ? state.requestSessionId : undefined,
            ], current).catch((error) => {
              deps.log?.warn('remote agent guest session index update failed', { error: String(error) });
            });
          }
          // 组内电脑不能替本机发凭证。
          const { [GROUP_SWITCH_STATE_KEY]: _forged, ...forwarded } = state;
          emit(() => {
            if (!run.closing) append(run, { t: 'state', state: forwarded });
          });
        },
        onRequest: async (request, signal) => {
          if (request.type !== 'model-access') return reverse(run, request, signal);
          const current = () => !run.closing && run.relay === backend && !signal.aborted
            && deps.isOwnerCurrent(run.owner) && deps.isControllerAuthorized(run.controller);
          const providerId = run.providerId;
          if (!current() || !providerId || !deps.providerAccess) return { type: 'callback', value: false };
          if (request.model) {
            try { return { type: 'callback', value: deps.providerAccess.isAllowed(providerId, run.controller, request.model, run.sessionId) }; }
            catch (error) {
              if (error instanceof Error && error.message.includes('[REMOTE_AGENT_MEMBER_BUDGET_PAUSED]'))
                return { type: 'callback', value: { allowed: false, code: 'REMOTE_AGENT_MEMBER_BUDGET_PAUSED' } };
              throw error;
            }
          }
          const models = await deps.providerAccess.models?.(run.kind, providerId, run.controller, run.sessionId);
          // This is the frozen runtime catalog. Temporary usage pauses are evaluated
          // by the individual model checks, so recovery does not require a restart.
          return { type: 'callback', value: current() && models ? models : [] };
        },
        onWs: (item) => {
          if (run.closing || run.relay !== backend) return;
          const connId = relayConnId(attempt, item.connId);
          if (item.kind === 'open') wsOpened.add(connId);
          emit(() => {
            if (!run.closing) append(run, { ...item, connId });
          });
        },
        onClosed: (reason, error, idleReclaimed) => {
          if (run.relay !== backend || run.closing) return;
          if (!backend.started) {
            closedEarly = { reason, ...(error ? { error } : {}) };
            return;
          }
          relayClosed(reason, error, idleReclaimed);
        },
        // 受邀者那边还有这个任务的工作(它在拉取本机时报的 hold)：接着报给组内电脑，免得那台按闲置收回。
        holdsRemote: () => run.heldAt !== undefined && now() - run.heldAt < REMOTE_HOLD_FRESH_MS,
      }, randomUUID, deps.log);
      run.relay = backend;
      try {
        const caps = await RemoteAgentRunClient.caps(connection.invoke);
        backend.modelAccess = caps.relayModelAccess === true && !!deps.providerAccess?.models;
        if (caps.virtualWorkspace !== true
          || (payload.options.localApplication !== undefined && caps.localApplication !== true)
          || (!backend.modelAccess && deps.providerAccess?.restricted?.(groupProviderId, run.controller, run.sessionId))
          || (current.sameAccount ? caps.guestRelay !== true : caps.reshareConsent !== true)) {
          throw new Error('[REMOTE_AGENT_PEER_TOO_OLD] the computer in the provider group cannot take shared tasks yet');
        }
        // 等 caps 期间任务已经结束(撤权、受邀者关闭)：不再打开(收尾已经放掉了这次尝试的负载)。
        if (run.closing) return;
        // 发打开之前先记下这台：它在启动 Agent 之前就会建受邀者目录与会话记录，启动失败、还没有原生会话 id
        // 时，删除受邀者也要能请它清掉。
        if (run.hostSessionId) await recordRelayDevice(run.controller, run.hostSessionId, current.agentDeviceId);
        if (run.closing) return;
        openSent = true;
        await deps.groupRelay?.bindFastPolicy?.({ group: groupProviderId, deviceId: current.agentDeviceId,
          sessionId: relaySessionIdFor(run.controller, payload.sessionId), relay: relayKeyFor(run.controller) });
        if (run.closing) return;
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
        if (run.closing) break;
        // 分享来的那台拒绝了这个人(主人没同意或刚撤回)：组所在电脑重新核对同意情况，之后不再选它。
        const reshareKey = reshareKeyForGuest(run.controller);
        if (!current.sameAccount && reshareKey && /\[REMOTE_AGENT_RESHARE_NOT_ALLOWED\]/.test(String(error))) {
          relayDeps.noteReshareDenied?.(current.agentDeviceId, reshareKey);
        }
        // 续接只能回到原来那台：那台接不下时请受邀者交接后重新打开，由组换一台(凭证排在启动失败前面)。
        if (!options.fresh) {
          await offerSwitchAfterResumeFailure(run, current, error, backend.model ?? payload.options.model);
          break;
        }
        tried.add(current.memberKey);
        // 与本机自己的任务同一个判定：换到哪台都一样的失败不再换，照原来的错误报给受邀者。
        if (!relayDeps.noteStartFailure(groupProviderId, current, error, backend.model ?? payload.options.model)) break;
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
          reshareKey,
        }).catch(() => null);
        if (next?.kind === 'local' && deps.isAgentAvailable(run.kind) && !run.closing) {
          if (next.load) run.groupLoad = next.load;
          // 本机这一台也起不来时同样换下一台(这一轮试过的不再回去)。
          run.groupFreshStart = { avoid: [...tried] };
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
      const args = takeGroupNewRound(run, callId, method, Array.isArray(raw) ? raw : []);
      let callArgs: unknown[] = args;
      if (method === 'setVendorOptions') callArgs = [sanitizeGuestVendorOptions(args[0])];
      if (method === 'setExtraDirs') {
        const library = confineGuestDirs([args[1]], run.virtualRoot)[0] ?? null;
        callArgs = [confineGuestDirs(args[0], run.virtualRoot), library];
      }
      if (method === 'setWritableDirs') callArgs = [confineGuestDirs(args[0], run.virtualRoot)];
      const access = deps.providerAccess;
      if (access && (method === 'send' || method === 'steer') && run.providerId
        && !access.isAllowed(run.providerId, run.controller, run.authorizedModel, run.sessionId)) {
        failProviderNotAllowed();
      }
      if (method === 'setModel') {
        // 来源钉在分享的供应商上(本机按分享的那个供应商核对模型)，转给那台时换成那台上的这个供应商。
        const opts = args[1] && typeof args[1] === 'object' && !Array.isArray(args[1]) ? args[1] as Record<string, unknown> : {};
        if (access) {
          const resolved = await access.resolve(run.kind, typeof args[0] === 'string' ? args[0] : '', run.providerId ?? null, run.controller, run.sessionId);
          if (!resolved) failProviderNotAllowed();
        }
        callArgs = [args[0], { ...opts, providerId: relay.member.providerId }, ...args.slice(2)];
      }
      const value = await relay.client.callWithId(callId, method, callArgs);
      if (method === 'setModel' && typeof args[0] === 'string') run.authorizedModel = args[0];
      if (method === 'commitRewindFiles' && run.kind === 'claude-code') run.rewindPending = true;
      append(run, { t: 'result', callId, ok: true, ...(value !== undefined ? { value: JSON.parse(JSON.stringify(value)) } : {}) });
    } catch (error) {
      const info = relayErrorInfoFrom(error);
      if (method === 'send' && run.lastSendCallId === callId && run.relay === relay) {
        if (run.quotaFailure) await run.quotaFailure.delivery;
        else if (isAccountUsageLimitError(info)) {
          await deliverQuotaFailure(run, relay.member, info, relay.model ?? run.authorizedModel ?? '');
        }
      }
      append(run, { t: 'result', callId, ok: false, error: info });
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
  const runFinishes = new WeakMap<Run, Promise<void>>();
  function finishRun(
    run: Run,
    reason: string,
    teardown: RemoteAgentTeardownReason,
    closeHandle = true,
    skipClosedEvent = false,
    mode: 'close' | 'detach' = 'close',
  ): Promise<void> {
    const pending = runFinishes.get(run);
    if (pending) return pending;
    run.closing = true;
    // Register before calling native close: it can synchronously trigger another
    // finish entry. Every caller joins the first mode/reason and full teardown.
    const finishing = Promise.resolve().then(() => finishRunOnce(run, reason, teardown, closeHandle, skipClosedEvent, mode));
    runFinishes.set(run, finishing);
    return finishing;
  }

  async function finishRunOnce(
    run: Run,
    reason: string,
    teardown: RemoteAgentTeardownReason,
    closeHandle: boolean,
    skipClosedEvent: boolean,
    mode: 'close' | 'detach',
  ): Promise<void> {
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
    run.ownerRoute?.release();
    run.ownerRoute = undefined;
    await run.tunnel?.close().catch(() => undefined);
    run.execStartupBatches?.clear();
    // Native image materialization must finish before the log becomes unreadable.
    await imagePreparation.get(run);
    // 收尾事件绕过 closing 判断直接写入。
    if (!skipClosedEvent) run.log.append({ t: 'closed', reason, ...(run.idleReclaimed ? { idleReclaimed: true } : {}) });
    run.log.end();
    run.closedAt = now();
    deps.log?.info('remote agent run finished', { runId: run.id, reason, ...(run.idleReclaimed ? { idleReclaimed: true } : {}) });
  }

  function finishForHostStop(run: Run, teardown: RemoteAgentTeardownReason): Promise<void> {
    // Do not relabel an intentional disconnect already closing in parallel.
    if (teardown === 'app-quit' && !run.closing && !busyForReclaim(run)) run.idleReclaimed = true;
    // Old controllers silently close idle runs and keep their existing error path
    // for busy runs; new controllers can reconnect either to the native session.
    const reason = teardown === 'app-quit'
      ? run.idleReclaimed ? 'ended' : 'provider-restarting'
      : 'controller-disconnected';
    return finishRun(run, reason, teardown);
  }

  function disposeRun(run: Run): Promise<void> {
    // open ACKs before native startup, which may need poll/reply. Stop first
    // (finishRun rejects reverse requests), then drain startup's last writes.
    // Startup never acquires the guest lock. Keep it in runs until it drains,
    // and coalesce sweep/dispose calls instead of accumulating pending waits.
    const pending = runDisposals.get(run);
    if (pending) return pending;
    const work = (runStarts.get(run) ?? Promise.resolve()).then(() => disposeRunFiles(run));
    runDisposals.set(run, work);
    void work.then(() => runDisposals.delete(run), () => runDisposals.delete(run));
    return work;
  }

  async function disposeRunFiles(run: Run): Promise<void> {
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
    if (!delegatedRunAllowed(run)) fail('REMOTE_AGENT_UNAVAILABLE', 'this shared task is no longer authorized');
    return run;
  }

  function delegatedRunAllowed(run: Run): boolean {
    return run.trust !== 'guest' || (deps.isControllerAuthorized(run.controller)
      && (!!run.relayKey || !deps.directGuestExecution
        || (run.sessionId !== undefined && deps.directGuestExecution.sessionAllowed(run.controller, run.sessionId))));
  }

  async function call(run: Run, callId: string, method: RemoteAgentMethod, payload: RemoteAgentPayload): Promise<void> {
    if (method !== 'setModel') return callOnHandle(run, callId, method, payload);
    const change = (run.modelChange ?? Promise.resolve()).then(() => callOnHandle(run, callId, method, payload));
    run.modelChange = change.catch(() => undefined);
    await change;
  }

  async function callOnHandle(run: Run, callId: string, method: RemoteAgentMethod, payload: RemoteAgentPayload): Promise<void> {
    if (run.relay?.started) return relayCall(run, run.relay, callId, method, payload);
    const handle = run.handle;
    let rollbackProvider: (() => void) | undefined;
    try {
      if (run.closing) fail('REMOTE_AGENT_EXPIRED', 'task has ended');
      if (!delegatedRunAllowed(run)) fail('REMOTE_AGENT_UNAVAILABLE', 'this shared task is no longer authorized');
      if (!handle) fail('REMOTE_AGENT_UNAVAILABLE', 'agent has not started');
      const raw = await resolvePayload(run.controller, payload);
      const args = takeGroupNewRound(run, callId, method, Array.isArray(raw) ? raw : []);
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
      if (access && (method === 'send' || method === 'steer') && run.providerId
        && !access.isAllowed(run.providerId, run.controller, run.authorizedModel, run.sessionId)) {
        failProviderNotAllowed();
      }
      if (access && method === 'setModel') {
        const opts = args[1];
        const optsObject = opts && typeof opts === 'object' && !Array.isArray(opts) ? opts : undefined;
        const explicitProvider = optsObject !== undefined && 'providerId' in optsObject;
        const requested = explicitProvider ? (optsObject as { providerId?: unknown }).providerId : run.providerId;
        const resolved = await access.resolve(
          run.kind,
          typeof args[0] === 'string' ? args[0] : '',
          typeof requested === 'string' ? requested : null,
          run.controller,
          run.sessionId,
        );
        if (!resolved) failProviderNotAllowed();
        if (explicitProvider || run.trust === 'guest') {
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
      if (run.closing) fail('REMOTE_AGENT_EXPIRED', 'task has ended');
      if (!delegatedRunAllowed(run)) fail('REMOTE_AGENT_UNAVAILABLE', 'this shared task is no longer authorized');
      if (nextProviderId && run.ownerRoute && run.providerId) {
        const binding = run.ownerRoute;
        const previousProviderId = run.providerId;
        binding.setProvider(nextProviderId);
        rollbackProvider = () => binding.setProvider(previousProviderId);
      }
      let value: unknown;
      try {
        value = await (target as (...a: unknown[]) => unknown).apply(handle, callArgs);
      } catch (error) {
        rollbackProvider?.();
        throw error;
      }
      if (nextProviderId && !run.closing) run.providerId = nextProviderId;
      if (method === 'setModel' && typeof args[0] === 'string' && !run.closing) run.authorizedModel = args[0];
      if (method === 'commitRewindFiles' && run.kind === 'claude-code') run.rewindPending = true;
      append(run, { t: 'result', callId, ok: true, ...(value !== undefined ? { value: JSON.parse(JSON.stringify(value)) } : {}) });
    } catch (error) {
      const info = remoteAgentErrorInfo(error);
      if (method === 'send' && run.lastSendCallId === callId) {
        if (run.quotaFailure) await run.quotaFailure.delivery;
        else if (isAccountUsageLimitError(info)) {
          await deliverQuotaFailure(run, localGroupMember(run.providerId ?? ''), info, handle?.model ?? run.authorizedModel ?? '');
        }
      }
      append(run, { t: 'result', callId, ok: false, error: info });
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
    wanted: ReadonlyArray<{ runId: string; cursor: number; hold?: true }>,
    waitMs: number,
    signal?: AbortSignal,
  ): Promise<RemoteAgentPollResult> {
    const touch = (updateHold: boolean) => {
      const t = now();
      for (const { runId, hold } of wanted) {
        const run = runs.get(key(controller, runId));
        if (!run || !delegatedRunAllowed(run)) continue;
        run.lastReadAt = t;
        // Only apply the snapshot when this request arrives; an older long poll returning later must
        // not clear a newer hold received with a process startup reply.
        if (!updateHold) continue;
        // 控制端那边还有这个任务的工作在进行：按有活动算，不按闲置收回。
        if (hold) run.activeAt = run.heldAt = t;
        else run.heldAt = undefined;
      }
    };
    const live = () => wanted.flatMap(({ runId, cursor }) => {
      const run = runs.get(key(controller, runId));
      return run && delegatedRunAllowed(run) && run.log.isValidCursor(cursor) ? [{ run, cursor }] : [];
    });
    touch(true);
    const initial = live();
    const anyReady = initial.length < wanted.length || initial.some(({ run, cursor }) => run.log.isReady(cursor));
    if (!anyReady && waitMs > 0) await waitForAny(initial.map(({ run }) => run.log), waitMs, signal);
    touch(false);
    const out: RemoteAgentPollResult = { runs: [] };
    let budget = REMOTE_AGENT_POLL_MAX_BYTES;
    const start = wanted.length ? pollRotation++ % wanted.length : 0;
    for (let index = 0; index < wanted.length; index += 1) {
      const { runId, cursor } = wanted[(start + index) % wanted.length];
      const run = runs.get(key(controller, runId));
      if (run && !delegatedRunAllowed(run)) {
        // A sibling task may keep this guest peer authorized after this task's
        // grant expires. Do not disguise that denial as a missing/restarted run,
        // and never read the now-unauthorized task's buffered content.
        void finishRun(run, 'access-revoked', 'navigation');
        const data = Buffer.from(JSON.stringify({ t: 'closed', reason: 'access-revoked' }) + '\n');
        out.runs.push({ runId, cursor: cursor + data.length, data: data.toString('base64'), done: true });
        continue;
      }
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
    directForgetId?: string,
    directCleanupEpoch?: number,
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
    const directControllers = directForgetId
      ? new Set([...owned.map((run) => run.controller), ...records.map(([, record]) => record.controller)])
      : new Set<string>();
    const directPaths: string[] = [];
    for (const controller of directControllers) {
      const otherRelay = [...map.values()].some((record) => record.controller === controller && !!record.relay)
        || [...runs.values()].some((run) => run.controller === controller && !!run.relayKey);
      const prefix = controllerDir(controller);
      if (!otherRelay) {
        // No relay shares this peer's parent directories: also remove older
        // orphan children whose run ID predated durable attachment indexing.
        directPaths.push(path.join(deps.runsRoot, 'workspaces', prefix),
          path.join(deps.runsRoot, 'attachments', prefix));
        continue;
      }
      // A same-peer relay shares the parent directories. Delete only the
      // direct subdirs recorded before M wrote any guest content.
      const workspaceIds = new Set([
        ...owned.map((run) => run.hostSessionId).filter((id): id is string => !!id),
        ...records.flatMap(([, record]) => [...record.hostSessionIds,
          ...Object.values(record.forkWorkspaces ?? {}).flat()]),
      ]);
      const attachmentIds = new Set([
        ...owned.map((run) => run.id),
        ...records.flatMap(([, record]) => record.attachmentRunIds ?? []),
      ]);
      if ([...workspaceIds, ...attachmentIds].some((id) => !/^[0-9a-f-]{36}$/.test(id))) {
        fail('REMOTE_AGENT_INVALID', 'direct guest cleanup contains an invalid local directory id');
      }
      directPaths.push(...[...workspaceIds].map((id) => path.join(deps.runsRoot, 'workspaces', prefix, id)),
        ...[...attachmentIds].map((id) => path.join(deps.runsRoot, 'attachments', prefix, id)));
    }
    // 受邀者目录里是它的 Codex / Pi 会话历史；Windows 上刚退出的 Agent 可能还占着文件，重试几次。
    const targets = [
      ...[...controllers].flatMap((controller) => ['workspaces', 'attachments'].map((dir) => path.join(deps.runsRoot, dir, controllerDir(controller)))),
      ...directPaths,
      ...[...scopes].map((scope) => guestHomeFor(scope)),
    ];
    await Promise.all(targets.map((target) => {
      const removal = fsp.rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      return directForgetId ? removal : removal.catch(() => undefined);
    }));
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
    if (directForgetId && !deps.purgeHostedTranscripts) {
      fail('REMOTE_AGENT_INVALID', 'direct guest transcript cleanup is unavailable');
    }
    try {
      await deps.purgeHostedTranscripts?.(
        records.flatMap(([, record]) => record.hostSessionIds),
        records.flatMap(([, record]) => record.nativeIds),
      );
    } catch (error) {
      // 留着登记，下次清理重试。
      deps.log?.warn('remote agent transcript purge failed', { error: String(error) });
      if (directForgetId) throw error;
      if (forgets) {
        await persistGuestIndex(map);
        void retryPendingForgets();
      }
      return;
    }
    const updates = new Map<string, GuestSessionRecord | undefined>();
    for (const [digest, record] of records) {
      // 本机这边清完了，只留下还没通知到的组内电脑。
      if (record.forgetPending?.length) {
        updates.set(digest, {
          controller: record.controller,
          ...(record.relay ? { relay: record.relay } : {}),
          hostSessionIds: [],
          nativeIds: [],
          forgetPending: record.forgetPending,
        });
      } else if (directForgetId && record.directOwnerDeviceId && !record.relay) {
        updates.set(digest, { controller: record.controller, hostSessionIds: [], nativeIds: [],
          directOwnerDeviceId: record.directOwnerDeviceId,
          ...(record.directOwnerScopeKey ? { directOwnerScopeKey: record.directOwnerScopeKey } : {}),
          cleanupEpoch: Math.max(map.get(digest)?.cleanupEpoch ?? 0, record.cleanupEpoch ?? 0, directCleanupEpoch ?? 0),
          lastDirectForgetId: directForgetId });
      } else {
        updates.set(digest, undefined);
      }
    }
    // Legacy relay cleanup retains its existing best-effort publication. Direct
    // cleanup keeps the old retryable record until the tombstone is on disk.
    if (!directForgetId) applyGuestIndexUpdates(map, updates);
    await persistGuestIndex(map, directForgetId !== undefined, directForgetId ? updates : undefined);
    if (forgets) void retryPendingForgets();
  }

  let forgetRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let forgetRetrying: Promise<void> | null = null;
  let forgetRetryAgain = false;
  let disposed = false;
  let disposal: Promise<void> | undefined;

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
    return handleRequest(controller, request, signal);
  }

  async function handleRequest(controller: string, request: RemoteAgentRequest,
    signal?: AbortSignal, directLocked = false): Promise<unknown> {
    if (!deps.isControllerAuthorized(controller)) fail('REMOTE_AGENT_UNAVAILABLE', 'remote control is not allowed');
    switch (request.op) {
      case 'native-history': {
        if (trustOf(controller) !== 'owner' || !deps.nativeHistory) fail('REMOTE_AGENT_UNSUPPORTED', 'native history transfer is unavailable');
        const owner = deps.captureOwner();
        const assertCurrent = () => {
          if (!deps.isOwnerCurrent(owner) || !deps.isControllerAuthorized(controller) || trustOf(controller) !== 'owner') {
            fail('REMOTE_AGENT_UNAVAILABLE', 'remote control is not allowed');
          }
        };
        const hostSessionId = hostSessionIdFor(controller, request.sessionId);
        // The controller closes the source run before requesting a snapshot. Never copy a live writer.
        for (const run of runs.values()) {
          if (run.controller === controller && run.hostSessionId === hostSessionId && run.closedAt === undefined) fail('REMOTE_AGENT_BUSY', 'close the running session before transferring its history');
        }
        const workingDir = path.join(shadowSessionRoot(controller, hostSessionId), 'fs', 'workspace', ...Array.from({ length: MAX_ANCESTOR_LEVELS }, () => 'p'));
        const result = await deps.nativeHistory!(`${controller}:${request.sessionId}`, request.command, workingDir, assertCurrent);
        assertCurrent();
        return result;
      }
      case 'direct-locate':
        if (trustOf(controller) !== 'guest' || !deps.directGuestExecution?.locate) fail('REMOTE_AGENT_INVALID', 'location is only for shared users');
        return deps.directGuestExecution.locate(controller, request);
      case 'allocate': {
        if (trustOf(controller) !== 'guest' || !deps.directGuestExecution) fail('REMOTE_AGENT_INVALID', 'allocation is only for shared users');
        if (!directLocked) return withDirectGuestLock(controller, () => handleRequest(controller, request, signal, true));
        // An existing O-hosted task stays on its legacy route, even when an old
        // controller asks to allocate it again without a native resume ID.
        if (deps.directGuestExecution.locate
          && !await deps.directGuestExecution.locate(controller, { op: 'direct-locate', sessionId: request.sessionId })) {
          const record = (await loadGuestIndex()).get(guestDigest(controller));
          if (record?.hostSessionIds.includes(hostSessionIdFor(controller, request.sessionId))
            || [...runs.values()].some((run) => run.controller === controller && !run.relayKey
              && run.sessionId === request.sessionId)) return null;
        }
        return deps.directGuestExecution.allocate(controller, request);
      }
      case 'direct-status':
        if (trustOf(controller) !== 'guest' || !deps.directGuestExecution) fail('REMOTE_AGENT_INVALID', 'status is only for shared users');
        deps.directGuestExecution.status(controller, request);
        return {};
      case 'direct-release':
        if (trustOf(controller) !== 'guest' || !deps.directGuestExecution) fail('REMOTE_AGENT_INVALID', 'release is only for shared users');
        await deps.directGuestExecution.release(controller, request);
        return {};
      case 'direct-switch':
        if (trustOf(controller) !== 'guest' || !deps.directGuestExecution) fail('REMOTE_AGENT_INVALID', 'switch is only for shared users');
        return deps.directGuestExecution.switch(controller, request);
      case 'direct-usage':
        if (trustOf(controller) !== 'owner' || !deps.directGuestExecution) fail('REMOTE_AGENT_INVALID', 'usage requires the owner account');
        await deps.directGuestExecution.usage(controller, request);
        return {};
      case 'delegate': {
        if (trustOf(controller) !== 'owner' || !deps.directGuestExecution) fail('REMOTE_AGENT_INVALID', 'delegation requires the owner account');
        if (!directLocked) return withDirectGuestLock(
          providerShareGuestPeer(request.shareId, request.memberId, request.guestDeviceId),
          () => handleRequest(controller, request, signal, true));
        const revoked = await deps.directGuestExecution.delegate(controller, request);
        if (request.action === 'grant') {
          try {
            await recordDirectGuestOwner(controller, request);
          } catch (error) {
            await deps.directGuestExecution.delegate(controller, { ...request, action: 'revoke' }).catch(() => undefined);
            throw error;
          }
        }
        if (request.action === 'revoke' && revoked) {
          await Promise.all([...runs.values()].filter((run) => {
            const peer = parseProviderSharePeer(run.controller);
            return peer?.role === 'guest' && peer.shareId === request.shareId
              && peer.memberId === request.memberId && peer.deviceId === request.guestDeviceId
              && run.sessionId === request.sessionId;
          }).map((run) => finishRun(run, 'access-revoked', 'navigation')));
        }
        return {};
      }
      case 'fast-policy':
        if (!deps.fastPolicy) fail('REMOTE_AGENT_UNSUPPORTED', 'subscription Fast policy is not supported');
        return deps.fastPolicy!(controller, request);
      case 'fork': {
        const owner = deps.captureOwner();
        const controllerTrust = trustOf(controller);
        if (!directLocked && controllerTrust === 'guest' && !request.relay && deps.directGuestExecution) {
          return withDirectGuestLock(controller, () => handleRequest(controller, request, signal, true));
        }
        const guest = controllerTrust === 'guest' || !!request.relay;
        if (controllerTrust === 'guest' && !request.relay
          && deps.directGuestExecution && !deps.directGuestExecution.sessionAllowed(controller, request.sourceSessionId)) {
          fail('REMOTE_AGENT_INVALID', 'this shared task is not authorized on this computer');
        }
        const scope = guestScopeOf(controller, request.relay);
        const assertAccess = () => {
          if (!deps.isOwnerCurrent(owner) || !deps.isControllerAuthorized(controller)) {
            fail('REMOTE_AGENT_UNAVAILABLE', 'remote control is not allowed');
          }
          if (controllerTrust === 'guest' && !request.relay && deps.directGuestExecution
            && !deps.directGuestExecution.sessionAllowed(controller, request.sourceSessionId)) {
            fail('REMOTE_AGENT_UNAVAILABLE', 'this shared task is no longer authorized');
          }
          if (controllerTrust === 'guest' && request.relay && deps.reshare
            && !deps.reshare.allows(controller, request.reshareKey)) failProviderNotAllowed();
        };
        assertAccess();
        if (guest && (!GUEST_SUPPORTED_AGENTS.has(request.agentKind) || !deps.providerAccess || !deps.bindGuestProviderRoute)) {
          fail('REMOTE_AGENT_PEER_TOO_OLD', 'update Cindy on the computer running this task to fork it');
        }
        if (guest && !(await guestOwnsSession(controller, request.relay, request.sourceSdkSessionId))) {
          fail('REMOTE_AGENT_INVALID', 'this conversation cannot be forked on this computer');
        }
        const providerId = await deps.providerAccess?.resolve(
          request.agentKind, request.model, request.providerId, controller, request.sourceSessionId,
        );
        if (deps.providerAccess && !providerId) failProviderNotAllowed();
        const assertProvider = () => {
          assertAccess();
          if (providerId && !deps.providerAccess?.isAllowed(providerId, controller, request.model, request.sourceSessionId)) failProviderNotAllowed();
        };
        assertProvider();
        const member = guest && !request.relay ? await relayMemberOf(controller, request.sourceSdkSessionId) : null;
        const hostSessionId = hostSessionIdFor(scope, request.sourceSessionId);
        const forkWorkspaceIds = [...new Set([...(await forkWorkspacesFor(scope, request.sourceSdkSessionId)), hostSessionId])];
        let result: RemoteAgentForkResult;
        if (member) {
          if (!deps.groupRelay) fail('REMOTE_AGENT_UNAVAILABLE', 'the computer running this task is unavailable');
          try {
            const { invoke } = deps.groupRelay.connect(member.agentDeviceId);
            const caps = await RemoteAgentRunClient.caps(invoke);
            if (!caps.nativeFork) fail('REMOTE_AGENT_PEER_TOO_OLD', 'update Cindy on the computer running this task to fork it');
            assertProvider();
            result = parseRemoteAgentForkResult(await invoke([{
              ...request,
              sourceSessionId: relaySessionIdFor(controller, request.sourceSessionId),
              newSessionId: relaySessionIdFor(controller, request.newSessionId),
              providerId: member.providerId,
              relay: relayKeyFor(controller),
              reshareKey: reshareKeyForGuest(controller),
            }]));
          } catch (error) {
            // 受邀者只看到中性错误；原始原因只记在本机，组主人排查时才有据可查。
            deps.log?.warn('remote agent: a computer in the provider group could not fork the shared task', {
              to: member.agentDeviceId,
              error: remoteAgentErrorInfo(error),
            });
            const safe = relayErrorForGuest(relayErrorInfoFrom(error)) ?? RELAY_UNAVAILABLE_ERROR;
            fail(safe.code, safe.message);
          }
        } else {
          if (!deps.forkHosted) {
            fail('REMOTE_AGENT_PEER_TOO_OLD', 'update Cindy on the computer running this task to fork it');
          }
          if (!deps.isAgentAvailable(request.agentKind)) {
            // 经供应商组转来的受邀者看不到组内电脑，也装不了它的 Agent：回位置类错误，组所在电脑(含旧版)统一成「暂时不可用」。
            if (request.relay) fail('REMOTE_AGENT_UNAVAILABLE', 'the computer running this task is not available right now');
            fail('REMOTE_AGENT_UNSUPPORTED', 'this agent is not available on the computer running this task');
          }
          const workingDir = path.join(shadowSessionRoot(controller, hostSessionId), 'fs', 'workspace', ...Array.from({ length: MAX_ANCESTOR_LEVELS }, () => 'p'));
          // Idle runs may have released their shadow workspace; native history is retained.
          const native = await withShadowLock(hostSessionId, async () => {
            await fsp.mkdir(workingDir, { recursive: true });
            assertProvider();
            try {
              return await deps.forkHosted!(request.agentKind, {
                sourceSdkSessionId: request.sourceSdkSessionId,
                model: request.model,
                providerId: providerId ?? request.providerId,
                upToMessageId: request.upToMessageId,
                lastTurnId: request.lastTurnId,
                tailTurnsToDrop: request.tailTurnsToDrop,
                forkAtTimestampMs: request.forkAtTimestampMs,
                workingDir,
                ...(guest ? { hostedGuestHome: guestHomeFor(scope) } : {}),
              });
            } catch (error) {
              if (error instanceof Error && /^\[REMOTE_AGENT_[A-Z_]+\]/.test(error.message)) throw error;
              // Agent 自己的分叉失败不是「电脑连不上」：给专门的码，组转发也不会把它换成「暂时不可用」。
              // 原始报错可能带本机路径，只记本机日志。
              deps.log?.warn('remote agent: native fork failed', {
                agentKind: request.agentKind,
                error: remoteAgentErrorInfo(error),
              });
              // 包在 Agent 报错里的远程 Agent 码(如 CodexForkError 的 cause)保留下来，正文换成中性说明。
              // 新错误码只回给声明认识它的控制端(provider-groups.md §14)，旧控制端照旧收到 UNAVAILABLE。
              const nested = error instanceof Error ? remoteAgentErrorCode(error.message) : null;
              fail(nested ?? (request.acceptsForkFailed ? 'REMOTE_AGENT_FORK_FAILED' : 'REMOTE_AGENT_UNAVAILABLE'),
                'the conversation could not be forked on the computer running this task');
            }
          });
          result = {
            newSdkSessionId: native.newSdkSessionId,
            uuidMap: [...native.uuidMap],
            ...(native.initialContextTokens ? { initialContextTokens: native.initialContextTokens } : {}),
            ...(native.usedNativeForkAnchor ? { usedNativeForkAnchor: true } : {}),
          };
        }
        // Register children before returning so a second fork/resume and share deletion use the same ownership boundary.
        assertProvider();
        await recordGuestSession(controller, request.relay, hostSessionId, [result.newSdkSessionId], member ?? undefined,
          member ? undefined : forkWorkspaceIds);
        assertProvider();
        return result;
      }
      case 'images': {
        if (trustOf(controller) === 'guest' && !request.relay && deps.directGuestExecution
          && !deps.directGuestExecution.sessionAllowed(controller, request.sessionId)) {
          fail('REMOTE_AGENT_INVALID', 'this shared task is not authorized on this computer');
        }
        if (!deps.imageArtifacts) fail('REMOTE_AGENT_INVALID', 'image recovery is unavailable');
        const owner = deps.captureOwner();
        const result = await deps.imageArtifacts!(hostSessionIdFor(guestScopeOf(controller, request.relay), request.sessionId), request);
        if (!deps.isOwnerCurrent(owner) || !deps.isControllerAuthorized(controller)
          || (trustOf(controller) === 'guest' && !request.relay && deps.directGuestExecution
            && !deps.directGuestExecution.sessionAllowed(controller, request.sessionId))) {
          fail('REMOTE_AGENT_UNAVAILABLE', 'remote control is not allowed');
        }
        return result;
      }
      case 'caps': {
        const guest = trustOf(controller) === 'guest';
        const limits = deps.readLimits?.() ?? DEFAULT_REMOTE_AGENT_LIMITS;
        const caps: RemoteAgentCaps = {
          ...(deps.fastPolicy ? { subscriptionFastPolicy: true as const } : {}),
          version: REMOTE_AGENT_VERSION,
          agents: (['claude-code', 'codex', 'pi'] as const).map((kind) => ({
            kind,
            available: deps.isAgentAvailable(kind) && (!guest || GUEST_SUPPORTED_AGENTS.has(kind)),
          })),
          maxRuns: limits.perDevice,
          idleReclaimMinutes: limits.idleMinutes ?? 0,
          uploadChunkBytes: REMOTE_AGENT_UPLOAD_CHUNK_BYTES,
          maxPayloadBytes: REMOTE_AGENT_MAX_PAYLOAD_BYTES,
          virtualWorkspace: true,
          localApplication: true,
          ...(deps.forkHosted ? { nativeFork: true } : {}),
          ...(!guest && deps.nativeHistory ? { nativeHistoryTransfer: true } : {}),
          ...(deps.imageArtifacts ? { imageRecovery: true, imageRecoveryRelay: true } : {}),
          // 能按受邀者隔离运行(供应商级授权与出站边界都已接上)，才接受组所在电脑中转过来的受邀者任务。
          ...(deps.providerAccess && deps.bindGuestProviderRoute ? { guestRelay: true } : {}),
          ...(deps.directGuestExecution && deps.providerAccess && deps.bindGuestProviderRoute
            ? { directGuestExecution: true } : {}),
          ...(deps.providerAccess && deps.bindGuestProviderRoute ? { relayModelAccess: true } : {}),
          // 转分享的同意只对受邀者(把这里分享的供应商放进自己组的人)有意义。
          ...(guest && deps.reshare && (deps.reshare.canUse?.(controller) ?? true) ? { reshareConsent: true } : {}),
          ...(guest && deps.reshare && (deps.reshare.canUse?.(controller) ?? true) ? { reshareBatch: true } : {}),
        };
        return caps;
      }
      case 'forget':
        if ('directGuest' in request) {
          // The short-lived lease is gone after deletion. This durable record
          // binds the guest to the authenticated O that originally delegated it.
          if (trustOf(controller) !== 'owner') fail('REMOTE_AGENT_INVALID', 'direct guest cleanup requires the owner computer');
          if (!deps.directGuestExecution?.forget) fail('REMOTE_AGENT_INVALID', 'direct guest cleanup is unavailable');
          const peer = providerShareGuestPeer(request.directGuest.shareId, request.directGuest.memberId,
            request.directGuest.guestDeviceId);
          if (!directLocked) return withDirectGuestLock(peer,
            () => handleRequest(controller, request, signal, true), { controller, ...request.directGuest });
          const record = (await loadGuestIndex()).get(guestDigest(peer));
          const ownerScopeKey = deps.directGuestExecution.ownerScope();
          if (!ownerScopeKey) fail('REMOTE_AGENT_INVALID', 'direct guest account is unavailable');
          if (!record) {
            // A provisional O route can be deleted before its grant reaches M.
            // There is nothing to purge if M has neither a run nor a guest home.
            if ([...runs.values()].some((run) => run.controller === peer && !run.relayKey)) {
              fail('REMOTE_AGENT_INVALID', 'direct guest cleanup is missing its run index');
            }
            try {
              await fsp.stat(guestHomeFor(guestScopeOf(peer, undefined)));
              fail('REMOTE_AGENT_INVALID', 'direct guest cleanup is missing its home index');
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            }
            deps.directGuestExecution.forget(controller, peer, request.directGuest.cleanupEpoch);
            return {};
          }
          if (record.controller !== peer || record.relay || record.directOwnerDeviceId !== controller
            || record.directOwnerScopeKey !== ownerScopeKey) {
            fail('REMOTE_AGENT_INVALID', 'direct guest cleanup is not owned by this computer');
          }
          if ((record.cleanupEpoch ?? 0) > request.directGuest.cleanupEpoch) return {};
          if (record.lastDirectForgetId === request.directGuest.forgetId) return {};
          if (!deps.directGuestExecution.forget(controller, peer, request.directGuest.cleanupEpoch, true)) return {};
          await purgeGuests((run) => run.controller === peer && !run.relayKey,
            (item) => item.controller === peer && !item.relay && item.directOwnerDeviceId === controller,
            false, request.directGuest.forgetId, request.directGuest.cleanupEpoch);
        } else {
          // Group owner only clears the relay scope it issued for this guest.
          await forgetRelay(controller, request.relay);
        }
        return {};
      case 'reshare':
        // 转分享：受邀者的组所在电脑报上它分享的人(整体替换它上一份)，主人逐人同意。同账号电脑经组使用不需要同意。
        if (!deps.reshare || trustOf(controller) !== 'guest' || deps.reshare.canUse?.(controller) === false) {
          fail('REMOTE_AGENT_INVALID', 'reshare is only for shared users');
        }
        return deps.reshare.sync(controller, request.entries, request.batch);
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
        if (!directLocked && controllerTrust === 'guest' && !relayKey && deps.directGuestExecution) {
          // Uploads were consumed above. Re-enter with the decoded payload so
          // authorization, resume lookup and runs.set all happen under the lock.
          return withDirectGuestLock(controller, () => handleRequest(controller,
            { ...request, payload: { json: payload } }, signal, true));
        }
        const trust: RemoteAgentControllerTrust = relayKey ? 'guest' : controllerTrust;
        if (controllerTrust === 'guest' && !relayKey && deps.directGuestExecution
          && !deps.directGuestExecution.sessionAllowed(controller, payload.sessionId)) {
          fail('REMOTE_AGENT_INVALID', 'this shared task is not authorized on this computer');
        }
        if (relayKey && guestUnsupported) {
          fail('REMOTE_AGENT_UNSUPPORTED', `${request.agentKind} is not available to shared users on this computer`);
        }
        // 转分享(provider-sharing.md §4.3)：受邀者的组替它分享的人转来的任务，只在本机主人同意过那个人时运行。
        // 新错误码只回给带了 reshareKey 的组所在电脑；旧版本按「没开放这个供应商」处理，照常换组里下一台。
        const reshareKey = controllerTrust === 'guest' && relayKey ? payload.reshareKey : undefined;
        if (controllerTrust === 'guest' && relayKey && deps.reshare && !deps.reshare.allows(controller, reshareKey)) {
          if (reshareKey) fail('REMOTE_AGENT_RESHARE_NOT_ALLOWED', 'the owner of this computer has not agreed to this user');
          failProviderNotAllowed();
        }
        assertRunCapacity(controller);
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
            payload.sessionId,
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
        // The guest-supplied groupAssigned hint cannot authorize M to route a
        // delegated task into M's own group. Ordinary G→O guests have no local
        // delegation and must retain O's group routing.
        const groupRouted = controllerTrust === 'guest' && !relayKey && !payload.groupAssigned
          && !deps.directGuestExecution?.sessionDelegated(controller, payload.sessionId)
          && !!deps.groupRelay && !!providerId;
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
            if (avoid.length && payload.groupSwitchToken) {
              // A valid token binds this guest and task to the move. Retire its
              // old direct assignment before planning a new executor, so a
              // failed open can retry with the token without reviving old M.
              await deps.directGuestExecution?.switched?.(controller, payload.sessionId,
                payload.groupSwitchToken);
            }
            const plan = await deps.groupRelay.plan({
              kind: request.agentKind,
              model: payload.options.model,
              providerId,
              exclude: new Set(avoid),
              reserve: true,
              reshareKey: reshareKeyForGuest(controller),
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
        if (controllerTrust === 'guest' && !relayKey
          && !deps.directGuestExecution?.sessionDelegated(controller, payload.sessionId)) {
          try {
            // The accepted O fallback, not a possibly stale release notice,
            // retires the direct pin. This also covers a lost release ACK.
            await deps.directGuestExecution?.acceptRelay?.(controller, payload.sessionId,
              !!payload.options.resumeSessionId);
          } catch (error) {
            reserved?.release();
            throw error;
          }
        }
        // 上面有等待：同一个 runId 的重发可能已经先登记了。
        if (runs.has(key(controller, request.runId))) {
          reserved?.release();
          return {};
        }
        // 查询供应商与续接归属期间主人可能已经撤回，而尚未登记的任务不会被 abortReshare 找到。
        // 最后一次核对与 runs.set 之间不能 await；登记后撤回会走正常的任务收尾。
        if (controllerTrust === 'guest' && relayKey && deps.reshare && !deps.reshare.allows(controller, reshareKey)) {
          reserved?.release();
          if (reshareKey) fail('REMOTE_AGENT_RESHARE_NOT_ALLOWED', 'the owner of this computer has not agreed to this user');
          failProviderNotAllowed();
        }
        // 供应商查询/组分配有 await；最终检查与登记间不能再等待，防止并发 open 超额。
        if (controllerTrust === 'guest' && !relayKey && deps.directGuestExecution
          && !deps.directGuestExecution.sessionAllowed(controller, payload.sessionId)) {
          reserved?.release();
          fail('REMOTE_AGENT_UNAVAILABLE', 'this shared task is no longer authorized');
        }
        try {
          // Admission may throw a specific pause error after the awaited group reservation.
          // Nothing owns the reserved load until runs.set, so release it on either rejection path.
          if (providerId && deps.providerAccess && !deps.providerAccess.isAllowed(providerId, controller, payload.options.model, payload.sessionId)) {
            failProviderNotAllowed();
          }
          if (disposed) fail('REMOTE_AGENT_UNAVAILABLE', 'remote agent host has been disposed');
          assertRunCapacity(controller);
        } catch (error) {
          reserved?.release();
          throw error;
        }
        const run: Run = {
          // Routing hints prevent group loops; they are not permission to skip
          // this executor's policy. Direct and relayed guests inherit its local
          // group restriction even when the caller says it was already assigned.
          ...(trust === 'guest' && deps.groupRelay && providerId ? { groupProviderId: providerId } : {}),
          id: request.runId,
          sessionId: payload.sessionId,
          authorizedModel: payload.options.model,
          acceptsImageDeliveryReceipts: payload.acceptsImageDeliveryReceipts === true,
          controller,
          trust,
          ...(relayKey ? { relayKey } : {}),
          ...(reshareKey ? { reshareKey } : {}),
          owner: deps.captureOwner(),
          kind: request.agentKind,
          log: new EventLog(REMOTE_AGENT_HOST_UNREAD_BYTES),
          lastReadAt: now(),
          activeAt: now(),
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
        if (groupRouted && payload.options.resumeSessionId) run.groupResumed = true;
        if (relayTo) {
          const member = relayTo;
          // 先登记再中转：中转中途失败时，分享删除也能找到并清理(含通知那台组内电脑)。
          run.hostSessionId = hostSessionIdFor(controller, payload.sessionId);
          run.imageDeliveryEpoch = payload.imageDeliveryEpoch;
          const load = reserved;
          const starting = recordGuestSession(controller, undefined, run.hostSessionId, [])
            .then(() => startRelay(run, payload, member, { fresh: !payload.options.resumeSessionId, avoid, ...(load ? { load } : {}) }))
            .catch(async (error) => {
              load?.release();
              append(run, { t: 'start-failed', error: relayErrorInfoFrom(error) });
              await finishRun(run, 'start-failed', 'navigation', false);
            });
          runStarts.set(run, starting);
          void starting;
        } else {
          // 组为受邀者的全新任务选中了本机这一台：本机起不来时与组内电脑一样换下一台。
          if (groupRouted && !payload.options.resumeSessionId) run.groupFreshStart = { avoid };
          const starting = startRun(run, payload);
          runStarts.set(run, starting);
          void starting;
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
        run.activeAt = now();
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
        run.activeAt = now();
        pending.resolve(reply);
        return {};
      }
      case 'push': {
        const run = requireRun(controller, request.runId);
        // The first local process may start between poll batches. Its startup reply carries the hold
        // immediately; retries refresh the lease without delivering the frames again.
        if (request.hold) run.activeAt = run.heldAt = now();
        if (run.pushSeq.has(request.seq)) return {};
        run.pushSeq.add(request.seq);
        // Codex 执行环境在控制端的输出与回包：控制端那边还在干活。
        run.activeAt = now();
        if (run.pushSeq.size > 1024) run.pushSeq.delete(run.pushSeq.values().next().value as number);
        const relay = run.relay;
        if (relay) {
          // 中转任务：帧原样转给组内电脑(不拼接)，按任务串行发出以保持顺序；只认当前这次启动尝试的连接。
          const frames = request.frames.flatMap((frame) => {
            const connId = relayMemberConnId(relay.attempt, frame.connId);
            return connId ? [{ ...frame, connId }] : [];
          });
          if (frames.length) {
            const queuedAt = now();
            relay.pushChain = relay.pushChain
              .then(async () => {
                const startedAt = now();
                await relay.client.push(frames);
                const waitMs = startedAt - queuedAt;
                const pushMs = now() - startedAt;
                if (waitMs + pushMs >= RELAY_SLOW_PUSH_MS && !relay.slowPushLogged) {
                  relay.slowPushLogged = true;
                  deps.log?.warn('remote agent relay push slow', { runId: run.id, waitMs, pushMs, frames: frames.length });
                }
              })
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
                run.execStartupBatches?.delete(frame.connId);
                run.tunnel?.closeWs(frame.connId);
              } else run.pushParts.set(frame.connId, joined);
              continue;
            }
            run.pushParts.delete(frame.connId);
            if (!run.execStartupBatches?.get(frame.connId)?.response(joined)) run.tunnel?.sendWs(frame.connId, joined);
          } else {
            run.pushParts.delete(frame.connId);
            // closeWs removes its connection before the close event; wsClose will not run.
            run.execStartupBatches?.delete(frame.connId);
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
    /** O alone may issue a one-use switch token after validating a direct guest assignment. */
    issueDirectGroupSwitchToken(controller: string, sessionId: string, exclude: ReadonlySet<string>): string | null {
      const peer = parseProviderSharePeer(controller);
      if (disposed || peer?.role !== 'guest' || !deps.isControllerAuthorized(controller)
        || !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId) || exclude.size === 0 || exclude.size > 32) return null;
      const hostSessionId = hostSessionIdFor(controller, sessionId);
      const roundKey = key(controller, hostSessionId);
      const previous = groupSwitchRounds.get(roundKey);
      const tried = new Set([...(previous && now() - previous.at <= GROUP_SWITCH_ROUND_MS ? previous.tried : []), ...exclude]);
      if (tried.size > 32) return null;
      groupSwitchRounds.set(roundKey, { tried, at: now() });
      return issueGroupSwitchTokenFor(controller, hostSessionId, tried);
    },
    limitUsage(): RemoteAgentLimitUsage {
      const counts = [...usageByDevice().values()];
      return { total: counts.reduce((sum, count) => sum + count, 0), devices: counts.length, largestDevice: Math.max(0, ...counts) };
    },
    resolveClaudeSessionId(sdkSessionId: string): string | null {
      if (disposed || !sdkSessionId || sdkSessionId === '<pending>') return null;
      for (const run of runs.values()) {
        if (
          run.kind !== 'claude-code'
          || run.trust !== 'owner'
          || run.closing
          || run.closedAt !== undefined
          || run.relay
          || run.handle?.requestSessionId !== sdkSessionId
        ) continue;
        if (!deps.isOwnerCurrent(run.owner)) return null;
        return run.hostSessionId ?? null;
      }
      return null;
    },
    /** 远程控制关闭 / 退出时结束全部任务。 */
    async abortAll(reason: RemoteAgentTeardownReason = 'navigation'): Promise<void> {
      await Promise.all([...runs.values()].map((run) => finishForHostStop(run, reason)));
    },
    /** Old execution hosts cannot retain a newly introduced member restriction. */
    async revalidateModelAccess(): Promise<void> {
      await Promise.all([...runs.values()]
        .filter(run => run.relay && !run.relay.modelAccess && run.providerId
          && deps.providerAccess?.restricted?.(run.providerId, run.controller, run.sessionId))
        .map(run => finishRun(run, 'access-revoked', 'navigation')));
    },
    /** 立即结束某个控制端的全部任务(例如分享被关闭)，不等巡检周期。 */
    async abortControllers(match: (controller: string) => boolean): Promise<void> {
      await Promise.all([...runs.values()]
        .filter((run) => match(run.controller))
        .map((run) => finishRun(run, 'access-revoked', 'navigation')));
    },
    /**
     * 转分享的同意被撤回(provider-sharing.md §4.3)：立即结束匹配控制端(受邀者的组所在电脑)替那个人转来的任务。
     * 那个人的会话记录与目录留着，主人再同意后还能续接；受邀者删除时随它一起清理。
     */
    async abortReshare(match: (controller: string) => boolean, reshareKey: string): Promise<void> {
      await Promise.all([...runs.values()]
        .filter((run) => run.reshareKey === reshareKey && match(run.controller))
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
    dispose(): Promise<void> {
      if (disposal) return disposal;
      if (sweepTimer) clearInterval(sweepTimer);
      sweepTimer = null;
      disposed = true;
      if (forgetRetryTimer) clearTimeout(forgetRetryTimer);
      forgetRetryTimer = null;
      // 退出前尽力收尾：影子工作目录含同步过去的项目与个人说明，不能留到下次启动。
      const stopping = [...runs.values()].map(run =>
        finishForHostStop(run, 'app-quit').then(() => disposeRun(run)),
      );
      // A sweep removes its run from the map before its filesystem cleanup ends.
      disposal = Promise.allSettled([...stopping, ...runDisposals.values()]).then(results => {
        for (const result of results) {
          if (result.status === 'rejected') deps.log?.warn('remote agent disposal failed', { error: String(result.reason) });
        }
      });
      return disposal;
    },
  };
}

export type RemoteAgentHost = ReturnType<typeof createRemoteAgentHost>;
