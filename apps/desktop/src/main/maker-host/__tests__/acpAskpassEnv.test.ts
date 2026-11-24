/*
 * 测试价值
 * - 生产入口与可观察结果：串联 `buildAcpAgent`（`acp-host.ts`）→ `createPluginHarnessRegistry.spawn`
 *   （`pluginHarnesses.ts`）→ `GhostNodeRuntimeBroker.spawnHarness`（`nodeRuntimeBroker.ts`）→
 *   `createUtilityNodeWorkerProcess`（`nodeRuntimeBroker.desktop.ts`）及 `AskpassHost.envFor`
 *   （`input-handoff/askpass/host.ts`），验证最终传给 `utilityProcess.fork` 的环境变量在
 *   local / remoteWorkspace / guestWorkspace 三条路径下的实际结果，以及宿主环境预设 askpass 时的回退行为。
 * - Bug／规则依据：PR #12642（本机 ACP 插件引擎缺少宿主原生 askpass 环境变量透传，以及宿主环境已设
 *   `SUDO_ASKPASS`/`SSH_ASKPASS`/`GIT_ASKPASS` 时插件环境过滤导致注入失效）；
 *   `docs/dev-rules/credentials-and-local-storage.md`（askpass 仅限本机一次性路由、不得跨机泄漏）；
 *   `docs/dev-rules/plugin-security-and-authoring.md`（任务执行引擎进程边界）。
 * - 现有覆盖缺口：`pluginHarnesses.test.ts` 与 `nodeRuntimeBroker.test.ts` 只验证各自的隔离契约，
 *   未覆盖 ACP 宿主 `taskShellEnv` 装配与 `extraEnv` 跨层透传/合并；`askpass.native.test.ts`
 *   只验证内置 shell 与真实 git 进程，不经过插件引擎注册表、broker 与 `pluginNodeEnvironment` 过滤。
 * - 为何单独建文件：本文件覆盖跨越 `maker-host`、`cindy-brain` 与 `input-handoff/askpass` 三个子模块的
 *   端到端环境变量装配与纵深防御守卫，需要同时准备 ACP JSON-RPC stub、harness registry、broker 与
 *   `utilityProcess.fork` 假体；并入任一单模块测试文件都会引入跨层夹具耦合。
 * - 最小失败输入：(1) 本机 ACP 会话未将 `extraEnv` 合并到 `utilityProcess.fork` 的 `env`，或宿主已设
 *   `SUDO_ASKPASS`/`SSH_ASKPASS`/`GIT_ASKPASS` 时插件引擎拿不到 Cindy helper；
 *   (2) `remoteWorkspace` 或 `guestWorkspace` 会话（含显式向 registry / broker 传入 `extraEnv` 的防御场景）
 *   把 askpass 变量泄漏到子进程 `env`。
 * - tier：unit（内存 fake / stub，无真实外部引擎进程、无网络）。
 * - 实测耗时：< 1s（`apps/desktop` 下 `vitest run src/main/maker-host/__tests__/acpAskpassEnv.test.ts`）。
 */
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '@cindy/maker-core';
import { buildAcpAgent } from '../acp-host.js';
import {
  GHOST_HARNESS_GUEST_WORKSPACE_ARG,
  GHOST_HARNESS_REMOTE_WORKSPACE_ARG,
} from '@cindy/plugin-protocol';
import {
  validateGhostManifest,
  type InstalledGhost,
} from '../../../shared/ghost.js';
import { createPluginHarnessRegistry } from '../../cindy-brain/pluginHarnesses.js';
import {
  createUtilityNodeWorkerProcess,
  GhostNodeRuntimeBroker,
} from '../../cindy-brain/nodeRuntimeBroker.desktop.js';
import type { PluginNodeProcess } from '../../cindy-brain/nodeRuntimeProcessAdapter.js';
import { AskpassHost, INPUT_HANDOFF_ROUTE_ENV } from '../../input-handoff/askpass/host.js';

const silentLogger: Logger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  child: () => silentLogger,
};

const ASKPASS_ENV = {
  SUDO_ASKPASS: '/tmp/cindy-askpass',
  SSH_ASKPASS: '/tmp/cindy-askpass',
  SSH_ASKPASS_REQUIRE: 'force',
  GIT_ASKPASS: '/tmp/cindy-askpass',
  [INPUT_HANDOFF_ROUTE_ENV]: 'route-local-1',
};

