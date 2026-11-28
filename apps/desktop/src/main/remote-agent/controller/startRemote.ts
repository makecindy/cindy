import { createCompanyReportingRenewal } from './companyReportingRenewal.js';
import { companyExecutionReporting } from '../../usage/companyTokenFacts.js';
import { createAttachmentPreservationReceiver } from '../attachmentPreservation.js';
import type { PreserveAttachmentBatch } from '../../maker-host/attachmentPreservation.js';
import { currentSessionCreationSignal } from '../../localDb/sessionRuntimeCleanup.js';
import { readRemoteProviderGroupUsageLimit } from '../../provider-group/failurePolicy.js';
/**
 * 在另一台电脑上启动 Agent、任务留在本机(控制端入口)。
 *
 * 本机为这个任务准备好执行器(文件与命令在本机执行，过本机权限上限)、本机 Cindy 工具的 MCP
 * 身份与项目说明快照，然后让对方用它自己的 Agent 程序、登录与供应商启动 Agent。返回的句柄对
 * 本机 Maker / Session 来说就是普通会话。
 *
 * 本机部分(执行器及其中的后台命令、本机 MCP 身份、Codex 执行环境中继)跟着句柄走；对方电脑上的
 * Agent 进程是一条可以让出的连接：名额紧张时连接池(connectionPool.ts)只结束对方的进程，对方按主人
 * 设置的时长收回闲置任务(事件流 `closed` 带 idleReclaimed)时也一样，要它干活时带原来的会话 id 连回来，
 * 接回同一套本机部分。
 */
import os from 'node:os';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';

import {
  REMOTE_AGENT_GROUP_SWITCH_STATE_KEY,
  REMOTE_AGENT_PLUGIN_ENGINE_KIND,
  REMOTE_AGENT_RELAY_KEY_PATTERN,
  type RemoteAgentCaps,
  type RemoteAgentEngineKind,
  type RemoteAgentKind,
  type RemoteAgentMethod,
  type RemoteAgentReply,
  type RemoteAgentReverseRequest,
  type RemoteAgentStreamItem,
} from '@cindy/device-link';
import type { AgentEvent, AgentSessionHandle, Effort, StartSessionOptions } from '@cindy/maker-core';
import {
  AgentStartupCleanupPendingError,
  AgentStartupResourcesReleasedError,
  AgentStartupStoppedError,
  createAcpMcpResultBackfiller,
  LOCAL_AGENT_CLIENT,
} from '@cindy/maker-core';
import { withTransientRemoteRetry } from '@cindy/maker-shared/device-link-contract';

import { PROVIDER_SHARE_CREDENTIAL_SESSION_APPROVAL } from '../../../shared/providerShareCredentialConsent';
import { credentialGrantPermission, type CredentialGrantRecord } from '../executor/credentialGrants';
import { RemoteExecutor, type ExecutorCaptureHooks } from '../executor/executor';
import type { PdfTextExtractor } from '../executor/files';
import { ExecutorGate, executorGateModeFor, type ExecutorAction } from '../executor/gate';
import { GitCredentialHistory } from '../executor/gitCredentials';
import type { GuardedFetch } from '../executor/webFetch';
import { ExecutorWorkspace, projectPathText } from '../executor/workspace';
import { remoteAgentStartupTiming } from '../startupTiming';
import type {
  RemoteAgentOpenPayload,
  RemoteAgentWireAncestorFile,
  RemoteAgentWireAncestorMarkers,
  RemoteAgentWireFile,
  RemoteAgentWireImportFile,
  RemoteAgentWirePersonal,
} from '../wire';
import { encodeStartOptions, MAX_ANCESTOR_LEVELS } from '../wire';
import { isRemoteRunLimitError, type PooledRemoteConnection, type RemoteConnectionPool } from './connectionPool';
import {
  createRemoteAgentHandle,
  localizeRemoteError,
  parseStartedInfo,
  type LocalConfirmation,
  type RemoteAgentHandleController,
  type RemoteAgentLink,
  type RemoteStartedInfo,
  type SharedReconnectSendEvidence,
} from './proxyHandle';
import { ExecServerRelay } from './execServerRelay';
import type { ManagedSkillOverlay } from './managedSkillOverlay';
import { createReverseHttpRouter, type LocalMcpTarget } from './router';
import { RemoteAgentPoller, RemoteAgentRemoteError, RemoteAgentRunClient, type RemoteAgentInvoke } from './runClient';
import { isSharedTaskAuthorizationDenied } from './poller';

// Local evidence from the same open that failed. An old offer or a send RPC
// error must never authorize replay of a persisted input.
const stoppedReconnectOffers = new WeakMap<RemoteAgentRemoteError, () => void>();
const reconnectOfferCapture = new AsyncLocalStorage<{
  sessionId: string;
  evidence?: SharedReconnectSendEvidence;
  replacement?: boolean;
}>();

export function withSharedReconnectOfferCapture<T>(
  sessionId: string,
  send: () => Promise<T>,
  evidence?: SharedReconnectSendEvidence,
  replacement?: boolean,
): Promise<T> {
  return reconnectOfferCapture.run({ sessionId, evidence, replacement }, send);
}

interface SharedReconnectHandoff {
  signal?: AbortSignal;
  onOpened(nativeId: string | null): void;
  assertCurrent(): void;
}

const reconnectHandoff = new AsyncLocalStorage<SharedReconnectHandoff & { sessionId: string }>();

export function withSharedReconnectHandoff<T>(
  sessionId: string,
  handoff: SharedReconnectHandoff,
  start: () => Promise<T>,
): Promise<T> {
  return reconnectHandoff.run({ sessionId, ...handoff }, start);
}

export function takeStoppedSharedReconnectOffer(error: unknown): (() => void) | undefined {
  if (!(error instanceof RemoteAgentRemoteError)) return undefined;
  const offer = stoppedReconnectOffers.get(error);
  stoppedReconnectOffers.delete(error);
  return offer;
}

export interface PreparedRemoteMcp {
  /** 本任务可用的本机 MCP 服务(名字 → 带本任务身份的地址与请求头)。 */
  servers: Map<string, LocalMcpTarget>;
  dispose(): void;
  /** Close only the transports owned by a confirmed remote Agent process run. */
  closeSessionInstance?(): void;
  /** Backfill empty ACP MCP tool results from this computer's Host MCP bridge. */
  takeMcpToolResult?: import('@cindy/maker-core').TakeMcpToolResult;
}

