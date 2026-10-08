/**
 * 设备托管会话属于另一个账号(供应商分享的受邀者)时，Pi 不加载本机用户的 Pi 包、扩展、托管
 * 技能、全局说明、技能偏好与插件清单，也不执行受邀者带来的项目扩展；说明文件只取会话目录内的
 * (经 cindy-guest-context 扩展放回系统提示)，受邀者的项目技能与提示词模板照常加载，也不能经
 * Agent 在本机装 Pi 包；供应商只留分享的那一个(models.json、子代理路由、proxy 令牌与密钥 env)。
 * 同账号托管会话不变(Pi 原生能力非退化红线)。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

import ts from 'typescript';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const knobs = vi.hoisted(() => ({
  spawnedEnvs: [] as Array<Record<string, string | undefined>>,
  spawnedArgs: [] as string[][],
}));

vi.mock('../transport.js', () => ({
  createPiStdioTransport: (opts: { args: string[]; env: Record<string, string | undefined>; onProcessSpawned?: (pid: number) => void }) => {
    knobs.spawnedEnvs.push({ ...(opts.env ?? {}) });
    knobs.spawnedArgs.push([...(opts.args ?? [])]);
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
    async request(cmd: { type: string }): Promise<{ success: boolean; data?: unknown }> {
      if (cmd.type === 'get_state') {
        return { success: true, data: { sessionFile: '/mock/session.jsonl', model: { contextWindow: 200000 } } };
      }
      return { success: true, data: { entries: [], commands: [] } };
    }
    send(): void {}
    async close(): Promise<void> {
      this.isClosed = true;
    }
    get pid(): number { return 1234; }
  },
}));

import { PiAgent } from '../index.js';
import type {
  AgentDeps,
  DeviceHostedGuestProvider,
  DeviceHostedSession,
  PiNativeProviderSpec,
} from '../../base-agent.js';
import type { Logger } from '../../../interfaces/logger.js';
import {
  CINDY_GUEST_CONTEXT_DATA_FILENAME,
  CINDY_GUEST_CONTEXT_EXTENSION_FILENAME,
  CINDY_GUEST_CONTEXT_EXTENSION_SOURCE,
} from '../device-hosted-guest.js';

const noopLogger: Logger = {
  trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {},
  child: () => noopLogger,
};

function repeatedArgValues(args: readonly string[], flag: string): string[] {
  return args.flatMap((value, index) => value === flag && args[index + 1] ? [args[index + 1]!] : []);
}

describe('Pi device-hosted guest sessions', () => {
  let root = '';
  let agentHome = '';
  let hostDir = '';
  let sessionRoot = '';
  let cwd = '';
  let globalHome = '';
  let spies: {
    getGhostRosterPrompt: ReturnType<typeof vi.fn>;
    getManagedSkills: ReturnType<typeof vi.fn>;
    getDisabledSkillPaths: ReturnType<typeof vi.fn>;
    resolvePiNativePackagePaths: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    knobs.spawnedArgs = [];
    knobs.spawnedEnvs = [];
    root = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'pi-hosted-guest-')));
    agentHome = path.join(root, 'agent-home');
    // 本机用户的目录：带 .git、说明文件与 Agent Skills，位于会话目录之上。
    hostDir = path.join(root, 'host-user');
    sessionRoot = path.join(hostDir, 'remote-agent', 'workspaces', 'c1', 's1');
    cwd = path.join(sessionRoot, 'fs', 'workspace');
    globalHome = path.join(root, 'pi-global');
    for (const dir of [agentHome, cwd, globalHome, path.join(hostDir, '.git')]) mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(hostDir, 'AGENTS.md'), 'HOST PRIVATE RULES');
    mkdirSync(path.join(hostDir, '.agents', 'skills', 'host-skill'), { recursive: true });
    writeFileSync(path.join(hostDir, '.agents', 'skills', 'host-skill', 'SKILL.md'), '# host\n');
    writeFileSync(path.join(globalHome, 'AGENTS.md'), 'HOST GLOBAL RULES');
    // 受邀者带来的：项目说明、个人说明(会话目录)、项目技能 / 模板 / 扩展。
    writeFileSync(path.join(cwd, 'AGENTS.md'), 'GUEST PROJECT RULES');
    writeFileSync(path.join(sessionRoot, 'CLAUDE.md'), 'GUEST PERSONAL RULES');
    mkdirSync(path.join(cwd, '.pi', 'skills', 'demo'), { recursive: true });
    writeFileSync(path.join(cwd, '.pi', 'skills', 'demo', 'SKILL.md'), '# demo\n');
    mkdirSync(path.join(cwd, '.pi', 'prompts'), { recursive: true });
    writeFileSync(path.join(cwd, '.pi', 'prompts', 'review.md'), '# review\n');
    mkdirSync(path.join(cwd, '.pi', 'extensions'), { recursive: true });
    writeFileSync(path.join(cwd, '.pi', 'extensions', 'hook.ts'), 'export default () => {};\n');
    const managedSkill = path.join(root, 'managed', 'learn', 'SKILL.md');
    mkdirSync(path.dirname(managedSkill), { recursive: true });
    writeFileSync(managedSkill, '---\nname: learn\ndescription: Fixture\n---\nBody');
    spies = {
      getGhostRosterPrompt: vi.fn(() => 'HOST GHOST ROSTER'),
      getManagedSkills: vi.fn(async () => [{
        kind: 'agent-skill' as const,
        name: 'learn',
        path: managedSkill,
        source: 'skill' as const,
        enabled: true,
      }]),
      getDisabledSkillPaths: vi.fn(() => []),
      resolvePiNativePackagePaths: vi.fn(async () => ['npm:host-package']),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  function buildDeps(extra: Partial<AgentDeps> = {}): AgentDeps {
    return {
      auth: {
        getState: async () => ({ authenticated: true, identity: 'test', authSource: 'api-key' as const }),
        triggerLogin: async () => ({ authenticated: true }),
        logout: async () => {},
        getAuthEnv: async () => ({}),
      },
      runtimeConfig: { endpoint: 'http://127.0.0.1:9', systemPrompt: 'GLOBAL CINDY HOST PROMPT' },
      binaryPath: path.join(agentHome, 'pi'),
      logger: noopLogger,
      capabilityAdditions: {
        availableModels: [{ id: 'm', displayName: 'M', contextWindow: 200_000, efforts: [], defaultEffort: null }],
      },
      resolvePiGatewayModelApi: () => 'openai-responses',
      resolvePiAgentHome: () => agentHome,
      resolvePiGlobalContextHome: () => globalHome,
      mutatePiManagedPackage: async () => ({}),
      spawnPiSubagentRunner: () => {
        const handle = {
          pid: 4321,
          killed: false,
          once(event: string, listener: (...args: unknown[]) => void) {
            if (event === 'spawn') queueMicrotask(listener);
            return handle;
          },
          kill: () => true,
        };
        return handle as never;
      },
      ...spies,
      ...extra,
    } as AgentDeps;
  }

  async function start(guest: boolean, extra: {
    guestHome?: string;
    resumeSessionId?: string;
    providerId?: string;
    model?: string;
    guestProvider?: DeviceHostedGuestProvider | null;
    deps?: Partial<AgentDeps>;
  } = {}) {
    const model = extra.model ?? 'm';
    const providerId = extra.providerId ?? (guest ? 'xd' : undefined);
    const guestProvider = extra.guestProvider === null
      ? undefined
      : extra.guestProvider ?? { providerId: providerId ?? 'xd', modelIds: [model], routeToken: 'route-token' };
    const deviceHosted: DeviceHostedSession = {
      workingDir: cwd,
      extraDirs: [],
      writableDirs: [],
      platform: 'darwin',
      shell: 'zsh',
      isGitRepo: false,
      tunnelUrl: 'http://127.0.0.1:4000/t/tok/',
      tunnelToken: 'tok',
      mcpServers: ['cindy_contacts'],
      mirrorRoot: path.join(sessionRoot, 'fs'),
      ...(guest ? { guest: true } : {}),
      ...(extra.guestHome ? { guestHome: extra.guestHome } : {}),
      ...(guest && guestProvider ? { guestProvider } : {}),
    };
    const handle = await new PiAgent(buildDeps(extra.deps)).startSession({
      sessionId: guest ? 'guest-session' : 'owner-session',
      sessionInstanceId: 'pi-instance-1',
      workingDir: cwd,
      model,
      ...(providerId ? { providerId } : {}),
      deviceHosted,
      ...(extra.resumeSessionId ? { resumeSessionId: extra.resumeSessionId } : {}),
    });
    const args = knobs.spawnedArgs[0]!;
    const env = knobs.spawnedEnvs[0]!;
    const configHome = env.PI_CODING_AGENT_DIR!;
    const extensionsDir = path.posix.join(configHome, 'internal-extensions');
    return { handle, args, env, configHome, extensionsDir };
  }

  it('keeps this computer\'s Pi packages, skills, instructions and project extensions out of a guest session', async () => {
    const { handle, args, env, configHome, extensionsDir } = await start(true);
    try {
      expect(args).toEqual(expect.arrayContaining([
        '--no-approve', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files',
      ]));
      // 受邀者的说明文件扩展排在 bridge 之前；项目扩展不加载。
      expect(repeatedArgValues(args, '--extension')).toEqual([
        path.posix.join(extensionsDir, CINDY_GUEST_CONTEXT_EXTENSION_FILENAME),
        path.posix.join(extensionsDir, 'cindy-bridge.ts'),
        path.posix.join(extensionsDir, 'cindy-subagent.ts'),
      ]);
      // 受邀者的项目技能与提示词模板照常加载；本机目录里的 Agent Skills 与托管技能不加载。
      expect(repeatedArgValues(args, '--skill')).toEqual([realpathSync(path.join(cwd, '.pi', 'skills', 'demo'))]);
      expect(repeatedArgValues(args, '--prompt-template')).toEqual([
        realpathSync(path.join(cwd, '.pi', 'prompts', 'review.md')),
      ]);
      // 说明文件只取会话目录内的，按 Pi 原生顺序(上级在前)。
      const data = JSON.parse(readFileSync(path.join(extensionsDir, CINDY_GUEST_CONTEXT_DATA_FILENAME), 'utf8')) as {
        files: Array<{ path: string; content: string }>;
      };
      expect(data.files).toEqual([
        { path: path.join(sessionRoot, 'CLAUDE.md'), content: 'GUEST PERSONAL RULES' },
        { path: path.join(cwd, 'AGENTS.md'), content: 'GUEST PROJECT RULES' },
      ]);
      expect(existsSync(path.join(configHome, 'AGENTS.md'))).toBe(false);
      const settings = JSON.parse(readFileSync(path.join(configHome, 'settings.json'), 'utf8'));
      expect(settings.packages).toBeUndefined();
      expect(env.CINDY_PI_PACKAGE_MANAGEMENT).toBeUndefined();
      expect(JSON.parse(env.CINDY_PI_HOSTED!)).toMatchObject({ guest: true });
      expect(args[args.indexOf('--append-system-prompt') + 1] ?? '').not.toContain('HOST GHOST ROSTER');
      expect(spies.getGhostRosterPrompt).not.toHaveBeenCalled();
      expect(spies.getManagedSkills).not.toHaveBeenCalled();
      expect(spies.getDisabledSkillPaths).not.toHaveBeenCalled();
      expect(spies.resolvePiNativePackagePaths).not.toHaveBeenCalled();
    } finally {
      await handle.close();
    }
  });

  it('keeps a guest\'s Pi sessions in its guest home and resumes only from there', async () => {
    const guestHome = path.join(root, 'guest-homes', 'c1');
    const { handle, args } = await start(true, { guestHome });
    try {
      expect(args[args.indexOf('--session-dir') + 1]).toBe(path.join(guestHome, 'pi-sessions'));
    } finally {
      await handle.close();
    }
    // 凭路径打开本机的其它文件(例如本机用户自己的会话)一律拒绝，不启动 Pi。
    const ownSession = path.join(agentHome, 'sessions', 'own.jsonl');
    mkdirSync(path.dirname(ownSession), { recursive: true });
    writeFileSync(ownSession, '{}');
    knobs.spawnedArgs = [];
    await expect(start(true, { guestHome, resumeSessionId: ownSession })).rejects.toThrow(/REMOTE_AGENT_INVALID/);
    expect(knobs.spawnedArgs).toHaveLength(0);
    const guestSession = path.join(guestHome, 'pi-sessions', 'guest.jsonl');
    writeFileSync(guestSession, '{}');
    const resumed = await start(true, { guestHome, resumeSessionId: guestSession });
    await resumed.handle.close();
  });

  const sessionHeaders = {
    'x-cindy-pi-session-id': '$CINDY_PI_SESSION_ID',
    'x-cindy-pi-session-token': '$CINDY_PI_SESSION_TOKEN',
  };
  function byom(id: string, model: string): PiNativeProviderSpec {
    const envId = id.toUpperCase().replace(/-/g, '_');
    return {
      id,
      name: id,
      baseUrl: `http://127.0.0.1:9/${id}`,
      api: 'openai-completions',
      apiKeyEnvVar: `CINDY_PI_KEY_${envId}`,
      // 自定义请求头里的凭证也经 env 交给 Pi(pi-host 的 `<id>_HEADER_<name>`)。
      headers: { ...sessionHeaders, authorization: `$CINDY_PI_${envId}_HEADER_authorization` },
      models: [{ id: model }],
    };
  }
  /** 本机用户连了两个自定义供应商，外加网关模型 m；记录本机 proxy 登记的令牌对应的供应商。 */
  function providerDeps() {
    const registered: Array<string | null> = [];
    const deps: Partial<AgentDeps> = {
      resolvePiNativeProviders: async () => ({
        providers: [byom('byom-a', 'model-a'), byom('byom-b', 'model-b')],
        env: {
          CINDY_PI_KEY_BYOM_A: 'key-a',
          CINDY_PI_KEY_BYOM_B: 'key-b',
          CINDY_PI_BYOM_A_HEADER_authorization: 'header-a',
          CINDY_PI_BYOM_B_HEADER_authorization: 'header-b',
          CINDY_PI_UNREFERENCED: 'stray',
        },
      }),
      // 本机用户开了视觉桥：视觉后端(本机用户自己的其它供应商)的地址与密钥。
      resolvePiVisionBridgeEnv: () => ({ CINDY_PI_VISION_BRIDGE_TEST: 'vision-secret' }),
      registerPiProxySession: (_sessionId, _token, resolveProviderId) => {
        registered.push(resolveProviderId());
        return () => {};
      },
    };
    return { deps, registered };
  }
  function readSubagentRoutes(env: Record<string, string | undefined>): Record<string, Array<{ provider: string }>> {
    return JSON.parse(readFileSync(env.CINDY_PI_SUBAGENT_RUNTIME_FILE!, 'utf8')).modelRoutes;
  }

  it('keeps a guest on the shared provider: models.json, subagent routes, proxy tokens and keys', async () => {
    const { deps, registered } = providerDeps();
    const { handle, env, configHome } = await start(true, { providerId: 'byom-a', model: 'model-a', deps });
    try {
      const models = JSON.parse(readFileSync(path.join(configHome, 'models.json'), 'utf8'));
      expect(Object.keys(models.providers).sort()).toEqual(['byom-a', 'cindy']);
      expect(models.providers.cindy.models).toEqual([]);
      expect(env.CINDY_PI_KEY_BYOM_A).toBe('key-a');
      expect(env.CINDY_PI_BYOM_A_HEADER_authorization).toBe('header-a');
      expect(env.CINDY_PI_KEY_BYOM_B).toBeUndefined();
      expect(env.CINDY_PI_BYOM_B_HEADER_authorization).toBeUndefined();
      expect(env.CINDY_PI_UNREFERENCED).toBeUndefined();
      // 视觉桥不进受邀者会话(视觉后端是本机用户的其它供应商，vision 工具还会直接读本机文件)。
      expect(env.CINDY_PI_VISION_BRIDGE_TEST).toBeUndefined();
      const routes = readSubagentRoutes(env);
      expect(Object.keys(routes)).toEqual(['model-a']);
      expect(routes['model-a']!.map((route) => route.provider)).toEqual(['byom-a']);
      // 根令牌与子代理令牌都只对应分享的供应商；没有网关令牌。
      expect(registered.length).toBeGreaterThan(0);
      expect(new Set(registered)).toEqual(new Set(['byom-a']));
    } finally {
      await handle.close();
    }
  });

  it('keeps a guest sharing the Cindy gateway on gateway models only', async () => {
    const { deps, registered } = providerDeps();
    const { handle, env, configHome } = await start(true, { deps });
    try {
      const models = JSON.parse(readFileSync(path.join(configHome, 'models.json'), 'utf8'));
      expect(Object.keys(models.providers)).toEqual(['cindy']);
      expect(models.providers.cindy.models.map((model: { id: string }) => model.id)).toEqual(['m']);
      expect(env.CINDY_PI_KEY_BYOM_A).toBeUndefined();
      expect(env.CINDY_PI_KEY_BYOM_B).toBeUndefined();
      expect(env.CINDY_PI_BYOM_A_HEADER_authorization).toBeUndefined();
      expect(env.CINDY_PI_BYOM_B_HEADER_authorization).toBeUndefined();
      expect(env.CINDY_PI_VISION_BRIDGE_TEST).toBeUndefined();
      expect(Object.keys(readSubagentRoutes(env))).toEqual(['m']);
      expect(new Set(registered)).toEqual(new Set([null]));
    } finally {
      await handle.close();
    }
  });

  it('refuses a guest session without a provider boundary or on another provider', async () => {
    await expect(start(true, { guestProvider: null })).rejects.toThrow(/REMOTE_AGENT_PROVIDER_NOT_ALLOWED/);
    await expect(start(true, {
      providerId: 'byom-b',
      model: 'model-b',
      guestProvider: { providerId: 'byom-a', modelIds: ['model-a'], routeToken: 'route-token' },
    })).rejects.toThrow(/REMOTE_AGENT_PROVIDER_NOT_ALLOWED/);
    expect(knobs.spawnedArgs).toHaveLength(0);
  });

  it('keeps same-account provider routes unchanged', async () => {
    const { deps, registered } = providerDeps();
    const { handle, env, configHome } = await start(false, { providerId: 'byom-a', model: 'model-a', deps });
    try {
      const models = JSON.parse(readFileSync(path.join(configHome, 'models.json'), 'utf8'));
      expect(Object.keys(models.providers).sort()).toEqual(['byom-a', 'byom-b', 'cindy']);
      expect(models.providers.cindy.models.map((model: { id: string }) => model.id)).toEqual(['m']);
      expect(env.CINDY_PI_KEY_BYOM_B).toBe('key-b');
      expect(env.CINDY_PI_BYOM_B_HEADER_authorization).toBe('header-b');
      expect(env.CINDY_PI_UNREFERENCED).toBe('stray');
      expect(env.CINDY_PI_VISION_BRIDGE_TEST).toBe('vision-secret');
      expect(Object.keys(readSubagentRoutes(env)).sort()).toEqual(['m', 'model-a', 'model-b']);
      expect(new Set(registered)).toEqual(new Set(['byom-a', 'byom-b', null]));
    } finally {
      await handle.close();
    }
  });

  it('keeps same-account hosted sessions unchanged', async () => {
    const { handle, args, env, configHome, extensionsDir } = await start(false);
    try {
      for (const flag of ['--no-skills', '--no-prompt-templates', '--no-context-files', '--no-extensions']) {
        expect(args).not.toContain(flag);
      }
      expect(repeatedArgValues(args, '--extension')).toEqual([
        path.posix.join(extensionsDir, 'cindy-bridge.ts'),
        path.posix.join(extensionsDir, 'cindy-subagent.ts'),
        realpathSync(path.join(cwd, '.pi', 'extensions', 'hook.ts')),
      ]);
      expect(repeatedArgValues(args, '--skill')).toEqual(expect.arrayContaining([
        realpathSync(path.join(cwd, '.pi', 'skills', 'demo')),
        path.join(configHome, 'cindy-managed-skills'),
      ]));
      expect(existsSync(path.join(extensionsDir, CINDY_GUEST_CONTEXT_EXTENSION_FILENAME))).toBe(false);
      expect(readFileSync(path.join(configHome, 'AGENTS.md'), 'utf8')).toBe('HOST GLOBAL RULES');
      const settings = JSON.parse(readFileSync(path.join(configHome, 'settings.json'), 'utf8'));
      expect(settings.packages).toEqual(['npm:host-package']);
      expect(env.CINDY_PI_PACKAGE_MANAGEMENT).toBeTruthy();
      expect(JSON.parse(env.CINDY_PI_HOSTED!).guest).toBeUndefined();
      expect(args[args.indexOf('--append-system-prompt') + 1]).toContain('HOST GHOST ROSTER');
      expect(spies.getManagedSkills).toHaveBeenCalled();
      expect(spies.resolvePiNativePackagePaths).toHaveBeenCalled();
      expect(args[args.indexOf('--session-dir') + 1]).toBe(path.posix.join(agentHome, 'sessions'));
    } finally {
      await handle.close();
    }
  });
});