function createTestGhost(id = 'agy-acp', harnessId = 'agy'): InstalledGhost {
  const parsed = validateGhostManifest({
    schemaVersion: 3,
    minCindyVersion: '0.1.61',
    id,
    name: 'AGY ACP',
    version: '1.0.0',
    entry: 'main.js',
    node: { entry: 'worker.js', protocol: 'json-rpc-stdio', entries: ['engine.js'] },
    harnesses: [
      { id: harnessId, name: 'AGY', description: 'Local ACP agent', protocol: 'acp', entry: 'engine.js' },
    ],
  });
  if (!parsed.ok) throw new Error(parsed.reason);
  return {
    manifest: parsed.manifest,
    dir: path.resolve('/plugins', id),
    enabled: true,
    approval: { state: 'approved', revision: '00000000-0000-4000-8000-000000000001' },
    approvedHarnesses: [harnessId],
  };
}

interface CapturedForkCall {
  modulePath: string;
  args: string[];
  env: NodeJS.ProcessEnv | undefined;
}

function createFakeUtilityFork(captured: CapturedForkCall[]) {
  return ((modulePath: string, args?: string[], options?: { env?: NodeJS.ProcessEnv }) => {
    captured.push({ modulePath, args: args ?? [], env: options?.env });
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const events = new EventEmitter();
    const child = Object.assign(events, {
      pid: 4242,
      stdout,
      stderr,
      postMessage(message: unknown) {
        const msg = message as { type?: string; chunk?: string };
        if (msg.type === 'stdin-end') {
          queueMicrotask(() => events.emit('exit', 0));
          return;
        }
        if (msg.type !== 'stdin-b64' || typeof msg.chunk !== 'string') return;
        const text = Buffer.from(msg.chunk, 'base64').toString('utf8');
        for (const line of text.split('\n')) {
          if (!line.trim()) continue;
          const rpc = JSON.parse(line) as { id?: number; method?: string };
          if (rpc.method === 'initialize') {
            stdout.write(`${JSON.stringify({
              jsonrpc: '2.0',
              id: rpc.id,
              result: {
                protocolVersion: 1,
                agentCapabilities: { mcpCapabilities: { http: true } },
              },
            })}\n`);
          } else if (rpc.method === 'session/new') {
            stdout.write(`${JSON.stringify({
              jsonrpc: '2.0',
              id: rpc.id,
              result: { sessionId: 'native-1', configOptions: [] },
            })}\n`);
          }
        }
      },
      kill() {
        queueMicrotask(() => events.emit('exit', 0));
        return true;
      },
    }) as unknown as PluginNodeProcess;
    queueMicrotask(() => {
      events.emit('spawn');
      events.emit('message', { type: 'ready' });
    });
    return child;
  }) as unknown as Parameters<typeof createUtilityNodeWorkerProcess>[3];
}

function createWiredHarnessStack(taskShellEnv: (ctx: { sessionId: string }) => Record<string, string>) {
  const ghost = createTestGhost();
  const forkCalls: CapturedForkCall[] = [];
  const fakeFork = createFakeUtilityFork(forkCalls);

  const broker = new GhostNodeRuntimeBroker({
    getGhost: (ghostId) => (ghostId === ghost.manifest.id ? ghost : undefined),
    spawnChildProcess: (entryPath, cwd, ghostId, args, extraEnv) =>
      createUtilityNodeWorkerProcess(entryPath, cwd, ghostId, fakeFork, args, extraEnv),
  });

  const registry = createPluginHarnessRegistry({
    listGhosts: () => [ghost],
    isAvailable: () => true,
    readAvailability: () => ({
      harnesses: [{ id: 'agy', available: true, remoteWorkspace: true, guestWorkspace: true }],
    }),
    uiLocale: () => 'en',
    spawn: (ghostId, harnessId, options) => broker.spawnHarness(ghostId, harnessId, options),
  });

  const agent = buildAcpAgent({
    logger: silentLogger,
    appVersion: '0.1.145',
    taskShellEnv,
    spawnHarness: (key, options) => (options ? registry.spawn(key, options) : registry.spawn(key)),
  });

  return { agent, registry, broker, forkCalls, ghost };
}