export interface StartRemoteAgentDeps {
  attachmentPreservation?(sessionId: string): PreserveAttachmentBatch;
  attachmentStorageRoots?(sessionId: string): Record<string, string>;
  nativeHistoryBackup?: boolean;
  /** The share opens with its owner, without a delegated executor. */
  recoverSharedReconnect?: boolean;
  /** Cancellation for this startup attempt only; never cancels other starts of the task. */
  startupSignal?: AbortSignal;
  /** Recheck this attempt's permission/explicit-close boundary until its first startup finishes. */
  assertStartupCurrent?(): void;
  /** From this point a failed or lost write may have started a process on the executor. */
  onStartupOpenRequest?(): void;
  /** A direct share must renew the original executor's grant before reopening. */
  reconnectAuthorization?(isCurrent: () => boolean, options?: { force?: boolean }): Promise<void>;
  /** Background renewal is allowed only while M has confirmed the current grant. */
  onTaskGrantRenewable?(renewable: boolean): void;
  readImageDeliveryEpoch?(sessionId: string): Promise<number>;
  invoke: RemoteAgentInvoke;
  /** 这台电脑的共享拉取器(同一台电脑上的任务共用一个 poll)；缺省时本任务单独一个。 */
  poller?: RemoteAgentPoller;
  /** 这台电脑的连接池(名额紧张时让出闲置任务的 Agent 进程)；缺省时不让。 */
  pool?: RemoteConnectionPool;
  rgPath: string;
  /** 为本任务登记本机 Cindy 工具的身份，返回可转发的 MCP 服务。 */
  /**
   * vendorOptions 是本任务唯一的一份可变对象：协同等工具改写它后(setVendorOptions)，
   * 本机 MCP 身份要立即看到，所以登记时必须保留同一个引用。
   */
  prepareMcp(input: { kind: RemoteAgentKind; opts: StartSessionOptions; vendorOptions: Record<string, unknown> }): Promise<PreparedRemoteMcp>;
  /** 本机「每轮改动对比」的抓取钩子(按任务绑定)。 */
  capture?(input: { kind: RemoteAgentEngineKind; opts: StartSessionOptions }): ExecutorCaptureHooks | undefined;
  /** 读取要同步到对方影子目录的项目说明类文件。 */
  collectProjectFiles(workingDir: string): Promise<RemoteAgentWireFile[]>;
  /** 项目上级目录里的说明文件；缺省不同步。 */
  collectAncestorFiles?(workingDir: string): Promise<RemoteAgentWireAncestorFile[]>;
  /** 项目各级上级目录里 Codex 要找的名字有没有(对方据此少问)；缺省不带，对方照常逐个来问。 */
  collectAncestorMarkers?(workingDir: string): Promise<RemoteAgentWireAncestorMarkers>;
  /**
   * 你这台的个人配置；缺省不同步。agent：对方 caps 里与托管 Skill 有关的声明(新运行端才有)。
   */
  collectPersonal?(kind: RemoteAgentKind, projectFiles: readonly RemoteAgentWireFile[], agent?: {
    managedSkillDigests?: Readonly<Record<string, string>>;
  }): Promise<{
    personal: RemoteAgentWirePersonal;
    roots: Array<{ relative: string; local: string; managed?: true }>;
  }>;
  /**
   * 说明文件里 `@` 导入的文件(只对 Claude Code)；会就地改写传入说明文件里的引用。缺省不同步。
   */
  collectImports?(input: {
    workingDir: string;
    projectFiles: RemoteAgentWireFile[];
    ancestorFiles: RemoteAgentWireAncestorFile[];
    personal: RemoteAgentWirePersonal;
  }): Promise<RemoteAgentWireImportFile[]>;
  isGitRepo(workingDir: string): Promise<boolean>;
  /** Read 读 PDF 时取文字(Claude Code)。 */
  extractPdfText?: PdfTextExtractor;
  /** 远程执行器访问本机工作树（文件/命令工具）前等待后台 worktree 完整检出就绪。 */
  ensureWorktreeReady?(sessionId: string, signal?: AbortSignal): Promise<void>;
  /**
   * 在本机抓取网页的出站通道：给 Claude Code 提供 WebFetch(供应商分享的受邀者任务，自带的
   * WebFetch 在对方电脑上已关闭)。缺省时不提供。
   */
  webFetch?: GuardedFetch;
  /**
   * 供应商分享的受邀者任务(docs/product-rules/provider-sharing.md §9 第 7 条)：读写凭证类文件、执行读取
   * 凭证的命令不论权限档都要本机用户确认，没有批准时在本机弹确认卡；`description` 是卡上的说明。
   * 同账号任务不提供。`grant` 是这个任务在这个分享上的「本任务总是允许」记录，Agent 实例被系统回收
   * 重建后据此恢复；缺省时授权只在本次启动的执行器内有效。
   */
  credentialConsent?: {
    description: string;
    grant?: CredentialGrantRecord;
    /** 受邀者把这个分享切成了「信任 {分享者}」：每次操作前问一遍，true 时与本机任务一样不弹卡。 */
    skip?: () => boolean;
  };
  /** 改写来自对方的事件(如工具名)。 */
  mapEvent?: (kind: RemoteAgentKind) => ((event: AgentEvent) => AgentEvent) | undefined;
  /** 本机 Codex 程序(给对方的 Codex 提供 exec-server 执行环境)；缺省时不提供。 */
  codexPath?: () => string | undefined;
  /** 这个任务由供应商组分配到那台：告诉那台直接运行，不再进入它自己的组(防转圈)。 */
  groupAssigned?: boolean;
  /**
   * 供应商组「需要换一台」(分享的人，docs/product-rules/provider-groups.md §6.1)：提供即在打开时声明支持。
   * `token` 是交接后重新打开时带回的凭证；对方发来新凭证时交给 `offer`；`takeNewRound` 为 true 的那次发送告诉
   * 对方开始新的一轮(用户亲自接手过)。
   */
  groupSwitch?: { token?: string; requireToken?: true; offer(token: string): void; takeNewRound?(): boolean };
  newId(): string;
  log?: {
    debug?(message: string, meta?: Record<string, unknown>): void;
    info(message: string, meta?: Record<string, unknown>): void;
    warn(message: string, meta?: Record<string, unknown>): void;
  };
}

/** 去掉一层路径(两种分隔符都认)，到根时返回 null。 */
function parentOf(value: string): string | null {
  const normalized = value.replace(/\\/g, '/').replace(/\/+$/, '');
  const index = normalized.lastIndexOf('/');
  if (index <= 0) return null;
  const parent = normalized.slice(0, index);
  return /^[A-Za-z]:$/.test(parent) ? null : parent;
}

/**
 * 取走对方状态里的「需要换一台」凭证(供应商组，组所在电脑发来)：格式正确才交给 `offer`；凭证不并入任务状态。
 * 返回剩下的状态，取走后什么都不剩时返回 null。
 */
export function takeGroupSwitchState(
  state: Record<string, unknown>,
  offer: ((token: string) => void) | undefined,
): Record<string, unknown> | null {
  if (!(REMOTE_AGENT_GROUP_SWITCH_STATE_KEY in state)) return state;
  const { [REMOTE_AGENT_GROUP_SWITCH_STATE_KEY]: token, ...rest } = state;
  if (typeof token === 'string' && REMOTE_AGENT_RELAY_KEY_PATTERN.test(token)) offer?.(token);
  return Object.keys(rest).length ? rest : null;
}

/**
 * 影子目录(对方电脑上的路径) → 本机真实路径的映射。虚拟工作区使用固定 opaque 层级，旧协议
 * 仍按真实路径逐级镜像；同步过去的个人 Skill 等映射回你这台的个人配置目录。越具体的放越前面。
 */
/** 托管 Skill 的映射在影子目录里的虚拟路径(`shadowAliases` 生成的 `from`)。 */
export function managedAliasSources(
  shadowDir: string,
  personalRoots: ReadonlyArray<{ relative: string; managed?: true }>,
): Set<string> {
  const shadow = shadowDir.replace(/[\\/]+$/, '');
  return new Set(personalRoots.filter((root) => root.managed).map((root) => `${shadow}/${root.relative}`));
}

export function shadowAliases(
  started: { shadowDir: string; mirrorRoot?: string; previousMirrorRoots?: string[]; extraDirs?: string[]; writableDirs?: string[]; virtualWorkspace?: boolean },
  workingDir: string,
  personalRoots: ReadonlyArray<{ relative: string; local: string; managed?: true }>,
  directories?: { extraDirs: readonly string[]; writableDirs: readonly string[] },
): Array<{ from: string; to: string }> {
  if (!started.shadowDir) return [];
  const aliases: Array<{ from: string; to: string }> = personalRoots.map((root) => ({
    from: `${started.shadowDir.replace(/[\\/]+$/, '')}/${root.relative}`,
    to: root.local,
  }));
  if (started.virtualWorkspace && directories) {
    for (const key of ['extraDirs', 'writableDirs'] as const) {
      for (const [index, from] of (started[key] ?? []).entries()) {
        const to = directories[key][index];
        if (to) aliases.push({ from, to });
      }
    }
  }
  if (started.virtualWorkspace && started.mirrorRoot) {
    const native = /^[A-Za-z]:|^\\\\/.test(started.mirrorRoot) ? path.win32 : path.posix;
    aliases.push({ from: native.join(started.mirrorRoot, 'home'), to: os.homedir() });
    aliases.push({ from: native.join(started.mirrorRoot, 'tmp'), to: os.tmpdir() });
  }
  const mirrorRoot = started.mirrorRoot?.replace(/\\/g, '/').replace(/\/+$/, '');
  let shadow = started.shadowDir;
  let real = workingDir;
  const realPath = /^[A-Za-z]:|^\\\\/.test(workingDir) ? path.win32 : path.posix;
  aliases.push({ from: shadow, to: real });
  if (!mirrorRoot) return aliases;
  for (;;) {
    const nextShadow = parentOf(shadow);
    const nextReal = realPath.dirname(real);
    if (!nextShadow || nextReal === real || !nextShadow.startsWith(`${mirrorRoot}/`)) break;
    shadow = nextShadow;
    real = nextReal;
    aliases.push({ from: shadow, to: real });
  }
  if (started.virtualWorkspace && Array.isArray(started.previousMirrorRoots)) {
    const current = [...aliases];
    for (const previous of started.previousMirrorRoots) {
      if (typeof previous !== 'string') continue;
      const root = previous.replace(/\\/g, '/').replace(/\/+$/, '');
      if (!root || root === mirrorRoot) continue;
      for (const alias of current) {
        const from = alias.from.replace(/\\/g, '/');
        if (from.startsWith(`${mirrorRoot}/`)) aliases.push({ from: root + from.slice(mirrorRoot.length), to: alias.to });
      }
    }
  }
  return aliases;
}

/** 供应商分享的受邀者任务共用：同一个仓库的扫描结果留给后面的命令与任务。 */
const sharedGitCredentials = new GitCredentialHistory();

/** 凭证类操作的确认卡：用与 Agent 自带工具同名的工具显示本机路径或命令。 */
export function credentialConfirmation(action: ExecutorAction, description: string): LocalConfirmation {
  return confirmationFor(action, {
    description,
    metadata: { hostOwnedConfirmation: 'shared_provider_credential' },
    suggestions: [PROVIDER_SHARE_CREDENTIAL_SESSION_APPROVAL],
  });
}

/**
 * 权限上限拦下的普通操作的确认卡：与本机任务里 Agent 发来的同名工具确认卡一样(只允许这一次，不带
 * 会话级规则)。Agent 所在电脑没有先问本机用户时(如它的自动审查已放行)，由这张卡补问。
 */
export function approvalConfirmation(action: ExecutorAction): LocalConfirmation {
  return confirmationFor(action, { metadata: { permissionScope: 'once' } });
}

