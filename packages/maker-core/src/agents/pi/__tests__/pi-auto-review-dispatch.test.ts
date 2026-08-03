/**
 * pi auto 档 dispatcher + spawn 配置回归 —— mock PiRpcProcess(不 spawn 真 pi),
 * 捕获构造参数与 send() 帧,验证:
 *   1. spawn args:改用 --append-system-prompt(保留 pi 默认 prompt),不再 --system-prompt;
 *   2. spawn env:PI_OFFLINE=1(嵌入式不做启动期联网)、PI_CACHE_RETENTION=long、
 *      NO_PROXY 含 loopback 且吞并小写 no_proxy;
 *   3. auto 档:区内写静默 confirmed:true;灰区交当前模型 reviewer,仅 reviewer 明确
 *      ask / 本地红线才弹 resolver;reviewer 缺失时 fail-closed deny;
 *   4. ask 档:区内写照旧弹 resolver(auto 的差异只在 auto 档生效)。
 */

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const captured = vi.hoisted(() => ({
  args: [] as string[],
  env: {} as Record<string, string | undefined>,
  onEvent: null as ((event: unknown) => void) | null,
  sent: [] as Array<Record<string, unknown>>,
  proxyRegistration: null as { sessionId: string; token: string } | null,
  requests: [] as string[],
  failSetModel: false,
  rejectSetModel: false,
  onAfterSetModel: null as null | (() => void),
  closed: false,
}));

vi.mock('../rpc-client.js', () => ({
  PiRpcProcess: class {
    isClosed = false;
    constructor(opts: {
      args: string[];
      env: Record<string, string | undefined>;
      onEvent: (event: unknown) => void;
    }) {
      captured.args = opts.args;
      captured.env = opts.env;
      captured.onEvent = opts.onEvent;
    }
    async request(cmd: { type: string }): Promise<{ success: boolean; data?: unknown }> {
      captured.requests.push(cmd.type);
      if (cmd.type === 'set_model' && captured.rejectSetModel) {
        throw new Error('pi rpc timeout after 30000ms: set_model');
      }
      if (cmd.type === 'set_model' && captured.failSetModel) {
        captured.onAfterSetModel?.();
        return { success: false };
      }
      if (cmd.type === 'get_state') {
        return { success: true, data: { sessionFile: '/mock/session.jsonl', model: { contextWindow: 200000 } } };
      }
      return { success: true, data: { entries: [] } };
    }
    send(msg: Record<string, unknown>): void {
      captured.sent.push(msg);
    }
    async close(): Promise<void> {
      this.isClosed = true;
      captured.closed = true;
    }
  },
}));

import { PiAgent } from '../index.js';
import type { AgentDeps, AgentSessionHandle } from '../../base-agent.js';
import type { Logger } from '../../../interfaces/logger.js';

