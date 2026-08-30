/**
 * PiAgent.startSession 失败清理 —— 纯控制流单测(mock PiRpcProcess,不 spawn 真 pi)。
 *
 * 契约:MCP 桥身份 ctx 在 preparePiExtraSpawnConfig 阶段注册后,若 startSession 在
 * 交出 handle 之前失败,必须注销该 ctx(否则 `?session=` 路由永久残留),并关掉可能
 * 已 spawn 的子进程(否则僵尸 pi 仍持有 MCP 路由)。两条失败路径:
 *   1. proc 构造(spawn)同步抛 —— 此刻尚无 proc 可关,只注销 ctx。
 *   2. 启动期 RPC(get_state 等)拒绝 —— 注销 ctx + 关 proc。
 * 成功路径不得误注销。
 *
 * 用 mock 是因为真 pi 无法确定性地触发"构造同步抛 / 启动 RPC 拒绝"(pi 接受不存在的
 * resume 路径、启动 RPC 也不会即时拒),控制流本身才是被测对象。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// hoisted 控制旋钮:vi.mock 工厂被提升到 import 之上,不能闭包引用普通 let。
const knobs = vi.hoisted(() => ({
  ctorThrows: false,
  getStateRejects: false,
  abortRejects: false,
  getStateGate: null as Promise<void> | null,
  closeRejects: false,
  closeFailuresRemaining: 0,
  closeGate: null as Promise<void> | null,
  closeCount: 0,
  onExit: null as null | ((info: { code: number | null; signal: string | null }) => void),
  onEvent: null as null | ((event: unknown) => void),
  /** Everything the bridge pushed back to the Pi process. */
  sent: [] as Array<Record<string, unknown>>,
  spawnedEnvs: [] as Array<Record<string, string | undefined>>,
  spawnedArgs: [] as string[][],
  requests: [] as string[],
}));

vi.mock('../transport.js', () => ({
  createPiStdioTransport: (opts: {
    args: string[];
    env: Record<string, string | undefined>;
    onProcessSpawned?: (pid: number) => void | (() => void);
  }) => {
    // spawn 参数/隔离 configHome 断言移到 transport 工厂(spawn 行为在 stdio transport)。
    knobs.spawnedEnvs.push({ ...(opts.env ?? {}) });
    knobs.spawnedArgs.push([...(opts.args ?? [])]);
    if (knobs.ctorThrows) throw new Error('spawn failed (mock)');
    opts.onProcessSpawned?.(1234);
    return {
      writeLine: async () => {},
      onLine: () => () => {},
      onStderr: () => () => {},
      onClose: () => () => {},
      close: async () => {},
      pid: 1234,
      isClosed: () => false,
    };
  },
  attachJsonlReader: () => {},
}));

vi.mock('../rpc-client.js', () => ({
  PiRpcProcess: class {
    isClosed = false;
    constructor(opts: unknown) {
      // 捕获 onExit 以便单测模拟进程异常退出(crash)。
      const o = opts as
        | {
            onExit?: typeof knobs.onExit;
            onEvent?: typeof knobs.onEvent;
          }
        | undefined;
      knobs.onExit = o?.onExit ?? null;
      knobs.onEvent = o?.onEvent ?? null;
    }
    async request(cmd: { type: string }): Promise<{ success: boolean; data?: unknown; error?: string }> {
      knobs.requests.push(cmd.type);
      if (cmd.type === 'get_state') {
        const gate = knobs.getStateGate;
        if (gate) await gate;
        if (knobs.getStateRejects) throw new Error('get_state rejected (mock)');
        return { success: true, data: { sessionFile: '/mock/session.jsonl', model: { contextWindow: 200000 } } };
      }
      if (cmd.type === 'abort' && knobs.abortRejects) {
        return { success: false, error: 'abort rejected (mock)' };
      }
      // switch_session / set_thinking_level / set_auto_compaction / get_entries 等一律成功。
      return { success: true, data: { entries: [] } };
    }
    send(message: unknown): void {
      knobs.sent.push(message as Record<string, unknown>);
    }
    async close(): Promise<void> {
      knobs.closeCount++;
      const gate = knobs.closeGate;
      if (gate) await gate;
      if (knobs.closeFailuresRemaining > 0) {
        knobs.closeFailuresRemaining -= 1;
        throw new Error('close unconfirmed (mock)');
      }
      if (knobs.closeRejects) throw new Error('close unconfirmed (mock)');
      this.isClosed = true;
    }
    get pid(): number { return 1234; }
  },
}));

import { PiAgent } from '../index.js';
import { Session } from '../../../session.js';
import * as piSubagentRuns from '../pi-subagent-runs.js';
import type { PiSubagentRunStatus } from '../pi-subagent-runs.js';
import { piProjectKey } from '../project-trust.js';
import type { AgentDeps } from '../../base-agent.js';
import type { Logger } from '../../../interfaces/logger.js';
import type { PiProjectTrustInputSnapshot } from '../../../types/pi-project-trust.js';

const noopLogger: Logger = {
  trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {},
  child: () => noopLogger,
};

