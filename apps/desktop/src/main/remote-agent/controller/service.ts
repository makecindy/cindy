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
import { LOCAL_AGENT_CLIENT, resolveMemoryScopeKey } from '@cindy/maker-core';
import { parseProviderSharePeer, providerShareHostPeer } from '@cindy/device-link';
import { createLogger } from '../../logger.js';
import { findReceivedShare, parseProviderShareAgentDeviceId } from '../../device-link/providerShareGuest.js';

import { credentialGrantFor } from '../executor/credentialGrants';
import type { ExecutorCaptureHooks } from '../executor/executor';
import type { PdfTextExtractor } from '../executor/files';
import type { GuardedFetch } from '../executor/webFetch';
import { RemoteConnectionPool } from './connectionPool';
import { remoteAgentEventMapper } from './eventMap';
import {
  collectAncestorInstructionFiles,
  collectAncestorMarkers,
  collectInstructionImports,
  collectPersonalConfig,
  collectProjectInstructionFiles,
} from './projectFiles';
import type { LocalMcpTarget } from './router';
import { RemoteAgentPoller, RemoteAgentRunClient, remoteAgentInvoker } from './runClient';
import { registerPendingRemoteStart, startRemoteAgentSession, type PreparedRemoteMcp } from './startRemote';
import { authorizeSharedTaskHistory, sharedTaskLeaseDeadline, trackLiveSharedTaskTarget } from './providerShareTaskLocation.js';

export interface DeviceAgentServiceDeps {
  readImageDeliveryEpoch?(sessionId: string): Promise<number>;
  remoteInvoke(deviceId: string, channel: string, args: unknown[]): Promise<{ ok: boolean; result?: unknown; error?: { code?: string; message?: string } }>;
  /** Re-open the authenticated share link after a successful lease renewal. */
  renewSharedProviderLink?(peer: string): Promise<unknown>;
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
    release?(sessionId: string): void;
    offer(sessionId: string, token: string): void;
    /** 用户亲自接手后的这次发送开始新的一轮(取走即用掉)。 */
    takeNewRound?(sessionId: string): boolean;
  };
  /** 任务的「Agent 所在电脑」是不是分享来的供应商(受邀者任务)。 */
  isSharedProviderDevice?(deviceId: string): boolean;
  /** 受邀者在设置里把这个分享切成了「信任 {分享者}」(每次操作前问一遍)。 */
  skipSharedProviderCredentialConsent?(deviceId: string): boolean;
  /** 受邀者任务在本机抓取网页的出站通道(WebFetch)。 */
  webFetch?: GuardedFetch;
  /** 受邀者任务里凭证类操作确认卡上的说明(按界面语言)。 */
  sharedProviderCredentialNotice?(): string;
  logger: Logger;
}

/** 没有提供界面语言的说明时用的英文说明。 */
const SHARED_PROVIDER_CREDENTIAL_NOTICE =
  "This task uses a shared provider, so what the agent reads passes through the sharer's computer or another computer they arrange. "
  + 'This may involve credentials, so it needs your confirmation. '
  + 'Always allow for this session skips further shared-provider credential confirmations in this task. '
  + 'Changing its permission mode or Plan mode, or quitting Cindy, requires confirmation again.';

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

// A live direct handle, rather than an allocation cache entry, owns the right to
// request a group switch. The identity prevents an old handle from clearing a
// newly opened task with the same session ID.
const liveDirectGuestSessions = new Map<string, {
  identity: object;
  ownerRoute: string;
  requestSwitch(): Promise<string | undefined>;
}>();
const DIRECT_GRANT_ID = /^[0-9a-f-]{36}$/;

