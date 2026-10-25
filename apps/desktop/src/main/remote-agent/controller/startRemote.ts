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

import {
  REMOTE_AGENT_GROUP_SWITCH_STATE_KEY,
  REMOTE_AGENT_RELAY_KEY_PATTERN,
  type RemoteAgentKind,
  type RemoteAgentMethod,
  type RemoteAgentReply,
  type RemoteAgentReverseRequest,
  type RemoteAgentStreamItem,
} from '@cindy/device-link';
import type { AgentEvent, AgentSessionHandle, Effort, StartSessionOptions } from '@cindy/maker-core';
import { withTransientRemoteRetry } from '@cindy/maker-shared/device-link-contract';

import { PROVIDER_SHARE_CREDENTIAL_SESSION_APPROVAL } from '../../../shared/providerShareCredentialConsent';
import { credentialGrantPermission, type CredentialGrantRecord } from '../executor/credentialGrants';
import { RemoteExecutor, type ExecutorCaptureHooks } from '../executor/executor';
import type { PdfTextExtractor } from '../executor/files';
import { ExecutorGate, executorGateModeFor, type ExecutorAction } from '../executor/gate';
import { GitCredentialHistory } from '../executor/gitCredentials';
import type { GuardedFetch } from '../executor/webFetch';
import { ExecutorWorkspace, projectPathText } from '../executor/workspace';
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
} from './proxyHandle';
import { ExecServerRelay } from './execServerRelay';
import { createReverseHttpRouter, type LocalMcpTarget } from './router';
import { RemoteAgentPoller, RemoteAgentRunClient, type RemoteAgentInvoke } from './runClient';

export interface PreparedRemoteMcp {
  /** 本任务可用的本机 MCP 服务(名字 → 带本任务身份的地址与请求头)。 */
  servers: Map<string, LocalMcpTarget>;
  dispose(): void;
}

