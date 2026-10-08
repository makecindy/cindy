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

/** Maker 的 startDeviceAgentSession 实现。 */
export function createDeviceAgentStarter(deps: DeviceAgentServiceDeps) {
  const log = deps.logger.child('remote-agent');
  // 每台电脑一个拉取器：那台上的全部任务共用一个 poll，不挤占设备互联的其它请求。
  const pollers = new Map<string, RemoteAgentPoller>();
  // 空闲的拉取器不发任何请求，同账号电脑数量有限，留着复用。
  const pollerFor = (deviceId: string): RemoteAgentPoller => {
    let poller = pollers.get(deviceId);
    if (!poller) {
      poller = new RemoteAgentPoller(remoteAgentInvoker(deviceId, deps.remoteInvoke), log);
      pollers.set(deviceId, poller);
    }
    return poller;
  };
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
    return startRemoteAgentSession(input.agentKind, opts, {
      invoke: poller.invoke,
      poller,
      rgPath: deps.rgPath(),
      codexPath: () => deps.codexPath?.(),
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