function confirmationFor(
  action: ExecutorAction,
  base: Omit<LocalConfirmation, 'toolName' | 'input'>,
): LocalConfirmation {
  switch (action.kind) {
    case 'exec':
      return { ...base, toolName: 'Bash', input: { command: action.command, cwd: action.cwd } };
    case 'write':
      return { ...base, toolName: 'Write', input: { file_path: action.path } };
    case 'fetch':
      return { ...base, toolName: 'WebFetch', input: { url: action.url } };
    default:
      return action.scope === 'tree'
        ? { ...base, toolName: 'Grep', input: { path: action.path } }
        : { ...base, toolName: 'Read', input: { file_path: action.path } };
  }
}

function shellName(): string {
  if (process.platform === 'win32') return 'bash';
  return (process.env.SHELL ?? '/bin/bash').split('/').pop() || 'bash';
}

/**
 * 对方打开任务时会把启动选项里的路径按这台电脑的工作目录(及各级上级目录)、用户目录与附加目录投影到
 * 虚拟工作区(host/runHost.ts prepareShadow)，接回用的会话 id 也不例外。Pi 的会话 id 是对方电脑上的会话文件
 * 路径，两台同为 Mac 或同为 Windows 时常落在这些前缀下(如 /Users)，带过去会被改写成不存在的文件、只能开新会话。
 * 返回 true 表示这个 id 带给对方会被改写。
 */
export function hostRewritesResumeId(
  id: string,
  workspace: { workingDir: string; homeDir?: string; extraDirs: readonly string[]; writableDirs: readonly string[] },
): boolean {
  if (!path.posix.isAbsolute(id) && !path.win32.isAbsolute(id)) return false;
  const local = /^[A-Za-z]:|^\\\\/.test(workspace.workingDir) ? path.win32 : path.posix;
  const marker = '\u0000';
  const aliases: Array<{ from: string; to: string }> = [{ from: workspace.workingDir, to: marker }];
  if (workspace.homeDir) aliases.push({ from: workspace.homeDir, to: marker });
  let parent = workspace.workingDir;
  for (let up = 1; up <= MAX_ANCESTOR_LEVELS; up += 1) {
    const next = local.dirname(parent);
    if (next === parent) break;
    parent = next;
    aliases.push({ from: parent, to: marker });
  }
  for (const dir of [...workspace.extraDirs, ...workspace.writableDirs]) aliases.push({ from: dir, to: marker });
  return projectPathText(id, aliases) !== id;
}

/** 真正的原生会话 id(Claude Code 首轮完成前是占位)。 */
function isNativeSessionId(id: unknown): id is string {
  return typeof id === 'string' && id.length > 0 && id !== '<pending>' && id !== '<failed>';
}

function isConfirmedRunEnd(reason: string, idleReclaimed?: boolean): boolean {
  // The executor reports idleReclaimed even if native close fails: only quiet
  // runs are reclaimed, and the next send starts a new run.
  return idleReclaimed === true || reason === 'ended' || reason === 'closed';
}

/**
 * 连接的状态：connecting(第一次打开或连回中)→ connected → releasing(连接池在让出名额)→ released
 * → connecting …；closed 是句柄已关闭或对方意外结束。
 */
type LinkState = 'connecting' | 'connected' | 'releasing' | 'released' | 'closed';

/** 尚未完成的远程启动(按任务 id)：任务结束或主人改选时只退役这些尝试。 */
const pendingStarts = new Map<string, Set<(reason?: Error) => void>>();

/**
 * 任务被删除或归档时调用。第一次启动还没完成(对方可能还在准备、在供应商组里换电脑或启动 Agent)的，
 * 立即告诉对方结束这个任务，不让它迟到地启动并跑完这一轮(2026-10-22：慢启动期间删掉的任务，对方几分钟后
 * 仍换到另一台电脑启动并生成了回复)。启动已完成的任务由 Maker 照常关闭，这里不管。
 * 主人明确改选时复用同一取消入口，传入改选原因；不把仍保留的任务误报为已结束。
 */
export function cancelPendingRemoteStart(sessionId: string, reason?: Error): void {
  for (const cancel of [...pendingStarts.get(sessionId) ?? []]) cancel(reason);
}

/** Reuse attempt cancellation from allocation through preparation, without a permanent task tombstone. */
export function registerPendingRemoteStart(sessionId: string, parent = currentSessionCreationSignal(sessionId)) {
  const controller = new AbortController();
  const abort = (reason = new Error('[REMOTE_AGENT_EXPIRED] The task has ended on this computer.')) => controller.abort(reason);
  const cancel = (reason?: Error) => abort(reason);
  const cancelParent = () => abort(parent?.reason);
  const cancels = pendingStarts.get(sessionId) ?? new Set<(reason?: Error) => void>();
  pendingStarts.set(sessionId, cancels);
  cancels.add(cancel);
  parent?.addEventListener('abort', cancelParent, { once: true });
  if (parent?.aborted) cancelParent();
  return {
    signal: controller.signal, abort,
    cancellationError(startup: Promise<AgentSessionHandle>): AgentStartupCleanupPendingError {
      const reason: unknown = controller.signal.reason;
      const whenStopped = startup.then(handle => handle.close({ reason: 'account-boundary' }), error => {
        if (error instanceof AgentStartupCleanupPendingError) return error.whenStopped;
        if (error instanceof AgentStartupResourcesReleasedError || error instanceof AgentStartupStoppedError) return;
        // A rejected wait alone does not prove the unpublished resources were released.
        throw error;
      });
      // Some callers do not use Maker; retain the rejection for its lifecycle
      // consumer without an unhandled rejection if no host subscribes to it.
      void whenStopped.catch(() => undefined);
      return new AgentStartupCleanupPendingError(reason instanceof Error ? reason.message : String(reason), {
        cause: reason, whenStopped,
      });
    },
    dispose() {
      parent?.removeEventListener('abort', cancelParent);
      cancels.delete(cancel);
      if (!cancels.size && pendingStarts.get(sessionId) === cancels) pendingStarts.delete(sessionId);
    },
  };
}

export async function startRemoteAgentSession(
  kind: RemoteAgentEngineKind,
  opts: StartSessionOptions,
  deps: StartRemoteAgentDeps,
): Promise<AgentSessionHandle> {
  if (!opts.sessionId) throw new Error('remote agent sessions require a session id');
  // 第一处异步准备之前登记，MCP 启动期间的删除/归档也不能漏掉。
  const sessionId = opts.sessionId;
  const scopedHandoff = reconnectHandoff.getStore();
  const handoff = scopedHandoff?.sessionId === sessionId ? scopedHandoff : undefined;
  handoff?.assertCurrent();
  if (handoff && (!deps.recoverSharedReconnect || !deps.groupSwitch?.token || opts.resumeSessionId)) {
    throw new Error('The confirmed shared reconnect is no longer authorized');
  }
  const startupSignal = handoff?.signal && deps.startupSignal
    ? AbortSignal.any([handoff.signal, deps.startupSignal]) : handoff?.signal ?? deps.startupSignal;
  const abort = registerPendingRemoteStart(sessionId, startupSignal);
  const expired = () => new Error('[REMOTE_AGENT_EXPIRED] The task has ended on this computer.');
  let rejectCancelled!: (error: unknown) => void;
  const cancelled = new Promise<never>((_, reject) => { rejectCancelled = reject; });
  let startup!: Promise<AgentSessionHandle>;
  const onCancelled = () => {
    rejectCancelled(abort.cancellationError(Promise.resolve().then(() => startup)));
  };
  abort.signal.addEventListener('abort', onCancelled, { once: true });
  const timing = remoteAgentStartupTiming(deps.log, { side: 'controller', kind, sessionId });
  let status: 'ok' | 'failed' = 'failed';
  try {
    if (abort.signal.aborted) throw new AgentStartupResourcesReleasedError(abort.signal.reason ?? expired());
    // Reject promptly even when MCP preparation or a remote RPC ignores cancellation.
    // The preparation path still owns cleanup of any late result.
    startup = prepareAndStartRemoteAgentSession(kind, opts, deps, abort.signal, timing).then(async handle => {
      if (abort.signal.aborted) {
        await handle.close({ reason: 'account-boundary' });
        throw new AgentStartupResourcesReleasedError(abort.signal.reason ?? expired());
      }
      return handle;
    });
    const handle = await Promise.race([startup, cancelled]);
    if (handoff) {
      // As in cold startup, if O restarts between opens or the token expires,
      // G can treat an ordinary fresh open as a completed switch. This can add
      // one unnecessary handoff. The failed run received no send.
      try {
        abort.signal.throwIfAborted();
        deps.assertStartupCurrent?.();
        handoff.assertCurrent();
        handoff.onOpened(isNativeSessionId(handle.id) ? handle.id : null);
      } catch (error) {
        await handle.close({ reason: 'navigation' });
        throw error;
      }
    }
    status = 'ok';
    return handle;
  } finally {
    abort.signal.removeEventListener('abort', onCancelled);
    abort.dispose();
    timing.finish(status);
  }
}