export interface StartRemoteAgentDeps {
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
  capture?(input: { kind: RemoteAgentKind; opts: StartSessionOptions }): ExecutorCaptureHooks | undefined;
  /** 读取要同步到对方影子目录的项目说明类文件。 */
  collectProjectFiles(workingDir: string): Promise<RemoteAgentWireFile[]>;
  /** 项目上级目录里的说明文件；缺省不同步。 */
  collectAncestorFiles?(workingDir: string): Promise<RemoteAgentWireAncestorFile[]>;
  /** 项目各级上级目录里 Codex 要找的名字有没有(对方据此少问)；缺省不带，对方照常逐个来问。 */
  collectAncestorMarkers?(workingDir: string): Promise<RemoteAgentWireAncestorMarkers>;
  /** 你这台的个人配置；缺省不同步。 */
  collectPersonal?(kind: RemoteAgentKind, projectFiles: readonly RemoteAgentWireFile[]): Promise<{
    personal: RemoteAgentWirePersonal;
    roots: Array<{ relative: string; local: string }>;
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
  groupSwitch?: { token?: string; offer(token: string): void; takeNewRound?(): boolean };
  newId(): string;
  log?: {
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
export function shadowAliases(
  started: { shadowDir: string; mirrorRoot?: string; previousMirrorRoots?: string[]; extraDirs?: string[]; writableDirs?: string[]; virtualWorkspace?: boolean },
  workingDir: string,
  personalRoots: ReadonlyArray<{ relative: string; local: string }>,
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
  const base = {
    description,
    metadata: { hostOwnedConfirmation: 'shared_provider_credential' },
    suggestions: [PROVIDER_SHARE_CREDENTIAL_SESSION_APPROVAL],
  };
  switch (action.kind) {
    case 'exec':
      return { ...base, toolName: 'Bash', input: { command: action.command } };
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

/**
 * 连接的状态：connecting(第一次打开或连回中)→ connected → releasing(连接池在让出名额)→ released
 * → connecting …；closed 是句柄已关闭或对方意外结束。
 */
type LinkState = 'connecting' | 'connected' | 'releasing' | 'released' | 'closed';

/** 第一次启动还没完成的远程任务(按任务 id)：任务被删除或归档时据此让对方停下。 */
const pendingStarts = new Map<string, Set<() => void>>();

/**
 * 任务被删除或归档时调用。第一次启动还没完成(对方可能还在准备、在供应商组里换电脑或启动 Agent)的，
 * 立即告诉对方结束这个任务，不让它迟到地启动并跑完这一轮(2026-10-22：慢启动期间删掉的任务，对方几分钟后
 * 仍换到另一台电脑启动并生成了回复)。启动已完成的任务由 Maker 照常关闭，这里不管。
 */
export function cancelPendingRemoteStart(sessionId: string): void {
  for (const cancel of [...pendingStarts.get(sessionId) ?? []]) cancel();
}

export async function startRemoteAgentSession(
  kind: RemoteAgentKind,
  opts: StartSessionOptions,
  deps: StartRemoteAgentDeps,
): Promise<AgentSessionHandle> {
  if (!opts.sessionId) throw new Error('remote agent sessions require a session id');
  // 第一处异步准备之前登记，MCP 启动期间的删除/归档也不能漏掉。
  const sessionId = opts.sessionId;
  const abort = new AbortController();
  const cancel = () => abort.abort();
  const cancels = pendingStarts.get(sessionId) ?? new Set<() => void>();
  pendingStarts.set(sessionId, cancels);
  cancels.add(cancel);
  try {
    return await prepareAndStartRemoteAgentSession(kind, opts, deps, abort.signal);
  } finally {
    cancels.delete(cancel);
    if (!cancels.size && pendingStarts.get(sessionId) === cancels) pendingStarts.delete(sessionId);
  }
}

async function prepareAndStartRemoteAgentSession(
  kind: RemoteAgentKind,
  opts: StartSessionOptions,
  deps: StartRemoteAgentDeps,
  signal: AbortSignal,
): Promise<AgentSessionHandle> {
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
    ...(deps.extractPdfText ? { extractPdfText: deps.extractPdfText } : {}),
    // 只有 Claude Code 经 cindy_exec 使用这组工具。
    ...(kind === 'claude-code' && deps.webFetch ? { webFetch: deps.webFetch } : {}),
    ...(credentialConsent
      ? {
          confirm: async (action: ExecutorAction, signal: AbortSignal) =>
            controller?.confirm(credentialConfirmation(action, credentialConsent.description), signal) ?? false,
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
  const vendorOptions: Record<string, unknown> = { ...(opts.vendorOptions ?? {}) };
  const mcp = await deps.prepareMcp({ kind, opts, vendorOptions }).catch((error) => {
    void executor.close();
    throw error;
  });
  if (signal.aborted) {
    try { mcp.dispose(); } finally { await executor.close(); }
    throw new Error('[REMOTE_AGENT_EXPIRED] The task has ended on this computer.');
  }
  const router = createReverseHttpRouter({ executor, mcpTarget: (name) => mcp.servers.get(name) });

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
  let lastStarted: RemoteStartedInfo | null = null;

  let personalRoots: Array<{ relative: string; local: string }> = [];
  /** 正在连或连着的那条连接(Codex 的执行环境帧经它推给对方)。 */
  let active: RemoteAgentRunClient | null = null;
  let linkState: LinkState = 'connecting';
  /** 进行中的、要对方参与的调用数(期间不让出名额)。 */
  let inflight = 0;
  let lastActivity = Date.now();
  let releasing: Promise<void> | null = null;
  let reconnecting: Promise<RemoteAgentRunClient> | null = null;
  const touch = () => {
    lastActivity = Date.now();
  };
  // 其它回调会改这两个值：读的时候不让 TypeScript 按局部赋值收窄。
  const stateNow = (): LinkState => linkState;
  const activeNow = (): RemoteAgentRunClient | null => active;
  // Codex：对方的 Codex 把本机当作 exec-server 执行环境。
  const codexPath = kind === 'codex' ? deps.codexPath?.() : undefined;
  const relay = codexPath
    ? new ExecServerRelay({
        codexPath,
        cwd: workspace.workingDir,
        workspace,
        authorize: (action) => executor.check(action),
        ...(credentialConsent ? { confirm: (action: ExecutorAction) => executor.confirm(action) } : {}),
        push: async (frames) => {
          await active?.push(frames);
        },
        log: deps.log,
        // 后台终端跑完：闲置从这时算起。
        onProcessesEnded: () => touch(),
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

  /** 连接池让出名额：只结束对方的 Agent 进程，本机部分与对话记录都留着。 */
  /** 结束对方的这个 Agent 进程，本机部分留着，状态回到已让出(调用前已置为 releasing)。 */
  async function closeRun(client: RemoteAgentRunClient): Promise<void> {
    try {
      // 用 close 而不是 detach：detach 不结束对方的进程，名额让不出来。
      await client.close('close', 'navigation');
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

  let localDisposal: Promise<void> | null = null;
  const disposeLocal = (): Promise<void> => {
    if (localDisposal) return localDisposal;
    linkState = 'closed';
    // Attempt every cleanup even if one fails. Preserve the settled result so
    // a second close cannot mistake an unfinished/failed cleanup for success.
    localDisposal = Promise.allSettled([
      Promise.resolve().then(() => leavePool?.()),
      Promise.resolve().then(() => relay?.close()),
      Promise.resolve().then(() => mcp.dispose()),
      Promise.resolve().then(() => executor.close()),
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
  ): Promise<RemoteAgentRunClient> {
    let projectionReady = false;
    let opened = false;
    const early: Array<{ type: 'event' | 'state'; value: unknown }> = [];
    let closedEarly: { reason: string; message?: string } | null = null;
    const expectedResume = payload.options.resumeSessionId;
    let resumeLost = false;
    // 只处理当前这条连接的往来；正在让出名额的那条剩下的收尾不再进任务。
    const isCurrent = () => active === client && linkState !== 'releasing';
    // 连回时只补新映射，不替换已有的(见 ExecutorWorkspace.addAliases)。
    const applyProjection = (projection: Parameters<typeof shadowAliases>[0], virtualRoot: string | undefined) => {
      const aliases = shadowAliases(projection, workspace.workingDir, personalRoots, openedDirs);
      if (reconnect) workspace.addAliases(aliases);
      else workspace.setAliases(aliases);
      workspace.setVirtualRoot(virtualRoot);
    };
    const client: RemoteAgentRunClient = new RemoteAgentRunClient(deps.newId(), poller, {
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
        const remaining = takeGroupSwitchState(incoming, deps.groupSwitch?.offer);
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
        if (active !== client || linkState === 'releasing') return;
        if (!opened) {
          closedEarly = { reason, message: error?.message };
          return;
        }
        active = null;
        // 对方按闲置收回了它的 Agent 进程(它只收回不忙的任务)：与连接池让出名额一样，本机部分与对话都留着，
        // 要它干活时带原来的会话 id 连回。
        if (idleReclaimed && controller) {
          relay?.reset();
          linkState = 'released';
          deps.log?.info('remote agent connection reclaimed by the other computer', { kind, runId: client.runId });
          return;
        }
        linkState = 'closed';
        if (controller) controller.onClosed(reason, error?.message);
        else void disposeLocal();
      },
      // Codex 经执行环境在本机起的进程还在跑(对方看不到)：拉取时告诉对方，免得被当成闲置收回。
      holdsRemote: () => isCurrent() && relay?.busy() === true,
    }, deps.newId, deps.log);
    if (stateNow() === 'closed') throw new Error('[REMOTE_AGENT_EXPIRED] The task has ended on this computer.');
    active = client;
    try {
      const raw = await client.open(kind, payload);
      if (closedEarly) throw new Error((closedEarly as { message?: string }).message ?? '[REMOTE_AGENT_UNAVAILABLE] The agent stopped right after starting.');
      if (stateNow() === 'closed') {
        // 连回途中任务关掉了(那时还没有这条连接可关)：对方已经起了进程，关掉它让出名额。
        await client.close('close', 'navigation').catch(() => undefined);
        throw new Error('[REMOTE_AGENT_EXPIRED] The task has ended on this computer.');
      }
      const started = parseStartedInfo(raw, kind);
      if (!projectionReady) applyProjection(started, started.virtualWorkspace ? started.mirrorRoot : undefined);
      opened = true;
      linkState = 'connected';
      lastStarted = started;
      onOpened(started);
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
      client.abandon('start-failed');
      if (active === client) active = null;
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

  async function buildPayload(reconnect: boolean): Promise<RemoteAgentOpenPayload> {
    // 每次打开都读最新的图片清空代次：让出期间清空过的，连回的新进程按新代次交付。
    const imageDeliveryEpoch = await deps.readImageDeliveryEpoch?.(opts.sessionId!);
    const startOptions = openOptions(reconnect);
    const projectFiles = await deps.collectProjectFiles(opts.workingDir).catch(() => []);
    const ancestorFiles = await (deps.collectAncestorFiles?.(opts.workingDir) ?? Promise.resolve([])).catch(() => []);
    // 每次打开(含连回)都重新看一遍：上级目录里的标记以这次打开时为准。
    const ancestorMarkers = await (deps.collectAncestorMarkers?.(opts.workingDir) ?? Promise.resolve(undefined))
      .catch(() => undefined);
    const collectedPersonal = await (deps.collectPersonal?.(kind, projectFiles) ?? Promise.resolve(null))
      .catch(() => null);
    personalRoots = collectedPersonal?.roots ?? [];
    const personal = collectedPersonal?.personal ?? { files: [] };
    const importFiles = kind === 'claude-code' && deps.collectImports
      ? await deps.collectImports({ workingDir: opts.workingDir, projectFiles, ancestorFiles, personal }).catch(() => [])
      : [];
    return {
      sessionId: opts.sessionId!,
      acceptsImageDeliveryReceipts: true,
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
        isGitRepo: await deps.isGitRepo(opts.workingDir).catch(() => false),
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
    // 重启恢复可能撞上 relay 尚未上线/拥堵冷却；只重试无副作用的能力读取，
    // 等既有链路自行恢复。open/upload/send 的交付不确定时不能整次重放。
    const caps = await withTransientRemoteRetry(() => {
      if (linkState === 'closed') {
        throw new Error('[REMOTE_AGENT_EXPIRED] The task has ended on this computer.');
      }
      return RemoteAgentRunClient.caps(deps.invoke);
    });
    if (caps.virtualWorkspace !== true) {
      throw new Error('[REMOTE_AGENT_UNSUPPORTED] The other computer does not support the virtual workspace required to protect local paths.');
    }
    deps.pool?.noteMaxRuns(caps.maxRuns);
    deps.pool?.noteIdleReclaimMinutes(caps.idleReclaimMinutes);
    await deps.pool?.beforeOpen(member);
    const payload = await buildPayload(reconnect);
    try {
      return await openRun(payload, reconnect, onOpened);
    } catch (error) {
      if (!deps.pool || linkState === 'closed' || !isRemoteRunLimitError(error) || !await deps.pool.releaseForRetry(member)) throw error;
      return await openRun(payload, reconnect, onOpened);
    }
  }

  /**
   * 连回后补上对方进程里的状态(不在启动选项里的)。任一步失败就抛错：不能让消息在缺设置的 Agent 上执行
   * (目录没给到，消息里的虚拟路径就落空；自动审查兜底没恢复则少了一道安全设置)。
   * 目录：打开时给的是第一次的列表，之后的增减在这里按运行中改目录的方式补发，与一直连着时的效果一致。
   */
  async function reapply(client: RemoteAgentRunClient): Promise<void> {
    const methods = new Set(firstStarted?.methods ?? []);
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
    let attempt: Promise<RemoteAgentRunClient> | null = null;
    attempt = (async () => {
      try {
        const client = await connect(true, (started) => {
          controller?.onReconnected(started);
        });
        touch();
        deps.log?.info('remote agent reconnected', { kind, runId: client.runId });
        try {
          await reapply(client);
        } catch (error) {
          // 补发失败：关掉这次开的进程、还回名额，保持已让出；待补发的内容都还在，下次调用重新连回再补。
          if (stateNow() === 'connected' && activeNow() === client) {
            linkState = 'releasing';
            await closeRun(client);
          }
          throw error;
        }
        if (stateNow() !== 'connected' || activeNow() !== client) throw new Error('[REMOTE_AGENT_EXPIRED] The task has ended on this computer.');
        return client;
      } catch (error) {
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
    if (client) void client.close('close', 'navigation').catch(() => undefined);
  };
  signal.addEventListener('abort', cancelStart, { once: true });
  try {
    await connect(false, (started) => {
      firstStarted = started;
      controller = createRemoteAgentHandle({
        link,
        started,
        workspace,
        recordApproval: (action) => executor.recordApproval(action),
        cancelPendingConfirmations: () => executor.cancelPendingConfirmations(),
        onInvalidResumeSession: opts.onInvalidResumeSession,
        mapEvent: deps.mapEvent?.(kind),
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
    throw localizeRemoteError(error);
  } finally {
    signal.removeEventListener('abort', cancelStart);
  }
  touch();
  deps.log?.info('remote agent session started', { kind, runId: activeNow()?.runId });
  return (controller as RemoteAgentHandleController | null)!.handle;
}
