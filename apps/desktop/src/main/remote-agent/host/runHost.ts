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
import type { AgentEvent, AgentSessionHandle, InteractionRequest } from '@cindy/maker-core';

import { EventLog, waitForAny } from '../eventLog';
import { createGuestUsageMeter, type GuestUsageSample } from './guestUsage';
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
  tunnel: { url: string; token: string };
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
  /** 影子目录重建按 hostSessionId 串行：同一任务的两次打开不并发争用同一个目录。 */
  const shadowLocks = new Map<string, Promise<unknown>>();
  let sweepTimer: ReturnType<typeof setInterval> | null = null;
  const key = (controller: string, id: string) => `${controller}\0${id}`;
  const trustOf = (controller: string): RemoteAgentControllerTrust => deps.controllerTrust?.(controller) ?? 'owner';
  /** 按控制端分开存放的目录名(影子工作区、附件与受邀者目录)。 */
  const controllerDir = (controller: string) => createHash('sha256').update(controller).digest('hex').slice(0, 16);
  /** 受邀者目录：Codex / Pi 的会话历史与 Codex 的运行目录，按控制端跨任务保留，清理时整体删除。 */
  const guestHomeFor = (controller: string) => path.join(deps.runsRoot, 'guest-homes', controllerDir(controller));

  /**
   * 受邀者在本机建立过的会话：恢复与分叉只能接回自己的会话(不能凭 id 接上本机用户自己的
   * 会话)；分享删除时据此清理本机留下的会话记录。落盘，重启后仍然有效。
   */
  interface GuestSessionRecord {
    /** 控制端 key(供应商分享的本地 peer key，含分享与成员，不是秘密)，按成员清理时据此匹配。 */
    controller: string;
    hostSessionIds: string[];
    nativeIds: string[];
  }
  const guestIndexFile = path.join(deps.runsRoot, 'guest-sessions.json');
  const guestDigest = (controller: string) => createHash('sha256').update(controller).digest('hex').slice(0, 32);
  let guestIndex: Promise<Map<string, GuestSessionRecord>> | null = null;
  let guestIndexWrite: Promise<void> = Promise.resolve();

  function loadGuestIndex(): Promise<Map<string, GuestSessionRecord>> {
    guestIndex ??= fsp.readFile(guestIndexFile, 'utf8')
      .then((raw) => {
        const parsed = JSON.parse(raw) as Record<string, Partial<GuestSessionRecord>>;
        const map = new Map<string, GuestSessionRecord>();
        for (const [digest, record] of Object.entries(parsed)) {
          const list = (value: unknown) => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);
          if (typeof record?.controller !== 'string') continue;
          map.set(digest, { controller: record.controller, hostSessionIds: list(record?.hostSessionIds), nativeIds: list(record?.nativeIds) });
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

  async function recordGuestSession(controller: string, hostSessionId: string, nativeIds: ReadonlyArray<string | undefined>): Promise<void> {
    const map = await loadGuestIndex();
    const digest = guestDigest(controller);
    const record = map.get(digest) ?? { controller, hostSessionIds: [], nativeIds: [] };
    let changed = !map.has(digest);
    if (!record.hostSessionIds.includes(hostSessionId)) {
      record.hostSessionIds.push(hostSessionId);
      changed = true;
    }
    for (const id of nativeIds) {
      if (id && !record.nativeIds.includes(id)) {
        record.nativeIds.push(id);
        changed = true;
      }
    }
    if (!changed) return;
    map.set(digest, record);
    await persistGuestIndex(map);
  }

  async function guestOwnsSession(controller: string, nativeId: string): Promise<boolean> {
    const map = await loadGuestIndex();
    return map.get(guestDigest(controller))?.nativeIds.includes(nativeId) ?? false;
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
    const serialized = JSON.stringify(state);
    if (serialized === run.lastState) return;
    run.lastState = serialized;
    append(run, { t: 'state', state });
    // 会话 id 可能在任务中途换新(清空上下文等)，受邀者能恢复的会话随之登记。
    if (run.trust === 'guest' && run.hostSessionId) {
      void recordGuestSession(run.controller, run.hostSessionId, [
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
      await fsp.writeFile(target, isInstruction ? instructionBytes(data, path.dirname(target)) : data);
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
      await writeNew(target, projectBytes(Buffer.from(file.data, 'base64')));
    }
    if (personal.permissions) await mergeLocalPermissions(path.join(shadowDir, '.claude', 'settings.local.json'), Object.fromEntries(Object.entries(personal.permissions).map(([key, rules]) => [key, rules?.map(projectText)])));
    return { shadowDir, mirrorRoot, sessionRoot, extraDirs: virtualAll.slice(0, extraCount), writableDirs: virtualAll.slice(extraCount), projectText };
  }

  async function startRun(run: Run, payload: RemoteAgentOpenPayload): Promise<void> {
    try {
      const hostSessionId = hostSessionIdFor(run.controller, payload.sessionId);
      run.hostSessionId = hostSessionId;
      let guestHome: string | undefined;
      if (run.trust === 'guest') {
        // 先登记再启动：启动中途失败时，受邀者目录与会话记录也能在分享删除时被找到并清理。
        await recordGuestSession(run.controller, hostSessionId, []);
        guestHome = guestHomeFor(run.controller);
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
        tunnel: { url: tunnel.url, token: tunnel.token },
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
      if (run.trust === 'guest') await recordGuestSession(run.controller, hostSessionId, [handle.id, handle.requestSessionId]);
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
    try {
      for await (const event of handle.events()) {
        if (run.closing) break;
        if (run.trust === 'guest') meterGuestUsage(run, handle, event);
        append(run, { t: 'event', event });
        emitState(run);
      }
      await finishRun(run, 'ended', 'navigation', false);
    } catch (error) {
      append(run, { t: 'closed', reason: 'error', error: remoteAgentErrorInfo(error) });
      await finishRun(run, 'error', 'navigation', false, true);
    }
  }

  function meterGuestUsage(run: Run, handle: AgentSessionHandle, event: AgentEvent): void {
    if (!deps.recordGuestUsage || event.type !== 'done') return;
    run.usageMeter ??= createGuestUsageMeter(run.kind);
    try {
      const samples = run.usageMeter.observe(event, handle.model);
      if (samples.length > 0) deps.recordGuestUsage(run.controller, { kind: run.kind, providerId: run.providerId ?? null, samples });
    } catch (error) {
      deps.log?.warn('remote agent guest usage record failed', { runId: run.id, error: String(error) });
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
    const handle = run.handle;
    try {
      if (!handle) fail('REMOTE_AGENT_UNAVAILABLE', 'agent has not started');
      const raw = await resolvePayload(run.controller, payload);
      const args = Array.isArray(raw) ? raw : [];
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
        };
        return caps;
      }
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
        if (!deps.isAgentAvailable(request.agentKind)) fail('REMOTE_AGENT_UNSUPPORTED', `${request.agentKind} is not available on this computer`);
        const trust = trustOf(controller);
        if (trust === 'guest' && (!GUEST_SUPPORTED_AGENTS.has(request.agentKind) || !deps.providerAccess || !deps.bindGuestProviderRoute)) {
          discardPayload(controller, request.payload);
          fail('REMOTE_AGENT_UNSUPPORTED', `${request.agentKind} is not available to shared users on this computer`);
        }
        const active = [...runs.values()].filter((run) => run.controller === controller && run.closedAt === undefined).length;
        if (active >= REMOTE_AGENT_MAX_RUNS_PER_CONTROLLER) fail('REMOTE_AGENT_BUSY', 'too many tasks are running from this computer');
        let payload = decodeOpenPayload(await resolvePayload(controller, request.payload));
        if (trust === 'guest') {
          // 受邀者必须用虚拟工作区：本机 Agent 只看到会话目录内的路径，附加目录也映射在其中。
          if (payload.virtualWorkspace !== true) {
            fail('REMOTE_AGENT_UNSUPPORTED', 'shared users need the virtual workspace; update Cindy on the other computer');
          }
          payload = sanitizeGuestOpenPayload(payload);
          // 只能接回自己在本机建立过的会话：会话 id 不能用来接上本机用户自己的会话。
          const resumeId = payload.options.resumeSessionId;
          if (resumeId && !(await guestOwnsSession(controller, resumeId))) {
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
        // 上面有等待：同一个 runId 的重发可能已经先登记了。
        if (runs.has(key(controller, request.runId))) return {};
        const run: Run = {
          id: request.runId,
          controller,
          trust,
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
        };
        runs.set(key(controller, request.runId), run);
        ensureSweep();
        deps.log?.info('remote agent run opened', { runId: run.id, agent: run.kind });
        void startRun(run, payload);
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
      const owned = [...runs.values()].filter((run) => match(run.controller));
      await Promise.all(owned.map((run) => finishRun(run, 'access-revoked', 'navigation')));
      await Promise.all(owned.map((run) => disposeRun(run)));
      const map = await loadGuestIndex();
      const controllers = new Set([
        ...owned.map((run) => run.controller),
        ...[...map.values()].map((record) => record.controller).filter(match),
      ]);
      // 受邀者目录里是它的 Codex / Pi 会话历史；Windows 上刚退出的 Agent 可能还占着文件，重试几次。
      await Promise.all([...controllers].flatMap((controller) => ['workspaces', 'attachments', 'guest-homes'].map((dir) => (
        fsp.rm(path.join(deps.runsRoot, dir, controllerDir(controller)), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
          .catch(() => undefined)
      ))));
      const records = [...map.entries()].filter(([, record]) => match(record.controller));
      if (!records.length) return;
      try {
        await deps.purgeHostedTranscripts?.(
          records.flatMap(([, record]) => record.hostSessionIds),
          records.flatMap(([, record]) => record.nativeIds),
        );
      } catch (error) {
        // 留着登记，下次清理重试。
        deps.log?.warn('remote agent transcript purge failed', { error: String(error) });
        return;
      }
      for (const [digest] of records) map.delete(digest);
      await persistGuestIndex(map);
    },
    /** 有进行中任务的控制端(分享管理页显示「几个任务运行中」)。 */
    activeControllers(): string[] {
      return [...runs.values()].filter((run) => run.closedAt === undefined && !run.closing).map((run) => run.controller);
    },
    /** 测试与诊断用。 */
    runCount(): number {
      return [...runs.values()].filter((run) => run.closedAt === undefined).length;
    },
    dispose(): void {
      if (sweepTimer) clearInterval(sweepTimer);
      sweepTimer = null;
      // 退出前尽力收尾：影子工作目录含同步过去的项目与个人说明，不能留到下次启动。
      for (const run of runs.values()) void finishRun(run, 'aborted', 'app-quit').then(() => disposeRun(run));
    },
  };
}

export type RemoteAgentHost = ReturnType<typeof createRemoteAgentHost>;