describe('ACP host native askpass env passthrough', () => {
  it('merges local askpass env into the spawned harness utility process through registry and broker', async () => {
    const taskShellEnv = vi.fn(({ sessionId }: { sessionId: string }) => ({
      ...ASKPASS_ENV,
      [INPUT_HANDOFF_ROUTE_ENV]: `route-${sessionId}`,
    }));
    const { agent, forkCalls } = createWiredHarnessStack(taskShellEnv);

    const handle = await agent.startSession({
      sessionId: 'local-sess-1',
      workingDir: '/tmp/repo',
      model: 'default',
      providerId: 'acp-plugin:agy-acp:agy',
    });

    expect(taskShellEnv).toHaveBeenCalledWith({ sessionId: 'local-sess-1' });
    expect(forkCalls).toHaveLength(1);
    expect(forkCalls[0]!.args).not.toContain(GHOST_HARNESS_REMOTE_WORKSPACE_ARG);
    expect(forkCalls[0]!.args).not.toContain(GHOST_HARNESS_GUEST_WORKSPACE_ARG);
    expect(forkCalls[0]!.env).toMatchObject({
      CINDY_GHOST_ID: 'agy-acp',
      SUDO_ASKPASS: '/tmp/cindy-askpass',
      SSH_ASKPASS: '/tmp/cindy-askpass',
      SSH_ASKPASS_REQUIRE: 'force',
      GIT_ASKPASS: '/tmp/cindy-askpass',
      [INPUT_HANDOFF_ROUTE_ENV]: 'route-local-sess-1',
    });
    await handle.close();
  });

  it.each([
    { label: 'remoteWorkspace', guest: false, expectedArgs: [GHOST_HARNESS_REMOTE_WORKSPACE_ARG] },
    { label: 'guestWorkspace', guest: true, expectedArgs: [GHOST_HARNESS_REMOTE_WORKSPACE_ARG, GHOST_HARNESS_GUEST_WORKSPACE_ARG] },
  ])('never injects local askpass env for $label ACP sessions through registry and broker', async ({ guest, expectedArgs }) => {
    const taskShellEnv = vi.fn(() => ASKPASS_ENV);
    const { agent, forkCalls } = createWiredHarnessStack(taskShellEnv);

    const handle = await agent.startSession({
      sessionId: guest ? 'guest-sess-1' : 'remote-sess-1',
      workingDir: '/shadow/p',
      model: 'default',
      providerId: 'acp-plugin:agy-acp:agy',
      deviceHosted: {
        workingDir: '/shadow/p',
        extraDirs: [],
        writableDirs: [],
        platform: 'linux',
        shell: 'bash',
        isGitRepo: true,
        tunnelUrl: 'http://127.0.0.1:4711/',
        tunnelToken: 'tok',
        mcpServers: ['cindy_exec'],
        ...(guest ? { guest: true } : {}),
      },
    });

    expect(taskShellEnv).not.toHaveBeenCalled();
    expect(forkCalls).toHaveLength(1);
    for (const arg of expectedArgs) {
      expect(forkCalls[0]!.args).toContain(arg);
    }
    if (!guest) {
      expect(forkCalls[0]!.args).not.toContain(GHOST_HARNESS_GUEST_WORKSPACE_ARG);
    }
    expect(forkCalls[0]!.env?.CINDY_GHOST_ID).toBe('agy-acp');
    expect(forkCalls[0]!.env?.SUDO_ASKPASS).toBeUndefined();
    expect(forkCalls[0]!.env?.SSH_ASKPASS).toBeUndefined();
    expect(forkCalls[0]!.env?.SSH_ASKPASS_REQUIRE).toBeUndefined();
    expect(forkCalls[0]!.env?.GIT_ASKPASS).toBeUndefined();
    expect(forkCalls[0]!.env?.[INPUT_HANDOFF_ROUTE_ENV]).toBeUndefined();
    await handle.close();
  });

  it('strips extraEnv in createPluginHarnessRegistry.spawn for remoteWorkspace and guestWorkspace even if passed directly', async () => {
    const ghost = createTestGhost();
    const spawnSpy = vi.fn(async () => ({} as ReturnType<typeof createUtilityNodeWorkerProcess>));
    const registry = createPluginHarnessRegistry({
      listGhosts: () => [ghost],
      isAvailable: () => true,
      readAvailability: () => ({
        harnesses: [{ id: 'agy', available: true, remoteWorkspace: true, guestWorkspace: true }],
      }),
      uiLocale: () => 'en',
      spawn: spawnSpy,
    });

    await registry.spawn('agy-acp:agy', { extraEnv: ASKPASS_ENV });
    await registry.spawn('agy-acp:agy', { remoteWorkspace: true, extraEnv: ASKPASS_ENV });
    await registry.spawn('agy-acp:agy', { guestWorkspace: true, extraEnv: ASKPASS_ENV });

    expect(spawnSpy).toHaveBeenNthCalledWith(1, 'agy-acp', 'agy', { extraEnv: ASKPASS_ENV });
    expect(spawnSpy).toHaveBeenNthCalledWith(2, 'agy-acp', 'agy', { remoteWorkspace: true });
    expect(spawnSpy).toHaveBeenNthCalledWith(3, 'agy-acp', 'agy', { remoteWorkspace: true, guestWorkspace: true });
  });

  it('strips extraEnv in GhostNodeRuntimeBroker.spawnHarness for remoteWorkspace and guestWorkspace even if passed directly', async () => {
    const ghost = createTestGhost();
    const forkCalls: CapturedForkCall[] = [];
    const fakeFork = createFakeUtilityFork(forkCalls);
    const broker = new GhostNodeRuntimeBroker({
      getGhost: (ghostId) => (ghostId === ghost.manifest.id ? ghost : undefined),
      spawnChildProcess: (entryPath, cwd, ghostId, args, extraEnv) =>
        createUtilityNodeWorkerProcess(entryPath, cwd, ghostId, fakeFork, args, extraEnv),
    });

    const localProc = await broker.spawnHarness('agy-acp', 'agy', { extraEnv: ASKPASS_ENV });
    const remoteProc = await broker.spawnHarness('agy-acp', 'agy', { remoteWorkspace: true, extraEnv: ASKPASS_ENV });
    const guestProc = await broker.spawnHarness('agy-acp', 'agy', { guestWorkspace: true, extraEnv: ASKPASS_ENV });

    try {
      expect(forkCalls).toHaveLength(3);
      expect(forkCalls[0]!.env).toMatchObject({ CINDY_GHOST_ID: 'agy-acp', ...ASKPASS_ENV });
      expect(forkCalls[1]!.env?.SUDO_ASKPASS).toBeUndefined();
      expect(forkCalls[1]!.env?.[INPUT_HANDOFF_ROUTE_ENV]).toBeUndefined();
      expect(forkCalls[2]!.env?.SUDO_ASKPASS).toBeUndefined();
      expect(forkCalls[2]!.env?.[INPUT_HANDOFF_ROUTE_ENV]).toBeUndefined();
    } finally {
      localProc.kill();
      remoteProc.kill();
      guestProc.kill();
    }
  });

  const posixAskpassSupported = process.platform === 'darwin' || process.platform === 'linux';
  it.runIf(posixAskpassSupported)('computes plugin askpass overrides against empty plugin baseEnv even when host env pre-sets askpass vars', async () => {
    const host = new AskpassHost({
      isDisabledForSession: async () => false,
      startTerminalPrompt: () => ({ ok: true }),
      baseEnv: {
        SUDO_ASKPASS: '/user/sudo-askpass',
        SSH_ASKPASS: '/user/ssh-askpass',
        GIT_ASKPASS: '/user/git-askpass',
      },
    });
    try {
      await host.prepare();
      const builtinEnv = host.envFor('local-sess-1');
      expect(builtinEnv.SUDO_ASKPASS).toBeUndefined();
      expect(builtinEnv.SSH_ASKPASS).toBeUndefined();
      expect(builtinEnv.GIT_ASKPASS).toBeUndefined();
      expect(builtinEnv[INPUT_HANDOFF_ROUTE_ENV]).toBeTruthy();

      const pluginEnv = host.envFor('local-sess-1', {});
      expect(pluginEnv.SUDO_ASKPASS).toBe(host.helperPath);
      expect(pluginEnv.SSH_ASKPASS).toBe(host.helperPath);
      expect(pluginEnv.SSH_ASKPASS_REQUIRE).toBe('force');
      expect(pluginEnv.GIT_ASKPASS).toBe(host.helperPath);
      expect(pluginEnv[INPUT_HANDOFF_ROUTE_ENV]).toBe(builtinEnv[INPUT_HANDOFF_ROUTE_ENV]);
    } finally {
      await host.close();
    }
  });
});