describe('cindy-guest-context extension', () => {
  let home = '';
  beforeEach(() => {
    home = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'pi-guest-context-ext-')));
    mkdirSync(path.join(home, 'internal-extensions'), { recursive: true });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  async function loadExtension(files: Array<{ path: string; content: string }>) {
    writeFileSync(
      path.join(home, 'internal-extensions', CINDY_GUEST_CONTEXT_DATA_FILENAME),
      JSON.stringify({ files }),
    );
    // 与其它扩展源码测试一样：按 Pi 的方式转成 JS 后在隔离上下文里运行。
    const compiled = ts.transpileModule(CINDY_GUEST_CONTEXT_EXTENSION_SOURCE, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const module = { exports: {} as { default?: (pi: unknown) => void } };
    runInNewContext(compiled, {
      require: createRequire(import.meta.url),
      module,
      exports: module.exports,
      process: { env: { PI_CODING_AGENT_DIR: home } },
    });
    const mod = { default: module.exports.default! };
    const handlers: Array<(event: unknown) => unknown> = [];
    mod.default({ on: (name: string, handler: (event: unknown) => unknown) => {
      if (name === 'before_agent_start') handlers.push(handler);
    } });
    return handlers;
  }

  it('puts the session files back into the structured system prompt before other handlers render it', async () => {
    const files = [
      { path: '/s/CLAUDE.md', content: 'personal' },
      { path: '/s/fs/workspace/AGENTS.md', content: 'project' },
    ];
    const handlers = await loadExtension(files);
    expect(handlers).toHaveLength(1);
    const event = { systemPromptOptions: { contextFiles: [] as Array<{ path: string; content: string }> } };
    handlers[0]!(event);
    expect(event.systemPromptOptions.contextFiles).toEqual(files);
    // 已经在的不重复添加。
    handlers[0]!(event);
    expect(event.systemPromptOptions.contextFiles).toEqual(files);
  });

  it('does nothing without session files', async () => {
    expect(await loadExtension([])).toHaveLength(0);
  });
});