const noopLogger: Logger = {
  trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {},
  child: () => noopLogger,
};

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('pi auto-review dispatch & spawn config (mocked pi process)', () => {
  let agentHome = '';
  let cwd = '';
  let savedNoProxy: string | undefined;
  let savedNoProxyLower: string | undefined;

  beforeEach(() => {
    captured.args = [];
    captured.env = {};
    captured.onEvent = null;
    captured.sent = [];
    captured.proxyRegistration = null;
    captured.requests = [];
    captured.failSetModel = false;
    captured.rejectSetModel = false;
    captured.onAfterSetModel = null;
    captured.closed = false;
    agentHome = mkdtempSync(path.join(tmpdir(), 'pi-dispatch-home-'));
    cwd = mkdtempSync(path.join(tmpdir(), 'pi-dispatch-cwd-'));
    savedNoProxy = process.env.NO_PROXY;
    savedNoProxyLower = process.env.no_proxy;
  });

  afterEach(() => {
    rmSync(agentHome, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
    if (savedNoProxy === undefined) delete process.env.NO_PROXY; else process.env.NO_PROXY = savedNoProxy;
    if (savedNoProxyLower === undefined) delete process.env.no_proxy; else process.env.no_proxy = savedNoProxyLower;
  });

  function buildDeps(
    reviewAutoPermissionAction?: AgentDeps['reviewAutoPermissionAction'],
  ): AgentDeps {
    return {
      auth: {
        getState: async () => ({ authenticated: true, identity: 'test', authSource: 'api-key' as const }),
        triggerLogin: async () => ({ authenticated: true }),
        logout: async () => {},
        getAuthEnv: async () => ({}),
      },
      runtimeConfig: { endpoint: 'http://127.0.0.1:9', systemPrompt: 'You are Cindy.' },
      binaryPath: path.join(agentHome, 'pi'),
      logger: noopLogger,
      capabilityAdditions: {
        availableModels: [
          {
            id: 'm',
            displayName: 'M',
            contextWindow: 200_000,
            efforts: [],
            defaultEffort: null,
            cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
            maxOutputTokens: 64_000,
          },
        ],
      },
      resolvePiAgentHome: () => agentHome,
      registerPiProxySession: (sessionId, token) => {
        captured.proxyRegistration = { sessionId, token };
      },
      reviewAutoPermissionAction,
    };
  }

  async function start(
    permissionMode?: string,
    reviewAutoPermissionAction?: AgentDeps['reviewAutoPermissionAction'],
  ): Promise<AgentSessionHandle> {
    const agent = new PiAgent(buildDeps(reviewAutoPermissionAction));
    return agent.startSession({
      sessionId: 's1',
      workingDir: cwd,
      model: 'm',
      ...(permissionMode ? { permissionMode: permissionMode as never } : {}),
    });
  }

  function firePermissionRequest(id: string, toolName: string, input: Record<string, unknown>): void {
    captured.onEvent!({
      type: 'extension_ui_request',
      method: 'confirm',
      id,
      title: 'cindy:permission',
      message: JSON.stringify({ toolName, input }),
    });
  }

  it('spawns with --append-system-prompt (default pi prompt preserved) and offline/no-proxy env', async () => {
    if (process.platform === 'win32') {
      // Windows 的环境变量键不区分大小写，无法同时构造“仅有小写键”的进程环境。
      process.env.NO_PROXY = 'corp.internal';
    } else {
      process.env.no_proxy = 'corp.internal';
      delete process.env.NO_PROXY;
    }
    await start();
    expect(captured.args).not.toContain('--system-prompt');
    const idx = captured.args.indexOf('--append-system-prompt');
    expect(idx).toBeGreaterThan(-1);
    expect(captured.args[idx + 1]).toBe('You are Cindy.');
    expect(captured.env.PI_OFFLINE).toBe('1');
    expect(captured.env.PI_CACHE_RETENTION).toBe('long');
    expect(captured.proxyRegistration).toEqual({
      sessionId: 's1',
      token: captured.env.CINDY_PI_SESSION_TOKEN,
    });
    expect(captured.env.CINDY_PI_SESSION_TOKEN).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(JSON.parse(captured.env.CINDY_PI_SECRET_ENV_NAMES ?? '[]')).toEqual(
      expect.arrayContaining([
        'CINDY_PI_API_KEY',
        'CINDY_PI_SESSION_ID',
        'CINDY_PI_SESSION_TOKEN',
        // 子代理路由快照是**控制面**:一次获批的 bash 拿到路径就能改写 provider/model,
        // 让后续每次委派打到攻击者选定的 endpoint。与 permission file 同类,必须从
        // bash/模型工具的 spawn 边界剥离(review)。
        'CINDY_PI_SUBAGENT_RUNTIME_FILE',
      ]),
    );
    const noProxy = (captured.env.NO_PROXY ?? '').split(',');
    for (const entry of ['corp.internal', '127.0.0.1', 'localhost', '::1', '[::1]']) {
      expect(noProxy).toContain(entry);
    }
    expect(captured.env.no_proxy).toBeUndefined();
  });


  it('refuses the model switch when the subagent routing snapshot cannot be persisted', async () => {
    // 顺序不能反:快照必须先落盘、再切 pi 侧模型。
    //
    // 上一版是先 set_model 成功、再写快照,写失败就置 subagentRoutingEnabled = false —— 而那个
    // 撤销是**无效的**:该标志只在构造 spawnEnv 时读一次(spawn 之前),进程起来后改它既收不回
    // 已注入的 env、也不能让扩展停止读那个文件。于是"写失败 + 删除也失败"(只读挂载/磁盘满)时,
    // 父会话已切到新 provider,子代理仍按上一个有效快照跑 —— 委派发往旧 endpoint(review)。
    const handle = await start();
    const runtimeDir = path.join(agentHome, 'runtime');
    const snapshot = readdirSync(runtimeDir).find((f) => f.startsWith('subagent-'));
    expect(snapshot).toBeTruthy();
    const snapshotPath = path.join(runtimeDir, snapshot as string);
    const before = readFileSync(snapshotPath, 'utf8');

    // 让写入必然失败:把快照文件换成同名目录(writeFile → EISDIR)。
    rmSync(snapshotPath, { force: true });
    mkdirSync(snapshotPath);
    captured.requests = [];

    await expect(handle.setModel('m')).rejects.toThrow(/子代理路由快照/);
    // 关键:pi 侧的 set_model **根本没发出去** —— 父子路由不会出现"父已切、子没切"的中间态。
    expect(captured.requests).not.toContain('set_model');

    // 收尾:恢复成文件,别把目录留给 close()。
    rmSync(snapshotPath, { recursive: true, force: true });
    writeFileSync(snapshotPath, before);
    await handle.close();
  });


  it('terminates the session when the routing snapshot cannot be rolled back', async () => {
    // 新快照落盘成功、set_model 失败、回滚又失败(第一次写之后文件系统才转只读)时,盘上的
    // 快照指向**被拒绝的** provider/model,而父会话仍在旧路由 —— 下一次委派就打到用户并未启用
    // 的端点。此时 subagentRoutingEnabled 是空操作(只在 spawn 前读),删文件也已失败,唯一
    // 可证明有效的手段是让这个 pi 进程不再有下一次派发:终止会话(review 连点两轮)。
    const handle = await start();
    const runtimeDir = path.join(agentHome, 'runtime');
    const snapshot = readdirSync(runtimeDir).find((f) => f.startsWith('subagent-'));
    const snapshotPath = path.join(runtimeDir, snapshot as string);

    // 让 set_model 失败;第一次快照写入照常成功。
    captured.failSetModel = true;
    captured.requests = [];
    // 让**回滚**写入失败:回滚发生在 set_model 之后,这里用只读目录制造 EACCES/EISDIR。
    captured.onAfterSetModel = () => {
      rmSync(snapshotPath, { force: true });
      mkdirSync(snapshotPath);
    };

    await expect(handle.setModel('m')).rejects.toThrow(/已终止本会话/);
    // 会话必须真的被关掉,而不是只置一个拦不住任何东西的标志。
    expect(captured.closed).toBe(true);

    rmSync(snapshotPath, { recursive: true, force: true });
  });


  it('terminates the session when set_model neither confirms nor rejects cleanly (reject/timeout)', async () => {
    // reject / 超时与 `success:false` 有本质区别:后者我们**知道**没生效、可以回滚;前者我们
    // **不知道** pi 侧切没切。两条路都不安全 —— 回滚可能与真实状态相反,放行也可能相反,任一
    // 方向都是父子路由分叉(下一次委派打到用户并未启用的端点)。所以 fail-closed:终止会话。
    const handle = await start();
    const runtimeDir = path.join(agentHome, 'runtime');
    const snapshot = readdirSync(runtimeDir).find((f) => f.startsWith('subagent-'));
    const snapshotPath = path.join(runtimeDir, snapshot as string);
    const before = JSON.parse(readFileSync(snapshotPath, 'utf8')) as { model?: string; provider?: string };
    // 启动快照必须是用户实际选的 provider(BYOM / 本地模型的直连约束)。
    expect(before.provider).toBeTruthy();

    captured.rejectSetModel = true;
    await expect(handle.setModel('m')).rejects.toThrow(/未收到确认/);
    // 会话必须真的被关掉:进程还活着就意味着"下一次委派"仍可能发生。
    expect(captured.closed).toBe(true);
  });

  it('rolls back to the user-selected provider when set_model cleanly reports failure', async () => {
    // 与上一条对照:success:false 是**确定**没生效 → 回滚,快照必须回到用户原本选定的
    // provider/model,下一次委派才会继续直连那个 Pi 原生 provider(BYOM 约束)。
    const handle = await start();
    const runtimeDir = path.join(agentHome, 'runtime');
    const snapshot = readdirSync(runtimeDir).find((f) => f.startsWith('subagent-'));
    const snapshotPath = path.join(runtimeDir, snapshot as string);
    const before = JSON.parse(readFileSync(snapshotPath, 'utf8')) as { model?: string; provider?: string };

    captured.failSetModel = true;
    await expect(handle.setModel('m')).rejects.toThrow(/set_model failed/);
    // 会话不该因为一次干净的失败被终止(那是 reject/超时才有的代价)。
    expect(captured.closed).toBe(false);
    // 快照已回滚到切换前的值 —— 父进程路由与下一次委派一致。
    const after = JSON.parse(readFileSync(snapshotPath, 'utf8')) as { model?: string; provider?: string };
    expect(after).toEqual(before);

    await handle.close();
  });

  it('overrides the Pi bash tool and strips host credentials at its spawn boundary', async () => {
    await start();
    const { readFileSync } = await import('node:fs');
    const configHome = captured.env.PI_CODING_AGENT_DIR as string;
    const bridge = readFileSync(path.join(configHome, 'extensions', 'cindy-bridge.ts'), 'utf8');
    expect(bridge).toContain("import { createBashTool } from '@earendil-works/pi-coding-agent'");
    expect(bridge).toContain('env: withoutPiSecrets(env)');
    expect(bridge).toContain('exposeSessionEnvironment: false');
    expect(bridge).toContain("'CINDY_PI_PERMISSION_FILE'");
  });

  it('models.json carries real cost and maxTokens from the model descriptor', async () => {
    await start();
    const config = JSON.parse(
      readFileSync(path.join(captured.env.PI_CODING_AGENT_DIR as string, 'models.json'), 'utf8'),
    ) as {
      providers: {
        cindy: {
          headers: Record<string, string>;
          models: Array<{ id: string; maxTokens: number; cost: Record<string, number> }>;
        };
      };
    };
    const m = config.providers.cindy.models.find((x) => x.id === 'm');
    expect(m?.maxTokens).toBe(64_000);
    expect(m?.cost).toEqual({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });
    expect(config.providers.cindy.headers).toEqual({
      'x-cindy-pi-session-id': '$CINDY_PI_SESSION_ID',
      'x-cindy-pi-session-token': '$CINDY_PI_SESSION_TOKEN',
    });
    expect(JSON.stringify(config)).not.toContain(captured.env.CINDY_PI_SESSION_TOKEN);
  });

  it('只把 resumed retired 模型补进私有 models.json,不暴露到公开能力', async () => {
    const resolver = vi.fn(() => ({
      id: 'chatgpt/gpt-retired',
      displayName: 'GPT Retired',
      contextWindow: 300_000,
      efforts: ['minimal', 'low'] as const,
      defaultEffort: 'low' as const,
      maxOutputTokens: 96_000,
    }));
    const deps = buildDeps();
    deps.resolvePiRuntimeModelDescriptor = resolver;
    const agent = new PiAgent(deps);
    const resumeFile = path.join(agentHome, 'retired-session.jsonl');
    writeFileSync(resumeFile, '{}\n');

    const handle = await agent.startSession({
      sessionId: 'retired-resume',
      workingDir: cwd,
      model: 'chatgpt/gpt-retired',
      providerId: 'openai',
      resumeSessionId: resumeFile,
    });
    const config = JSON.parse(
      readFileSync(path.join(captured.env.PI_CODING_AGENT_DIR as string, 'models.json'), 'utf8'),
    ) as { providers: { cindy: { models: Array<{ id: string; maxTokens: number }> } } };

    expect(resolver).toHaveBeenCalledWith('openai', 'chatgpt/gpt-retired');
    expect(config.providers.cindy.models).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'm' }),
      expect.objectContaining({ id: 'chatgpt/gpt-retired', maxTokens: 96_000 }),
    ]));
    expect(agent.capabilities.availableModels.map((model) => model.id)).toEqual(['m']);
    await handle.close();
  });

  it('新会话缺少公开模型时不调用私有续跑解析器', async () => {
    const resolver = vi.fn(() => ({
      id: 'chatgpt/gpt-retired',
      displayName: 'GPT Retired',
      contextWindow: 300_000,
      efforts: [] as const,
      defaultEffort: null,
    }));
    const deps = buildDeps();
    deps.resolvePiRuntimeModelDescriptor = resolver;
    const agent = new PiAgent(deps);
    const handle = await agent.startSession({
      sessionId: 'fresh-retired',
      workingDir: cwd,
      model: 'chatgpt/gpt-retired',
      providerId: 'openai',
    });
    const config = JSON.parse(
      readFileSync(path.join(captured.env.PI_CODING_AGENT_DIR as string, 'models.json'), 'utf8'),
    ) as { providers: { cindy: { models: Array<{ id: string }> } } };

    expect(resolver).not.toHaveBeenCalled();
    expect(config.providers.cindy.models.some((model) => model.id === 'chatgpt/gpt-retired')).toBe(false);
    await handle.close();
  });

  it('auto mode silently approves in-workspace writes without consulting the resolver', async () => {
    const handle = await start('auto');
    let resolverCalls = 0;
    handle.setInteractionResolver?.(async () => {
      resolverCalls++;
      return { kind: 'permission', behavior: 'allow' } as never;
    });
    firePermissionRequest('r1', 'edit', { path: path.join(cwd, 'a.ts') });
    await flush();
    expect(captured.sent).toContainEqual({ type: 'extension_ui_response', id: 'r1', confirmed: true });
    expect(resolverCalls).toBe(0);
  });

  it('auto mode lets the current-model reviewer allow a gray write without prompting', async () => {
    const review = vi.fn(async () => ({ verdict: 'allow' as const }));
    const handle = await start('auto', review);
    let resolverCalls = 0;
    handle.setInteractionResolver?.(async () => {
      resolverCalls++;
      return { kind: 'permission', behavior: 'deny' } as never;
    });
    await handle.send({ type: 'user', content: 'Update the shared scratch file for this test.' });
    firePermissionRequest('r2', 'write', { path: '/tmp/outside.txt' });
    await flush();
    expect(review).toHaveBeenCalledWith(expect.objectContaining({
      agentKind: 'pi',
      model: 'm',
      userIntent: 'Update the shared scratch file for this test.',
      action: { kind: 'file-write', path: '/tmp/outside.txt' },
    }));
    expect(resolverCalls).toBe(0);
    expect(captured.sent).toContainEqual({ type: 'extension_ui_response', id: 'r2', confirmed: true });
  });

  it('auto mode gives the current-model reviewer complete MCP tool evidence', async () => {
    const review = vi.fn(async () => ({ verdict: 'allow' as const }));
    const handle = await start('auto', review);
    await handle.send({ type: 'user', content: 'Start a review team.' });
    firePermissionRequest('r3', 'mcp__cindy_orca__start_team', {});
    await flush();
    expect(review).toHaveBeenCalledWith(expect.objectContaining({
      action: {
        kind: 'other',
        description: JSON.stringify({ toolName: 'mcp__cindy_orca__start_team', input: {} }),
      },
    }));
    expect(captured.sent).toContainEqual({ type: 'extension_ui_response', id: 'r3', confirmed: true });
  });

  it('auto mode prompts only when the current-model reviewer explicitly asks', async () => {
    const handle = await start('auto', async () => ({ verdict: 'ask' }));
    let resolverCalls = 0;
    handle.setInteractionResolver?.(async () => {
      resolverCalls++;
      return { kind: 'permission', behavior: 'allow' } as never;
    });
    firePermissionRequest('r4', 'write', { path: '/etc/hosts' });
    await flush();
    expect(resolverCalls).toBe(1);
    expect(captured.sent).toContainEqual({ type: 'extension_ui_response', id: 'r4', confirmed: true });
  });

  it('auto mode silently blocks gray actions when the current-model reviewer is unavailable', async () => {
    const handle = await start('auto');
    let resolverCalls = 0;
    handle.setInteractionResolver?.(async () => {
      resolverCalls++;
      return { kind: 'permission', behavior: 'allow' } as never;
    });
    firePermissionRequest('r7', 'write', { path: '/tmp/outside.txt' });
    await flush();
    expect(resolverCalls).toBe(0);
    expect(captured.sent).toContainEqual({ type: 'extension_ui_response', id: 'r7', confirmed: false });
  });

  it('ask mode still prompts for in-workspace writes (auto shortcut is auto-only)', async () => {
    const handle = await start();
    let resolverCalls = 0;
    handle.setInteractionResolver?.(async () => {
      resolverCalls++;
      return { kind: 'permission', behavior: 'allow' } as never;
    });
    firePermissionRequest('r5', 'edit', { path: path.join(cwd, 'a.ts') });
    await flush();
    expect(resolverCalls).toBe(1);
    expect(captured.sent).toContainEqual({ type: 'extension_ui_response', id: 'r5', confirmed: true });
  });

  it('hot-switching to auto via setPermissionMode takes effect for subsequent calls', async () => {
    const handle = await start();
    let resolverCalls = 0;
    handle.setInteractionResolver?.(async () => {
      resolverCalls++;
      return { kind: 'permission', behavior: 'allow' } as never;
    });
    await handle.setPermissionMode?.('auto');
    firePermissionRequest('r6', 'edit', { path: path.join(cwd, 'b.ts') });
    await flush();
    expect(resolverCalls).toBe(0);
    expect(captured.sent).toContainEqual({ type: 'extension_ui_response', id: 'r6', confirmed: true });
  });
});
