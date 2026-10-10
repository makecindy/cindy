/**
 * 远程 Agent 的控制端接线：Maker 遇到「Agent 在另一台电脑上运行」的任务时调用这里。
 *
 * 本机为任务准备：
 *  - 本机 Cindy 工具：与本机 Pi 任务同一套 MCP 桥身份登记(按任务、按实例)，对方的工具请求经
 *    隧道转发到这里；外部 HTTP MCP 也从本机发出；
 *  - 执行器：文件与命令在本机执行，写入前交给「每轮改动对比」抓取改前内容；
 *  - 项目说明快照与记忆索引快照(记忆在本机，对方不读它自己的记忆库)。
 */
import { randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

import type {
  AgentEvent,
  AgentKind,
  AgentSessionHandle,
  Logger,
  MakerMemoryManager,
  McpProvider,
  PiExtraSpawnConfig,
  PiExtraSpawnConfigContext,
  StartSessionOptions,
} from '@cindy/maker-core';
import { resolveMemoryScopeKey } from '@cindy/maker-core';

import type { ExecutorCaptureHooks } from '../executor/executor';
import type { PdfTextExtractor } from '../executor/files';
import type { GuardedFetch } from '../executor/webFetch';
import { remoteAgentEventMapper } from './eventMap';
import {
  collectAncestorInstructionFiles,
  collectPersonalConfig,
  collectProjectInstructionFiles,
} from './projectFiles';
import type { LocalMcpTarget } from './router';
import { RemoteAgentPoller, remoteAgentInvoker } from './runClient';
import { startRemoteAgentSession, type PreparedRemoteMcp } from './startRemote';

export interface DeviceAgentServiceDeps {
  remoteInvoke(deviceId: string, channel: string, args: unknown[]): Promise<{ ok: boolean; result?: unknown; error?: { code?: string; message?: string } }>;
  rgPath(): string;
  /** 本机 codex 程序(给对方的 Codex 提供 exec-server 执行环境)。 */
  codexPath?(): string | undefined;
  /** 本机 Cindy 工具(与本机 Pi 任务同一组 provider)。 */
  mcpProviders(): McpProvider[];
  prepareMcpBridge(
    providers: McpProvider[],
    logger: Logger,
    ctx: PiExtraSpawnConfigContext,
  ): Promise<PiExtraSpawnConfig | null>;
  makerMemory(): MakerMemoryManager | undefined;
  captureKnownFileBefore(input: { sessionId: string; provider: 'claude-code' | 'pi'; cwd: string; targetPath: string }): Promise<void>;
  noteOpaqueTurnChange(input: { sessionId: string; provider: 'claude-code' | 'pi'; cwd: string }): void;
  /** 改写来自对方的事件(如 Claude Code 的 Cindy 工具名换回自带工具名)。 */
  mapEvent?: (kind: AgentKind) => ((event: AgentEvent) => AgentEvent) | undefined;
  /** Read 读 PDF 时取文字。 */
  extractPdfText?: PdfTextExtractor;
  /** 这个任务由供应商组分配(本机的组或另一台电脑上的组)：打开时告诉那台不要再进入它自己的组。 */
  isGroupAssigned?(sessionId: string): boolean;
  /**
   * 供应商组「需要换一台」(分享的人，docs/product-rules/provider-groups.md §6.1)：打开任务时声明支持并带回交接后
   * 要用的凭证，对方发来的新凭证交回这里。
   */
  groupSwitch?: {
    takeForOpen(sessionId: string): string | undefined;
    offer(sessionId: string, token: string): void;
    /** 用户亲自接手后的这次发送开始新的一轮(取走即用掉)。 */
    takeNewRound?(sessionId: string): boolean;
  };
  /** 任务的「Agent 所在电脑」是不是分享来的供应商(受邀者任务)。 */
  isSharedProviderDevice?(deviceId: string): boolean;
  /** 受邀者任务在本机抓取网页的出站通道(WebFetch)。 */
  webFetch?: GuardedFetch;
  logger: Logger;
}

function mcpTargets(extra: PiExtraSpawnConfig | null): Map<string, LocalMcpTarget> {
  const targets = new Map<string, LocalMcpTarget>();
  const bridge = extra?.mcpBridge;
  if (!bridge) return targets;
  for (const server of bridge.servers) {
    if (server.remote) {
      // 外部 HTTP MCP：请求头真值从本机 env 映射取(与本机 Pi 的 bridge 扩展同一口径)。
      const headers: Record<string, string> = {};
      for (const [name, envName] of Object.entries(server.remote.headerEnvVars)) {
        const value = extra?.mcpEnv?.[envName];
        if (typeof value === 'string') headers[name] = value;
      }
      targets.set(server.name, { url: server.url, headers });
    } else {
      targets.set(server.name, { url: server.url, headers: bridge.token ? { authorization: `Bearer ${bridge.token}` } : {} });
    }
  }
  return targets;
}

async function isGitRepo(workingDir: string): Promise<boolean> {
  let dir = path.resolve(workingDir);
  for (let i = 0; i < 64; i += 1) {
    try {
      await fsp.stat(path.join(dir, '.git'));
      return true;
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) return false;
      dir = parent;
    }
  }
  return false;
}

/**
 * 每台电脑一个拉取器：那台上的全部任务共用一个 poll，不挤占设备互联的其它请求。本机作为控制端的任务
 * 与供应商组替受邀者中转的任务(remote-agent/host 的 groupRelay)共用同一份，同一台电脑只占一个长等待。
 * 空闲的拉取器不发任何请求，同账号电脑数量有限，留着复用。
 */