export function liveDirectGuestSession(sessionId: string): Readonly<{
  ownerRoute: string;
  requestSwitch(): Promise<string | undefined>;
}> | null {
  return liveDirectGuestSessions.get(sessionId) ?? null;
}

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
  // Agent 统一流有突发限流；启动阶段日志必须完整落在 main 流，才能解释慢启动。
  const startupLog = createLogger('remote-agent:startup');
  const pollerFor = (deviceId: string): RemoteAgentPoller => remoteAgentPollerFor(deviceId, deps.remoteInvoke, log);
  // 每台运行 Agent 的电脑一个连接池：对方按这台设备计名额，池里算的是本机在那台上开着的连接；
  // 闲置多久可以让出按那台主人设置的闲置收回时长(打开前与主动让出前从 caps 读)。
  const pools = new Map<string, RemoteConnectionPool>();
  const directTasks = new Map<string, { target: string; agentKind: AgentKind; model: string;
    until: number; authorizedUntil: number; leaseDeadline: number; generation?: string }>();
  const poolFor = (deviceId: string): RemoteConnectionPool => {
    let pool = pools.get(deviceId);
    if (!pool) {
      const invoke = remoteAgentInvoker(deviceId, deps.remoteInvoke);
      pool = new RemoteConnectionPool({ log, readCaps: () => RemoteAgentRunClient.caps(invoke) });
      pools.set(deviceId, pool);
    }
    return pool;
  };
  type StartInput = { agentKind: AgentKind; deviceId: string; options: StartSessionOptions };
  const startAttempt = async (input: StartInput, skipDirect: boolean, attempt: ReturnType<typeof registerPendingRemoteStart>): Promise<AgentSessionHandle> => {
    const requireCurrent = () => attempt.signal.throwIfAborted();
    requireCurrent();
    const opts: StartSessionOptions = { ...input.options };
    // 记忆在本机：对方只用这里给的索引快照，工具读写也回到本机记忆库。
    if (opts.makerMemoryEnabled === true) {
      const scopeKey = opts.makerMemoryScopeKey ?? await resolveMemoryScopeKey(opts.workingDir, undefined);
      requireCurrent();
      opts.makerMemoryScopeKey = scopeKey;
      if (opts.makerMemoryIndexSnapshot === undefined) {
        try {
          const store = await deps.makerMemory()?.getStore(scopeKey);
          requireCurrent();
          opts.makerMemoryIndexSnapshot = await store?.getIndex() ?? '';
        } catch (error) {
          requireCurrent();
          log.warn('remote agent: memory index unavailable; starting without it', { error: String(error) });
          opts.makerMemoryIndexSnapshot = '';
        }
      }
    }
    requireCurrent();
    const sessionId = opts.sessionId;
    const groupSwitch = sessionId && deps.groupSwitch ? deps.groupSwitch : null;
    const switchToken = groupSwitch && sessionId ? groupSwitch.takeForOpen(sessionId) : undefined;
    if (switchToken && sessionId) directTasks.delete(`${parseProviderShareAgentDeviceId(input.deviceId) ?? ''}:${sessionId}`);
    // 受邀者任务(分享来的供应商)：可直连组内执行电脑；不可达时由分享者的电脑中转。
    //  - Agent 自带的 WebFetch 在分享者电脑上已关闭，改由本机抓取；
    //  - 凭证类文件不随启动同步，任务中读写凭证类文件、执行读取凭证的命令不论权限档都要本机确认。
    // 同账号任务都不提供。
    const shared = deps.isSharedProviderDevice?.(input.deviceId) === true || !!parseProviderShareAgentDeviceId(input.deviceId);
    const shareId = shared ? parseProviderShareAgentDeviceId(input.deviceId) : null;
    let target = input.deviceId;
    let selectedDirectRoute: ReturnType<typeof directTasks.get>;
    const releaseFailedDirectAllocation = async (generation: string | undefined): Promise<void> => {
      if (!sessionId || !generation) return;
      // A late failure from an old open must never revoke a newer allocation.
      try {
        await remoteAgentInvoker(input.deviceId, deps.remoteInvoke)([{
          op: 'direct-release', sessionId, generation,
        }]);
      } catch (error) {
        log.warn('shared provider failed direct allocation release will expire', { error: String(error) });
      }
    };
    if (shareId && opts.resumeSessionId) {
      if (!sessionId) throw new Error('[REMOTE_AGENT_INVALID] shared history requires its task identity');
      const owner = findReceivedShare(shareId);
      if (owner?.hostDeviceId) {
        await deps.renewSharedProviderLink?.(providerShareHostPeer(shareId, owner.hostDeviceId));
      }
      const allocationStartedAt = Date.now();
      const allocationStartedMonotonic = performance.now();
      requireCurrent();
      const history = await authorizeSharedTaskHistory(input.deviceId, sessionId, input.agentKind, opts.model, attempt.signal);
      if (attempt.signal.aborted) void releaseFailedDirectAllocation(history.generation);
      requireCurrent();
      target = history.target;
      const taskKey = `${shareId}:${sessionId}`;
      directTasks.delete(taskKey);
      if (history.direct) directTasks.set(taskKey, { target, agentKind: input.agentKind, model: opts.model,
        until: allocationStartedAt + 25 * 60_000, authorizedUntil: allocationStartedAt + 29 * 60_000,
        leaseDeadline: history.leaseDeadline ?? allocationStartedMonotonic + 30 * 60_000,
        ...(history.generation ? { generation: history.generation } : {}) });
      selectedDirectRoute = directTasks.get(taskKey);
    } else if (!skipDirect && shareId && sessionId && !deps.isGroupAssigned?.(sessionId) && !switchToken
      && findReceivedShare(shareId)?.status === 'active') {
      const taskKey = `${shareId}:${sessionId}`;
      const cached = directTasks.get(taskKey);
      if (cached && cached.until > Date.now() && cached.leaseDeadline > performance.now() && cached.agentKind === input.agentKind && cached.model === opts.model) {
        try {
          // M's grant is memory-only. A process restart can invalidate it even
          // while G's cached route still has time left.
          await RemoteAgentRunClient.caps(remoteAgentInvoker(cached.target, deps.remoteInvoke));
          requireCurrent();
          if (cached.leaseDeadline <= performance.now()) throw new Error('[REMOTE_AGENT_UNAVAILABLE] shared task authorization has expired');
          selectedDirectRoute = cached;
          target = cached.target;
        } catch {
          requireCurrent();
          directTasks.delete(taskKey);
        }
      }
      if (target === input.deviceId) {
        directTasks.delete(taskKey);
        try {
          const owner = findReceivedShare(shareId);
          if (owner?.hostDeviceId) {
            await deps.renewSharedProviderLink?.(providerShareHostPeer(shareId, owner.hostDeviceId));
          }
          requireCurrent();
          const allocationStartedAt = Date.now();
          const allocationStartedMonotonic = performance.now();
          const allocation = await remoteAgentInvoker(input.deviceId, deps.remoteInvoke)([{
            op: 'allocate', agentKind: input.agentKind, model: opts.model, sessionId,
          }]);
          const row = allocation && typeof allocation === 'object'
            ? allocation as { deviceId?: unknown; generation?: unknown } : null;
          if (attempt.signal.aborted) {
            const generation = typeof row?.generation === 'string' && DIRECT_GRANT_ID.test(row.generation) ? row.generation : undefined;
            void releaseFailedDirectAllocation(generation);
            requireCurrent();
          }
          if (row) {
            let proposed: string;
            const generation = typeof row.generation === 'string' && DIRECT_GRANT_ID.test(row.generation)
              ? row.generation : undefined;
            // Validate before publishing any route; the handshake also consumes this lease.
            let leaseDeadline: number;
            try {
              if (typeof row.deviceId !== 'string') throw new Error('[REMOTE_AGENT_INVALID] invalid shared executor');
              proposed = providerShareHostPeer(shareId, row.deviceId);
              leaseDeadline = sharedTaskLeaseDeadline(allocation, allocationStartedMonotonic) ?? allocationStartedMonotonic + 30 * 60_000;
              // A fresh task grant does not refresh G's cached transport state.
              // Confirm only this executor, using the share's existing relay.
              await deps.renewSharedProviderLink?.(proposed);
              requireCurrent();
              const caps = await RemoteAgentRunClient.caps(remoteAgentInvoker(proposed, deps.remoteInvoke));
              requireCurrent();
              if (!caps.directGuestExecution || !caps.agents.some(agent => agent.kind === input.agentKind && agent.available)) {
                throw new Error('[REMOTE_AGENT_PEER_TOO_OLD] shared executor cannot accept this task');
              }
              if (leaseDeadline <= performance.now()) throw new Error('[REMOTE_AGENT_UNAVAILABLE] shared task authorization has expired');
            }
            catch (error) {
              void releaseFailedDirectAllocation(generation);
              throw error;
            }
            target = proposed;
            for (const [key, route] of directTasks) if (route.until <= Date.now()) directTasks.delete(key);
            if (directTasks.size >= 512) directTasks.delete(directTasks.keys().next().value!);
            directTasks.set(taskKey, { target, agentKind: input.agentKind, model: opts.model,
              until: allocationStartedAt + 25 * 60_000,
              authorizedUntil: allocationStartedAt + 29 * 60_000,
              leaseDeadline,
              ...(generation ? { generation } : {}) });
            selectedDirectRoute = directTasks.get(taskKey);
          }
        } catch (error) {
          requireCurrent();
          log.warn('shared provider direct executor unavailable; using group owner', { error: String(error) });
        }
      }
    }
    requireCurrent();
    const poller = pollerFor(target);
    const directIdentity = {};
    if (shareId && sessionId && target !== input.deviceId) {
      liveDirectGuestSessions.set(sessionId, {
        identity: directIdentity,
        ownerRoute: input.deviceId,
        async requestSwitch() {
          const result = await remoteAgentInvoker(input.deviceId, deps.remoteInvoke)([{ op: 'direct-switch', sessionId }]);
          const token = result && typeof result === 'object' ? (result as { token?: unknown }).token : undefined;
          return typeof token === 'string' ? token : undefined;
        },
      });
    }
    const clearDirectIdentity = () => {
      if (sessionId && liveDirectGuestSessions.get(sessionId)?.identity === directIdentity) {
        liveDirectGuestSessions.delete(sessionId);
      }
    };
    const openingDirectGeneration = selectedDirectRoute?.generation;
    // Keep this attempt's grant even if another start replaces the task's route cache.
    const openingDirectRoute = selectedDirectRoute;
    let leaseDeadline = openingDirectRoute?.leaseDeadline ?? performance.now();
    let expiryTimer: ReturnType<typeof setTimeout> | undefined;
    const startupAbort = attempt;
    let expireLive: (() => void) | undefined;
    function armLeaseExpiry(): void {
      if (expiryTimer) clearTimeout(expiryTimer);
      const expire = () => {
        if (performance.now() < leaseDeadline) { armLeaseExpiry(); return; }
        startupAbort.abort(new Error('[REMOTE_AGENT_EXPIRED] shared task authorization has expired'));
        expireLive?.();
      };
      const remaining = leaseDeadline - performance.now();
      if (remaining <= 0) { expire(); return; }
      expiryTimer = setTimeout(expire, remaining);
      (expiryTimer as { unref?: () => void }).unref?.();
    }
    if (openingDirectRoute) armLeaseExpiry();
    const webFetch = deps.webFetch && shared ? deps.webFetch : undefined;
    const collect = { skipCredentials: shared };
    let cancelPreparedHandle: (() => void) | undefined;
    const handle = await startRemoteAgentSession(input.agentKind, opts, {
      startupSignal: attempt.signal,
      readImageDeliveryEpoch: deps.readImageDeliveryEpoch,
      invoke: poller.invoke,
      poller,
      pool: poolFor(target),
      rgPath: deps.rgPath(),
      codexPath: () => deps.codexPath?.(),
      ...(target !== input.deviceId || opts[LOCAL_AGENT_CLIENT]?.groupAssigned || (sessionId && deps.isGroupAssigned?.(sessionId))
        ? { groupAssigned: true } : {}),
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
      ...(shared
        ? {
            credentialConsent: {
              description: deps.sharedProviderCredentialNotice?.() ?? SHARED_PROVIDER_CREDENTIAL_NOTICE,
              // 受邀者在设置里对这个分享选了「信任 {分享者}」：实时读，运行中切换下一步就生效。
              skip: () => deps.skipSharedProviderCredentialConsent?.(input.deviceId) === true,
              ...(sessionId ? { grant: credentialGrantFor(sessionId, input.deviceId) } : {}),
            },
          }
        : {}),
      prepareMcp: async ({ kind, opts: startOpts, vendorOptions }): Promise<PreparedRemoteMcp> => {
        const client = startOpts[LOCAL_AGENT_CLIENT];
        if (client) return {
          servers: new Map([[client.mcpName ?? 'client', { url: client.url, headers: { authorization: `Bearer ${client.token}` } }]]),
          dispose() {},
        };
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
        if (startOpts[LOCAL_AGENT_CLIENT]) return undefined;
        // Codex 自己报告每轮改动；Claude Code 与 Pi 的写入由执行器在写之前抓取。
        if (kind === 'codex' || !startOpts.sessionId) return undefined;
        const sessionId = startOpts.sessionId;
        const provider = kind;
        return {
          beforeWrite: (targetPath) => deps.captureKnownFileBefore({ sessionId, provider, cwd: startOpts.workingDir, targetPath }),
          noteOpaqueWrite: () => deps.noteOpaqueTurnChange({ sessionId, provider, cwd: startOpts.workingDir }),
        };
      },
      collectProjectFiles: (workingDir) => collectProjectInstructionFiles(workingDir, collect),
      // Codex 经执行环境在本机直接读取项目与上级目录的说明，不必同步。
      collectAncestorFiles: input.agentKind === 'codex'
        ? undefined
        : (workingDir) => collectAncestorInstructionFiles(workingDir, collect),
      // Codex 建线程时沿上级目录逐级查找 .git 与插件清单：先把有没有报过去，对方不再逐个经设备互联来问。
      ...(input.agentKind === 'codex' ? { collectAncestorMarkers } : {}),
      collectPersonal: (kind, projectFiles) => collectPersonalConfig(kind, projectFiles, collect),
      collectImports: (imports) => collectInstructionImports(imports, collect),
      isGitRepo,
      ...(deps.extractPdfText ? { extractPdfText: deps.extractPdfText } : {}),
      mapEvent: deps.mapEvent ?? remoteAgentEventMapper,
      newId: randomUUID,
      log: {
        debug: (message, fields) => startupLog.debug(message, fields),
        info: (message, fields) => log.info(message, fields),
        warn: (message, fields) => log.warn(message, fields),
      },
    }).then(handle => {
      // Keep cancellation attached until the service finishes its optional early renewal.
      cancelPreparedHandle = () => { void handle.close({ reason: 'account-boundary' }).catch(() => undefined); };
      attempt.signal.addEventListener('abort', cancelPreparedHandle, { once: true });
      if (startupAbort.signal.aborted) {
        cancelPreparedHandle();
        throw startupAbort.signal.reason;
      }
      return handle;
    }).catch(async (error: unknown) => {
      if (cancelPreparedHandle) attempt.signal.removeEventListener('abort', cancelPreparedHandle);
      if (expiryTimer) clearTimeout(expiryTimer);
      const ownsDirectIdentity = !!sessionId
        && liveDirectGuestSessions.get(sessionId)?.identity === directIdentity;
      clearDirectIdentity();
      if (target !== input.deviceId && shareId && sessionId) {
        const taskKey = `${shareId}:${sessionId}`;
        const failed = directTasks.get(taskKey);
        if (ownsDirectIdentity && failed?.target === target && failed.generation === openingDirectGeneration) {
          directTasks.delete(taskKey);
          if (startupAbort.signal.aborted) void releaseFailedDirectAllocation(openingDirectGeneration);
          else await releaseFailedDirectAllocation(openingDirectGeneration);
        }
        // A native resume ID belongs only to M, including failure after caps.
        if (opts.resumeSessionId || startupAbort.signal.aborted
          || (error instanceof Error && error.message.startsWith('[REMOTE_AGENT_EXPIRED]'))) throw error;
        // M can disappear after caps succeeds. O's established relay path may
        // still reach another group member, so retry that same share route once.
        requireCurrent();
        const fallback = await startAttempt(input, true, attempt);
        target = input.deviceId;
        return fallback;
      }
      throw error;
    });
    if (attempt.signal.aborted) {
      if (expiryTimer) clearTimeout(expiryTimer);
      if (cancelPreparedHandle) attempt.signal.removeEventListener('abort', cancelPreparedHandle);
      const ownsIdentity = !!sessionId && liveDirectGuestSessions.get(sessionId)?.identity === directIdentity;
      clearDirectIdentity();
      if (ownsIdentity && shareId && sessionId && directTasks.get(shareId + ':' + sessionId) === openingDirectRoute) {
        directTasks.delete(shareId + ':' + sessionId);
        void releaseFailedDirectAllocation(openingDirectGeneration);
      }
      void handle.close({ reason: 'account-boundary' }).catch(() => undefined);
      throw attempt.signal.reason;
    }
    if (shareId && sessionId && target !== input.deviceId) {
      const taskKey = `${shareId}:${sessionId}`;
      const targetDeviceId = parseProviderSharePeer(target)?.deviceId;
      const report = (running: boolean) => {
        void remoteAgentInvoker(input.deviceId, deps.remoteInvoke)([{
          op: 'direct-status', sessionId, running,
        }]).catch(() => undefined);
      };
      const statusTimer = setInterval(() => report(handle.isTurnRunning?.() === true), 30_000);
      (statusTimer as { unref?: () => void }).unref?.();
      let authorizedUntil = openingDirectRoute?.authorizedUntil ?? Date.now();
      // The same monotonic budget has been active throughout local preparation and M startup.
      let nextRenewAt = Math.min(Date.now() + 20 * 60_000, authorizedUntil - 9 * 60_000);
      // The proxy's model snapshot can lag behind a successful setModel RPC.
      let authorizedModel = handle.model;
      let renewing = false;
      let stopped = false;
      const clearLiveTarget = trackLiveSharedTaskTarget(sessionId, input.deviceId, target,
        () => !stopped && Date.now() < authorizedUntil && performance.now() < leaseDeadline);
      let awaitingTurnEnd = false;
      let authorizationTurn = Promise.resolve();
      const serializeAuthorization = <T>(work: () => Promise<T>): Promise<T> => {
        const result = authorizationTurn.then(work);
        authorizationTurn = result.then(() => undefined, () => undefined);
        return result;
      };
      const authorizeCurrentExecutor = async (model: string): Promise<void> => {
        if (stopped || !targetDeviceId || !deps.renewSharedProviderLink) {
          throw new Error('[REMOTE_AGENT_UNAVAILABLE] shared executor authorization cannot be renewed');
        }
        const allocationStartedAt = Date.now();
        const allocationStartedMonotonic = performance.now();
        const value = await remoteAgentInvoker(input.deviceId, deps.remoteInvoke)([{
          op: 'allocate', agentKind: input.agentKind, model, sessionId,
          preferredExecutorDeviceId: targetDeviceId,
        }]);
        const row = value && typeof value === 'object'
          ? value as { deviceId?: unknown; generation?: unknown } : null;
        if (row?.deviceId !== targetDeviceId) {
          directTasks.delete(taskKey);
          throw new Error('[REMOTE_AGENT_UNAVAILABLE] current shared executor cannot accept this model');
        }
        const releaseStoppedGrant = async (): Promise<never> => {
          const generation = typeof row.generation === 'string' && DIRECT_GRANT_ID.test(row.generation) ? row.generation : undefined;
          await releaseFailedDirectAllocation(generation);
          throw new Error('[REMOTE_AGENT_UNAVAILABLE] shared task has closed');
        };
        if (stopped) return releaseStoppedGrant();
        await deps.renewSharedProviderLink(target);
        if (stopped) return releaseStoppedGrant();
        const nextLeaseDeadline = sharedTaskLeaseDeadline(value, allocationStartedMonotonic) ?? allocationStartedMonotonic + 30 * 60_000;
        directTasks.set(taskKey, { target, agentKind: input.agentKind, model,
          until: allocationStartedAt + 25 * 60_000,
          authorizedUntil: allocationStartedAt + 29 * 60_000,
          leaseDeadline: nextLeaseDeadline,
          ...(typeof row.generation === 'string' && DIRECT_GRANT_ID.test(row.generation)
            ? { generation: row.generation } : {}) });
        authorizedUntil = allocationStartedAt + 29 * 60_000;
        leaseDeadline = nextLeaseDeadline;
        armLeaseExpiry();
        nextRenewAt = Math.min(Date.now() + 20 * 60_000, authorizedUntil - 9 * 60_000);
      };
      const renewTimer = deps.renewSharedProviderLink ? setInterval(() => {
        if (renewing || Date.now() < nextRenewAt) return;
        renewing = true;
        void serializeAuthorization(() => authorizeCurrentExecutor(authorizedModel)).catch((error: unknown) => {
          log.warn('shared provider direct authorization renewal failed', { error: String(error) });
        }).finally(() => {
          renewing = false;
          // After a failed renewal, retry while the existing 30-minute lease is still alive.
          if (nextRenewAt <= Date.now()) nextRenewAt = Date.now() + 60_000;
        });
      }, 60_000) : null;
      (renewTimer as { unref?: () => void } | null)?.unref?.();
      if (handle.setModel) {
        const setModel = handle.setModel.bind(handle);
        handle.setModel = (model, options) => serializeAuthorization(async () => {
          const previousModel = authorizedModel;
          if (model === previousModel) return setModel(model, options);
          if (awaitingTurnEnd || handle.isTurnRunning?.() === true || handle.isPreparingUserTurn?.() === true) {
            throw new Error('[REMOTE_AGENT_UNAVAILABLE] wait for the shared task turn to finish before changing models');
          }
          // The executor's lease pins one model. Reauthorize the same M before
          // asking its live Agent to switch, then restore the old model on failure.
          try {
            await authorizeCurrentExecutor(model);
            await setModel(model, options);
            authorizedModel = model;
          } catch (error) {
            if (stopped) throw error;
            // The allocate response can be lost after O has already changed M's
            // lease. Reconfirm A even when B's outcome is ambiguous.
            try {
              await authorizeCurrentExecutor(previousModel);
              await setModel(previousModel, { providerId: null });
            } catch (restoreError) {
              directTasks.delete(taskKey);
              log.warn('shared provider previous model could not be restored', { error: String(restoreError) });
              throw new Error('[REMOTE_AGENT_UNAVAILABLE] previous shared model authorization could not be confirmed');
            }
            throw error;
          }
        });
      }
      const events = handle.events.bind(handle);
      handle.events = () => ({
        async *[Symbol.asyncIterator]() {
          for await (const event of events()) {
            if (event.type === 'done' || (event.type === 'error' && event.data
              && typeof event.data === 'object' && 'isTerminal' in event.data && event.data.isTerminal === true)) {
              awaitingTurnEnd = false;
            }
            yield event;
          }
        },
      });
      const send = handle.send.bind(handle);
      handle.send = (message, options) => serializeAuthorization(async () => {
        if (stopped) throw new Error('[REMOTE_AGENT_UNAVAILABLE] shared task authorization has ended');
        // A failed background renewal must become a visible error before a
        // later turn uses an expired grant on the old executor.
        if (Date.now() >= authorizedUntil) await authorizeCurrentExecutor(authorizedModel);
        report(true);
        awaitingTurnEnd = true;
        try { await send(message, options); }
        catch (error) { awaitingTurnEnd = false; throw error; }
        finally { report(handle.isTurnRunning?.() === true); }
      });
      const close = handle.close.bind(handle);
      const stop = () => {
        stopped = true;
        if (cancelPreparedHandle) attempt.signal.removeEventListener('abort', cancelPreparedHandle);
        clearLiveTarget();
        clearDirectIdentity();
        clearInterval(statusTimer);
        if (renewTimer) clearInterval(renewTimer);
        if (expiryTimer) clearTimeout(expiryTimer);
        report(false);
      };
      expireLive = () => {
        if (stopped) return;
        stop();
        // Local teardown does not wait for the expired remote route to accept close.
        void close({ reason: 'account-boundary' }).catch((error: unknown) => {
          log.warn('shared provider expired task close notification failed', { error: String(error) });
        });
      };
      handle.close = async (options) => { stop(); await close(options); };
      if (handle.detach) {
        const detach = handle.detach.bind(handle);
        handle.detach = async (options) => { stop(); await detach(options); };
      }
      // Opening a resumed task can take longer than the early-renewal window.
      // Refresh before handing it back if that window has already passed.
      if (nextRenewAt <= Date.now()) {
        try { await serializeAuthorization(() => authorizeCurrentExecutor(authorizedModel)); }
        catch (error) {
          stop();
          await close().catch(() => undefined);
          throw error;
        }
      }
    }
    // Keep the switch intent across a failed open. O binds the token to this
    // guest and task; release it only after a usable session is returned.
    if (cancelPreparedHandle) attempt.signal.removeEventListener('abort', cancelPreparedHandle);
    if (switchToken && sessionId) groupSwitch?.release?.(sessionId);
    return handle;
  };
  return async (input: StartInput): Promise<AgentSessionHandle> => {
    if (!input.options.sessionId) throw new Error('remote agent sessions require a session id');
    const attempt = registerPendingRemoteStart(input.options.sessionId);
    let ready: AgentSessionHandle | undefined;
    let rejectCancelled!: (error: unknown) => void;
    const cancelled = new Promise<never>((_, reject) => { rejectCancelled = reject; });
    const closeCancelled = () => { void ready?.close({ reason: 'account-boundary' }).catch(() => undefined); };
    const onCancel = () => { closeCancelled(); rejectCancelled(attempt.signal.reason); };
    attempt.signal.addEventListener('abort', onCancel, { once: true });
    try {
      return await Promise.race([startAttempt(input, false, attempt).then(handle => {
        ready = handle;
        if (attempt.signal.aborted) { closeCancelled(); throw attempt.signal.reason; }
        return handle;
      }), cancelled]);
    } finally {
      attempt.signal.removeEventListener('abort', onCancel);
      attempt.dispose();
    }
  };
}
