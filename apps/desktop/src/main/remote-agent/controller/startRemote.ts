/**
 * 在另一台电脑上启动 Agent、任务留在本机(控制端入口)。
 *
 * 本机为这个任务准备好执行器(文件与命令在本机执行，过本机权限上限)、本机 Cindy 工具的 MCP
 * 身份与项目说明快照，然后让对方用它自己的 Agent 程序、登录与供应商启动 Agent。返回的句柄对
 * 本机 Maker / Session 来说就是普通会话。
 */
import os from 'node:os';
import path from 'node:path';

import type { RemoteAgentKind, RemoteAgentReply, RemoteAgentReverseRequest, RemoteAgentStreamItem } from '@cindy/device-link';
import type { AgentEvent, AgentSessionHandle, StartSessionOptions } from '@cindy/maker-core';

import { RemoteExecutor, type ExecutorCaptureHooks } from '../executor/executor';
import type { PdfTextExtractor } from '../executor/files';
import { ExecutorGate, executorGateModeFor } from '../executor/gate';
import { ExecutorWorkspace } from '../executor/workspace';
import type {
  RemoteAgentOpenPayload,
  RemoteAgentWireAncestorFile,
  RemoteAgentWireFile,
  RemoteAgentWirePersonal,
} from '../wire';
import { encodeStartOptions } from '../wire';
import {
  createRemoteAgentHandle,
  localizeRemoteError,
  parseStartedInfo,
  type RemoteAgentHandleController,
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
  invoke: RemoteAgentInvoke;
  /** 这台电脑的共享拉取器(同一台电脑上的任务共用一个 poll)；缺省时本任务单独一个。 */
  poller?: RemoteAgentPoller;
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
  /** 你这台的个人配置；缺省不同步。 */
  collectPersonal?(kind: RemoteAgentKind, projectFiles: readonly RemoteAgentWireFile[]): Promise<{
    personal: RemoteAgentWirePersonal;
    roots: Array<{ relative: string; local: string }>;
  }>;
  isGitRepo(workingDir: string): Promise<boolean>;
  /** Read 读 PDF 时取文字(Claude Code)。 */
  extractPdfText?: PdfTextExtractor;
  /** 改写来自对方的事件(如工具名)。 */
  mapEvent?: (kind: RemoteAgentKind) => ((event: AgentEvent) => AgentEvent) | undefined;
  /** 本机 Codex 程序(给对方的 Codex 提供 exec-server 执行环境)；缺省时不提供。 */
  codexPath?: () => string | undefined;
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
 * 影子目录(对方电脑上的路径) → 本机真实路径的映射。虚拟工作区使用固定 opaque 层级，旧协议
 * 仍按真实路径逐级镜像；同步过去的个人 Skill 等映射回你这台的个人配置目录。越具体的放越前面。
 */
export function shadowAliases(
  started: { shadowDir: string; mirrorRoot?: string; extraDirs?: string[]; writableDirs?: string[]; virtualWorkspace?: boolean },
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
  return aliases;
}

function shellName(): string {
  if (process.platform === 'win32') return 'bash';
  return (process.env.SHELL ?? '/bin/bash').split('/').pop() || 'bash';
}

export async function startRemoteAgentSession(
  kind: RemoteAgentKind,
  opts: StartSessionOptions,
  deps: StartRemoteAgentDeps,
): Promise<AgentSessionHandle> {
  if (!opts.sessionId) throw new Error('remote agent sessions require a session id');
  // 附加目录(只读引用)与可写目录分开跟踪，运行中任一侧变化都重算执行器根目录：
  // 否则新授予的目录过不了本机 shell/root 判定，撤掉的还被本机上限当可信根。
  let extraDirs = [...new Set(opts.extraDirs ?? [])];
  let writableDirs = [...new Set(opts.writableDirs ?? [])];
  const workspace = new ExecutorWorkspace({ workingDir: opts.workingDir, extraDirs: [...extraDirs, ...writableDirs] });
  const applyDirs = () => workspace.setExtraDirs([...new Set([...extraDirs, ...writableDirs])]);
  const gate = new ExecutorGate(workspace, executorGateModeFor(opts.permissionMode, opts.planMode === true));
  const executor = new RemoteExecutor({
    workspace,
    gate,
    rgPath: deps.rgPath,
    capture: deps.capture?.({ kind, opts }),
    ...(deps.extractPdfText ? { extractPdfText: deps.extractPdfText } : {}),
  });
  let permissionMode = opts.permissionMode;
  let planMode = opts.planMode === true;
  const vendorOptions: Record<string, unknown> = { ...(opts.vendorOptions ?? {}) };
  const mcp = await deps.prepareMcp({ kind, opts, vendorOptions }).catch((error) => {
    void executor.close();
    throw error;
  });
  const router = createReverseHttpRouter({ executor, mcpTarget: (name) => mcp.servers.get(name) });

  let controller: RemoteAgentHandleController | null = null;
  let personalRoots: Array<{ relative: string; local: string }> = [];
  let projectionReady = false;
  const early: Array<{ type: 'event' | 'state'; value: unknown }> = [];
  let closedEarly: { reason: string; message?: string } | null = null;
  // Codex：对方的 Codex 把本机当作 exec-server 执行环境。客户端在下面创建，帧推送时再取。
  let pushFrames: ((frames: Parameters<RemoteAgentRunClient['push']>[0]) => Promise<void>) | null = null;
  const codexPath = kind === 'codex' ? deps.codexPath?.() : undefined;
  const relay = codexPath
    ? new ExecServerRelay({
        codexPath,
        cwd: workspace.workingDir,
        workspace,
        authorize: (action) => executor.check(action),
        push: async (frames) => {
          await pushFrames?.(frames);
        },
        log: deps.log,
      })
    : null;

  const disposeLocal = async () => {
    relay?.close();
    try {
      mcp.dispose();
    } catch (error) {
      deps.log?.warn('remote agent: MCP dispose failed', { error: String(error) });
    }
    await executor.close();
  };

  const poller = deps.poller ?? new RemoteAgentPoller(deps.invoke, deps.log);
  const client = new RemoteAgentRunClient(deps.newId(), poller, {
    onEvent: (event) => {
      if (controller) controller.onEvent(event);
      else early.push({ type: 'event', value: event });
    },
    onState: (state) => {
      const projection = state.workspaceProjection as Parameters<typeof shadowAliases>[0] | undefined;
      if (projection?.virtualWorkspace === true && typeof projection.shadowDir === 'string') {
        workspace.setAliases(shadowAliases(projection, workspace.workingDir, personalRoots, { extraDirs, writableDirs }));
        workspace.setVirtualRoot(projection.mirrorRoot);
        projectionReady = true;
        state = { ...state };
        delete state.workspaceProjection;
        if (!Object.keys(state).length) return;
      }
      if (controller) controller.onState(state);
      else early.push({ type: 'state', value: state });
    },
    onRequest: async (request: RemoteAgentReverseRequest, signal): Promise<RemoteAgentReply> => {
      if (request.type === 'http') return router(request, signal);
      if (request.type === 'callback' && request.name === 'onInvalidResumeSession' && !controller) {
        const expected = request.args[0];
        const value = typeof expected === 'string' && opts.onInvalidResumeSession
          ? await opts.onInvalidResumeSession(expected)
          : false;
        return { type: 'callback', value };
      }
      const answered = controller?.onRequest(request);
      if (answered) return answered;
      return { type: 'error', error: { code: 'REMOTE_AGENT_UNAVAILABLE', message: 'This computer is not ready to answer yet.' } };
    },
    onWs: (item: Extract<RemoteAgentStreamItem, { t: 'ws' }>) => {
      if (relay) relay.handle(item);
      else if (item.kind === 'open') void pushFrames?.([{ connId: item.connId, kind: 'close' }])?.catch(() => undefined);
    },
    onClosed: (reason, error) => {
      if (controller) controller.onClosed(reason, error?.message);
      else {
        closedEarly = { reason, message: error?.message };
        void disposeLocal();
      }
    },
  }, deps.newId, deps.log);
  pushFrames = (frames) => client.push(frames);

  const projectFiles = await deps.collectProjectFiles(opts.workingDir).catch(() => []);
  const ancestorFiles = await (deps.collectAncestorFiles?.(opts.workingDir) ?? Promise.resolve([])).catch(() => []);
  const collectedPersonal = await (deps.collectPersonal?.(kind, projectFiles) ?? Promise.resolve(null))
    .catch(() => null);
  personalRoots = collectedPersonal?.roots ?? [];
  const payload: RemoteAgentOpenPayload = {
    sessionId: opts.sessionId,
    virtualWorkspace: true,
    options: encodeStartOptions(opts),
    workspace: {
      workingDir: opts.workingDir,
      extraDirs: opts.extraDirs ?? [],
      writableDirs: opts.writableDirs ?? [],
      platform: process.platform,
      shell: shellName(),
      osVersion: `${os.type()} ${os.release()}`,
      // 仅供被控端把项目说明中的本机 Home 路径投影到虚拟工作区；不会进入 deviceHosted。
      homeDir: os.homedir(),
      isGitRepo: await deps.isGitRepo(opts.workingDir).catch(() => false),
    },
    projectFiles,
    ancestorFiles,
    personal: collectedPersonal?.personal ?? { files: [] },
    mcpServers: [...mcp.servers.keys()],
  };

  let startedRaw: Record<string, unknown>;
  try {
    const caps = await RemoteAgentRunClient.caps(deps.invoke);
    if (caps.virtualWorkspace !== true) {
      throw new Error('[REMOTE_AGENT_UNSUPPORTED] The other computer does not support the virtual workspace required to protect local paths.');
    }
    startedRaw = await client.open(kind, payload);
  } catch (error) {
    client.abandon('start-failed');
    await disposeLocal();
    throw localizeRemoteError(error);
  }
  if (closedEarly) throw new Error((closedEarly as { message?: string }).message ?? '[REMOTE_AGENT_UNAVAILABLE] The agent stopped right after starting.');
  const started = parseStartedInfo(startedRaw, kind);
  if (!projectionReady) {
    workspace.setAliases(shadowAliases(started, workspace.workingDir, collectedPersonal?.roots ?? [], { extraDirs, writableDirs }));
    workspace.setVirtualRoot(started.virtualWorkspace ? started.mirrorRoot : undefined);
  }

  controller = createRemoteAgentHandle({
    client,
    started,
    workspace,
    recordApproval: (action) => executor.recordApproval(action),
    onInvalidResumeSession: opts.onInvalidResumeSession,
    mapEvent: deps.mapEvent?.(kind),
    newId: deps.newId,
    onPermissionMode: (mode) => {
      permissionMode = mode as typeof permissionMode;
      executor.setGateMode(executorGateModeFor(permissionMode, planMode));
    },
    onPlanMode: (enabled) => {
      planMode = enabled;
      executor.setGateMode(executorGateModeFor(permissionMode, planMode));
    },
    onExtraDirs: (dirs) => {
      extraDirs = [...new Set(dirs)];
      applyDirs();
    },
    onWritableDirs: (dirs) => {
      writableDirs = [...new Set(dirs)];
      applyDirs();
    },
    onVendorOptions: (patch) => {
      Object.assign(vendorOptions, patch);
    },
    dispose: disposeLocal,
  });
  for (const item of early.splice(0)) {
    if (item.type === 'event') controller.onEvent(item.value);
    else controller.onState(item.value as Record<string, unknown>);
  }
  deps.log?.info('remote agent session started', { kind, runId: client.runId });
  return controller.handle;
}