async function prepareAndStartRemoteAgentSession(
  kind: RemoteAgentEngineKind,
  opts: StartSessionOptions,
  deps: StartRemoteAgentDeps,
  signal: AbortSignal,
  startupTiming: ReturnType<typeof remoteAgentStartupTiming>,
): Promise<AgentSessionHandle> {
  const client = opts[LOCAL_AGENT_CLIENT];
  const hostToolsOnly = client?.hostToolsOnly === true;
  /**
   * 插件引擎(那台电脑上的插件提供)：本机交过去的 Cindy 工具范围、项目与个人说明文件按内置 Pi 的口径
   * (与本机的插件引擎任务同一约定)；文件与命令经 cindy_exec 在本机执行，写入前的改动抓取同样在本机执行器完成。
   */
  const pluginEngine = kind === REMOTE_AGENT_PLUGIN_ENGINE_KIND;
  const builtinKind: RemoteAgentKind = pluginEngine ? 'pi' : kind;
  if (pluginEngine && client) {
    throw new Error('[REMOTE_AGENT_UNSUPPORTED] Plugin engines are not available to external applications.');
  }
  // 附加目录(只读引用)与可写目录分开跟踪，运行中任一侧变化都重算执行器根目录：
  // 否则新授予的目录过不了本机 shell/root 判定，撤掉的还被本机上限当可信根。
  let extraDirs = [...new Set(opts.extraDirs ?? [])];
  let writableDirs = [...new Set(opts.writableDirs ?? [])];
  /**
   * 第一次打开时交给对方的目录列表。对方按它的顺序给目录起虚拟名(additional/dir-<序号>)，连回时原样再给一次，
   * 对话里出现过的虚拟路径才会指向同一个目录；之后的增减按运行中改目录的方式补发(见 reapply)。
   */
  const openedDirs = { extraDirs: [...(opts.extraDirs ?? [])], writableDirs: [...(opts.writableDirs ?? [])] };
  const workspace = new ExecutorWorkspace({ workingDir: opts.workingDir, extraDirs: [...extraDirs, ...writableDirs] });
  const applyDirs = () => workspace.setExtraDirs([...new Set([...extraDirs, ...writableDirs])]);
  let permissionMode = opts.permissionMode;
  let planMode = opts.planMode === true;
  const credentialConsent = deps.credentialConsent;
  const gate = new ExecutorGate(workspace, executorGateModeFor(permissionMode, planMode), Date.now, {
    confirmCredentials: credentialConsent ? () => credentialConsent.skip?.() !== true : false,
  });
  // 同一任务、同一分享、原始权限档未变时恢复之前的「本任务总是允许」(Orca Worker 等会在两轮之间被回收重建)。
  const grant = credentialConsent?.grant;
  const grantPermission = () => credentialGrantPermission(permissionMode, planMode);
  if (grant?.restore(grantPermission())) gate.restoreCredentialsForSession();
  let controller: RemoteAgentHandleController | null = null;
  const executor = new RemoteExecutor({
    workspace,
    gate,
    rgPath: deps.rgPath,
    capture: deps.capture?.({ kind, opts }),
    ...(opts.sessionId && deps.ensureWorktreeReady
      ? { beforeWorktreeAccess: (execSignal) => deps.ensureWorktreeReady!(opts.sessionId!, execSignal) }
      : {}),
    ...(deps.extractPdfText ? { extractPdfText: deps.extractPdfText } : {}),
    // 只有 Claude Code 经 cindy_exec 使用这组工具。
    ...(kind === 'claude-code' && deps.webFetch ? { webFetch: deps.webFetch } : {}),
    // 权限上限拦下的操作都在本机补问(凭证类用分享凭证卡)，不在没有卡的情况下拒绝。
    confirm: async (action, signal, credential) =>
      controller?.confirm(credentialConsent && credential
        ? credentialConfirmation(action, credentialConsent.description)
        : approvalConfirmation(action), signal) ?? false,
    ...(credentialConsent
      ? {
          gitCredentials: sharedGitCredentials,
          ...(grant
            ? {
                credentialGrant: {
                  remember: () => grant.remember(grantPermission()),
                  forget: () => grant.forget(),
                  watch: (revoke: () => void) => grant.watch(revoke),
                },
              }
            : {}),
        }
      : {}),
  });
  const attachmentRoots = !hostToolsOnly ? deps.attachmentStorageRoots?.(opts.sessionId!) : undefined;
  const attachments = attachmentRoots && deps.attachmentPreservation
    ? createAttachmentPreservationReceiver(deps.attachmentPreservation(opts.sessionId!), async file => {
      const projected = workspace.toAgentPath(file);
      if (projected === file) throw new Error('Attachment path projection unavailable');
      return projected;
    }) : undefined;
  let preparedMcp: PreparedRemoteMcp | undefined;
  let executorDisposal: Promise<void> | undefined;
  const disposePreparation = async (): Promise<void> => {
    const prepared = preparedMcp;
    preparedMcp = undefined;
    executorDisposal ??= Promise.resolve().then(() => executor.close());
    const results = await Promise.allSettled([
      executorDisposal, Promise.resolve().then(() => prepared?.dispose()), Promise.resolve().then(() => attachments?.dispose()),
    ]);
    const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    if (failures.length) throw new AggregateError(failures, 'Remote agent preparation cleanup failed');
  };
  const cancelPreparation = () => { void disposePreparation().catch(error => {
    deps.log?.warn('remote agent: cancelled preparation cleanup failed', { error: String(error) });
  }); };
  signal.addEventListener('abort', cancelPreparation, { once: true });
  const vendorOptions: Record<string, unknown> = { ...(opts.vendorOptions ?? {}) };
  let mcp: PreparedRemoteMcp;
  try {
    if (signal.aborted) throw signal.reason;
    deps.assertStartupCurrent?.();
    mcp = await startupTiming.measure('mcp-prepare', () => deps.prepareMcp({ kind: builtinKind, opts, vendorOptions }));
    preparedMcp = mcp;
    if (signal.aborted) throw signal.reason;
    deps.assertStartupCurrent?.();
  } catch (error) {
    // A late MCP result is disposed here even though the caller already rejected.
    await disposePreparation();
    if (signal.aborted) throw new AgentStartupResourcesReleasedError(signal.reason);
    throw error;
  } finally {
    signal.removeEventListener('abort', cancelPreparation);
  }
  const router = createReverseHttpRouter({ executor, mcpTarget: (name) => mcp.servers.get(name), hostToolsOnly, attachments });

  // 连回对方时按最新值打开(换模型、推理强度等在已让出名额时只记在这里)。
  let model = opts.model;
  let providerId = opts.providerId;
  let effort = opts.effort;
  let fastMode = opts.fastMode;
  let thinkingEnabled = opts.thinkingEnabled;
  let libraryRoot: string | null | undefined;
  let autoReviewFallback = false;
  /** setVendorOptions 改过的内容：对方进程里的状态，连回后再告诉它一次。 */
  const vendorPatches: Record<string, unknown> = {};
  let firstStarted: RemoteStartedInfo | null = null;
  /**
   * 回退 / 分叉的一次性选项(resumeSessionAt / forkSession)要等第一轮跑完才在对方生效：在那之前让出名额，
   * 连回时还要带上，否则回退悄悄失效。跑完一轮后再带会再截断一次，就不带了。
   */
  let oneShotPending = opts.vendorOptions?.resumeSessionAt !== undefined || opts.vendorOptions?.forkSession !== undefined;
  /**
   * 会话里有没有对话(接回的旧会话，或跑完过一轮)。没有时连回就开新会话：Codex 的线程、Pi 的会话文件在
   * 第一轮之前可能还没落盘，带 id 接回反而会被当成接不回。
   */
  let hasHistory = isNativeSessionId(opts.resumeSessionId);
  // Automatic continuation must not silently start with an empty conversation.
  let restartResumeRequired = false;
  let lastStarted: RemoteStartedInfo | null = null;

  let personalRoots: Array<{ relative: string; local: string; managed?: true }> = [];
  /** 上一次打开时托管 Skill 的映射来源：这次不再有的要撤掉。 */
  let managedAliasFroms = new Set<string>();
  /** 托管 Skill 在对方影子目录里的位置 → 本机目录(Codex 经执行环境找 Skill 时补齐上级目录，见 managedSkillOverlay)。 */
  let managedSkillOverlays: ManagedSkillOverlay[] = [];
  /** 正在连或连着的那条连接(Codex 的执行环境帧经它推给对方)。 */
  let active: RemoteAgentRunClient | null = null;
  let linkState: LinkState = 'connecting';
  let idleReclaimedByHost = false;
  /** 进行中的、要对方参与的调用数(期间不让出名额)。 */
  let inflight = 0;
  let lastActivity = Date.now();
  let releasing: Promise<void> | null = null;
  let reconnecting: Promise<RemoteAgentRunClient> | null = null;
  /** O issued a replacement grant that M has not confirmed yet; do not issue another. */
  let taskGrantReissued = false;
  const touch = () => {
    lastActivity = Date.now();
  };
  // 其它回调会改这两个值：读的时候不让 TypeScript 按局部赋值收窄。
  const stateNow = (): LinkState => linkState;
  const requireOpen = () => {
    const handoff = reconnectHandoff.getStore();
    if (handoff && handoff.sessionId === opts.sessionId) handoff.assertCurrent();
    signal.throwIfAborted();
    if (!firstStarted) deps.assertStartupCurrent?.();
    if (stateNow() === 'closed') throw new Error('[REMOTE_AGENT_EXPIRED] The task has ended on this computer.');
  };
  const activeNow = (): RemoteAgentRunClient | null => active;
  // Codex：对方的 Codex 把本机当作 exec-server 执行环境。
  const codexPath = kind === 'codex' && !hostToolsOnly ? deps.codexPath?.() : undefined;
  const relay = codexPath
    ? new ExecServerRelay({
        codexPath,
        cwd: workspace.workingDir,
        workspace,
        authorize: (action) => executor.check(action),
        confirm: (action: ExecutorAction) => executor.confirm(action),
        push: async (frames) => {
          await active?.push(frames);
        },
        log: deps.log,
        // 后台终端跑完：闲置从这时算起。
        onProcessesEnded: () => touch(),
        managedSkillOverlays: () => managedSkillOverlays,
      })
    : null;

  /** 让出后能不能接回原来的会话：没有对话就不用接；会话 id 会被对方改写的(见 hostRewritesResumeId)不让出。 */
  const resumableAfterRelease = () => {
    if (!hasHistory || !controller || !isNativeSessionId(controller.handle.id)) return true;
    return !hostRewritesResumeId(controller.handle.id, { workingDir: opts.workingDir, homeDir: os.homedir(), ...openedDirs });
  };

  const isIdle = () => linkState === 'connected'
    && !!active
    && inflight === 0
    && !active.hasPendingWork
    && !relay?.busy()
    && controller?.isQuiet() === true
    && resumableAfterRelease();

  function closeRunMcpInstance(runId: string): void {
    try { mcp.closeSessionInstance?.(); }
    catch (error) {
      deps.log?.warn('remote agent: closing ended run MCP instance failed', { runId, error: String(error) });
    }
  }

  async function closeStartedRun(client: RemoteAgentRunClient): Promise<void> {
    // A client that has already stopped polling returns from close without a remote receipt.
    if (client.isClosed) return;
    await client.close('close', 'navigation');
    closeRunMcpInstance(client.runId);
  }

  /** 结束对方的这个 Agent 进程，本机部分留着，状态回到已让出(调用前已置为 releasing)。 */
  async function closeRun(client: RemoteAgentRunClient): Promise<void> {
    try {
      // 用 close 而不是 detach：detach 不结束对方的进程，名额让不出来。
      await closeStartedRun(client);
    } catch (error) {
      deps.log?.warn('remote agent: closing a released connection failed', { runId: client.runId, error: String(error) });
      // 没送到：对方可能还占着名额，连接池继续给它占位并再试一次 close。
      deps.pool?.holdAfterFailedClose(member, () => poller.invoke([{ op: 'close', runId: client.runId, mode: 'close', reason: 'navigation' }]));
    } finally {
      // 对方的 Codex 已退出：本机为它起的 exec-server 一并关掉，连回来的 Agent 会重新连。
      relay?.reset();
      if (active === client) active = null;
      if (linkState === 'releasing') linkState = 'released';
    }
  }

  async function release(): Promise<boolean> {
    if (!isIdle() || !active) return false;
    const client = active;
    linkState = 'releasing';
    const done = closeRun(client);
    releasing = done;
    try {
      await done;
    } finally {
      if (releasing === done) releasing = null;
    }
    deps.log?.info('remote agent connection released', { kind, runId: client.runId });
    return true;
  }

  const member: PooledRemoteConnection = {
    occupiesSlot: () => linkState === 'connecting' || linkState === 'connected' || linkState === 'releasing',
    isIdle,
    lastActivityAt: () => lastActivity,
    release,
  };
  const leavePool = deps.pool?.add(member);

  let reportingTimer: ReturnType<typeof setInterval> | undefined;
  const syncReporting = createCompanyReportingRenewal(deps.invoke);
  let localDisposal: Promise<void> | null = null;
  const disposeLocal = (): Promise<void> => {
    clearInterval(reportingTimer);
    if (localDisposal) return localDisposal;
    linkState = 'closed';
    // Attempt every cleanup even if one fails. Preserve the settled result so
    // a second close cannot mistake an unfinished/failed cleanup for success.
    localDisposal = Promise.allSettled([
      Promise.resolve().then(() => leavePool?.()),
      Promise.resolve().then(() => relay?.close()),
      Promise.resolve().then(() => disposePreparation()),
    ]).then((results) => {
      const failures = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
      if (failures.length) throw new AggregateError(failures, 'Remote agent local resource cleanup failed');
    });
    return localDisposal;
  };

  const poller = deps.poller ?? new RemoteAgentPoller(deps.invoke, deps.log);

  /**
   * 开一个 Agent 进程(一个 run)。`onOpened` 在打开成功后同步执行(中间不让出事件循环)，第一次打开时
   * 建句柄，连回时合入状态。
   */
  async function openRun(
    payload: RemoteAgentOpenPayload,
    reconnect: boolean,
    onOpened: (started: RemoteStartedInfo) => void,
    reporting: boolean,
    runId: string,
  ): Promise<RemoteAgentRunClient> {
    let projectionReady = false;
    let opened = false;
    const early: Array<{ type: 'event' | 'state'; value: unknown }> = [];
    let closedEarly: { reason: string; message?: string } | null = null;
    const expectedResume = payload.options.resumeSessionId;
    const capture = reconnectOfferCapture.getStore();
    const captureReconnectOffer = reconnect && deps.recoverSharedReconnect && !!expectedResume
      && capture && capture.sessionId === opts.sessionId && !capture.replacement
      && payload.acceptsGroupSwitch && !payload.groupAssigned;
    let startupSwitchToken: string | undefined;
    let resumeLost = false;
    // 只处理当前这条连接的往来；正在让出名额的那条剩下的收尾不再进任务。
    const isCurrent = () => active === client && linkState !== 'releasing' && linkState !== 'closed';
    // 连回时只补新映射，不替换已有的(见 ExecutorWorkspace.addAliases)。
    const applyProjection = (projection: Parameters<typeof shadowAliases>[0], virtualRoot: string | undefined) => {
      const aliases = shadowAliases(projection, workspace.workingDir, personalRoots, openedDirs);
      const managed = managedAliasSources(projection.shadowDir, personalRoots);
      if (reconnect) {
        // 托管 Skill 每次连回都重新同步(插件更新后目录也变了)：这次的以新的为准，上次有、这次已停用或卸载的也撤掉；
        // 其余映射只补新的。
        workspace.addAliases(aliases, new Set([...managedAliasFroms, ...managed]));
      } else workspace.setAliases(aliases);
      managedAliasFroms = managed;
      const shadow = projection.shadowDir.replace(/[\\/]+$/, '');
      managedSkillOverlays = personalRoots.filter((root) => root.managed).map((root) => ({ agentDir: `${shadow}/${root.relative}`, localDir: root.local }));
      workspace.setVirtualRoot(virtualRoot);
      if (virtualRoot && attachmentRoots) {
        const native = /^[A-Za-z]:|^\\\\/.test(virtualRoot) ? path.win32 : path.posix;
        workspace.addAliases(Object.entries(attachmentRoots).map(([name, to]) => ({ from: native.join(virtualRoot, 'additional', 'attachments', name), to })));
      }
    };
    const client: RemoteAgentRunClient = new RemoteAgentRunClient(runId, poller, {
      onSend: reporting ? () => { void syncReporting(runId, isCurrent); } : undefined,
      onEvent: (event) => {
        if (!isCurrent()) return;
        touch();
        if ((event as { type?: unknown } | null)?.type === 'done') {
          oneShotPending = false;
          hasHistory = true;
        }
        // 打开完成前到的先攒着：连回时要先合入对方启动时的状态，再按顺序交给任务。
        if (controller && opened) controller.onEvent(event);
        else early.push({ type: 'event', value: event });
      },
      onState: (incoming) => {
        if (!isCurrent()) return;
        // 组所在电脑发来的「需要换一台」凭证(排在那次错误前面)：交给供应商组服务，不进任务状态。
        const remaining = takeGroupSwitchState(incoming, token => {
          deps.log?.info('remote agent switch credential received', {
            sessionId: opts.sessionId,
            phase: captureReconnectOffer && !opened ? 'reconnect' : 'run',
          });
          if (captureReconnectOffer && !opened) startupSwitchToken = token;
          else deps.groupSwitch?.offer(token);
        });
        if (!remaining) return;
        let state = remaining;
        const projection = state.workspaceProjection as Parameters<typeof shadowAliases>[0] | undefined;
        if (projection?.virtualWorkspace === true && typeof projection.shadowDir === 'string') {
          applyProjection(projection, projection.mirrorRoot);
          projectionReady = true;
          state = { ...state };
          delete state.workspaceProjection;
          if (!Object.keys(state).length) return;
        }
        if (controller && opened) {
          // 对方的后台任务、待唤醒续跑等刚结束(由忙转闲)：工作结束本身算一次活动，闲置从这时算起。
          const wasQuiet = controller.isQuiet();
          controller.onState(state);
          if (!wasQuiet && controller.isQuiet()) touch();
        }
        else early.push({ type: 'state', value: state });
      },
      onRequest: async (request: RemoteAgentReverseRequest, signal): Promise<RemoteAgentReply> => {
        if (!isCurrent()) {
          return { type: 'error', error: { code: 'REMOTE_AGENT_EXPIRED', message: 'This connection has been released.' } };
        }
        touch();
        if (request.type === 'http') return router(request, signal);
        if (request.type === 'callback' && request.name === 'onInvalidResumeSession') {
          const expected = request.args[0];
          if (reconnect && restartResumeRequired && expected === expectedResume) {
            return { type: 'callback', value: false };
          }
          const value = typeof expected === 'string' && opts.onInvalidResumeSession
            ? await opts.onInvalidResumeSession(expected)
            : false;
          // 连回时原来的会话接不上、对方改开新会话(与 App 重启后接回同一条规则)：不能悄悄丢掉上下文。
          if (reconnect && value && expected === expectedResume && !resumeLost) {
            resumeLost = true;
            controller?.notifyResumeLost();
          }
          return { type: 'callback', value };
        }
        const answered = controller?.onRequest(request);
        if (answered) return answered;
        return { type: 'error', error: { code: 'REMOTE_AGENT_UNAVAILABLE', message: 'This computer is not ready to answer yet.' } };
      },
      onWs: (item: Extract<RemoteAgentStreamItem, { t: 'ws' }>) => {
        if (!isCurrent()) return;
        if (relay) relay.handle(item);
        else if (item.kind === 'open') void client.push([{ connId: item.connId, kind: 'close' }]).catch(() => undefined);
      },
      onClosed: (reason, error, idleReclaimed) => {
        // 让出名额或已被换下的连接：不是任务结束。
        if (active !== client || linkState === 'releasing' || linkState === 'closed') return;
        if (isConfirmedRunEnd(reason, idleReclaimed)) closeRunMcpInstance(client.runId);
        if (!opened) {
          closedEarly = { reason, message: error?.message };
          return;
        }
        deps.onTaskGrantRenewable?.(false);
        // 对方按闲置收回了它的 Agent 进程(它只收回不忙的任务)：与连接池让出名额一样，本机部分与对话都留着，
        // 要它干活时带原来的会话 id 连回。
        // 'aborted' is only a legacy-host compatibility fallback: old hosts used it
        // for both shutdown and deliberate disconnect, with no distinguishing cap.
        // Such an old host may reconnect after a user disconnect (toggle-off still
        // refuses access). New hosts send controller-disconnected for user actions.
        const restart = reason === 'missing' || reason === 'provider-restarting' || reason === 'aborted';
        if (!restart && idleReclaimed && controller?.hasActiveTurn()) {
          // Reuse the release barrier: even a non-send RPC must wait until the
          // queued product terminal settles before it reconnects this handle.
          linkState = 'releasing';
          let finishRelease!: () => void;
          const pendingRelease = new Promise<void>(resolve => { finishRelease = resolve; });
          releasing = pendingRelease;
          controller.onIdleReclaimed(unfinished => {
            if (active === client && linkState === 'releasing') {
              active = null;
              relay?.reset();
              linkState = unfinished ? 'closed' : 'released';
              idleReclaimedByHost = !unfinished;
              if (unfinished) controller?.onClosed(reason, error?.message, client.runId);
              // Reclaim is a live idle observation. The host stops its state
              // timer before closing, so its last snapshot may still be busy.
              else controller?.onState({ turnRunning: false, preparing: false });
            }
            if (releasing === pendingRelease) releasing = null;
            finishRelease();
          });
          return;
        }
        active = null;
        if ((restart || (idleReclaimed && !controller?.hasActiveTurn())) && controller) {
          relay?.reset();
          linkState = 'released';
          idleReclaimedByHost = !restart;
          if (!restart) controller.onState({ turnRunning: false, preparing: false });
          deps.log?.info('remote agent connection released by the other computer', { kind, runId: client.runId, reason });
          if (restart) {
            // A first turn may already have changed local files before its first done.
            // Resume the native conversation, never replay the original request.
            controller.onInterrupted({ reason, runId: client.runId }, () => {
              hasHistory = true;
              restartResumeRequired = true;
            });
          }
          return;
        }
        linkState = 'closed';
        if (controller) controller.onClosed(reason, error?.message, client.runId);
        else void disposeLocal();
      },
      // Codex 经执行环境在本机起的进程还在跑(对方看不到)：拉取时告诉对方，免得被当成闲置收回。
      holdsRemote: () => isCurrent() && relay?.busy() === true,
      recoverAuthorization: async () => {
        const current = () => isCurrent() && opened;
        if (current()) await deps.reconnectAuthorization?.(current);
      },
    }, deps.newId, deps.log);
    if (stateNow() === 'closed') throw new Error('[REMOTE_AGENT_EXPIRED] The task has ended on this computer.');
    active = client;
    let remoteStarted = false;
    try {
      const raw = await client.open(kind, payload, reconnect ? undefined : requireOpen,
        reconnect ? undefined : deps.onStartupOpenRequest);
      remoteStarted = true;
      if (!reconnect) requireOpen();
      if (closedEarly) throw new Error((closedEarly as { message?: string }).message ?? '[REMOTE_AGENT_UNAVAILABLE] The agent stopped right after starting.');
      if (stateNow() === 'closed') {
        // 连回途中任务关掉了(那时还没有这条连接可关)：对方已经起了进程，关掉它让出名额。
        await closeStartedRun(client).catch(() => undefined);
        throw new Error('[REMOTE_AGENT_EXPIRED] The task has ended on this computer.');
      }
      const started = parseStartedInfo(raw, kind);
      if (reconnect && restartResumeRequired && (!expectedResume || started.id !== expectedResume)) {
        // Retire the rejected client before closing it. close() emits a local
        // 'closed' even on failure, so only its successful receipt can clean up.
        if (active === client) active = null;
        await closeStartedRun(client).catch(() => undefined);
        throw new Error('[REMOTE_AGENT_UNAVAILABLE] The original conversation could not be resumed after the supplier stopped.');
      }
      if (!projectionReady) applyProjection(started, started.virtualWorkspace ? started.mirrorRoot : undefined);
      opened = true;
      if (startupSwitchToken) {
        deps.log?.info('remote agent switch credential taken over', { sessionId: opts.sessionId, phase: 'reconnect' });
        deps.groupSwitch?.offer(startupSwitchToken);
      }
      linkState = 'connected';
      idleReclaimedByHost = false;
      lastStarted = started;
      onOpened(started);
      clearInterval(reportingTimer);
      if (reporting && companyExecutionReporting()?.available()) {
        reportingTimer = setInterval(() => { if (isCurrent() && !isIdle()) syncReporting(client.runId, isCurrent); }, 120000);
        reportingTimer.unref();
      }
      for (const item of early.splice(0)) {
        if (item.type === 'event') controller?.onEvent(item.value);
        else controller?.onState(item.value as Record<string, unknown>);
      }
      // 对方没走会话失效回调、却开了别的会话(如 Codex 接不回线程时新开)：同样告诉用户。
      if (reconnect && expectedResume && isNativeSessionId(started.id) && started.id !== expectedResume && !resumeLost) {
        resumeLost = true;
        controller?.notifyResumeLost();
      }
      return client;
    } catch (error) {
      const token = startupSwitchToken;
      const startupStopped = !remoteStarted && error instanceof RemoteAgentRemoteError && error.phase === 'start'
        && error.info.name === 'AgentStartupStoppedError';
      if (!remoteStarted && token && isCurrent()) {
        if (startupStopped && error.info.code === 'SUBSCRIPTION_ACCOUNT_LIMITED') {
          stoppedReconnectOffers.set(error, () => {
            deps.log?.info('remote agent switch credential taken over', { sessionId: opts.sessionId, phase: 'reconnect' });
            deps.groupSwitch?.offer(token);
          });
        } else {
          // Other failures (for example an expired login) retain their existing
          // offer path. This caller may only replay a confirmed quota rejection.
          deps.log?.info('remote agent switch credential taken over', { sessionId: opts.sessionId, phase: 'reconnect' });
          deps.groupSwitch?.offer(token);
        }
      }
      // The adapter can initialize MCP before startup returns. This typed
      // error proves the attempt stopped; a generic start-failed frame does not.
      if (startupStopped && isCurrent()) closeRunMcpInstance(client.runId);
      if (active === client) active = null;
      if (remoteStarted && !client.isClosed) {
        // An invalid started descriptor or a local bootstrap error can occur
        // after the other computer has started its Agent. End that run before
        // the caller falls back to another executor.
        await closeStartedRun(client).catch((closeError) => {
          deps.log?.warn('remote agent: closing a failed startup run failed', {
            runId: client.runId, error: String(closeError),
          });
        });
      } else client.abandon('start-failed');
      if (!remoteStarted && (
        (error instanceof Error && 'code' in error && error.code === 'IPC_ERROR')
        || startupStopped
      )) {
        const quota = readRemoteProviderGroupUsageLimit(error);
        if (quota) throw quota;
      }
      throw error;
    }
  }

  /** 打开时带的启动选项：第一次就是 Maker 给的；连回时换成最新的设置，并接回同一个会话。 */
  function openOptions(reconnect: boolean): StartSessionOptions {
    if (!reconnect || !controller) return opts;
    const state = controller.readState();
    const resumeId = hasHistory && isNativeSessionId(controller.handle.id) ? controller.handle.id : undefined;
    const vendor = { ...vendorOptions };
    if (!oneShotPending) {
      delete vendor.resumeSessionAt;
      delete vendor.forkSession;
    }
    const delivery = lastStarted?.codexProductPromptDelivery;
    const historyHasProductPrompt = delivery && delivery.threadId === resumeId
      ? delivery.historyHasProductPrompt
      : resumeId && resumeId === opts.resumeSessionId ? opts.codexHistoryHasProductPrompt : undefined;
    const next: StartSessionOptions = {
      ...opts,
      model,
      providerId,
      effort: typeof state.effort === 'string' ? state.effort as Effort : effort,
      fastMode: (typeof state.fastMode === 'boolean' || state.fastMode === 'ultrafast') ? state.fastMode : fastMode,
      thinkingEnabled,
      permissionMode,
      planMode: typeof state.planMode === 'boolean' ? state.planMode : planMode,
      ...openedDirs,
      vendorOptions: vendor,
      resumeSessionId: resumeId,
      codexHistoryHasProductPrompt: historyHasProductPrompt,
    };
    for (const key of ['resumeSessionId', 'codexHistoryHasProductPrompt', 'effort', 'fastMode', 'thinkingEnabled', 'providerId'] as const) {
      if (next[key] === undefined) delete next[key];
    }
    return next;
  }

  async function buildPayload(
    reconnect: boolean,
    timing: ReturnType<typeof remoteAgentStartupTiming>,
    caps: RemoteAgentCaps,
  ): Promise<RemoteAgentOpenPayload> {
    // 每次打开都读最新的图片清空代次：让出期间清空过的，连回的新进程按新代次交付。
    const imageDeliveryEpoch = await timing.measure('image-epoch', async () =>
      deps.readImageDeliveryEpoch?.(opts.sessionId!),
    );
    requireOpen();
    const startOptions = openOptions(reconnect);
    const projectFiles = await timing
      .measure('project-files', () => hostToolsOnly ? Promise.resolve([]) : deps.collectProjectFiles(opts.workingDir))
      .catch(() => []);
    requireOpen();
    const ancestorFiles = await timing
      .measure(
        'ancestor-files',
        () => (!hostToolsOnly && deps.collectAncestorFiles?.(opts.workingDir) || Promise.resolve([])),
      )
      .catch(() => []);
    requireOpen();
    // 每次打开(含连回)都重新看一遍：上级目录里的标记以这次打开时为准。
    const ancestorMarkers = await timing
      .measure(
        'ancestor-markers',
        () => (!hostToolsOnly && deps.collectAncestorMarkers?.(opts.workingDir) || Promise.resolve(undefined)),
      )
      .catch(() => undefined);
    requireOpen();
    const collectedPersonal = await timing
      .measure(
        'personal-config',
        () => (!hostToolsOnly && deps.collectPersonal?.(builtinKind, projectFiles, caps.managedSkills
          ? { managedSkillDigests: caps.managedSkills.digests } : undefined) || Promise.resolve(null)),
      )
      .catch(() => null);
    requireOpen();
    personalRoots = collectedPersonal?.roots ?? [];
    const personal = collectedPersonal?.personal ?? { files: [] };
    const importFiles =
      !hostToolsOnly && kind === 'claude-code' && deps.collectImports
        ? await timing
            .measure('instruction-imports', () =>
              deps.collectImports!({ workingDir: opts.workingDir, projectFiles, ancestorFiles, personal }),
            )
            .catch(() => [])
        : [];
    requireOpen();
    const gitRepo = await timing.measure('git-probe', () => deps.isGitRepo(opts.workingDir)).catch(() => false);
    requireOpen();
    return {
      sessionId: opts.sessionId!,
      acceptsImageDeliveryReceipts: true,
      ...(caps.nativeHistoryBackup && deps.nativeHistoryBackup && kind === 'pi'
        ? { acceptsNativeHistoryBackup: true } : {}),
      ...(attachments ? { acceptsAttachmentPreservation: true } : {}),
      ...(imageDeliveryEpoch !== undefined ? { imageDeliveryEpoch } : {}),
      virtualWorkspace: true,
      options: encodeStartOptions(startOptions),
      workspace: {
        workingDir: opts.workingDir,
        ...openedDirs,
        platform: process.platform,
        shell: shellName(),
        osVersion: `${os.type()} ${os.release()}`,
        // 仅供被控端把项目说明中的本机 Home 路径投影到虚拟工作区；不会进入 deviceHosted。
        homeDir: os.homedir(),
        isGitRepo: gitRepo,
      },
      projectFiles,
      ancestorFiles,
      ...(ancestorMarkers ? { ancestorMarkers } : {}),
      ...(importFiles.length ? { importFiles } : {}),
      personal,
      mcpServers: [...mcp.servers.keys()],
      ...(deps.groupAssigned ? { groupAssigned: true } : {}),
      ...(deps.groupSwitch ? { acceptsGroupSwitch: true } : {}),
      // 交接凭证只给全新打开用；连回是接着原来的会话。
      ...(!reconnect && deps.groupSwitch?.token ? { groupSwitchToken: deps.groupSwitch.token } : {}),
      ...(!reconnect && deps.groupSwitch?.requireToken ? { requireGroupSwitchToken: true as const } : {}),
    };
  }

  /**
   * 打开前问对方的能力与当前上限(每次都问：对方可能刚改了上限)；名额紧张时先由连接池让出名额。
   * 对方以名额已满拒绝时让一个再重试一次，没有能让的就照原样报错。
   */
  async function connect(
    reconnect: boolean,
    onOpened: (started: RemoteStartedInfo) => void,
  ): Promise<RemoteAgentRunClient> {
    const timing = reconnect
      ? remoteAgentStartupTiming(deps.log, {
          side: 'controller',
          kind,
          sessionId: opts.sessionId,
          reconnect,
        })
      : startupTiming;
    let status: 'ok' | 'failed' = 'failed';
    try {
      // 重启恢复可能撞上 relay 尚未上线/拥堵冷却；只重试无副作用的能力读取，
      // 等既有链路自行恢复。open/upload/send 的交付不确定时不能整次重放。
      const caps = await timing.measure('capability-handshake', () =>
        withTransientRemoteRetry(() => {
          if (linkState === 'closed') {
            throw new Error('[REMOTE_AGENT_EXPIRED] The task has ended on this computer.');
          }
          return RemoteAgentRunClient.caps(deps.invoke);
        }),
      );
      requireOpen();
      if (caps.virtualWorkspace !== true) {
        throw new Error('[REMOTE_AGENT_UNSUPPORTED] The other computer does not support the virtual workspace required to protect local paths.');
      }
      // 不认识插件引擎的旧版本会把打开请求判成无效；先说清楚要更新，绝不改用那台的内置引擎。
      if (pluginEngine && caps.pluginEngines !== true) {
        throw new Error('[REMOTE_AGENT_PEER_TOO_OLD] Update Cindy on the computer that has this plugin engine to use it from another computer.');
      }
      if (client && caps.localApplication !== true) {
        throw new Error('[REMOTE_AGENT_PEER_TOO_OLD] Update Cindy on the computer providing this supplier to use it from an external application.');
      }
      if (!reconnect && deps.groupSwitch?.requireToken && !caps.directGuestStandby) {
        throw new Error('[REMOTE_AGENT_PEER_TOO_OLD] The owner does not support confirmed standby task handoff.');
      }
      deps.pool?.noteMaxRuns(caps.maxRuns);
      deps.pool?.noteIdleReclaimMinutes(caps.idleReclaimMinutes);
      await timing.measure('connection-slot', async () => deps.pool?.beforeOpen(member));
      requireOpen();
      const reporting = caps.companyTokenReporting === true && companyExecutionReporting()?.available() === true;
      const reserveRun = () => {
        const id = deps.newId();
        if (reporting) syncReporting(id, () => stateNow() !== 'closed');
        return id;
      };
      const firstRun = reserveRun();
      const payload = await buildPayload(reconnect, timing, caps);
      requireOpen();
      try {
        const client = await timing.measure('remote-open', () =>
          openRun(payload, reconnect, onOpened, reporting, firstRun),
        );
        status = 'ok';
        return client;
      } catch (error) {
        if (!deps.pool || linkState === 'closed' || !isRemoteRunLimitError(error) || !await deps.pool.releaseForRetry(member)) throw error;
        const client = await timing.measure('remote-open', () =>
          openRun(payload, reconnect, onOpened, reporting, reserveRun()),
        );
        status = 'ok';
        return client;
      }
    } finally {
      if (reconnect) timing.finish(status);
    }
  }

  /**
   * 连回后补上对方进程里的状态(不在启动选项里的)。任一步失败就抛错：不能让消息在缺设置的 Agent 上执行
   * (目录没给到，消息里的虚拟路径就落空；自动审查兜底没恢复则少了一道安全设置)。
   * 目录：打开时给的是第一次的列表，之后的增减在这里按运行中改目录的方式补发，与一直连着时的效果一致。
   */
  async function reapply(client: RemoteAgentRunClient, started: RemoteStartedInfo | null = firstStarted): Promise<void> {
    const methods = new Set((started ?? firstStarted)?.methods ?? []);
    const steps: Array<[RemoteAgentMethod, unknown[]]> = [];
    const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((dir, index) => dir === b[index]);
    if (Object.keys(vendorPatches).length && methods.has('setVendorOptions')) steps.push(['setVendorOptions', [vendorPatches]]);
    if ((libraryRoot || !same(extraDirs, openedDirs.extraDirs)) && methods.has('setExtraDirs')) {
      steps.push(['setExtraDirs', [workspace.virtualizeDirs(extraDirs), libraryRoot ? workspace.virtualizeDirs([libraryRoot])[0] : null]]);
    }
    if (!same(writableDirs, openedDirs.writableDirs) && methods.has('setWritableDirs')) {
      steps.push(['setWritableDirs', [workspace.virtualizeDirs(writableDirs)]]);
    }
    if (autoReviewFallback && methods.has('useCindyAutoReviewFallback')) steps.push(['useCindyAutoReviewFallback', []]);
    for (const [method, args] of steps) {
      try {
        await client.call(method, args);
      } catch (error) {
        deps.log?.warn('remote agent: restoring state after reconnect failed', { method, error: String(error) });
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`[REMOTE_AGENT_UNAVAILABLE] Reconnected to the other computer but could not restore this task's settings (${method}): ${detail}`);
      }
    }
  }

  /**
   * 要对方 Agent 干活时：已让出名额就连回同一个会话。正在让就等它让完；同时只连一次。
   * 连回期间(含连回后补发设置)其它调用都等它：打开成功时状态已是 connected，不能抢在设置恢复前用这条连接。
   */
  async function ensureConnected(): Promise<RemoteAgentRunClient> {
    for (;;) {
      if (linkState === 'closed') throw new Error('[REMOTE_AGENT_EXPIRED] The task has ended on this computer.');
      if (reconnecting) return reconnecting;
      if (linkState === 'connected' && active) return active;
      if (!releasing) break;
      await releasing.catch(() => undefined);
    }
    linkState = 'connecting';
    deps.onTaskGrantRenewable?.(false);
    let attempt: Promise<RemoteAgentRunClient> | null = null;
    attempt = (async () => {
      const connectOnce = async (skipAuthorization = false): Promise<RemoteAgentRunClient> => {
        if (!skipAuthorization) await deps.reconnectAuthorization?.(() => stateNow() !== 'closed');
        requireOpen();
        let reconnectedStarted: RemoteStartedInfo | null = null;
        const client = await connect(true, (started) => {
          reconnectedStarted = started;
          controller?.onReconnected(started);
        });
        // M's task-scoped open is the confirmation that the current grant is
        // usable. A later independent M restart may ask O for a new one again.
        if (stateNow() === 'connected' && activeNow() === client) {
          taskGrantReissued = false;
          deps.onTaskGrantRenewable?.(true);
        }
        touch();
        deps.log?.info('remote agent reconnected', { kind, runId: client.runId });
        try {
          await reapply(client, reconnectedStarted);
        } catch (error) {
          deps.onTaskGrantRenewable?.(false);
          // 补发失败：关掉这次开的进程、还回名额，保持已让出；待补发的内容都还在，下次调用重新连回再补。
          if (stateNow() === 'connected' && activeNow() === client) {
            linkState = 'releasing';
            await closeRun(client);
          }
          throw error;
        }
        if (stateNow() !== 'connected' || activeNow() !== client) throw new Error('[REMOTE_AGENT_EXPIRED] The task has ended on this computer.');
        return client;
      };
      try {
        const connectWithRecovery = async (): Promise<RemoteAgentRunClient> => {
          try {
            return await connectOnce();
          } catch (error) {
            if (stateNow() === 'closed' || !deps.reconnectAuthorization
              || taskGrantReissued || !isSharedTaskAuthorizationDenied(error)) throw error;
            // M restarted and lost its in-memory task grant. Only O can reissue
            // that grant, and only for the original M; never migrate native history.
            // Mark the replacement only after O actually resolves: O being
            // unreachable must not permanently suppress a later retry.
            await deps.reconnectAuthorization(() => stateNow() !== 'closed', { force: true });
            taskGrantReissued = true;
            return await connectOnce(true);
          }
        };
        const client = await connectWithRecovery();
        restartResumeRequired = false;
        return client;
      } catch (error) {
        // Automatic recovery failed. A later explicit retry may use the normal
        // invalid-resume callback/context rebuild instead of being stuck forever.
        restartResumeRequired = false;
        // 连不回(对方忙、离线等)：保持已让出名额，下次发送再试。
        if (stateNow() === 'connecting') linkState = 'released';
        throw localizeRemoteError(error);
      } finally {
        // 在这次尝试结束的同时清掉：之后来的调用不会拿到已经失败的旧尝试。
        if (reconnecting === attempt) reconnecting = null;
      }
    })();
    reconnecting = attempt;
    return attempt;
  }

  const link: RemoteAgentLink = {
    live: async () => {
      if (reconnecting) return reconnecting.catch(() => null);
      return linkState === 'connected' ? active : null;
    },
    ensure: ensureConnected,
    begin: () => {
      inflight += 1;
      touch();
      let ended = false;
      return () => {
        if (ended) return;
        ended = true;
        inflight -= 1;
        touch();
      };
    },
    close: async (mode, reason) => {
      if (releasing) await releasing.catch(() => undefined);
      const client = active;
      linkState = 'closed';
      // 已让出名额时对方没有这个任务的进程，不用再关；正在连回的那条一起关掉。
      if (client) await client.close(mode, reason);
    },
  };

  // 第一次启动期间任务被删除或归档：标成已关闭(还没发出的打开不再发)，已发出的立即让对方结束；
  // 在等的打开随之以「任务已结束」失败。
  const cancelStart = () => {
    if (linkState === 'closed') return;
    linkState = 'closed';
    const client = active;
    deps.log?.info('remote agent: task removed while starting; ending it on the other computer', {
      kind,
      ...(client ? { runId: client.runId } : {}),
    });
    active = null;
    if (client) {
      // Notify M, but end reverse HTTP/WS and local resources without waiting for M.
      void client.close('close', 'navigation').catch(() => undefined);
      client.abandon('start-cancelled');
    }
    void disposeLocal().catch(error => {
      deps.log?.warn('remote agent: cancelled startup cleanup failed', { error: String(error) });
    });
  };
  signal.addEventListener('abort', cancelStart, { once: true });
  if (signal.aborted) cancelStart();
  try {
    await connect(false, (started) => {
      firstStarted = started;
      controller = createRemoteAgentHandle({
        link,
        started,
        sharedReconnectSendEvidence: () => {
          const capture = reconnectOfferCapture.getStore();
          return capture && capture.sessionId === opts.sessionId ? capture.evidence : undefined;
        },
        workspace,
        getExecutorCwd: () => executor.getCwd(),
        recordApproval: (action) => executor.recordApproval(action),
        cancelPendingConfirmations: () => executor.cancelPendingConfirmations(),
        onInvalidResumeSession: opts.onInvalidResumeSession,
        // 插件引擎的工具卡片标题由它自己的 Agent 给出，Cindy 不猜测改名；但引擎若省略了 MCP
        // `tool_call_update` 的输出正文，从本机 MCP 桥回填 `tool_result_full`（如 PR 卡片令牌）。
        mapEvent: pluginEngine
          ? (mcp.takeMcpToolResult
              ? createAcpMcpResultBackfiller({
                  takeMcpToolResult: mcp.takeMcpToolResult,
                  serverNames: [...mcp.servers.keys()],
                })
              : undefined)
          : deps.mapEvent?.(builtinKind),
        newId: deps.newId,
        ...(deps.groupSwitch?.takeNewRound ? { takeGroupNewRound: deps.groupSwitch.takeNewRound } : {}),
        onPermissionMode: (mode) => {
          if (permissionMode === mode) return;
          permissionMode = mode as typeof permissionMode;
          executor.setGateMode(executorGateModeFor(permissionMode, planMode));
        },
        onPlanMode: (enabled) => {
          if (planMode === enabled) return;
          planMode = enabled;
          executor.setGateMode(executorGateModeFor(permissionMode, planMode));
        },
        onExtraDirs: (dirs, root) => {
          extraDirs = [...new Set(dirs)];
          // 与发给对方的一致：没带就是清掉。
          libraryRoot = root ?? null;
          applyDirs();
        },
        onWritableDirs: (dirs) => {
          writableDirs = [...new Set(dirs)];
          applyDirs();
        },
        onVendorOptions: (patch) => {
          Object.assign(vendorOptions, patch);
          Object.assign(vendorPatches, JSON.parse(JSON.stringify(patch)) as Record<string, unknown>);
        },
        onModel: (next, modelOpts) => {
          model = next;
          if (modelOpts?.providerId !== undefined) providerId = modelOpts.providerId;
          if (modelOpts?.effort) effort = modelOpts.effort;
        },
        onEffort: (next) => {
          effort = next;
        },
        onFastMode: (enabled) => {
          fastMode = enabled;
        },
        onThinkingEnabled: (enabled) => {
          thinkingEnabled = enabled;
        },
        onAutoReviewFallback: () => {
          autoReviewFallback = true;
        },
        dispose: disposeLocal,
        log: deps.log,
      });
    });
  } catch (error) {
    await disposeLocal();
    // Remote notification is best effort. Only the completed local executor,
    // MCP and relay teardown proves this attempt no longer owns host resources.
    if (signal.aborted) throw new AgentStartupResourcesReleasedError(signal.reason);
    throw localizeRemoteError(error);
  } finally {
    signal.removeEventListener('abort', cancelStart);
  }
  touch();
  deps.log?.info('remote agent session started', { kind, runId: activeNow()?.runId });
  const handle = (controller as RemoteAgentHandleController | null)!.handle;
  if (deps.recoverSharedReconnect) {
    handle.hasReclaimedSharedRun = () => linkState === 'released' && idleReclaimedByHost;
  }
  return handle;
}
