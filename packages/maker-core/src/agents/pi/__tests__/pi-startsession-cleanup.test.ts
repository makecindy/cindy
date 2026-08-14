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

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// hoisted 控制旋钮:vi.mock 工厂被提升到 import 之上,不能闭包引用普通 let。
const knobs = vi.hoisted(() => ({
  ctorThrows: false,
  getStateRejects: false,
  closeCount: 0,
  onExit: null as null | ((info: { code: number | null; signal: string | null }) => void),
  onEvent: null as null | ((event: unknown) => void),
  spawnedEnvs: [] as Array<Record<string, string | undefined>>,
  spawnedArgs: [] as string[][],
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
      if (cmd.type === 'get_state') {
        if (knobs.getStateRejects) throw new Error('get_state rejected (mock)');
        return { success: true, data: { sessionFile: '/mock/session.jsonl', model: { contextWindow: 200000 } } };
      }
      // switch_session / set_thinking_level / set_auto_compaction / get_entries 等一律成功。
      return { success: true, data: { entries: [] } };
    }
    send(): void {}
    async close(): Promise<void> {
      knobs.closeCount++;
      this.isClosed = true;
    }
    get pid(): number { return 1234; }
  },
}));

import { PiAgent } from '../index.js';
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
  let preparedMcpContext: unknown;

  beforeEach(() => {
    knobs.ctorThrows = false;
    knobs.getStateRejects = false;
    knobs.closeCount = 0;
    knobs.onExit = null;
    knobs.onEvent = null;
    knobs.spawnedEnvs = [];
    knobs.spawnedArgs = [];
    disposed = 0;
    proxyDisposed = 0;
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
      registerPiProxySession: () => () => { proxyDisposed++; },
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

  it('disposes ctx (and does not close a nonexistent proc) when the process constructor throws synchronously', async () => {
    knobs.ctorThrows = true;
    const agent = new PiAgent(buildDeps());
    await expect(agent.startSession(opts())).rejects.toThrow(/spawn failed/);
    expect(disposed).toBe(1);
    expect(proxyDisposed).toBe(1);
    expect(knobs.closeCount).toBe(0); // 构造失败没有 proc 可关
  });

  it('disposes ctx and closes the proc when a startup RPC rejects before handoff', async () => {
    knobs.getStateRejects = true;
    const agent = new PiAgent(buildDeps());
    await expect(agent.startSession(opts())).rejects.toThrow(/get_state rejected/);
    expect(disposed).toBe(1);
    expect(proxyDisposed).toBe(1);
    expect(knobs.closeCount).toBe(1); // 已 spawn → 必须关掉,避免僵尸持有 ?session= 路由
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
    expect(clearIntervalSpy).toHaveBeenCalledOnce();
    expect(disposed).toBe(1); // close() 才注销
    expect(proxyDisposed).toBe(1);
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
    expect(clearIntervalSpy).toHaveBeenCalledOnce();
    expect(disposed).toBe(1);
    expect(proxyDisposed).toBe(1);

    // 上层随后仍可能调用 close() —— 幂等,不得二次注销。
    await handle.close();
    expect(disposed).toBe(1);
    expect(proxyDisposed).toBe(1);
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
    const agent = new PiAgent(buildDeps({ resolvePiProjectTrustInput }));
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
    ]);
    expect(repeatedArgValues(knobs.spawnedArgs[reviewIndex]!, '--skill')).toEqual([]);
    expect(repeatedArgValues(knobs.spawnedArgs[approvedIndex]!, '--extension')).toEqual([
      path.posix.join(approvedHome, 'extensions', 'cindy-bridge.ts'),
      path.posix.join(approvedHome, 'extensions', 'cindy-subagent.ts'),
    ]);
    expect(repeatedArgValues(knobs.spawnedArgs[reviewIndex]!, '--extension')).toEqual([
      path.posix.join(reviewHome, 'extensions', 'cindy-bridge.ts'),
    ]);
    expect(resolvePiProjectTrustInput).toHaveBeenCalledOnce();
    expect(resolvePiProjectTrustInput).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'approved',
    }));
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