describe('PiAgent.startSession failure cleanup (mocked pi process)', () => {
  let agentHome = '';
  let cwd = '';
  let disposed = 0;
  let proxyDisposed = 0;
  let proxyGeneration = 0;
  let preparedMcpContext: unknown;

  beforeEach(() => {
    knobs.ctorThrows = false;
    knobs.getStateRejects = false;
    knobs.abortRejects = false;
    knobs.getStateGate = null;
    knobs.closeRejects = false;
    knobs.closeFailuresRemaining = 0;
    knobs.closeGate = null;
    knobs.closeCount = 0;
    knobs.onExit = null;
    knobs.onEvent = null;
    knobs.sent = [];
    knobs.spawnedEnvs = [];
    knobs.spawnedArgs = [];
    knobs.requests = [];
    disposed = 0;
    proxyDisposed = 0;
    proxyGeneration++;
    preparedMcpContext = undefined;
    agentHome = mkdtempSync(path.join(tmpdir(), 'pi-cleanup-home-'));
    // Match fs.promises.realpath used by launch-time validation. On Windows the
    // non-native sync implementation may preserve an 8.3 alias (RUNNER~1)
    // while the async native implementation returns the final long path.
    cwd = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'pi-cleanup-cwd-')));
    mkdirSync(path.join(cwd, '.git'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(agentHome, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  function buildDeps(overrides: Partial<AgentDeps> = {}): AgentDeps {
    const generation = proxyGeneration;
    return {
      auth: {
        getState: async () => ({ authenticated: true, identity: 'test', authSource: 'api-key' as const }),
        triggerLogin: async () => ({ authenticated: true }),
        logout: async () => {},
        getAuthEnv: async () => ({}),
      },
      runtimeConfig: { endpoint: 'http://127.0.0.1:9' },
      // 不存在的路径即可:BaseAgent 只校验非空;plan-mode 扩展 stat 落空 → 跳过 get_entries。
      binaryPath: path.join(agentHome, 'pi'),
      logger: noopLogger,
      capabilityAdditions: {
        availableModels: [
          { id: 'm', displayName: 'M', contextWindow: 200_000, efforts: [], defaultEffort: null },
        ],
      },
      resolvePiGatewayModelApi: () => 'openai-responses',
      resolvePiAgentHome: () => agentHome,
      spawnPiSubagentRunner: () => {
        const handle = {
          pid: 4321,
          killed: false,
          once(event: 'spawn' | 'error' | 'exit' | 'close', listener: (...args: unknown[]) => void) {
            if (event === 'spawn') queueMicrotask(listener);
            return handle;
          },
          kill: () => true,
        };
        return handle as never;
      },
      registerPiProxySession: () => () => {
        // Detached Subagent leases intentionally dispose after close. Ignore a previous
        // test's late lease callback instead of charging it to the next test's counters.
        if (generation === proxyGeneration) proxyDisposed++;
      },
      // 注册身份并回传 disposeSessionCtx 探针；外部 MCP 描述只放 env 引用，真值
      // 单独放 mcpEnv，供本文件断言 spawn / bash 隔离契约。
      preparePiExtraSpawnConfig: async (_providers, context) => {
        preparedMcpContext = context;
        return {
          mcpBridge: {
            token: '',
            servers: [{
              name: 'custom_remote',
              url: 'https://mcp.example.test/',
              remote: {
                headerEnvVars: { authorization: 'CINDY_PI_REMOTE_MCP_SECRET_0' },
                startupTimeoutMs: 10_000,
                requestTimeoutMs: 600_000,
              },
            }],
          },
          mcpEnv: { CINDY_PI_REMOTE_MCP_SECRET_0: 'Bearer spawn-secret-canary' },
          disposeSessionCtx: () => { disposed++; },
        };
      },
      ...overrides,
    };
  }

  function approvedInput(
    workingDir: string,
    revision: string,
    skills: readonly string[],
    repoRoot = workingDir,
  ): PiProjectTrustInputSnapshot {
    const identity: PiProjectTrustInputSnapshot['identity'] = {
      workingDir,
      canonicalWorkingDir: workingDir,
      canonicalRepoRoot: repoRoot,
      repoRootStatus: 'resolved',
      platform: process.platform === 'win32' ? 'win32' : 'posix',
      canonicalPathEncoding: process.platform === 'win32' ? 'utf16-lossless' : 'utf8-lossless',
      ...(process.platform === 'win32'
        ? { windowsCaseComparison: 'ordinal-insensitive' as const }
        : {}),
    };
    const scopeKey = piProjectKey(identity);
    if (!scopeKey) throw new Error('test project identity must be canonical');
    return {
      identity,
      approval: {
        status: 'approved',
        scope: 'working-dir',
        scopeKey,
        revision,
      },
      discovered: {
        skills,
        canonicalSkillEvidence: skills.map((skillPath) => ({
          discoveredPath: skillPath,
          canonicalPath: skillPath,
        })),
        settings: [],
        packages: [],
        extensions: [],
      },
    };
  }

  function repeatedArgValues(args: readonly string[], flag: string): string[] {
    return args.flatMap((value, index) => value === flag && args[index + 1]
      ? [args[index + 1]!]
      : []);
  }

  function stagedSkillPath(configHome: string, index: number, sourcePath: string): string {
    return path.join(configHome, 'project-resources', 'skills', String(index), path.basename(sourcePath));
  }

  const opts = () => ({
    sessionId: 's1',
    sessionInstanceId: 'pi-instance-1',
    workingDir: cwd,
    model: 'm',
  });

  /**
   * Owner ids are `<host pid>:<session-instance scope>`; the pid half is what
   * lets an agent-home-wide sweep tell this process's runs from a concurrent
   * instance's. Fixtures owned by "this handle" must use the same shape.
   */
  const ownerId = (scope = 'pi-instance-1') =>
    piSubagentRuns.piSubagentRuntimeOwnerId(process.pid, scope);

  function pendingSubagentRun(
    input: Record<string, unknown>,
    overrides: Partial<PiSubagentRunStatus> = {},
    method: 'confirm' | 'input' = 'confirm',
  ): PiSubagentRunStatus {
    const runId = '123e4567-e89b-42d3-a456-426614174096';
    return {
      version: 1,
      runId,
      taskId: 'tool-subagent-approval',
      parentSessionId: 's1',
      runtimeOwnerId: ownerId(),
      interactiveOwner: 'host',
      runnerInstanceId: 'runner-subagent-approval',
      state: 'running',
      startedAt: 1,
      updatedAt: 2,
      tasks: [{
        childId: `${runId}-1`,
        sessionId: `${runId}-1`,
        agent: 'worker',
        title: 'approval-fixture',
        status: 'running',
        pendingApproval: {
          id: 'approval-1',
          method,
          title: 'cindy:permission',
          ...(method === 'input'
            ? { placeholder: JSON.stringify(input) }
            : { message: JSON.stringify(input) }),
        },
      }],
      ...overrides,
    };
  }

  it('disposes ctx (and does not close a nonexistent proc) when the process constructor throws synchronously', async () => {
    knobs.ctorThrows = true;
    const agent = new PiAgent(buildDeps());
    await expect(agent.startSession(opts())).rejects.toThrow(/spawn failed/);
    expect(disposed).toBe(1);
    expect(proxyDisposed).toBe(2);
    expect(knobs.closeCount).toBe(0); // 构造失败没有 proc 可关
  });

  it('disposes ctx and closes the proc when a startup RPC rejects before handoff', async () => {
    knobs.getStateRejects = true;
    const agent = new PiAgent(buildDeps());
    await expect(agent.startSession(opts())).rejects.toThrow(/get_state rejected/);
    expect(disposed).toBe(1);
    expect(proxyDisposed).toBe(2);
    expect(knobs.closeCount).toBe(1); // 已 spawn → 必须关掉,避免僵尸持有 ?session= 路由
  });

  it('quarantines a failed startup process until cleanup is confirmed', async () => {
    knobs.getStateRejects = true;
    knobs.closeRejects = true;
    const agent = new PiAgent(buildDeps());

    await expect(agent.startSession(opts())).rejects.toThrow(/cleanup remains unconfirmed/);
    expect(knobs.spawnedEnvs).toHaveLength(1);
    // Same business id cannot spawn while the old proc still fails cleanup.
    await expect(agent.startSession(opts())).rejects.toThrow(/close unconfirmed/);
    expect(knobs.spawnedEnvs).toHaveLength(1);

    knobs.closeRejects = false;
    knobs.getStateRejects = false;
    const handle = await agent.startSession(opts());
    expect(knobs.spawnedEnvs).toHaveLength(2);
    await handle.close();
  });

  it('retries every quarantined startup process during dispose and remains idempotent', async () => {
    knobs.getStateRejects = true;
    knobs.closeRejects = true;
    const agent = new PiAgent(buildDeps());

    await expect(agent.startSession(opts())).rejects.toThrow(/cleanup remains unconfirmed/);
    await expect(agent.startSession({ ...opts(), sessionId: 's2' })).rejects.toThrow(
      /cleanup remains unconfirmed/,
    );
    expect(knobs.closeCount).toBe(2);

    knobs.closeRejects = false;
    await agent.dispose();
    await agent.dispose();

    expect(knobs.closeCount).toBe(4);
  });

  it('reclaims a startup cleanup entry registered after dispose begins', async () => {
    let releaseGetState!: () => void;
    knobs.getStateGate = new Promise<void>((resolve) => {
      releaseGetState = resolve;
    });
    knobs.getStateRejects = true;
    knobs.closeFailuresRemaining = 1;
    const agent = new PiAgent(buildDeps());

    const startup = agent.startSession(opts());
    const startupFailure = expect(startup).rejects.toThrow(/cleanup remains unconfirmed/);
    await vi.waitFor(() => expect(knobs.spawnedEnvs).toHaveLength(1));
    const disposing = agent.dispose();
    releaseGetState();

    await startupFailure;
    await disposing;
    expect(knobs.closeCount).toBe(2);
    await expect(agent.startSession(opts())).rejects.toThrow(/disposing/);
  });

  it('shares a late dispose cleanup and fences replacement startup', async () => {
    knobs.getStateRejects = true;
    knobs.closeRejects = true;
    const agent = new PiAgent(buildDeps());

    await expect(agent.startSession(opts())).rejects.toThrow(/cleanup remains unconfirmed/);
    expect(knobs.spawnedEnvs).toHaveLength(1);

    let releaseClose!: () => void;
    knobs.closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    knobs.closeRejects = false;
    const firstDispose = agent.dispose();
    const secondDispose = agent.dispose();
    await vi.waitFor(() => expect(knobs.closeCount).toBe(2));
    await expect(agent.startSession(opts())).rejects.toThrow(/disposing/);
    expect(knobs.spawnedEnvs).toHaveLength(1);

    releaseClose();
    await Promise.all([firstDispose, secondDispose]);
    knobs.closeGate = null;

    expect(knobs.spawnedEnvs).toHaveLength(1);
    expect(knobs.closeCount).toBe(2);
  });

  it('does not dispose ctx on the success path (dispose is deferred to close())', async () => {
    const agent = new PiAgent(buildDeps());
    const handle = await agent.startSession(opts());
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    knobs.onEvent?.({ type: 'message_start' });
    expect(preparedMcpContext).toMatchObject({
      sessionId: 's1',
      sessionInstanceId: 'pi-instance-1',
      workingDir: cwd,
      mcpCallerKind: 'root',
      mcpCallerAttested: true,
    });
    expect(disposed).toBe(0);
    expect(proxyDisposed).toBe(0);
    await handle.close();
    // Pi RPC and Cindy's durable Subagent status poll are both session-owned.
    expect(clearIntervalSpy).toHaveBeenCalledTimes(2);
    expect(disposed).toBe(1); // close() 才注销
    expect(proxyDisposed).toBe(2);
  });

  /**
   * Durable run fixture on disk, owned by this test's runtime instance so the
   * host-side approval/ownership fences accept it.
   */
  function writeDurableRunStatus(
    runId: string,
    state: 'running' | 'completed',
    extra: Record<string, unknown> = {},
  ): string {
    const runDir = path.join(agentHome, 'runtime', 'pi-subagent-runs', 's1', runId);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      path.join(runDir, 'status.json'),
      JSON.stringify({
        version: 1,
        runId,
        taskId: 'tool-durable',
        parentSessionId: 's1',
        runtimeOwnerId: ownerId(),
        runnerInstanceId: 'runner-durable',
        state,
        startedAt: 1,
        updatedAt: Date.now(),
        ...(state === 'completed' ? { endedAt: Date.now() } : {}),
        tasks: [{
          childId: `${runId}-1`,
          sessionId: `${runId}-1`,
          agent: 'scout',
          status: state,
        }],
        ...extra,
      }) + '\n',
    );
    return runDir;
  }

  it('keeps the proxy token leased until detached Subagents settle', async () => {
    const agent = new PiAgent(buildDeps());
    const handle = await agent.startSession(opts());
    const runId = '123e4567-e89b-42d3-a456-426614174099';
    writeDurableRunStatus(runId, 'running');

    await handle.close({ reason: 'navigation' });
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(disposed).toBe(1);
    expect(proxyDisposed).toBe(0);

    writeDurableRunStatus(runId, 'completed');
    await vi.waitFor(() => expect(proxyDisposed).toBe(2), { timeout: 2_000 });
  });

  it('drains the approval set at the boundary instead of sampling it once', () => {
    // Defence in depth, asserted on the source because it cannot be observed:
    // the dispatch gate makes a second round impossible, so a single snapshot
    // now happens to be sufficient and the two shapes behave identically. The
    // loop is what keeps that true if the gate is ever weakened — sampling once
    // is precisely how the previous version let an offer fired after the fence
    // escape the wait.
    const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')
      .replace(/\r\n/g, '\n');
    const teardown = source.slice(
      source.indexOf('const stopDetachedSubagentRunsForAccountBoundary = async ()'),
    );
    const barrier = teardown.slice(0, teardown.indexOf('let proxyLeaseInitialInspection'));
    expect(barrier).toContain('while (converged && piSubagentApprovalDispatches.size > 0)');
    // Still bounded, and the budget is shared by every round rather than
    // restarted per round — a wedged resolver must not extend a logout.
    expect(barrier).toContain("setTimeout(() => resolve('timed-out'), 2_000)");
    expect([...barrier.matchAll(/setTimeout\(/g)]).toHaveLength(1);
    // The gate itself: no offer may start once the fence is up, which is what
    // makes a drain terminate at all.
    const dispatcher = source.slice(source.indexOf('const dispatchPiSubagentApproval = ('));
    const gate = dispatcher.indexOf('if (accountBoundaryTeardown) return;');
    const call = dispatcher.indexOf('resolvePiSubagentApproval(status, task)');
    expect(gate).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(gate);
    // And every dispatch site goes through that one door.
    expect([...source.matchAll(/resolvePiSubagentApproval\(status, task\)/g)]).toHaveLength(1);
  });

  it('raises the account-boundary fence before close() awaits anything', () => {
    // The fence used to be raised only inside
    // `stopDetachedSubagentRunsForAccountBoundary`, which runs *after*
    // `await piSubagentResumeTail`. A Pi process exiting inside that await ran
    // `onExit` with the fence still down, and the supervisor it started handed
    // the outgoing owner's proxy disposer to detached children and re-armed
    // their approval surface — the handover the boundary exists to prevent.
    //
    // Asserted on the source because the window only exists while a resume is
    // in flight; the behavioural fixtures here have an already-settled tail, so
    // they cannot tell the two orderings apart. What has to hold is the order
    // itself: the fence is raised before the first await on this path.
    const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')
      .replace(/\r\n/g, '\n');
    const closeStart = source.indexOf("const accountBoundary = (closeOpts?.reason ?? 'account-boundary')");
    expect(closeStart).toBeGreaterThan(-1);
    const raise = source.indexOf('if (accountBoundary) accountBoundaryTeardown = true;', closeStart);
    const firstAwait = source.indexOf('await piSubagentResumeTail;', closeStart);
    const boundaryStop = source.indexOf('await stopDetachedSubagentRunsForAccountBoundary();', closeStart);
    expect(raise).toBeGreaterThan(closeStart);
    expect(firstAwait).toBeGreaterThan(raise);
    expect(boundaryStop).toBeGreaterThan(firstAwait);
  });

  it('stamps Pi as the provider on durable background-task snapshots', () => {
    const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')
      .replace(/\r\n/g, '\n');
    const listed = source.slice(
      source.indexOf('listBackgroundTasks() {'),
      source.indexOf('async requestGracefulStop()'),
    );
    expect(listed).toContain("taskType: 'pi_subagent'");
    expect(listed).toContain("provider: 'pi' as const");
  });

  /**
   * A parent that dies between publishing the `queued` status and spawning the
   * runner leaves a record with no `runnerPid`. That is not a lease held to the
   * supervisor's 24h ceiling, and this pins why:
   *
   *  - `classifyRunnerPresenceSync` answers `gone` for a missing/invalid pid
   *    (`pi-subagent-runs.ts`) once the owner process is also gone, so after
   *    the 15s heartbeat window `isPiSubagentRunStale` is true;
   *  - `listPiSubagentRuns` drops stale records, so the supervisor's `active`
   *    is false;
   *  - its release also needs one of `directoryCount === 0` /
   *    `allDirectoriesReadable` / past `unreadableDirectoryDeadline`. The first
   *    two are false while the orphan directory sits there unreadable, but the
   *    deadline is only 2s after the supervisor starts — so the release lands on
   *    the first poll after staleness, not at the hard ceiling.
   *
   * Exposure is therefore bounded by the heartbeat window plus one 250ms poll.
   */
  it('releases the lease for a queued orphan once its heartbeat lapses', async () => {
    const agent = new PiAgent(buildDeps());
    const handle = await agent.startSession(opts());
    // Published `queued`, never spawned, and last touched longer ago than the
    // heartbeat window — exactly what a parent dying mid-launch leaves behind.
    const runId = '123e4567-e89b-42d3-a456-4266141740f5';
    const runDir = path.join(agentHome, 'runtime', 'pi-subagent-runs', 's1', runId);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(path.join(runDir, 'status.json'), `${JSON.stringify({
      version: 1,
      runId,
      taskId: 'tool-orphan',
      parentSessionId: 's1',
      runtimeOwnerId: piSubagentRuns.piSubagentRuntimeOwnerId(4_194_303, 'pi-instance-1'),
      runnerInstanceId: `launch-pending-${runId}`,
      state: 'queued',
      startedAt: Date.now() - 60_000,
      updatedAt: Date.now() - 60_000,
      tasks: [{ childId: `${runId}-1`, sessionId: `${runId}-1`, agent: 'scout', status: 'queued' }],
    })}\n`);

    await handle.close({ reason: 'navigation' });
    // Not held: no runner pid means nothing to supervise, and the record is
    // already past its heartbeat window.
    await vi.waitFor(() => expect(proxyDisposed).toBe(2), { timeout: 3_000 });
  });

  it('keeps the lease while a queued record is still within its heartbeat window', async () => {
    // The complement, so the case above cannot be "satisfied" by releasing on
    // any queued record: a launch published moments ago may still be spawning.
    const agent = new PiAgent(buildDeps());
    const handle = await agent.startSession(opts());
    const runId = '123e4567-e89b-42d3-a456-4266141740f6';
    const runDir = path.join(agentHome, 'runtime', 'pi-subagent-runs', 's1', runId);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(path.join(runDir, 'status.json'), `${JSON.stringify({
      version: 1,
      runId,
      taskId: 'tool-fresh',
      parentSessionId: 's1',
      runtimeOwnerId: ownerId(),
      runnerInstanceId: `launch-pending-${runId}`,
      state: 'queued',
      startedAt: Date.now(),
      updatedAt: Date.now(),
      tasks: [{ childId: `${runId}-1`, sessionId: `${runId}-1`, agent: 'scout', status: 'queued' }],
    })}\n`);

    await handle.close({ reason: 'navigation' });
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(proxyDisposed).toBe(0);
  });

  it('projects a diagnostic when a run dies without publishing a terminal status', async () => {
    // The panel refreshes off change pushes. Dropping the run from the in-memory
    // map without emitting one left the row reading `running` for good — the
    // durable reconciler only runs when something asks it to.
    const handle = await new PiAgent(buildDeps()).startSession(opts());
    const updates: unknown[] = [];
    void (async () => {
      for await (const event of handle.events()) {
        if (event.type === 'agent_task_update') updates.push(event.data);
      }
    })();

    const runId = '123e4567-e89b-42d3-a456-4266141740f1';
    writeDurableRunStatus(runId, 'running');
    await vi.waitFor(
      () => expect(updates.some((u) => (u as { taskType?: string }).taskType === 'pi_subagent')).toBe(true),
      { timeout: 3_000 },
    );

    // The runner dies without writing a terminal status: an expired heartbeat
    // over a pid that is provably gone is what "stale" means.
    writeDurableRunStatus(runId, 'running', {
      runnerPid: 4_194_303,
      updatedAt: Date.now() - 120_000,
      startedAt: Date.now() - 180_000,
    });

    await vi.waitFor(() => {
      const diagnostic = updates.find(
        (u) => (u as { taskType?: string }).taskType === 'pi_subagent_diagnostic',
      ) as { status?: string; summary?: string; taskId?: string } | undefined;
      expect(diagnostic).toBeDefined();
      expect(diagnostic?.status).toBe('failed');
      expect(diagnostic?.taskId).toBe('tool-durable');
      expect(diagnostic?.summary).toMatch(/stopped unexpectedly/i);
    }, { timeout: 3_000 });

    await handle.close({ reason: 'navigation' });
  });

  it('holds approval dedupe state through a status that is briefly unreadable', async () => {
    // `listPiSubagentRuns` hides what it cannot parse, and a status.json is
    // unreadable for a moment every time it is rewritten. Treating that as "the
    // run is gone" cleared the dedupe records, so the same pendingApproval was
    // offered again the instant the file parsed — two decisions racing for one
    // request.
    const run = pendingSubagentRun({ toolName: 'write', input: { path: 'a.txt' } });
    const list = vi.spyOn(piSubagentRuns, 'listPiSubagentRuns').mockResolvedValue([run]);
    vi.spyOn(piSubagentRuns, 'listPiSubagentRunDirectoryIds').mockResolvedValue([run.runId]);
    vi.spyOn(piSubagentRuns, 'listPiSubagentRunDiagnostics').mockResolvedValue([]);
    const control = vi.spyOn(piSubagentRuns, 'controlPiSubagentRuns').mockResolvedValue(1);
    const handle = await new PiAgent(buildDeps()).startSession(opts());
    handle.setInteractionResolver(vi.fn(async () => ({ kind: 'permission', behavior: 'allow' }) as const));

    await vi.waitFor(() => expect(control).toHaveBeenCalledTimes(1), { timeout: 3_000 });

    // One refresh cannot read it — the directory is still there, so nothing is
    // concluded — and then it reads again, unchanged.
    list.mockResolvedValueOnce([]);
    await new Promise((resolve) => setTimeout(resolve, 1_200));

    // Still exactly one decision for that approval.
    expect(control).toHaveBeenCalledTimes(1);
    await handle.close({ reason: 'navigation' });
  });

  it('does not release the lease on an empty scan while Pi can still launch', async () => {
    // Navigating away exactly as a subagent tool starts: the supervisor's first
    // scan runs before the extension has created the run directory. Treating
    // that emptiness as "no durable runs" revoked the proxy token and stopped
    // approval supervision, and the run that appeared a moment later had its
    // model requests fail with nobody to answer its approvals. Pi's own exit is
    // the only honest boundary.
    const agent = new PiAgent(buildDeps());
    const handle = await agent.startSession(opts());

    // Close with nothing on disk yet: the supervisor's first scan runs while Pi
    // is still alive and sees an empty directory.
    const runId = '123e4567-e89b-42d3-a456-4266141740c1';
    await handle.close({ reason: 'navigation' });
    // The launch that was already in flight inside Pi lands now — after that
    // first scan. The old code had already revoked the token by this point.
    writeDurableRunStatus(runId, 'running');
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(proxyDisposed).toBe(0);

    // And it is still supervised: settling it releases the lease as usual.
    writeDurableRunStatus(runId, 'completed');
    await vi.waitFor(() => expect(proxyDisposed).toBe(2), { timeout: 3_000 });
  });

  it('keeps answering detached Subagent approvals after the parent handle closes', async () => {
    // Regression: close() used to clear the only timer that refreshed
    // pendingApproval *and* short-circuit the approval handler on `closed`,
    // while the detached child and its proxy token survived to the durable run's
    // own terminal state. The child then waited out its run timeout on a card
    // nobody was consuming.
    const run = pendingSubagentRun({ toolName: 'write', input: { path: 'a.txt' } });
    vi.spyOn(piSubagentRuns, 'listPiSubagentRuns').mockResolvedValue([run]);
    vi.spyOn(piSubagentRuns, 'countPiSubagentRunDirectories').mockResolvedValue(1);
    const control = vi.spyOn(piSubagentRuns, 'controlPiSubagentRuns').mockResolvedValue(1);
    const handle = await new PiAgent(buildDeps()).startSession(opts());
    // A resolver stays wired to the handle; only the parent handle is closing.
    const resolver = vi.fn(async () => ({ kind: 'permission', behavior: 'allow' }) as const);

    await handle.close({ reason: 'navigation' });
    // The approval only appears after close, so nothing could have been
    // consumed by the foreground refresh timer.
    handle.setInteractionResolver(resolver);

    await vi.waitFor(() => expect(control).toHaveBeenCalledWith(
      expect.any(String),
      run.taskId,
      'approval',
      expect.objectContaining({ confirmed: true }),
    ), { timeout: 3_000 });
    expect(resolver).toHaveBeenCalledWith(expect.objectContaining({
      toolName: 'write',
      metadata: expect.objectContaining({ subagent: true }),
    }));
    // The lease is still held: the detached run has not settled.
    expect(proxyDisposed).toBe(0);
  });

  /**
   * Production teardown: a real `Session` owns the handle, so closing it runs
   * `performClose`, which clears `interactionListener` in its `finally`. The
   * resolver the handle keeps then answers `no_listener_attached` — the exact
   * path that used to turn "nobody was listening" into a system denial.
   */
  function wrapInSession(handle: Awaited<ReturnType<PiAgent['startSession']>>): Session {
    return new Session({
      id: 's1',
      agentKind: 'pi',
      workDir: cwd,
      handle,
      capabilities: { permissionModes: ['ask', 'auto', 'bypassPermissions'] } as never,
      logger: noopLogger,
    });
  }

  it('parks a detached Subagent approval instead of denying it when the listener is torn down', async () => {
    const run = pendingSubagentRun({ toolName: 'write', input: { path: 'a.txt' } });
    vi.spyOn(piSubagentRuns, 'listPiSubagentRuns').mockResolvedValue([run]);
    vi.spyOn(piSubagentRuns, 'countPiSubagentRunDirectories').mockResolvedValue(1);
    const control = vi.spyOn(piSubagentRuns, 'controlPiSubagentRuns').mockResolvedValue(1);
    const handle = await new PiAgent(buildDeps()).startSession(opts());
    const session = wrapInSession(handle);
    // No listener is ever attached: this is the torn-down surface, reached
    // through the real Session resolver rather than by poking the handle.
    await session.close();

    // Give the detached supervisor several poll cycles.
    await new Promise((resolve) => setTimeout(resolve, 900));

    // Nothing was delivered — in particular no `confirmed: false`.
    expect(control).not.toHaveBeenCalled();
    // Still leased: the run is live and its question is still open.
    expect(proxyDisposed).toBe(0);
  });

  it('delivers a parked Subagent approval once an approval surface is attached again', async () => {
    const run = pendingSubagentRun({ toolName: 'write', input: { path: 'a.txt' } });
    vi.spyOn(piSubagentRuns, 'listPiSubagentRuns').mockResolvedValue([run]);
    vi.spyOn(piSubagentRuns, 'countPiSubagentRunDirectories').mockResolvedValue(1);
    const control = vi.spyOn(piSubagentRuns, 'controlPiSubagentRuns').mockResolvedValue(1);
    const handle = await new PiAgent(buildDeps()).startSession(opts());
    const session = wrapInSession(handle);
    await session.close();
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(control).not.toHaveBeenCalled();

    // Re-attaching a Session re-wires the handle resolver (the same call the
    // production rebuild path makes) and the parked question is offered again.
    const reattached = wrapInSession(handle);
    reattached.setInteractionListener(async () => ({
      kind: 'permission',
      behavior: 'allow',
    }) as never);

    await vi.waitFor(() => expect(control).toHaveBeenCalledWith(
      expect.any(String),
      run.taskId,
      'approval',
      expect.objectContaining({ confirmed: true }),
    ), { timeout: 3_000 });
  });

  it('still denies a detached Subagent approval when a real surface refuses it', async () => {
    // fail-closed boundary is unchanged: "surface exists and said no" is a deny,
    // only "nobody was listening" parks.
    const run = pendingSubagentRun({ toolName: 'write', input: { path: 'a.txt' } });
    vi.spyOn(piSubagentRuns, 'listPiSubagentRuns').mockResolvedValue([run]);
    vi.spyOn(piSubagentRuns, 'countPiSubagentRunDirectories').mockResolvedValue(1);
    const control = vi.spyOn(piSubagentRuns, 'controlPiSubagentRuns').mockResolvedValue(1);
    const handle = await new PiAgent(buildDeps()).startSession(opts());
    const session = wrapInSession(handle);
    session.setInteractionListener(async () => ({
      kind: 'permission',
      behavior: 'deny',
      reason: 'user_rejected',
    }) as never);

    await vi.waitFor(() => expect(control).toHaveBeenCalledWith(
      expect.any(String),
      run.taskId,
      'approval',
      expect.objectContaining({ confirmed: false }),
    ), { timeout: 3_000 });
    await session.close();
  });

  it('parks an in-flight Subagent card when the session tears the surface down under it', async () => {
    // The user had the card on screen and never answered; closing the session
    // must not convert that into a denial for a child that is still running.
    const run = pendingSubagentRun({ toolName: 'write', input: { path: 'a.txt' } });
    vi.spyOn(piSubagentRuns, 'listPiSubagentRuns').mockResolvedValue([run]);
    vi.spyOn(piSubagentRuns, 'countPiSubagentRunDirectories').mockResolvedValue(1);
    const control = vi.spyOn(piSubagentRuns, 'controlPiSubagentRuns').mockResolvedValue(1);
    const handle = await new PiAgent(buildDeps()).startSession(opts());
    const session = wrapInSession(handle);
    let sawRequest!: () => void;
    const requestShown = new Promise<void>((resolve) => { sawRequest = resolve; });
    // Never resolves: the card is up and the user is thinking.
    session.setInteractionListener((() => {
      sawRequest();
      return new Promise(() => {});
    }) as never);

    await requestShown;
    await session.close();
    await new Promise((resolve) => setTimeout(resolve, 900));

    expect(control).not.toHaveBeenCalled();
  });

  it('stops detached Subagent runners and revokes the proxy token at an account boundary', async () => {
    const agent = new PiAgent(buildDeps());
    const handle = await agent.startSession(opts());
    const runId = '123e4567-e89b-42d3-a456-426614174095';
    const runDir = writeDurableRunStatus(runId, 'running');
    const stop = vi
      .spyOn(piSubagentRuns, 'stopPiSubagentRunsForAccountBoundary')
      .mockResolvedValue(true);

    await handle.close({ reason: 'account-boundary' });

    expect(stop).toHaveBeenCalledWith(
      path.join(agentHome, 'runtime', 'pi-subagent-runs', 's1'),
      { runtimeOwnerId: ownerId() },
    );
    // No lease transfer: the old owner's gateway route is revoked immediately.
    expect(proxyDisposed).toBe(2);
    expect(disposed).toBe(1);
    // Ownership boundary, not data removal.
    expect(existsSync(runDir)).toBe(true);
    // The run stays live long enough to prove nothing re-leased the token.
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(proxyDisposed).toBe(2);
  });

  it('does not resurrect a detached supervisor when the process exits after an account boundary', async () => {
    // proc.close() fires onExit after close() already stopped the runners; that
    // exit must not start a supervisor that answers the outgoing owner's cards.
    const run = pendingSubagentRun({ toolName: 'write', input: { path: 'a.txt' } });
    vi.spyOn(piSubagentRuns, 'listPiSubagentRuns').mockResolvedValue([run]);
    vi.spyOn(piSubagentRuns, 'countPiSubagentRunDirectories').mockResolvedValue(1);
    // A runner that misses its stop deadline is exactly the risky case.
    vi.spyOn(piSubagentRuns, 'stopPiSubagentRunsForAccountBoundary').mockResolvedValue(false);
    const control = vi.spyOn(piSubagentRuns, 'controlPiSubagentRuns').mockResolvedValue(1);
    const resolver = vi.fn(async () => ({ kind: 'permission', behavior: 'allow' }) as const);
    const handle = await new PiAgent(buildDeps()).startSession(opts());
    handle.setInteractionResolver(resolver);

    await handle.close({ reason: 'account-boundary' });
    knobs.onExit?.({ code: 0, signal: null });
    await new Promise((resolve) => setTimeout(resolve, 600));

    expect(control).not.toHaveBeenCalled();
    expect(resolver).not.toHaveBeenCalled();
  });

  it('leaves the supervisor when the account boundary is raised after it started', async () => {
    // The other ordering (boundary first, exit second) is covered above. This
    // is the one the supervisor could not see: Pi crashes, onExit starts the
    // supervisor, and only then does the user switch accounts. The teardown
    // stops the children, but one killed a moment ago still has an unexpired
    // heartbeat, so the loop kept reading it as active — and went on answering
    // its approvals through the outgoing account's resolver while holding that
    // account's proxy lease.
    let approvalGeneration = 0;
    vi.spyOn(piSubagentRuns, 'listPiSubagentRuns').mockImplementation(async () => {
      // A fresh approval id per poll: the supervisor's dedupe would otherwise
      // hide a loop that is still very much running.
      approvalGeneration += 1;
      const run = pendingSubagentRun({ toolName: 'write', input: { path: 'a.txt' } });
      run.tasks[0]!.pendingApproval!.id = `approval-${approvalGeneration}`;
      return [run];
    });
    vi.spyOn(piSubagentRuns, 'countPiSubagentRunDirectories').mockResolvedValue(1);
    vi.spyOn(piSubagentRuns, 'controlPiSubagentRuns').mockResolvedValue(1);
    // The risky case: the runner missed its stop deadline.
    vi.spyOn(piSubagentRuns, 'stopPiSubagentRunsForAccountBoundary').mockResolvedValue(false);
    const resolver = vi.fn(async () => ({ kind: 'permission', behavior: 'allow' }) as const);
    const handle = await new PiAgent(buildDeps()).startSession(opts());
    handle.setInteractionResolver(resolver);

    knobs.onExit?.({ code: 1, signal: null });
    await vi.waitFor(() => expect(resolver.mock.calls.length).toBeGreaterThan(0), { timeout: 2_000 });
    const answeredBeforeBoundary = resolver.mock.calls.length;

    await handle.close({ reason: 'account-boundary' });
    // Long enough for several 250ms supervisor rounds.
    await new Promise((resolve) => setTimeout(resolve, 900));

    // The lease goes back to the outgoing account instead of riding the
    // still-"active" run to the supervisor's 24h ceiling.
    expect(proxyDisposed).toBe(2);
    expect(resolver.mock.calls.length).toBe(answeredBeforeBoundary);
  });

  it('does not return from an account-boundary close while an approval write is still in flight', async () => {
    // Raising the fence and stopping the children only starts the wind-down. An
    // offer already dispatched keeps going on its own: it holds the outgoing
    // owner's resolver and finishes by writing the child's control mailbox. So
    // before the barrier, close() could return — the caller then revoking the
    // token and handing the runtime over — with that write still in progress.
    let approvalGeneration = 0;
    vi.spyOn(piSubagentRuns, 'listPiSubagentRuns').mockImplementation(async () => {
      approvalGeneration += 1;
      const run = pendingSubagentRun({ toolName: 'write', input: { path: 'a.txt' } });
      run.tasks[0]!.pendingApproval!.id = `approval-${approvalGeneration}`;
      return [run];
    });
    vi.spyOn(piSubagentRuns, 'countPiSubagentRunDirectories').mockResolvedValue(1);
    let writesStarted = 0;
    let writesFinished = 0;
    vi.spyOn(piSubagentRuns, 'controlPiSubagentRuns').mockImplementation(async () => {
      writesStarted += 1;
      await new Promise((resolve) => setTimeout(resolve, 300));
      writesFinished += 1;
      return 1;
    });
    vi.spyOn(piSubagentRuns, 'stopPiSubagentRunsForAccountBoundary').mockResolvedValue(true);
    const resolver = vi.fn(async () => ({ kind: 'permission', behavior: 'allow' }) as const);
    const handle = await new PiAgent(buildDeps()).startSession(opts());
    handle.setInteractionResolver(resolver);

    knobs.onExit?.({ code: 1, signal: null });
    // A mailbox write is under way, and deliberately not finished yet.
    await vi.waitFor(() => expect(writesStarted).toBeGreaterThan(0), { timeout: 2_000 });
    expect(writesFinished).toBe(0);

    await handle.close({ reason: 'account-boundary' });

    // Nothing of the outgoing owner's is still writing once close resolved.
    expect(writesFinished).toBe(writesStarted);
    const startedAtClose = writesStarted;
    const offersAtClose = resolver.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(writesStarted).toBe(startedAtClose);
    expect(resolver.mock.calls.length).toBe(offersAtClose);
    // And the lease went back with it.
    expect(proxyDisposed).toBe(2);
  });

  it('does not dispatch an approval the boundary raised while a scan was in flight', async () => {
    // The gap the barrier alone could not close: a supervisor round passes its
    // fence check, then blocks in the directory scan. The fence goes up while
    // it is in there, so the round's own check is already stale — and the
    // offers it fires when the scan returns were never in the set the barrier
    // sampled. Closing that means refusing at dispatch, not waiting harder.
    let openScan!: () => void;
    let releaseScan!: () => void;
    const scanStarted = new Promise<void>((resolve) => { openScan = resolve; });
    const scanGate = new Promise<void>((resolve) => { releaseScan = resolve; });
    let scans = 0;
    vi.spyOn(piSubagentRuns, 'listPiSubagentRuns').mockImplementation(async () => {
      scans += 1;
      if (scans === 1) {
        openScan();
        await scanGate;
      }
      return [pendingSubagentRun({ toolName: 'write', input: { path: 'a.txt' } })];
    });
    vi.spyOn(piSubagentRuns, 'countPiSubagentRunDirectories').mockResolvedValue(1);
    const control = vi.spyOn(piSubagentRuns, 'controlPiSubagentRuns').mockResolvedValue(1);
    vi.spyOn(piSubagentRuns, 'stopPiSubagentRunsForAccountBoundary').mockResolvedValue(true);
    const resolver = vi.fn(async () => ({ kind: 'permission', behavior: 'allow' }) as const);
    const handle = await new PiAgent(buildDeps()).startSession(opts());
    handle.setInteractionResolver(resolver);

    knobs.onExit?.({ code: 1, signal: null });
    await scanStarted;
    // close() raises the fence before its first await, so it is up by the time
    // the scan is allowed to finish.
    const closing = handle.close({ reason: 'account-boundary' });
    releaseScan();
    await closing;
    await new Promise((resolve) => setTimeout(resolve, 700));

    expect(scans).toBeGreaterThan(0);
    expect(resolver).not.toHaveBeenCalled();
    expect(control).not.toHaveBeenCalled();
    expect(proxyDisposed).toBe(2);
  });

  it('refuses to deliver an answer decided before the boundary but ready after it', async () => {
    // Auto-review reaches the mailbox without ever touching a user surface, so
    // the offer is not parked when the session closes — it simply finishes its
    // await and writes. Deciding under the outgoing account is fine; delivering
    // to a child after that account stopped owning the runtime is not, so the
    // fence is read again immediately before the write.
    let openReview!: () => void;
    let releaseReview!: () => void;
    const reviewStarted = new Promise<void>((resolve) => { openReview = resolve; });
    const reviewGate = new Promise<void>((resolve) => { releaseReview = resolve; });
    const run = pendingSubagentRun({
      toolName: 'bash',
      input: { command: 'printf hi > ./inside.txt' },
    }, {}, 'input');
    vi.spyOn(piSubagentRuns, 'listPiSubagentRuns').mockResolvedValue([run]);
    vi.spyOn(piSubagentRuns, 'countPiSubagentRunDirectories').mockResolvedValue(1);
    const control = vi.spyOn(piSubagentRuns, 'controlPiSubagentRuns').mockResolvedValue(1);
    vi.spyOn(piSubagentRuns, 'stopPiSubagentRunsForAccountBoundary').mockResolvedValue(true);
    const review = vi.fn(async () => {
      openReview();
      await reviewGate;
      return { verdict: 'allow' as const };
    });
    const handle = await new PiAgent(buildDeps({ reviewAutoPermissionAction: review }))
      .startSession({ ...opts(), permissionMode: 'auto' });

    await reviewStarted;
    const closing = handle.close({ reason: 'account-boundary' });
    releaseReview();
    await closing;
    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(review).toHaveBeenCalled();
    expect(control).not.toHaveBeenCalled();
  });

  it('stays idempotent over a repeated account-boundary close', async () => {
    let approvalGeneration = 0;
    vi.spyOn(piSubagentRuns, 'listPiSubagentRuns').mockImplementation(async () => {
      approvalGeneration += 1;
      const run = pendingSubagentRun({ toolName: 'write', input: { path: 'a.txt' } });
      run.tasks[0]!.pendingApproval!.id = `approval-${approvalGeneration}`;
      return [run];
    });
    vi.spyOn(piSubagentRuns, 'countPiSubagentRunDirectories').mockResolvedValue(1);
    const control = vi.spyOn(piSubagentRuns, 'controlPiSubagentRuns').mockResolvedValue(1);
    vi.spyOn(piSubagentRuns, 'stopPiSubagentRunsForAccountBoundary').mockResolvedValue(true);
    const resolver = vi.fn(async () => ({ kind: 'permission', behavior: 'allow' }) as const);
    const handle = await new PiAgent(buildDeps()).startSession(opts());
    handle.setInteractionResolver(resolver);

    knobs.onExit?.({ code: 1, signal: null });
    await vi.waitFor(() => expect(control.mock.calls.length).toBeGreaterThan(0), { timeout: 2_000 });
    await handle.close({ reason: 'account-boundary' });
    const writes = control.mock.calls.length;

    // A second teardown must not re-enter the barrier's budget, which is what a
    // leaked dispatch entry would cause, and must add no mailbox writes.
    const startedAt = Date.now();
    await handle.close({ reason: 'account-boundary' });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(control.mock.calls.length).toBe(writes);
  });

  it('fails closed to the account boundary when a teardown caller names no reason', async () => {
    const agent = new PiAgent(buildDeps());
    const handle = await agent.startSession(opts());
    writeDurableRunStatus('123e4567-e89b-42d3-a456-426614174094', 'running');
    const stop = vi
      .spyOn(piSubagentRuns, 'stopPiSubagentRunsForAccountBoundary')
      .mockResolvedValue(true);

    await handle.close();

    expect(stop).toHaveBeenCalledOnce();
    expect(proxyDisposed).toBe(2);
  });

  it('acknowledges durable Subagent turn-change capture without creating a user permission prompt', async () => {
    const runId = '123e4567-e89b-42d3-a456-426614174097';
    const noteOpaqueWrite = vi.fn();
    const control = vi.spyOn(piSubagentRuns, 'controlPiSubagentRuns').mockResolvedValue(1);
    vi.spyOn(piSubagentRuns, 'listPiSubagentRuns').mockResolvedValue([{
      version: 1,
      runId,
      taskId: 'tool-turn-change',
      parentSessionId: 's1',
      runtimeOwnerId: ownerId(),
      runnerInstanceId: 'runner-turn-change',
      state: 'running',
      startedAt: 1,
      updatedAt: 2,
      tasks: [{
        childId: `${runId}-1`,
        sessionId: `${runId}-1`,
        agent: 'worker',
        status: 'running',
        pendingApproval: {
          id: 'capture-1',
          method: 'confirm',
          title: 'cindy:turn-change-capture',
          message: JSON.stringify({
            toolName: 'bash',
            toolUseId: 'bash-1',
            input: { command: 'printf done' },
          }),
        },
      }],
    }]);
    const handle = await new PiAgent(buildDeps({
      turnChangeCapture: {
        beforeKnownFileWrite: vi.fn(async () => undefined),
        noteOpaqueWrite,
      },
    })).startSession(opts());

    await vi.waitFor(() => expect(control).toHaveBeenCalledWith(
      expect.any(String),
      'tool-turn-change',
      'approval',
      // `objectContaining`, not an exact match: the publish also passes the
      // fence callbacks the helper consults next to each write. They are
      // functions the helper calls, never fields it serialises — the mailbox
      // payload's own shape is pinned in `pi-subagent-runs.test.ts`.
      expect.objectContaining({
        childId: `${runId}-1`,
        approvalId: 'capture-1',
        confirmed: true,
        runtimeOwnerId: ownerId(),
      }),
    ));
    expect(noteOpaqueWrite).toHaveBeenCalledWith({
      sessionId: 's1',
      provider: 'pi',
      cwd,
    });

    await handle.close();
  });

  /**
   * The caller-side fence check is not the write. Between them
   * `controlPiSubagentRuns` discovers runs and guards the run directory —
   * several awaits, long enough for a teardown to start *and finish its stop
   * sweep*. The answer then landed anyway, and the child could act on an
   * `allow` using the account that had already gone away.
   *
   * The check that closes that is inside the helper, next to the write (pinned
   * in `pi-subagent-runs.test.ts`). What these two pin is the wiring: that this
   * session hands the helper a predicate reading the *live* flag, and that the
   * teardown waits for a publish already inside the helper before it sweeps.
   */
  describe('an account boundary that rises inside an approval publish', () => {
    function pendingPublishFixture(): {
      publishStarted: Promise<void>;
      releasePublish: () => void;
      gate: () => (() => boolean) | undefined;
      resolver: ReturnType<typeof vi.fn>;
    } {
      const run = pendingSubagentRun({ toolName: 'write', input: { path: 'a.txt' } });
      vi.spyOn(piSubagentRuns, 'listPiSubagentRuns').mockResolvedValue([run]);
      vi.spyOn(piSubagentRuns, 'countPiSubagentRunDirectories').mockResolvedValue(1);
      let openPublish!: () => void;
      let releasePublish!: () => void;
      const publishStarted = new Promise<void>((resolve) => { openPublish = resolve; });
      const publishGate = new Promise<void>((resolve) => { releasePublish = resolve; });
      let captured: (() => boolean) | undefined;
      // Stands in for the helper's own multi-await stretch between the caller's
      // check and the mailbox write.
      vi.spyOn(piSubagentRuns, 'controlPiSubagentRuns').mockImplementation(
        async (_root, _taskId, _action, options) => {
          captured = (options as { beforeMailboxWrite?: () => boolean } | undefined)
            ?.beforeMailboxWrite;
          openPublish();
          await publishGate;
          return 1;
        },
      );
      return {
        publishStarted,
        releasePublish,
        gate: () => captured,
        resolver: vi.fn(async () => ({ kind: 'permission', behavior: 'allow' }) as const),
      };
    }

    it('hands the helper a predicate that reads the live fence, not a snapshot', async () => {
      const fixture = pendingPublishFixture();
      vi.spyOn(piSubagentRuns, 'stopPiSubagentRunsForAccountBoundary').mockResolvedValue(true);
      const handle = await new PiAgent(buildDeps()).startSession(opts());
      handle.setInteractionResolver(fixture.resolver as never);

      await fixture.publishStarted;
      // Captured while the boundary is still down: it must answer "write".
      expect(fixture.gate()?.()).toBe(true);

      const closing = handle.close({ reason: 'account-boundary' });
      // Same closure, after the flag went up. A snapshot would still say true,
      // and the answer would land in a child's mailbox behind the sweep.
      expect(fixture.gate()?.()).toBe(false);
      fixture.releasePublish();
      await closing;
    });

    it('does not start the stop sweep until the publish has left the write phase', async () => {
      // Ordering, not just refusal: a publish that passed the gate is an fs
      // write in flight, and letting it land after the sweep is the hole the
      // gate alone cannot close. The teardown drains the write phase first —
      // that phase only, since acknowledgement waits on the very runner it is
      // about to stop.
      const fixture = pendingPublishFixture();
      const sweep = vi.spyOn(piSubagentRuns, 'stopPiSubagentRunsForAccountBoundary')
        .mockResolvedValue(true);
      const handle = await new PiAgent(buildDeps()).startSession(opts());
      handle.setInteractionResolver(fixture.resolver as never);

      await fixture.publishStarted;
      const closing = handle.close({ reason: 'account-boundary' });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(sweep).not.toHaveBeenCalled();

      fixture.releasePublish();
      await closing;
      expect(sweep).toHaveBeenCalled();
    });
  });

  /**
   * The live bridge is the other exit for the same decision. The durable path
   * publishes into a mailbox; this one answers the running Pi process directly,
   * and both used to release unconditionally after an await that can outlast
   * the account it was authorised under.
   */
  describe('the live extension bridge across an account boundary', () => {
    function responsesFor(id: string): Array<Record<string, unknown>> {
      return knobs.sent.filter((message) => (
        message.type === 'extension_ui_response' && message.id === id
      ));
    }

    it('does not release a turn-change capture whose snapshot outlived the account', async () => {
      let openSnapshot!: () => void;
      let releaseSnapshot!: () => void;
      const snapshotStarted = new Promise<void>((resolve) => { openSnapshot = resolve; });
      const snapshotGate = new Promise<void>((resolve) => { releaseSnapshot = resolve; });
      vi.spyOn(piSubagentRuns, 'stopPiSubagentRunsForAccountBoundary').mockResolvedValue(true);
      const handle = await new PiAgent(buildDeps({
        turnChangeCapture: {
          beforeKnownFileWrite: vi.fn(async () => {
            openSnapshot();
            await snapshotGate;
          }),
          noteOpaqueWrite: vi.fn(),
        },
      })).startSession(opts());

      knobs.onEvent?.({
        type: 'extension_ui_request',
        id: 'capture-live',
        method: 'confirm',
        title: 'cindy:turn-change-capture',
        message: JSON.stringify({ toolName: 'write', input: { path: 'a.txt' } }),
      });
      await snapshotStarted;

      // close() raises the fence before its first await, so it is up while the
      // workspace snapshot is still running.
      const closing = handle.close({ reason: 'account-boundary' });
      releaseSnapshot();
      await closing;
      await new Promise((resolve) => setTimeout(resolve, 300));

      // Parked, not denied: nothing at all goes back for this request. The
      // process it belongs to is being closed by the same teardown.
      expect(responsesFor('capture-live')).toEqual([]);
    });

    it('does not release a permission answer decided before the boundary', async () => {
      // The longest await this bridge has is a human at a card. Every exit
      // funnels through one send, which is where the fence sits.
      let openPrompt!: () => void;
      let releasePrompt!: () => void;
      const promptShown = new Promise<void>((resolve) => { openPrompt = resolve; });
      const promptGate = new Promise<void>((resolve) => { releasePrompt = resolve; });
      vi.spyOn(piSubagentRuns, 'stopPiSubagentRunsForAccountBoundary').mockResolvedValue(true);
      const handle = await new PiAgent(buildDeps()).startSession(opts());
      handle.setInteractionResolver((async () => {
        openPrompt();
        await promptGate;
        return { kind: 'permission', behavior: 'allow' } as const;
      }) as never);

      knobs.onEvent?.({
        type: 'extension_ui_request',
        id: 'permission-live',
        method: 'confirm',
        title: 'cindy:permission',
        message: JSON.stringify({ toolName: 'write', input: { path: 'a.txt' } }),
      });
      await promptShown;

      const closing = handle.close({ reason: 'account-boundary' });
      releasePrompt();
      await closing;
      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(responsesFor('permission-live')).toEqual([]);
    });

    it('still answers when no boundary is crossed', async () => {
      // The fence must not become a general mute: an ordinary capture on a live
      // session releases exactly as before.
      const handle = await new PiAgent(buildDeps({
        turnChangeCapture: {
          beforeKnownFileWrite: vi.fn(async () => undefined),
          noteOpaqueWrite: vi.fn(),
        },
      })).startSession(opts());

      knobs.onEvent?.({
        type: 'extension_ui_request',
        id: 'capture-normal',
        method: 'confirm',
        title: 'cindy:turn-change-capture',
        message: JSON.stringify({ toolName: 'write', input: { path: 'a.txt' } }),
      });
      await vi.waitFor(() => expect(responsesFor('capture-normal')).toHaveLength(1));

      expect(responsesFor('capture-normal')[0]).toMatchObject({ confirmed: true });
      await handle.close({ reason: 'navigation' });
    });
  });

  it('does not acknowledge a turn-change capture that finished after the account boundary', async () => {
    // The capture branch acknowledges without ever asking the user, so it looked
    // like it had no window — but `beforeKnownFileWrite` snapshots the file, and
    // that await is as long as the workspace is large. A switch inside it left
    // the outgoing account's surface telling a child of the outgoing account to
    // go ahead and write. Same write-side fence check as the ordinary path; same
    // fail-closed meaning, which here is *parked*: no confirmed, and no deny.
    const runId = '123e4567-e89b-42d3-a456-426614174097';
    let openCapture!: () => void;
    let releaseCapture!: () => void;
    const captureStarted = new Promise<void>((resolve) => { openCapture = resolve; });
    const captureGate = new Promise<void>((resolve) => { releaseCapture = resolve; });
    const control = vi.spyOn(piSubagentRuns, 'controlPiSubagentRuns').mockResolvedValue(1);
    vi.spyOn(piSubagentRuns, 'countPiSubagentRunDirectories').mockResolvedValue(1);
    vi.spyOn(piSubagentRuns, 'stopPiSubagentRunsForAccountBoundary').mockResolvedValue(true);
    vi.spyOn(piSubagentRuns, 'listPiSubagentRuns').mockResolvedValue([{
      version: 1,
      runId,
      taskId: 'tool-turn-change',
      parentSessionId: 's1',
      runtimeOwnerId: ownerId(),
      runnerInstanceId: 'runner-turn-change',
      state: 'running',
      startedAt: 1,
      updatedAt: 2,
      tasks: [{
        childId: `${runId}-1`,
        sessionId: `${runId}-1`,
        agent: 'worker',
        status: 'running',
        pendingApproval: {
          id: 'capture-boundary',
          method: 'confirm',
          title: 'cindy:turn-change-capture',
          // A known file write, so the long snapshot path is the one taken.
          message: JSON.stringify({ toolName: 'write', input: { path: 'a.txt' } }),
        },
      }],
    }]);
    const handle = await new PiAgent(buildDeps({
      turnChangeCapture: {
        beforeKnownFileWrite: vi.fn(async () => {
          openCapture();
          await captureGate;
        }),
        noteOpaqueWrite: vi.fn(),
      },
    })).startSession(opts());

    await captureStarted;
    // close() raises the fence before its first await, so it is up while the
    // snapshot is still running.
    const closing = handle.close({ reason: 'account-boundary' });
    releaseCapture();
    await closing;
    await new Promise((resolve) => setTimeout(resolve, 400));

    // Scoped to this session's run root. A supervisor left running by an
    // earlier case in this file polls the same module-level spy, and it reads
    // the run above too — but through the agent home *it* was built with, which
    // a fresh `mkdtemp` per test makes distinct.
    const ownRunRoot = path.join(agentHome, 'runtime', 'pi-subagent-runs', 's1');
    expect(control.mock.calls.filter((call) => call[0] === ownRunRoot)).toEqual([]);
  });

  it.each([
    ['allow', true],
    ['deny', false],
  ] as const)('forwards durable Subagent Ask payload and delivers %s once', async (behavior, confirmed) => {
    const run = pendingSubagentRun({
      toolName: 'bash',
      input: { command: 'printf fixture' },
    });
    vi.spyOn(piSubagentRuns, 'listPiSubagentRuns').mockResolvedValue([run]);
    const control = vi.spyOn(piSubagentRuns, 'controlPiSubagentRuns').mockResolvedValue(1);
    const resolver = vi.fn(async () => ({ kind: 'permission', behavior }) as const);
    const handle = await new PiAgent(buildDeps()).startSession(opts());
    handle.setInteractionResolver(resolver);

    await vi.waitFor(() => expect(control).toHaveBeenCalledWith(
      expect.any(String),
      run.taskId,
      'approval',
      expect.objectContaining({
        childId: run.tasks[0]!.childId,
        approvalId: 'approval-1',
        confirmed,
        runtimeOwnerId: ownerId(),
      }),
    ));
    expect(resolver).toHaveBeenCalledOnce();
    expect(resolver).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'permission',
      toolName: 'bash',
      input: { command: 'printf fixture' },
      title: 'Subagent: bash',
      description: 'Requested by approval-fixture',
      metadata: expect.objectContaining({ provider: 'pi', subagent: true }),
    }));
    await handle.close();
  });

  it.each([
    ['allow', 'allow'],
    ['deny', 'user-deny'],
  ] as const)(
    'preserves durable Subagent %s decisions through the source-aware envelope',
    async (behavior, value) => {
      const run = pendingSubagentRun({
        toolName: 'bash',
        input: { command: 'printf fixture' },
      }, {}, 'input');
      vi.spyOn(piSubagentRuns, 'listPiSubagentRuns').mockResolvedValue([run]);
      const control = vi.spyOn(piSubagentRuns, 'controlPiSubagentRuns').mockResolvedValue(1);
      const handle = await new PiAgent(buildDeps()).startSession(opts());
      handle.setInteractionResolver(vi.fn(async () => ({ kind: 'permission', behavior }) as const));

      await vi.waitFor(() => expect(control).toHaveBeenCalledWith(
        expect.any(String),
        run.taskId,
        'approval',
        expect.objectContaining({ value }),
      ));
      await handle.close();
    },
  );

  it('preserves Auto-review denial for durable Subagent child tools', async () => {
    const run = pendingSubagentRun({
      toolName: 'bash',
      input: { command: 'printf unsafe > /tmp/outside.txt' },
    }, {}, 'input');
    vi.spyOn(piSubagentRuns, 'listPiSubagentRuns').mockResolvedValue([run]);
    const control = vi.spyOn(piSubagentRuns, 'controlPiSubagentRuns').mockResolvedValue(1);
    const review = vi.fn(async () => ({ verdict: 'block' as const }));
    const handle = await new PiAgent(buildDeps({ reviewAutoPermissionAction: review })).startSession({
      ...opts(),
      permissionMode: 'auto',
    });
    const resolver = vi.fn(async () => ({ kind: 'permission', behavior: 'allow' }) as const);
    handle.setInteractionResolver(resolver);

    await vi.waitFor(() => expect(control).toHaveBeenCalledWith(
      expect.any(String),
      run.taskId,
      'approval',
      expect.objectContaining({ value: 'auto-review-deny' }),
    ));
    expect(review).toHaveBeenCalledOnce();
    expect(resolver).not.toHaveBeenCalled();
    await handle.close();
  });

  it('preserves system denial when a durable Subagent approval resolver fails', async () => {
    const run = pendingSubagentRun({
      toolName: 'write',
      input: { path: 'a.txt' },
    }, {}, 'input');
    vi.spyOn(piSubagentRuns, 'listPiSubagentRuns').mockResolvedValue([run]);
    const control = vi.spyOn(piSubagentRuns, 'controlPiSubagentRuns').mockResolvedValue(1);
    const handle = await new PiAgent(buildDeps()).startSession(opts());
    handle.setInteractionResolver(vi.fn(async () => { throw new Error('resolver failed'); }));

    await vi.waitFor(() => expect(control).toHaveBeenCalledWith(
      expect.any(String),
      run.taskId,
      'approval',
      expect.objectContaining({ value: 'system-deny' }),
    ));
    await handle.close();
  });

  it('never answers durable Subagent approvals owned by another runtime', async () => {
    const run = pendingSubagentRun(
      { toolName: 'write', input: { path: 'a.txt' } },
      // A *different live* Cindy process: adoption requires same-process or a
      // dead owner, so this stays refused.
      { runtimeOwnerId: piSubagentRuns.piSubagentRuntimeOwnerId(process.ppid, 'another-runtime') },
    );
    vi.spyOn(piSubagentRuns, 'listPiSubagentRuns').mockResolvedValue([run]);
    const control = vi.spyOn(piSubagentRuns, 'controlPiSubagentRuns').mockResolvedValue(1);
    const resolver = vi.fn(async () => ({ kind: 'permission', behavior: 'allow' }) as const);
    const handle = await new PiAgent(buildDeps()).startSession(opts());
    handle.setInteractionResolver(resolver);

    await new Promise((resolve) => setTimeout(resolve, 550));
    expect(control).not.toHaveBeenCalled();
    expect(resolver).not.toHaveBeenCalled();
    await handle.close();
  });

  it('refuses an approval whose run belongs to a different parent task', async () => {
    const run = pendingSubagentRun(
      { toolName: 'write', input: { path: 'a.txt' } },
      {
        runtimeOwnerId: ownerId('other-instance'),
        parentSessionId: 'some-other-session',
      },
    );
    vi.spyOn(piSubagentRuns, 'listPiSubagentRuns').mockResolvedValue([run]);
    const control = vi.spyOn(piSubagentRuns, 'controlPiSubagentRuns').mockResolvedValue(1);
    const resolver = vi.fn(async () => ({ kind: 'permission', behavior: 'allow' }) as const);
    const handle = await new PiAgent(buildDeps()).startSession(opts());
    handle.setInteractionResolver(resolver);

    await new Promise((resolve) => setTimeout(resolve, 550));
    expect(control).not.toHaveBeenCalled();
    expect(resolver).not.toHaveBeenCalled();
    await handle.close({ reason: 'navigation' });
  });

  it('adopts an approval parked by an earlier handle of the same task', async () => {
    // The reopened task gets a fresh sessionInstanceId, so the strict owner
    // fence used to make the parked approval permanently unanswerable.
    //
    // Own session id: adoption keys on parentSessionId, so a detached supervisor
    // left polling a never-terminal mock from an earlier case in this file would
    // otherwise be a second, legitimate answerer.
    const run = pendingSubagentRun(
      { toolName: 'write', input: { path: 'a.txt' } },
      { runtimeOwnerId: ownerId('earlier-handle-instance'), parentSessionId: 'adopt-1' },
    );
    vi.spyOn(piSubagentRuns, 'listPiSubagentRuns').mockResolvedValue([run]);
    const control = vi.spyOn(piSubagentRuns, 'controlPiSubagentRuns').mockResolvedValue(1);
    const resolver = vi.fn(async () => ({ kind: 'permission', behavior: 'allow' }) as const);
    const handle = await new PiAgent(buildDeps())
      .startSession({ ...opts(), sessionId: 'adopt-1', sessionInstanceId: 'reopened-instance' });
    handle.setInteractionResolver(resolver);

    await vi.waitFor(() => expect(control).toHaveBeenCalledWith(
      expect.any(String),
      run.taskId,
      'approval',
      expect.objectContaining({
        confirmed: true,
        // The answer must carry the *run's* owner id or the mailbox filter
        // would reject it.
        runtimeOwnerId: ownerId('earlier-handle-instance'),
      }),
    ), { timeout: 3_000 });
    expect(resolver).toHaveBeenCalledWith(expect.objectContaining({
      toolName: 'write',
      metadata: expect.objectContaining({ subagent: true }),
    }));
    await handle.close({ reason: 'navigation' });
  });

  it('never lets a Full Access session auto-allow an adopted approval', async () => {
    // Delivery surface only: the child was spawned under an earlier session's
    // mode, so reopening under Full Access must not launder its pending
    // approvals into a silent allow.
    const run = pendingSubagentRun(
      { toolName: 'bash', input: { command: 'rm -rf /tmp/x' } },
      { runtimeOwnerId: ownerId('earlier-handle-instance'), parentSessionId: 'adopt-2' },
    );
    vi.spyOn(piSubagentRuns, 'listPiSubagentRuns').mockResolvedValue([run]);
    const control = vi.spyOn(piSubagentRuns, 'controlPiSubagentRuns').mockResolvedValue(1);
    const review = vi.fn(async () => ({ verdict: 'allow' as const }));
    const resolver = vi.fn(async () => ({ kind: 'permission', behavior: 'deny' }) as const);
    const handle = await new PiAgent(buildDeps({ reviewAutoPermissionAction: review }))
      .startSession({
        ...opts(),
        sessionId: 'adopt-2',
        sessionInstanceId: 'reopened-instance-2',
        permissionMode: 'bypassPermissions',
      });
    handle.setInteractionResolver(resolver);

    await vi.waitFor(() => expect(control).toHaveBeenCalledWith(
      expect.any(String),
      run.taskId,
      'approval',
      expect.objectContaining({ confirmed: false }),
    ), { timeout: 3_000 });
    // The user was asked, and neither Full Access nor the Auto reviewer ruled.
    expect(resolver).toHaveBeenCalledOnce();
    expect(review).not.toHaveBeenCalled();
    await handle.close({ reason: 'navigation' });
  });

  it('reuses Auto-review for a safe durable Subagent workspace write without prompting', async () => {
    const run = pendingSubagentRun({
      toolName: 'write',
      input: { path: 'tmp/auto-safe.txt', content: 'safe' },
      resolvedWritePath: path.join(cwd, 'tmp', 'auto-safe.txt'),
      resolvedWritableRoots: [cwd],
    });
    vi.spyOn(piSubagentRuns, 'listPiSubagentRuns').mockResolvedValue([run]);
    const control = vi.spyOn(piSubagentRuns, 'controlPiSubagentRuns').mockResolvedValue(1);
    const handle = await new PiAgent(buildDeps()).startSession({
      ...opts(),
      permissionMode: 'auto',
    });
    const resolver = vi.fn(async () => ({ kind: 'permission', behavior: 'deny' }) as const);
    handle.setInteractionResolver(resolver);

    await vi.waitFor(() => expect(control).toHaveBeenCalledWith(
      expect.any(String),
      run.taskId,
      'approval',
      expect.objectContaining({ confirmed: true }),
    ));
    expect(resolver).not.toHaveBeenCalled();
    await handle.close();
  });

  it('requires confirmation when an older durable bridge omits canonical writable roots', async () => {
    const run = pendingSubagentRun({
      toolName: 'write',
      input: { path: 'tmp/legacy-safe.txt', content: 'legacy' },
      resolvedWritePath: path.join(cwd, 'tmp', 'legacy-safe.txt'),
    });
    vi.spyOn(piSubagentRuns, 'listPiSubagentRuns').mockResolvedValue([run]);
    const control = vi.spyOn(piSubagentRuns, 'controlPiSubagentRuns').mockResolvedValue(1);
    const review = vi.fn(async () => ({ verdict: 'allow' as const }));
    const resolver = vi.fn(async () => ({ kind: 'permission', behavior: 'deny' }) as const);
    const handle = await new PiAgent(buildDeps({ reviewAutoPermissionAction: review })).startSession({
      ...opts(),
      permissionMode: 'auto',
    });
    handle.setInteractionResolver(resolver);

    await vi.waitFor(() => expect(control).toHaveBeenCalledWith(
      expect.any(String),
      run.taskId,
      'approval',
      expect.objectContaining({ confirmed: false }),
    ));
    expect(review).not.toHaveBeenCalled();
    expect(resolver).toHaveBeenCalledOnce();
    await handle.close();
  });

  it('forces confirmation when a durable Subagent writable-root path resolves outside it', async () => {
    const writableDir = mkdtempSync(path.join(tmpdir(), 'pi-subagent-writable-'));
    const outsideDir = mkdtempSync(path.join(tmpdir(), 'pi-subagent-outside-'));
    const run = pendingSubagentRun({
      toolName: 'write',
      input: { path: path.join(writableDir, 'linked', 'result.txt'), content: 'unsafe' },
      resolvedWritePath: path.join(outsideDir, 'result.txt'),
      resolvedWritableRoots: [cwd, writableDir],
    });
    vi.spyOn(piSubagentRuns, 'listPiSubagentRuns').mockResolvedValue([run]);
    const control = vi.spyOn(piSubagentRuns, 'controlPiSubagentRuns').mockResolvedValue(1);
    const review = vi.fn(async () => ({ verdict: 'allow' as const }));
    const resolver = vi.fn(async () => ({ kind: 'permission', behavior: 'deny' }) as const);
    const handle = await new PiAgent(buildDeps({ reviewAutoPermissionAction: review })).startSession({
      ...opts(),
      permissionMode: 'auto',
      writableDirs: [writableDir],
    });
    handle.setInteractionResolver(resolver);

    try {
      await vi.waitFor(() => expect(control).toHaveBeenCalledWith(
        expect.any(String),
        run.taskId,
        'approval',
        expect.objectContaining({ confirmed: false }),
      ));
      expect(review).not.toHaveBeenCalled();
      expect(resolver).toHaveBeenCalledWith(expect.objectContaining({
        toolName: 'write',
        metadata: expect.objectContaining({ subagent: true }),
      }));
    } finally {
      await handle.close();
      rmSync(writableDir, { recursive: true, force: true });
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('reuses Auto-review when a durable Subagent writable root is itself a link', async () => {
    const realWritableDir = mkdtempSync(path.join(tmpdir(), 'pi-subagent-real-writable-'));
    const linkParent = mkdtempSync(path.join(tmpdir(), 'pi-subagent-linked-writable-'));
    const linkedWritableDir = path.join(linkParent, 'output');
    symlinkSync(
      realWritableDir,
      linkedWritableDir,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const run = pendingSubagentRun({
      toolName: 'write',
      input: { path: path.join(linkedWritableDir, 'result.txt'), content: 'safe' },
      resolvedWritePath: path.join(realpathSync(realWritableDir), 'result.txt'),
      resolvedWritableRoots: [cwd, realpathSync(realWritableDir)],
    });
    vi.spyOn(piSubagentRuns, 'listPiSubagentRuns').mockResolvedValue([run]);
    const control = vi.spyOn(piSubagentRuns, 'controlPiSubagentRuns').mockResolvedValue(1);
    const resolver = vi.fn(async () => ({ kind: 'permission', behavior: 'deny' }) as const);
    const handle = await new PiAgent(buildDeps()).startSession({
      ...opts(),
      permissionMode: 'auto',
      writableDirs: [linkedWritableDir],
    });
    handle.setInteractionResolver(resolver);

    try {
      await vi.waitFor(() => expect(control).toHaveBeenCalledWith(
        expect.any(String),
        run.taskId,
        'approval',
        expect.objectContaining({ confirmed: true }),
      ));
      expect(resolver).not.toHaveBeenCalled();
    } finally {
      await handle.close();
      rmSync(linkParent, { recursive: true, force: true });
      rmSync(realWritableDir, { recursive: true, force: true });
    }
  });

  it('keeps risky durable Subagent Auto actions behind the real Cindy prompt', async () => {
    const run = pendingSubagentRun({
      toolName: 'bash',
      input: { command: "printf unsafe > /tmp/outside.txt" },
    });
    vi.spyOn(piSubagentRuns, 'listPiSubagentRuns').mockResolvedValue([run]);
    const control = vi.spyOn(piSubagentRuns, 'controlPiSubagentRuns').mockResolvedValue(1);
    const review = vi.fn(async () => ({ verdict: 'ask' as const }));
    const handle = await new PiAgent(buildDeps({ reviewAutoPermissionAction: review })).startSession({
      ...opts(),
      permissionMode: 'auto',
    });
    const resolver = vi.fn(async () => ({ kind: 'permission', behavior: 'deny' }) as const);
    handle.setInteractionResolver(resolver);

    await vi.waitFor(() => expect(control).toHaveBeenCalledWith(
      expect.any(String),
      run.taskId,
      'approval',
      expect.objectContaining({ confirmed: false }),
    ));
    expect(review).toHaveBeenCalledOnce();
    expect(resolver).toHaveBeenCalledWith(expect.objectContaining({
      toolName: 'bash',
      input: { command: "printf unsafe > /tmp/outside.txt" },
      metadata: expect.objectContaining({ subagent: true }),
    }));
    await handle.close();
  });

  it('fails closed when the durable Subagent approval resolver throws', async () => {
    const run = pendingSubagentRun({ toolName: 'write', input: { path: 'a.txt' } });
    vi.spyOn(piSubagentRuns, 'listPiSubagentRuns').mockResolvedValue([run]);
    const control = vi.spyOn(piSubagentRuns, 'controlPiSubagentRuns').mockResolvedValue(1);
    const handle = await new PiAgent(buildDeps()).startSession(opts());
    handle.setInteractionResolver(vi.fn(async () => { throw new Error('resolver failed'); }));

    await vi.waitFor(() => expect(control).toHaveBeenCalledWith(
      expect.any(String),
      run.taskId,
      'approval',
      expect.objectContaining({ confirmed: false }),
    ));
    await handle.close();
  });

  it('retries durable Subagent approval delivery without asking the user twice', async () => {
    const run = pendingSubagentRun({ toolName: 'write', input: { path: 'a.txt' } });
    vi.spyOn(piSubagentRuns, 'listPiSubagentRuns').mockResolvedValue([run]);
    const control = vi.spyOn(piSubagentRuns, 'controlPiSubagentRuns')
      .mockRejectedValueOnce(new Error('mailbox unavailable'))
      .mockResolvedValue(1);
    const resolver = vi.fn(async () => ({ kind: 'permission', behavior: 'allow' }) as const);
    const handle = await new PiAgent(buildDeps()).startSession(opts());
    handle.setInteractionResolver(resolver);

    await vi.waitFor(() => expect(control).toHaveBeenCalledTimes(2), { timeout: 2_500 });
    expect(resolver).toHaveBeenCalledOnce();
    expect(control).toHaveBeenLastCalledWith(
      expect.any(String),
      run.taskId,
      'approval',
      expect.objectContaining({ confirmed: true }),
    );
    await handle.close();
  });

  it('waits for an in-flight Subagent resume before transferring the proxy lease', async () => {
    const agent = new PiAgent(buildDeps());
    const handle = await agent.startSession(opts());
    let releaseResume!: (runId: string) => void;
    const resumeResult = new Promise<string>((resolve) => { releaseResume = resolve; });
    const resumeSpy = vi
      .spyOn(piSubagentRuns, 'resumePiSubagentRun')
      .mockImplementation(async () => resumeResult);

    const resume = handle.resumeBackgroundTask?.('terminal-task', 'continue');
    await vi.waitFor(() => expect(resumeSpy).toHaveBeenCalledOnce());
    let closeSettled = false;
    const close = handle.close().then(() => { closeSettled = true; });
    await Promise.resolve();
    await Promise.resolve();

    expect(closeSettled).toBe(false);
    expect(proxyDisposed).toBe(0);

    releaseResume('123e4567-e89b-42d3-a456-426614174098');
    await resume;
    await close;
    expect(proxyDisposed).toBe(2);
  });

  it('graceful stop uses only the Pi abort RPC and keeps the process alive', async () => {
    const handle = await new PiAgent(buildDeps()).startSession(opts());
    knobs.onEvent?.({ type: 'message_start' });
    knobs.requests = [];

    await expect(handle.requestGracefulStop?.()).resolves.toBeUndefined();
    expect(knobs.requests).toEqual(['abort']);
    expect(knobs.closeCount).toBe(0);

    await handle.close();
  });

  it('does not surface an aborted gateway error when Host stop beats agent_start', async () => {
    const handle = await new PiAgent(buildDeps()).startSession(opts());
    const events: Array<{ type: string; data?: unknown }> = [];
    void (async () => {
      for await (const event of handle.events()) events.push(event);
    })();
    const rawError = 'OpenAI Responses stream ended before a terminal response event';

    await handle.send({ type: 'user', content: 'start a Pi turn' });
    await handle.abort();
    knobs.onEvent?.({ type: 'agent_start' });
    knobs.onEvent?.({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [],
        stopReason: 'aborted',
        errorMessage: rawError,
      },
    });
    knobs.onEvent?.({ type: 'agent_settled' });

    await vi.waitFor(() => expect(events.some((event) => event.type === 'done')).toBe(true));
    expect(events.filter((event) => event.type === 'error')).toHaveLength(0);

    await handle.close();
  });

  it('keeps a real gateway disconnect resumable when the Pi abort RPC is rejected', async () => {
    knobs.abortRejects = true;
    const handle = await new PiAgent(buildDeps()).startSession(opts());
    const events: Array<{ type: string; data?: unknown }> = [];
    void (async () => {
      for await (const event of handle.events()) events.push(event);
    })();
    const rawError = 'OpenAI Responses stream ended before a terminal response event';

    await handle.send({ type: 'user', content: 'start a Pi turn' });
    await handle.abort();
    knobs.onEvent?.({ type: 'agent_start' });
    knobs.onEvent?.({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [],
        stopReason: 'aborted',
        errorMessage: rawError,
      },
    });
    knobs.onEvent?.({ type: 'agent_settled' });

    await vi.waitFor(() => expect(events.some((event) => event.type === 'error')).toBe(true));
    expect(events.filter((event) => event.type === 'error')).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({ message: rawError, isTerminal: true }),
      }),
    ]);

    await handle.close();
  });

  it('keeps local runtime files until a close retry confirms process exit', async () => {
    knobs.closeFailuresRemaining = 1;
    const handle = await new PiAgent(buildDeps()).startSession(opts());
    const env = knobs.spawnedEnvs[0]!;
    const configHome = env.PI_CODING_AGENT_DIR!;
    const permissionFile = env.CINDY_PI_PERMISSION_FILE!;
    const subagentRuntimeFile = env.CINDY_PI_SUBAGENT_RUNTIME_FILE!;

    expect(existsSync(configHome)).toBe(true);
    expect(existsSync(permissionFile)).toBe(true);
    expect(existsSync(subagentRuntimeFile)).toBe(true);

    await expect(handle.close()).rejects.toThrow(/close unconfirmed/);
    expect(existsSync(configHome)).toBe(true);
    expect(existsSync(permissionFile)).toBe(true);
    expect(existsSync(subagentRuntimeFile)).toBe(true);

    await expect(handle.close()).resolves.toBeUndefined();
    await vi.waitFor(() => {
      expect(existsSync(configHome)).toBe(false);
      expect(existsSync(permissionFile)).toBe(false);
      expect(existsSync(subagentRuntimeFile)).toBe(false);
    });
    expect(knobs.closeCount).toBe(2);
  });

  it('always disables project trust and implicit extensions while explicitly restoring only Cindy extensions', async () => {
    const handle = await new PiAgent(buildDeps()).startSession(opts());
    const args = knobs.spawnedArgs[0]!;
    const configHome = knobs.spawnedEnvs[0]!.PI_CODING_AGENT_DIR!;

    expect(args).toEqual(expect.arrayContaining(['--no-approve', '--no-extensions']));
    expect(args).not.toContain('--approve');
    expect(args).not.toContain('--no-skills');
    expect(args).not.toContain('--skill');
    expect(repeatedArgValues(args, '--extension')).toEqual([
      // 轮 40-w4-t15:argv 里的 extension 路径是 posix join(远端派生路径统一
      // POSIX),对比也用 posix —— 平台 path.join 在 Windows 拼反斜杠不匹配。
      path.posix.join(configHome, 'extensions', 'cindy-bridge.ts'),
      path.posix.join(configHome, 'extensions', 'cindy-subagent.ts'),
    ]);
    await vi.waitFor(() => {
      expect(handle.getRuntimeCapabilities?.()?.projectResources).toEqual({
        status: 'unavailable',
        reason: 'approval-resolver-unavailable',
        approvalRevision: null,
        requestedSkillCount: 0,
      });
    });
    await handle.close();
  });

  it('freezes approval per new session and fails closed after revocation', async () => {
    const skillPath = path.join(cwd, '.pi', 'skills', 'approved-skill');
    mkdirSync(skillPath, { recursive: true });
    writeFileSync(path.join(skillPath, 'SKILL.md'), '# approved\n');
    const deps = buildDeps({
      resolvePiProjectTrustInput: async ({ sessionId, workingDir }) => sessionId === 'approved'
        ? approvedInput(workingDir, 'rev-approved', [skillPath])
        : {
            ...approvedInput(workingDir, 'rev-unused', [skillPath]),
            approval: { status: 'revoked', revision: 'rev-revoked', reason: 'user-revoked' },
          },
    });
    const agent = new PiAgent(deps);
    const approvedHandle = await agent.startSession({ sessionId: 'approved', workingDir: cwd, model: 'm' });
    const revokedHandle = await agent.startSession({ sessionId: 'revoked', workingDir: cwd, model: 'm' });

    expect(repeatedArgValues(knobs.spawnedArgs[0]!, '--skill')).toEqual([
      stagedSkillPath(knobs.spawnedEnvs[0]!.PI_CODING_AGENT_DIR!, 0, skillPath),
    ]);
    expect(repeatedArgValues(knobs.spawnedArgs[1]!, '--skill')).toEqual([]);
    await vi.waitFor(() => {
      expect(approvedHandle.getRuntimeCapabilities?.()?.projectResources).toMatchObject({
        status: 'approved', approvalRevision: 'rev-approved', requestedSkillCount: 1,
      });
      expect(revokedHandle.getRuntimeCapabilities?.()?.projectResources).toMatchObject({
        status: 'revoked', reason: 'user-revoked', approvalRevision: 'rev-revoked', requestedSkillCount: 0,
      });
    });
    await Promise.all([approvedHandle.close(), revokedHandle.close()]);
  });

  it('fails closed when the resolver returns another workingDir approval snapshot', async () => {
    const approvedDir = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'pi-approved-other-')));
    try {
      mkdirSync(path.join(approvedDir, '.git'));
      const skillPath = path.join(approvedDir, '.pi', 'skills', 'other-project-skill');
      mkdirSync(skillPath, { recursive: true });
      writeFileSync(path.join(skillPath, 'SKILL.md'), '# other project\n');
      const agent = new PiAgent(buildDeps({
        resolvePiProjectTrustInput: async () => approvedInput(
          approvedDir,
          'rev-other-project',
          [skillPath],
        ),
      }));
      const handle = await agent.startSession({ sessionId: 'requested', workingDir: cwd, model: 'm' });
      try {
        expect(repeatedArgValues(knobs.spawnedArgs[0]!, '--skill')).toEqual([]);
        await vi.waitFor(() => {
          expect(handle.getRuntimeCapabilities?.()?.projectResources).toMatchObject({
            status: 'approved',
            reason: 'approval-working-dir-mismatch',
            approvalRevision: 'rev-other-project',
            requestedSkillCount: 0,
          });
        });
      } finally {
        await handle.close();
      }
    } finally {
      rmSync(approvedDir, { recursive: true, force: true });
    }
  });

  it('fails closed when a nearer Git root appears after the approval snapshot', async () => {
    const outerRepo = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'pi-approved-outer-')));
    try {
      const requestedDir = path.join(outerRepo, 'packages', 'nested');
      const skillPath = path.join(outerRepo, '.agents', 'skills', 'outer-skill');
      mkdirSync(path.join(outerRepo, '.git'));
      mkdirSync(requestedDir, { recursive: true });
      mkdirSync(skillPath, { recursive: true });
      writeFileSync(path.join(skillPath, 'SKILL.md'), '# outer project\n');
      const snapshot = approvedInput(
        requestedDir,
        'rev-before-nested-repo',
        [skillPath],
        outerRepo,
      );
      mkdirSync(path.join(requestedDir, '.git'));

      const agent = new PiAgent(buildDeps({
        resolvePiProjectTrustInput: async () => snapshot,
      }));
      const handle = await agent.startSession({
        sessionId: 'nested-repo',
        workingDir: requestedDir,
        model: 'm',
      });
      try {
        expect(repeatedArgValues(knobs.spawnedArgs[0]!, '--skill')).toEqual([]);
        await vi.waitFor(() => {
          expect(handle.getRuntimeCapabilities?.()?.projectResources).toMatchObject({
            status: 'approved',
            reason: 'approved-repo-root-changed',
            approvalRevision: 'rev-before-nested-repo',
            requestedSkillCount: 0,
          });
        });
      } finally {
        await handle.close();
      }
    } finally {
      rmSync(outerRepo, { recursive: true, force: true });
    }
  });

  it('injects remote MCP secrets only through env and marks them for bash-child stripping', async () => {
    const agent = new PiAgent(buildDeps());
    const handle = await agent.startSession(opts());
    const env = knobs.spawnedEnvs[0]!;
    const secret = 'Bearer spawn-secret-canary';
    expect(env.CINDY_PI_REMOTE_MCP_SECRET_0).toBe(secret);

    const descriptorRaw = env.CINDY_PI_MCP_BRIDGE!;
    expect(descriptorRaw).not.toContain(secret);
    expect(JSON.parse(descriptorRaw)).toMatchObject({
      servers: [{
        name: 'custom_remote',
        remote: { headerEnvVars: { authorization: 'CINDY_PI_REMOTE_MCP_SECRET_0' } },
      }],
    });
    expect(JSON.parse(env.CINDY_PI_SECRET_ENV_NAMES!)).toEqual(expect.arrayContaining([
      'CINDY_PI_REMOTE_MCP_SECRET_0',
      'CINDY_PI_MCP_BRIDGE',
    ]));
    expect(JSON.stringify(knobs.spawnedArgs[0])).not.toContain(secret);
    await handle.close();
  });

  it('disposes proxy token + MCP ctx when the pi process exits unexpectedly (crash), idempotent with close()', async () => {
    // codex review:崩溃时 onExit 只 end 队列、上层短路 close(),proxy token / MCP ctx
    // 会滞留内存被本地进程盗用。onExit 必须幂等注销这些注册。
    const agent = new PiAgent(buildDeps());
    const handle = await agent.startSession(opts());
    expect(disposed).toBe(0);
    expect(proxyDisposed).toBe(0);
    expect(knobs.onExit).toBeTypeOf('function');
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    knobs.onEvent?.({ type: 'message_start' });

    knobs.onExit!({ code: 1, signal: null }); // 模拟进程异常退出
    // Pi RPC and Cindy's durable Subagent status poll both release their timers.
    expect(clearIntervalSpy).toHaveBeenCalledTimes(2);
    expect(disposed).toBe(1);
    await vi.waitFor(() => expect(proxyDisposed).toBe(2));

    // 上层随后仍可能调用 close() —— 幂等,不得二次注销。
    await handle.close();
    expect(clearIntervalSpy).toHaveBeenCalledTimes(2);
    expect(disposed).toBe(1);
    expect(proxyDisposed).toBe(2);
  });

  it('rejects a sessionId that would escape the runtime dir via the permission file path', async () => {
    // codex review:sessionId 拼进 perm-<id>.json;`../../..` 经 path.join 逃出 runtimeDir。
    const agent = new PiAgent(buildDeps());
    await expect(
      agent.startSession({ sessionId: '../../../../tmp/evil', workingDir: cwd, model: 'm' }),
    ).rejects.toThrow(/unsafe sessionId/);
    // 未注册任何东西 → 无泄漏。
    expect(disposed).toBe(0);
    expect(proxyDisposed).toBe(0);
  });

  // codex review P2:并发普通会话不得共写 agentHome/models.json —— 第二次写入会在首次写完
  // 到 spawn 之间截断/覆盖 provider 快照。每 startSession 用隔离的 configHome
  // (PI_CODING_AGENT_DIR = agentHome/run-tmp/<hex>)承载 models.json,close/退出时清理。
  it('isolates each session config home under run-tmp and keeps concurrent sessions independent', async () => {
    const { existsSync } = await import('node:fs');
    const skillOne = path.join(cwd, '.pi', 'skills', 'one');
    const skillTwo = path.join(cwd, '.agents', 'skills', 'two');
    for (const skillPath of [skillOne, skillTwo]) {
      mkdirSync(skillPath, { recursive: true });
      writeFileSync(path.join(skillPath, 'SKILL.md'), '# isolated\n');
    }
    const agent = new PiAgent(buildDeps({
      resolvePiProjectTrustInput: async ({ sessionId, workingDir }) => approvedInput(
        workingDir,
        `rev-${sessionId}`,
        [sessionId === 's1' ? skillOne : skillTwo],
      ),
    }));
    const [h1, h2] = await Promise.all([
      agent.startSession({ sessionId: 's1', workingDir: cwd, model: 'm' }),
      agent.startSession({ sessionId: 's2', workingDir: cwd, model: 'm' }),
    ]);

    const indexForSession = (sessionId: string) => knobs.spawnedEnvs.findIndex(
      (env) => env.CINDY_PI_SESSION_ID === sessionId,
    );
    const s1Index = indexForSession('s1');
    const s2Index = indexForSession('s2');
    const home1 = knobs.spawnedEnvs[s1Index].PI_CODING_AGENT_DIR as string;
    const home2 = knobs.spawnedEnvs[s2Index].PI_CODING_AGENT_DIR as string;
    // 轮 40-w4-t5:configHome 用 posix join —— 对比也用 posix(平台 path.join 在
    // Windows 拼 \ 与 / 不匹配)。
    const runTmp = path.posix.join(agentHome, 'run-tmp');
    // 两个会话各自独立的 configHome(都在 run-tmp 下,hex 不同),各有自己的 models.json。
    expect(home1).not.toBe(home2);
    expect(home1.startsWith(runTmp)).toBe(true);
    expect(home2.startsWith(runTmp)).toBe(true);
    expect(existsSync(path.join(home1, 'models.json'))).toBe(true);
    expect(existsSync(path.join(home2, 'models.json'))).toBe(true);
    expect(repeatedArgValues(knobs.spawnedArgs[s1Index]!, '--skill')).toEqual([
      stagedSkillPath(home1, 0, skillOne),
    ]);
    expect(repeatedArgValues(knobs.spawnedArgs[s2Index]!, '--skill')).toEqual([
      stagedSkillPath(home2, 0, skillTwo),
    ]);
    await vi.waitFor(() => {
      expect(h1.getRuntimeCapabilities?.()?.projectResources).toMatchObject({
        approvalRevision: 'rev-s1', requestedSkillCount: 1,
      });
      expect(h2.getRuntimeCapabilities?.()?.projectResources).toMatchObject({
        approvalRevision: 'rev-s2', requestedSkillCount: 1,
      });
    });

    // close 一个会话清理它的 configHome,另一个不受影响(cleanup 是 fire-and-forget,轮询等)。
    await h1.close();
    await waitFor(() => !existsSync(home1));
    expect(existsSync(path.join(home2, 'models.json'))).toBe(true);
    await h2.close();
    await waitFor(() => !existsSync(home2));
  });

  it('keeps an approved session isolated from a concurrent Review session', async () => {
    const skillPath = path.join(cwd, '.pi', 'skills', 'approved-only');
    mkdirSync(skillPath, { recursive: true });
    writeFileSync(path.join(skillPath, 'SKILL.md'), '# approved only\n');
    const resolvePiProjectTrustInput = vi.fn(async ({ workingDir }:
      Parameters<NonNullable<AgentDeps['resolvePiProjectTrustInput']>>[0]) => approvedInput(
      workingDir,
      'rev-approved-only',
      [skillPath],
    ));
    const packageExtension = path.join(agentHome, 'managed-packages', 'extension.ts');
    const packageSkill = path.join(agentHome, 'managed-packages', 'skill-one');
    const packagePrompt = path.join(agentHome, 'managed-packages', 'prompt-one.md');
    const resolvePiManagedPackageResources = vi.fn(async () => ({
      extensions: [packageExtension],
      skills: [{ path: packageSkill, name: 'package-skill' }],
      promptTemplates: [packagePrompt],
      packageRoots: [path.dirname(packageExtension)],
    }));
    const agent = new PiAgent(buildDeps({
      resolvePiProjectTrustInput,
      resolvePiManagedPackageResources,
    }));
    const [approvedHandle, reviewHandle] = await Promise.all([
      agent.startSession({ sessionId: 'approved', workingDir: cwd, model: 'm' }),
      agent.startSession({
        sessionId: 'review',
        workingDir: cwd,
        model: 'm',
        reviewMode: true,
      }),
    ]);

    const indexForSession = (sessionId: string) => knobs.spawnedEnvs.findIndex(
      (env) => env.CINDY_PI_SESSION_ID === sessionId,
    );
    const approvedIndex = indexForSession('approved');
    const reviewIndex = indexForSession('review');
    const approvedHome = knobs.spawnedEnvs[approvedIndex]!.PI_CODING_AGENT_DIR!;
    const reviewHome = knobs.spawnedEnvs[reviewIndex]!.PI_CODING_AGENT_DIR!;
    expect(approvedHome).not.toBe(reviewHome);
    expect(knobs.spawnedEnvs[approvedIndex]!.CINDY_PI_PERMISSION_FILE).not.toBe(
      knobs.spawnedEnvs[reviewIndex]!.CINDY_PI_PERMISSION_FILE,
    );
    expect(repeatedArgValues(knobs.spawnedArgs[approvedIndex]!, '--skill')).toEqual([
      stagedSkillPath(approvedHome, 0, skillPath),
      packageSkill,
    ]);
    expect(repeatedArgValues(knobs.spawnedArgs[reviewIndex]!, '--skill')).toEqual([]);
    expect(repeatedArgValues(knobs.spawnedArgs[approvedIndex]!, '--extension')).toEqual([
      path.posix.join(approvedHome, 'extensions', 'cindy-bridge.ts'),
      path.posix.join(approvedHome, 'extensions', 'cindy-subagent.ts'),
      packageExtension,
    ]);
    expect(repeatedArgValues(knobs.spawnedArgs[reviewIndex]!, '--extension')).toEqual([
      path.posix.join(reviewHome, 'extensions', 'cindy-bridge.ts'),
    ]);
    expect(repeatedArgValues(knobs.spawnedArgs[approvedIndex]!, '--prompt-template')).toEqual([
      packagePrompt,
    ]);
    expect(repeatedArgValues(knobs.spawnedArgs[reviewIndex]!, '--prompt-template')).toEqual([]);
    expect(resolvePiProjectTrustInput).toHaveBeenCalledOnce();
    expect(resolvePiProjectTrustInput).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'approved',
    }));
    expect(resolvePiManagedPackageResources).toHaveBeenCalledOnce();
    expect(resolvePiManagedPackageResources).toHaveBeenCalledWith({
      snapshotRoot: path.join(approvedHome, 'managed-packages'),
    });
    await vi.waitFor(() => {
      expect(approvedHandle.getRuntimeCapabilities?.()?.projectResources).toMatchObject({
        status: 'approved', approvalRevision: 'rev-approved-only', requestedSkillCount: 1,
      });
      expect(reviewHandle.getRuntimeCapabilities?.()?.projectResources).toEqual({
        status: 'unavailable',
        reason: 'review-mode-project-resources-disabled',
        approvalRevision: null,
        requestedSkillCount: 0,
      });
    });

    await Promise.all([approvedHandle.close(), reviewHandle.close()]);
  });

  it('cleans up the session config home when the pi process exits unexpectedly (crash)', async () => {
    const { existsSync } = await import('node:fs');
    const agent = new PiAgent(buildDeps());
    const handle = await agent.startSession(opts());
    const home = knobs.spawnedEnvs[0].PI_CODING_AGENT_DIR as string;
    expect(existsSync(home)).toBe(true);

    knobs.onExit!({ code: 1, signal: null }); // 模拟进程异常退出
    await waitFor(() => !existsSync(home));
    expect(existsSync(home)).toBe(false);

    // 上层随后仍可能调用 close() —— cleanup 幂等,不抛。
    await handle.close();
  });
});

/** 轮询等待条件成立(configHome cleanup 是 void fs.rm fire-and-forget,不阻塞 close)。 */
async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}