const sharedPollers = new WeakMap<DeviceAgentServiceDeps['remoteInvoke'], Map<string, RemoteAgentPoller>>();

export function remoteAgentPollerFor(
  deviceId: string,
  remoteInvoke: DeviceAgentServiceDeps['remoteInvoke'],
  log?: { warn(message: string, meta?: Record<string, unknown>): void },
): RemoteAgentPoller {
  let byDevice = sharedPollers.get(remoteInvoke);
  if (!byDevice) {
    byDevice = new Map();
    sharedPollers.set(remoteInvoke, byDevice);
  }
  let poller = byDevice.get(deviceId);
  if (!poller) {
    poller = new RemoteAgentPoller(remoteAgentInvoker(deviceId, remoteInvoke), log);
    byDevice.set(deviceId, poller);
  }
  return poller;
}

/** Maker 的 startDeviceAgentSession 实现。 */
export function createDeviceAgentStarter(deps: DeviceAgentServiceDeps) {
  const log = deps.logger.child('remote-agent');
  const pollerFor = (deviceId: string): RemoteAgentPoller => remoteAgentPollerFor(deviceId, deps.remoteInvoke, log);
  return async (input: { agentKind: AgentKind; deviceId: string; options: StartSessionOptions }): Promise<AgentSessionHandle> => {
    const opts: StartSessionOptions = { ...input.options };
    const poller = pollerFor(input.deviceId);
    // 记忆在本机：对方只用这里给的索引快照，工具读写也回到本机记忆库。
    if (opts.makerMemoryEnabled === true) {
      const scopeKey = opts.makerMemoryScopeKey ?? await resolveMemoryScopeKey(opts.workingDir, undefined);
      opts.makerMemoryScopeKey = scopeKey;
      if (opts.makerMemoryIndexSnapshot === undefined) {
        try {
          opts.makerMemoryIndexSnapshot = await (await deps.makerMemory()?.getStore(scopeKey))?.getIndex() ?? '';
        } catch (error) {
          log.warn('remote agent: memory index unavailable; starting without it', { error: String(error) });
          opts.makerMemoryIndexSnapshot = '';
        }
      }
    }
    const sessionId = opts.sessionId;
    const groupSwitch = sessionId && deps.groupSwitch ? deps.groupSwitch : null;
    const switchToken = groupSwitch && sessionId ? groupSwitch.takeForOpen(sessionId) : undefined;
    // 受邀者任务：Agent 自带的 WebFetch 在分享者电脑上已关闭，改由本机抓取。同账号任务不提供。
    const webFetch = deps.webFetch && deps.isSharedProviderDevice?.(input.deviceId) ? deps.webFetch : undefined;
    return startRemoteAgentSession(input.agentKind, opts, {
      invoke: poller.invoke,
      poller,
      rgPath: deps.rgPath(),
      codexPath: () => deps.codexPath?.(),
      ...(sessionId && deps.isGroupAssigned?.(sessionId) ? { groupAssigned: true } : {}),
      ...(groupSwitch && sessionId
        ? {
            groupSwitch: {
              ...(switchToken ? { token: switchToken } : {}),
              offer: (token: string) => groupSwitch.offer(sessionId, token),
              takeNewRound: () => groupSwitch.takeNewRound?.(sessionId) ?? false,
            },
          }
        : {}),
      ...(webFetch ? { webFetch } : {}),
      prepareMcp: async ({ kind, opts: startOpts, vendorOptions }): Promise<PreparedRemoteMcp> => {
        const extra = await deps.prepareMcpBridge(deps.mcpProviders(), deps.logger, {
          agentKind: kind,
          sessionId: startOpts.sessionId,
          ...(startOpts.sessionInstanceId ? { sessionInstanceId: startOpts.sessionInstanceId } : {}),
          workingDir: startOpts.workingDir,
          ...(startOpts.makerMemoryScopeKey ? { memoryScopeKey: startOpts.makerMemoryScopeKey } : {}),
          memoryEnabled: startOpts.makerMemoryEnabled === true,
          ...(startOpts.botRuntimeProfile?.mcpPolicy ? { botMcpPolicy: startOpts.botRuntimeProfile.mcpPolicy } : {}),
          vendorOptions,
          mcpCallerKind: 'root',
          mcpCallerAttested: true,
        });
        return {
          servers: mcpTargets(extra),
          dispose: () => extra?.disposeSessionCtx?.(),
        };
      },
      capture: ({ kind, opts: startOpts }): ExecutorCaptureHooks | undefined => {
        // Codex 自己报告每轮改动；Claude Code 与 Pi 的写入由执行器在写之前抓取。
        if (kind === 'codex' || !startOpts.sessionId) return undefined;
        const sessionId = startOpts.sessionId;
        const provider = kind;
        return {
          beforeWrite: (targetPath) => deps.captureKnownFileBefore({ sessionId, provider, cwd: startOpts.workingDir, targetPath }),
          noteOpaqueWrite: () => deps.noteOpaqueTurnChange({ sessionId, provider, cwd: startOpts.workingDir }),
        };
      },
      collectProjectFiles: collectProjectInstructionFiles,
      // Codex 经执行环境在本机直接读取项目与上级目录的说明，不必同步。
      collectAncestorFiles: input.agentKind === 'codex' ? undefined : collectAncestorInstructionFiles,
      collectPersonal: (kind, projectFiles) => collectPersonalConfig(kind, projectFiles),
      isGitRepo,
      ...(deps.extractPdfText ? { extractPdfText: deps.extractPdfText } : {}),
      mapEvent: deps.mapEvent ?? remoteAgentEventMapper,
      newId: randomUUID,
      log,
    });
  };
}
