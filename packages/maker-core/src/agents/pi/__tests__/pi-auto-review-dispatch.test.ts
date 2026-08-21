/**
 * pi auto 档 dispatcher + spawn 配置回归 —— mock PiRpcProcess(不 spawn 真 pi),
 * 捕获构造参数与 send() 帧,验证:
 *   1. spawn args:保留 pi 默认 prompt，不用 --tools 筛掉动态 MCP/subagent;
 *   2. spawn env:PI_OFFLINE=1(嵌入式不做启动期联网)、受管工具绝对路径、PI_CACHE_RETENTION=long、
 *      NO_PROXY 含 loopback 且吞并小写 no_proxy;
 *   3. auto 档:区内写静默 confirmed:true;灰区交当前模型 reviewer,仅 reviewer 明确
 *      ask / 本地红线才弹 resolver;reviewer 缺失时 fail-closed deny;
 *   4. ask 档:区内写照旧弹 resolver(auto 的差异只在 auto 档生效);
 *   5. 送审阅器的 model 与 Pi 当前运行模型同源:启动取 `--model`,热切换取成功的
 *      `set_model` id(都是用户选中的目录 id)。
 */

import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const captured = vi.hoisted(() => ({
  args: [] as string[],
  env: {} as Record<string, string | undefined>,
  onEvent: null as ((event: unknown) => void) | null,
  requests: [] as Array<Record<string, unknown>>,
  sent: [] as Array<Record<string, unknown>>,
  proxyRegistration: null as { sessionId: string; token: string } | null,
  mcpVendorOptions: undefined as Record<string, unknown> | undefined,
  failSetModel: false,
  rejectSetModel: false,
  failPrompt: false,
  failSteer: false,
  failNextGetState: false,
  commandCatalog: null as null | Array<Record<string, unknown>>,
  onPrompt: null as null | ((command: Record<string, unknown>) => void),
  onAfterSetModel: null as null | (() => void),
  // 卡住 set_model 的回包,让测试能在"RPC 在飞"的那一刻观察盘上的路由快照。
  holdSetModel: null as null | Promise<void>,
  closed: false,
}));

vi.mock('../transport.js', () => ({
  createPiStdioTransport: (opts: {
    args: string[];
    env: Record<string, string | undefined>;
    onProcessSpawned?: (pid: number) => void | (() => void);
  }) => {
    // spawn 参数断言移到 transport 工厂(spawn 行为在 stdio transport)。
    captured.args = opts.args;
    captured.env = opts.env;
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
    constructor(opts: {
      onEvent: (event: unknown) => void }) {
      captured.onEvent = opts.onEvent;
    }
    async request(
      cmd: Record<string, unknown> & { type: string },
    ): Promise<{ success: boolean; command?: string; data?: unknown }> {
      captured.requests.push(cmd);
      if (cmd.type === 'set_model' && captured.holdSetModel) {
        await captured.holdSetModel;
      }
      if (cmd.type === 'set_model' && captured.rejectSetModel) {
        throw new Error('pi rpc timeout after 30000ms: set_model');
      }
      if (cmd.type === 'set_model' && captured.failSetModel) {
        captured.onAfterSetModel?.();
        return { success: false };
      }
      if (cmd.type === 'prompt' && captured.failPrompt) {
        return { command: 'prompt', success: false };
      }
      if (cmd.type === 'steer' && captured.failSteer) {
        return { command: 'steer', success: false, error: 'receipt steer rejected' };
      }
      if (cmd.type === 'prompt') captured.onPrompt?.(cmd);
      if (cmd.type === 'get_commands' && captured.commandCatalog) {
        return {
          type: 'response',
          command: 'get_commands',
          success: true,
          data: { commands: captured.commandCatalog },
        } as never;
      }
      if (cmd.type === 'get_state') {
        if (captured.failNextGetState) {
          captured.failNextGetState = false;
          throw new Error('pi rpc timeout after 5000ms: get_state');
        }
        return { success: true, data: { sessionFile: '/mock/session.jsonl', model: { contextWindow: 200000 },
            isStreaming: false,
            isCompacting: false,
            pendingMessageCount: 0,
          },
        };
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

import {
  MAIN_OWNED_SEND_CONTEXT,
  PiManagedPackageMutationCancelledError,
  type TurnPermissionPolicy,
} from '../../base-agent.js';
import { PiAgent } from '../index.js';
import { Session } from '../../../session.js';
import type { AgentDeps, AgentSessionHandle } from '../../base-agent.js';
import type { Logger } from '../../../interfaces/logger.js';
import {
  AUTO_REVIEW_CONFIRM_UNDELIVERED_CODE,
  AUTO_REVIEW_UNAVAILABLE_METADATA_KEY,
  AUTO_REVIEW_UNAVAILABLE_PROMPT_TEXT,
} from '../../shared/auto-review-decision.js';
import type { InteractionDecision, InteractionRequest } from '../../../types/events.js';

type PiTestSessionHandle = AgentSessionHandle & {
  setModel: NonNullable<AgentSessionHandle['setModel']>;
};

const noopLogger: Logger = {
  trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {},
  child: () => noopLogger,
};

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('pi auto-review dispatch & spawn config (mocked pi process)', () => {
  let agentHome = '';
  let cwd = '';
  let managedRipgrepPath = '';
  let savedNoProxy: string | undefined;
  let savedNoProxyLower: string | undefined;

  beforeEach(() => {
    captured.args = [];
    captured.env = {};
    captured.onEvent = null;
    captured.requests = [];
    captured.sent = [];
    captured.proxyRegistration = null;
    captured.mcpVendorOptions = undefined;
    captured.failSetModel = false;
    captured.rejectSetModel = false;
    captured.failPrompt = false;
    captured.failSteer = false;
    captured.failNextGetState = false;
    captured.commandCatalog = null;
    captured.onPrompt = null;
    captured.onAfterSetModel = null;
    captured.holdSetModel = null;
    captured.closed = false;
    agentHome = mkdtempSync(path.join(tmpdir(), 'pi-dispatch-home-'));
    cwd = mkdtempSync(path.join(tmpdir(), 'pi-dispatch-cwd-'));
    managedRipgrepPath = path.join(
      agentHome,
      'managed-tools',
      process.platform === 'win32' ? 'rg.exe' : 'rg');
    mkdirSync(path.dirname(managedRipgrepPath), { recursive: true });
    writeFileSync(managedRipgrepPath, 'fake managed ripgrep');
    savedNoProxy = process.env.NO_PROXY;
    savedNoProxyLower = process.env.no_proxy;
  });

  afterEach(() => {
    rmSync(agentHome, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
    if (savedNoProxy === undefined) delete process.env.NO_PROXY; else process.env.NO_PROXY = savedNoProxy;
    if (savedNoProxyLower === undefined) delete process.env.no_proxy; else process.env.no_proxy = savedNoProxyLower;
  });

  interface McpSetup {
    /** 本会话「已注册」的桥接 MCP server 名(经 preparePiExtraSpawnConfig 下发)。 */
    serverNames?: string[];
    policy?: AgentDeps['getMcpToolApprovalPolicy'];
    presentation?: AgentDeps['getMcpToolApprovalPresentation'];
  }

  function buildDeps(
    reviewAutoPermissionAction?: AgentDeps['reviewAutoPermissionAction'],
    includeNextModel = false,
    mcp?: McpSetup,
  ): AgentDeps {
    return {
      ...(mcp?.policy ? { getMcpToolApprovalPolicy: mcp.policy } : {}),
      ...(mcp?.presentation
        ? { getMcpToolApprovalPresentation: mcp.presentation }
        : {}),
      ...(mcp?.serverNames
        ? {
          preparePiExtraSpawnConfig: async (_providers, context) => {
            captured.mcpVendorOptions = context?.vendorOptions;
            return {
              mcpBridge: {
                token: 'bridge-token',
                servers: mcp.serverNames!.map((name) => ({
                  name,
                  url: `http://127.0.0.1:1/${name}`,
                  })),
                },
                mcpEnv: {},
              };
            },
          }
        : {}),
      auth: {
        getState: async () => ({
          authenticated: true,
          identity: 'test',
          authSource: 'api-key' as const,
        }),
        triggerLogin: async () => ({ authenticated: true }),
        logout: async () => {},
        getAuthEnv: async () => ({}),
      },
      runtimeConfig: {
        endpoint: 'http://127.0.0.1:9',
        systemPrompt: 'You are Cindy.',
        managedExecutablePaths: { ripgrep: managedRipgrepPath },
      },
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
          ...(includeNextModel
            ? [
                {
                  id: 'm-next',
                  displayName: 'M Next',
                  contextWindow: 200_000,
                  efforts: [],
                  defaultEffort: null,
                  cost: {
                    input: 3,
                    output: 15,
                    cacheRead: 0.3,
                    cacheWrite: 3.75,
                  },
                  maxOutputTokens: 64_000,
                },
              ]
            : []),
        ],
      },
      resolvePiGatewayModelApi: () => 'openai-responses',
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
    includeNextModel = false,
    mcp?: McpSetup,
  ): Promise<PiTestSessionHandle> {
    const agent = new PiAgent(buildDeps(reviewAutoPermissionAction, includeNextModel, mcp));
    return agent.startSession({
      sessionId: 's1',
      workingDir: cwd,
      model: 'm',
      ...(permissionMode ? { permissionMode: permissionMode as never } : {}),
    }) as Promise<PiTestSessionHandle>;
  }

  /**
   * 等某个权限请求的回帧落地。用「等信号 + 有界超时」而不是固定 flush ——
   * 档位热切换会多经一次串行写入队列,靠 setTimeout(0) 的轮数猜等待就是计时型脆弱用例。
   */
  async function waitForResponse(id: string): Promise<Record<string, unknown>> {
    const deadline = Date.now() + 2_000;
    for (;;) {
      const hit = captured.sent.find((m) => m.id === id);
      if (hit) return hit;
      if (Date.now() > deadline) throw new Error(`no extension_ui_response for ${id}`);
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  function firePermissionRequest(
    id: string,
    toolName: string,
    input: Record<string, unknown>,
    options?: { resolvedCredentialPaths: unknown },
  ): void {
    captured.onEvent!({
      type: 'extension_ui_request',
      method: 'confirm',
      id,
      title: 'cindy:permission',
      message: JSON.stringify({ toolName, input, ...options }),
    });
  }

  function fireManagedPackageRequest(id: string, action: 'install' | 'update' | 'remove', source: string): void {
    captured.onEvent!({
      type: 'extension_ui_request',
      method: 'input',
      id,
      title: 'cindy:pi-package',
      placeholder: JSON.stringify({
        action,
        source,
        token: captured.env.CINDY_PI_PACKAGE_MANAGEMENT,
      }),
    });
  }

  it('spawns with a private managed rg path, default prompt and no restrictive tool allowlist', async () => {
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
    expect(captured.args).not.toContain('--tools');
    expect(captured.env.PI_OFFLINE).toBe('1');
    expect(captured.env.PI_CACHE_RETENTION).toBe('long');
    const privateRgPath = captured.env.CINDY_PI_MANAGED_RG_PATH;
    expect(privateRgPath).toBe(path.join(captured.env.PI_CODING_AGENT_DIR!, 'bin', process.platform === 'win32' ? 'rg.exe' : 'rg'));
    expect(path.isAbsolute(privateRgPath!)).toBe(true);
    expect(readFileSync(privateRgPath!, 'utf8')).toBe('fake managed ripgrep');
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
        'CINDY_PI_MANAGED_RG_PATH',
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

  it('routes chat-requested Pi extension installs into the host-managed store', async () => {
    const mutatePiManagedPackage = vi.fn(async () => ({
      changed: true,
      affectedPackage: { source: 'npm:context-mode', enabled: false },
    }));
    const deps = buildDeps();
    deps.mutatePiManagedPackage = mutatePiManagedPackage;
    const handle = await new PiAgent(deps).startSession({
      sessionId: 'managed-package-session',
      workingDir: cwd,
      model: 'm',
    });
    try {
      handle.setInteractionResolver?.(
        vi.fn(async () => ({
          kind: 'permission',
          behavior: 'allow',
        })) as never,
      );
      expect(captured.env.CINDY_PI_PACKAGE_MANAGEMENT).toMatch(/^[A-Za-z0-9_-]{40,}$/);
      fireManagedPackageRequest('pkg-1', 'install', ' npm:context-mode ');
      const response = await waitForResponse('pkg-1');
      expect(mutatePiManagedPackage).toHaveBeenCalledWith({
        action: 'install',
        source: 'npm:context-mode',
        authorization: 'confirmed-tool-call',
      });
      expect(JSON.parse(String(response.value))).toMatchObject({
        ok: true,
        result: {
          changed: true,
          affectedPackage: { source: 'npm:context-mode', enabled: false },
        },
      });
    } finally {
      await handle.close();
    }
  });

  it.each([
    ['spawn', "spawn /Users/example/private/pi ENOENT"],
    ['filesystem', "EACCES: open '/Users/example/Library/Application Support/Cindy/pi-package-home/state'"],
    ['inspection', "failed to inspect /private/tmp/secret-package/package.json"],
    ['Pi CLI', "npm ERR! raw stderr from /private/tmp/pi-package-home"],
  ])('keeps raw %s failures out of extension tool responses', async (kind, rawError) => {
    const warn = vi.fn();
    const deps = buildDeps();
    deps.logger = { ...noopLogger, warn };
    deps.getPiExtensionUiStrings = () => ({
      confirm: '确认',
      cancel: '取消',
      mutationFailed: 'Pi 扩展操作失败。',
      mutationSuccess: {
        install: 'Pi 扩展已安装。',
        update: 'Pi 扩展已更新。',
        remove: 'Pi 扩展已卸载。',
      },
    });
    deps.mutatePiManagedPackage = vi.fn(async () => {
      throw new Error(rawError);
    });
    const sessionId = `managed-package-tool-${kind.toLowerCase().replace(/\s+/g, '-')}-failure-session`;
    const handle = await new PiAgent(deps).startSession({
      sessionId,
      workingDir: cwd,
      model: 'm',
    });
    try {
      handle.setInteractionResolver?.(
        vi.fn(async () => ({
          kind: 'permission',
          behavior: 'allow',
        })) as never,
      );
      fireManagedPackageRequest(`pkg-${kind}`, 'install', 'npm:context-mode');

      const response = await waitForResponse(`pkg-${kind}`);
      expect(JSON.parse(String(response.value))).toEqual({
        ok: false,
        error: 'Pi 扩展操作失败。',
      });
      expect(String(response.value)).not.toContain(rawError);
      expect(warn).toHaveBeenCalledWith('pi extension mutation failed', {
        action: 'install',
        sessionId,
        message: rawError,
      });
    } finally {
      await handle.close();
    }
  });

  it('fails closed when managed extension confirmation is denied or the callback fails', async () => {
    const mutatePiManagedPackage = vi.fn(async () => ({ changed: true }));
    const deps = buildDeps();
    deps.mutatePiManagedPackage = mutatePiManagedPackage;
    const handle = await new PiAgent(deps).startSession({
      sessionId: 'managed-package-confirm-failure-session',
      workingDir: cwd,
      model: 'm',
      permissionMode: 'bypassPermissions',
    });
    try {
      const deny = vi.fn(async () => ({ kind: 'permission', behavior: 'deny' }) as const);
      handle.setInteractionResolver?.(deny as never);
      fireManagedPackageRequest('pkg-denied', 'install', 'npm:denied');
      expect(await waitForResponse('pkg-denied')).toMatchObject({
        cancelled: true,
      });

      const fail = vi.fn(async () => {
        throw new Error('confirmation unavailable');
      });
      handle.setInteractionResolver?.(fail as never);
      fireManagedPackageRequest('pkg-failed', 'update', 'npm:failed');
      expect(await waitForResponse('pkg-failed')).toMatchObject({
        cancelled: true,
      });

      expect(deny).toHaveBeenCalledOnce();
      expect(fail).toHaveBeenCalledOnce();
      expect(mutatePiManagedPackage).not.toHaveBeenCalled();
    } finally {
      await handle.close();
    }
  });

  it('does not turn a pending extension confirmation into approval after a permission switch', async () => {
    const mutatePiManagedPackage = vi.fn(async () => ({ changed: true }));
    const deps = buildDeps();
    deps.mutatePiManagedPackage = mutatePiManagedPackage;
    const handle = await new PiAgent(deps).startSession({
      sessionId: 'managed-package-permission-switch-session',
      workingDir: cwd,
      model: 'm',
    });
    try {
      let resolverStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        resolverStarted = resolve;
      });
      handle.setInteractionResolver?.(
        vi.fn(async () => {
          resolverStarted();
          return new Promise<never>(() => undefined);
        }) as never,
      );
      fireManagedPackageRequest('pkg-switch', 'install', 'npm:switch');
      await started;
      await handle.setPermissionMode?.('bypassPermissions');
      expect(await waitForResponse('pkg-switch')).toMatchObject({
        cancelled: true,
      });
      expect(mutatePiManagedPackage).not.toHaveBeenCalled();
    } finally {
      await handle.close();
    }
  });

  it('presents Pi extension notifications in the Cindy transcript', async () => {
    const handle = await start();
    const events: Array<Record<string, unknown>> = [];
    void (async () => {
      for await (const event of handle.events()) {
        events.push(event as unknown as Record<string, unknown>);
      }
    })();
    try {
      captured.onEvent!({
        type: 'extension_ui_request',
        id: 'context-mode-stats',
        method: 'notify',
        message: '## context-mode stats (Pi)\n\n- Events captured: 0',
        notifyType: 'info',
      });
      await flush();
      expect(events).toContainEqual({
        type: 'text',
        data: {
          text: '## context-mode stats (Pi)\n\n- Events captured: 0',
          isFinal: false,
        },
        source: 'pi',
      });
      expect(captured.sent.find((message) => message.id === 'context-mode-stats')).toBeUndefined();
    } finally {
      await handle.close();
    }
  });

  it('adapts Pi extension dialogs onto Cindy question cards', async () => {
    const deps = buildDeps();
    deps.getPiExtensionUiStrings = () => ({
      confirm: '確認',
      cancel: 'キャンセル',
      mutationFailed: '失敗しました',
      mutationSuccess: {
        install: 'インストールしました',
        update: '更新しました',
        remove: '削除しました',
      },
    });
    const handle = await new PiAgent(deps).startSession({
      sessionId: 'localized-extension-dialog-session',
      workingDir: cwd,
      model: 'm',
    });
    handle.setInteractionResolver(async (request) => {
      if (request.kind !== 'ask_user_question') {
        throw new Error(`unexpected interaction ${request.kind}`);
      }
      const question = request.questions[0]?.question ?? '';
      if (question.includes('Confirm')) {
        expect(request.questions[0]?.options).toEqual([
          { label: '確認' },
          { label: 'キャンセル' },
        ]);
      }
      const answer = question.includes('Pick')
        ? 'Beta'
        : question.includes('Confirm')
          ? '確認'
          : question.includes('Edit')
            ? 'updated\ntext'
            : 'typed value';
      return { kind: 'ask_user_question', answers: { [question]: answer } };
    });
    try {
      captured.onEvent!({
        type: 'extension_ui_request',
        id: 'select-1',
        method: 'select',
        title: 'Pick one',
        options: ['Alpha', 'Beta'],
      });
      expect(await waitForResponse('select-1')).toMatchObject({
        value: 'Beta',
      });

      captured.onEvent!({
        type: 'extension_ui_request',
        id: 'confirm-1',
        method: 'confirm',
        title: 'Confirm action',
        message: 'Proceed?',
      });
      expect(await waitForResponse('confirm-1')).toMatchObject({
        confirmed: true,
      });

      captured.onEvent!({
        type: 'extension_ui_request',
        id: 'input-1',
        method: 'input',
        title: 'Enter value',
        placeholder: 'name',
      });
      expect(await waitForResponse('input-1')).toMatchObject({
        value: 'typed value',
      });

      captured.onEvent!({
        type: 'extension_ui_request',
        id: 'editor-1',
        method: 'editor',
        title: 'Edit text',
        prefill: 'draft',
      });
      expect(await waitForResponse('editor-1')).toMatchObject({
        value: 'updated\ntext',
      });
    } finally {
      await handle.close();
    }
  });

  it('surfaces Pi UI requests that Cindy cannot safely adapt at runtime', async () => {
    const handle = await start();
    const events: Array<Record<string, unknown>> = [];
    void (async () => {
      for await (const event of handle.events()) events.push(event as unknown as Record<string, unknown>);
    })();
    try {
      captured.onEvent!({
        type: 'extension_ui_request',
        id: 'timed-select',
        method: 'select',
        title: 'Pick quickly',
        options: ['A', 'B'],
        timeout: 1_000,
      });
      expect(await waitForResponse('timed-select')).toMatchObject({
        cancelled: true,
      });
      captured.onEvent!({
        type: 'extension_ui_request',
        id: 'status-1',
        method: 'setStatus',
      });
      captured.onEvent!({
        type: 'extension_ui_request',
        id: 'status-2',
        method: 'setStatus',
      });
      await flush();
      const notices = events.filter((event) => event.type === 'text');
      expect(notices.some((event) => JSON.stringify(event).includes('timed select dialog'))).toBe(true);
      expect(notices.filter((event) => JSON.stringify(event).includes('setStatus'))).toHaveLength(1);
    } finally {
      await handle.close();
    }
  });

  it('closes a synchronous managed extension command after its visible notification', async () => {
    const packageRoot = path.join(agentHome, 'managed-context-mode');
    const extensionPath = path.join(packageRoot, 'extension.js');
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(extensionPath, '// extension');
    captured.commandCatalog = [
      {
        name: 'ctx-stats',
        description: 'Show context-mode stats',
        source: 'extension',
        sourceInfo: { path: extensionPath, source: 'extension' },
      },
    ];
    captured.onPrompt = (command) => {
      if (command.message !== '/ctx-stats') return;
      captured.onEvent!({
        type: 'extension_ui_request',
        id: 'ctx-notify',
        method: 'notify',
        message: '## context-mode stats (Pi)\n\n- Events captured: 0',
      });
    };
    const deps = buildDeps();
    deps.resolvePiManagedPackageResources = async () => ({
      extensions: [extensionPath],
      skills: [],
      promptTemplates: [],
      packageRoots: [packageRoot],
    });
    const handle = await new PiAgent(deps).startSession({
      sessionId: 'managed-extension-command-session',
      workingDir: cwd,
      model: 'm',
    });
    const events: Array<Record<string, unknown>> = [];
    let sendResolved = false;
    let terminalBeforeSendResolved = false;
    void (async () => {
      for await (const event of handle.events()) {
        if ((event.type === 'done' || event.type === 'status') && !sendResolved) {
          terminalBeforeSendResolved = true;
        }
        events.push(event as unknown as Record<string, unknown>);
      }
    })();
    try {
      const deadline = Date.now() + 2_000;
      while (handle.getRuntimeCapabilities?.()?.status !== 'loaded') {
        if (Date.now() > deadline) throw new Error('managed command catalog did not load');
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      captured.requests = [];
      await handle.send({ type: 'user', content: '/ctx-stats' });
      sendResolved = true;
      await new Promise((resolve) => setImmediate(resolve));
      await flush();
      expect(terminalBeforeSendResolved).toBe(false);
      expect(captured.requests.some((request) => request.type === 'get_state')).toBe(true);
      expect(events).toContainEqual({
        type: 'done',
        data: expect.objectContaining({
          type: 'pi/extension_command',
          result: expect.stringContaining('context-mode stats'),
        }),
        source: 'pi',
      });
      expect(events).toContainEqual({
        type: 'status',
        data: expect.objectContaining({ status: 'Done', isRunning: false }),
        source: 'pi',
      });
    } finally {
      await handle.close();
    }
  });

  it('rewrites context-mode doctor notify paths to the managed package root', async () => {
    const packageRoot = path.join(agentHome, 'managed-context-mode');
    const extensionPath = path.join(packageRoot, 'extension.js');
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(extensionPath, '// extension');
    writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: 'context-mode' }));
    captured.commandCatalog = [
      {
        name: 'ctx-doctor',
        description: 'Run context-mode diagnostics',
        source: 'extension',
        sourceInfo: { path: extensionPath, source: 'extension' },
      },
    ];
    captured.onPrompt = (command) => {
      if (command.message !== '/ctx-doctor') return;
      captured.onEvent!({
        type: 'extension_ui_request',
        id: 'other-ext-notify',
        method: 'notify',
        notifyType: 'warning',
        message: 'other-ext: (~/.pi/extensions/context-mode/), not via JSON-stdio.',
      });
      captured.onEvent!({
        type: 'extension_ui_request',
        id: 'ctx-doctor-notify',
        method: 'notify',
        notifyType: 'info',
        message: [
          'context-mode doctor',
          '',
          '[OK] Hook support: Pi hooks are wired via the context-mode Pi extension (~/.pi/extensions/context-mode/), not via JSON-stdio.',
        ].join('\n'),
      });
    };
    const deps = buildDeps();
    deps.resolvePiManagedPackageResources = async () => ({
      extensions: [extensionPath],
      skills: [],
      promptTemplates: [],
      packageRoots: [packageRoot],
    });
    const handle = await new PiAgent(deps).startSession({
      sessionId: 'managed-doctor-path-session',
      workingDir: cwd,
      model: 'm',
    });
    const events: Array<Record<string, unknown>> = [];
    void (async () => {
      for await (const event of handle.events()) {
        events.push(event as unknown as Record<string, unknown>);
      }
    })();
    try {
      const deadline = Date.now() + 2_000;
      while (handle.getRuntimeCapabilities?.()?.status !== 'loaded') {
        if (Date.now() > deadline) throw new Error('managed command catalog did not load');
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await handle.send({ type: 'user', content: '/ctx-doctor' });
      await new Promise((resolve) => setImmediate(resolve));
      await flush();
      const texts = events
        .filter((event) => event.type === 'text')
        .map((event) => (event.data as { text?: string }).text ?? '');
      expect(texts.some((text) => text.includes('other-ext') && text.includes('~/.pi/extensions/context-mode'))).toBe(true);
      expect(texts.some((text) => text.includes('Hook support') && text.includes(packageRoot))).toBe(true);
      expect(texts.some((text) => text.includes('Hook support') && text.includes('~/.pi/extensions/context-mode'))).toBe(false);
    } finally {
      await handle.close();
    }
  });

  it('leaves non-doctor extension notify text containing the stale path unchanged', async () => {
    const packageRoot = path.join(agentHome, 'managed-context-mode');
    const extensionPath = path.join(packageRoot, 'extension.js');
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(extensionPath, '// extension');
    writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: 'context-mode' }));
    captured.commandCatalog = [
      {
        name: 'ctx-stats',
        description: 'Show context-mode stats',
        source: 'extension',
        sourceInfo: { path: extensionPath, source: 'extension' },
      },
    ];
    const stale = '[OK] Hook support: (~/.pi/extensions/context-mode/), not via JSON-stdio.';
    captured.onPrompt = (command) => {
      if (command.message !== '/ctx-stats') return;
      captured.onEvent!({
        type: 'extension_ui_request',
        id: 'ctx-stats-notify',
        method: 'notify',
        message: stale,
      });
    };
    const deps = buildDeps();
    deps.resolvePiManagedPackageResources = async () => ({
      extensions: [extensionPath],
      skills: [],
      promptTemplates: [],
      packageRoots: [packageRoot],
    });
    const handle = await new PiAgent(deps).startSession({
      sessionId: 'managed-stats-path-unchanged-session',
      workingDir: cwd,
      model: 'm',
    });
    const events: Array<Record<string, unknown>> = [];
    void (async () => {
      for await (const event of handle.events()) {
        events.push(event as unknown as Record<string, unknown>);
      }
    })();
    try {
      const deadline = Date.now() + 2_000;
      while (handle.getRuntimeCapabilities?.()?.status !== 'loaded') {
        if (Date.now() > deadline) throw new Error('managed command catalog did not load');
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await handle.send({ type: 'user', content: '/ctx-stats' });
      await new Promise((resolve) => setImmediate(resolve));
      await flush();
      const texts = events
        .filter((event) => event.type === 'text')
        .map((event) => (event.data as { text?: string }).text ?? '');
      expect(texts).toContain(stale);
      expect(texts.some((text) => text.includes(packageRoot) && text.includes('Hook support'))).toBe(false);
    } finally {
      await handle.close();
    }
  });

  it('keeps an accepted extension command alive when the idle-state probe fails', async () => {
    const packageRoot = path.join(agentHome, 'managed-context-mode-probe-failure');
    const extensionPath = path.join(packageRoot, 'extension.js');
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(extensionPath, '// extension');
    captured.commandCatalog = [
      {
        name: 'ctx-stats',
        description: 'Show context-mode stats',
        source: 'extension',
        sourceInfo: { path: extensionPath, source: 'extension' },
      },
    ];
    const deps = buildDeps();
    deps.resolvePiManagedPackageResources = async () => ({
      extensions: [extensionPath],
      skills: [],
      promptTemplates: [],
      packageRoots: [packageRoot],
    });
    const handle = await new PiAgent(deps).startSession({
      sessionId: 'managed-extension-command-probe-failure-session',
      workingDir: cwd,
      model: 'm',
    });
    const events: Array<Record<string, unknown>> = [];
    void (async () => {
      for await (const event of handle.events()) events.push(event as unknown as Record<string, unknown>);
    })();
    try {
      const deadline = Date.now() + 2_000;
      while (handle.getRuntimeCapabilities?.()?.status !== 'loaded') {
        if (Date.now() > deadline) throw new Error('managed command catalog did not load');
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      captured.failNextGetState = true;
      await expect(handle.send({ type: 'user', content: '/ctx-stats' })).resolves.toBeUndefined();
      await new Promise((resolve) => setImmediate(resolve));
      expect(events.some((event) => event.type === 'done')).toBe(false);
      expect(events.some((event) => event.type === 'status' && (event.data as { isRunning?: boolean })?.isRunning === false)).toBe(false);
    } finally {
      await handle.close();
    }
  });

  it('routes a managed extension slash command through prompt while a turn is running', async () => {
    const packageRoot = path.join(agentHome, 'managed-context-mode-running');
    const extensionPath = path.join(packageRoot, 'extension.js');
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(extensionPath, '// extension');
    captured.commandCatalog = [
      {
        name: 'ctx-stats',
        description: 'Show context-mode stats',
        source: 'extension',
        sourceInfo: { path: extensionPath, source: 'extension' },
      },
    ];
    const deps = buildDeps();
    deps.resolvePiManagedPackageResources = async () => ({
      extensions: [extensionPath],
      skills: [],
      promptTemplates: [],
      packageRoots: [packageRoot],
    });
    const handle = await new PiAgent(deps).startSession({
      sessionId: 'managed-extension-command-steer-session',
      workingDir: cwd,
      model: 'm',
    });
    try {
      const deadline = Date.now() + 2_000;
      while (handle.getRuntimeCapabilities?.()?.status !== 'loaded') {
        if (Date.now() > deadline) throw new Error('managed command catalog did not load');
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      captured.requests = [];
      await handle.steer({ type: 'user', content: '/ctx-stats' });
      expect(captured.requests).toContainEqual({
        type: 'prompt',
        message: '/ctx-stats',
      });
      expect(captured.requests.some((request) => request.type === 'steer')).toBe(false);
    } finally {
      await handle.close();
    }
  });

  it('rejects forged Pi extension mutation UI requests without the bridge capability', async () => {
    const mutatePiManagedPackage = vi.fn(async () => ({ changed: true }));
    const deps = buildDeps();
    deps.mutatePiManagedPackage = mutatePiManagedPackage;
    const handle = await new PiAgent(deps).startSession({
      sessionId: 'managed-package-forgery-session',
      workingDir: cwd,
      model: 'm',
    });
    try {
      captured.onEvent!({
        type: 'extension_ui_request',
        method: 'input',
        id: 'pkg-forged',
        title: 'cindy:pi-package',
        placeholder: JSON.stringify({
          action: 'install',
          source: 'npm:context-mode',
          token: 'forged-token',
        }),
      });
      expect(await waitForResponse('pkg-forged')).toEqual({
        type: 'extension_ui_response',
        id: 'pkg-forged',
        value: JSON.stringify({
          ok: false,
          error: 'Invalid Cindy Pi extension request.',
        }),
      });
      expect(mutatePiManagedPackage).not.toHaveBeenCalled();
    } finally {
      await handle.close();
    }
  });

  it('deterministically handles an exact pi install user command before prompting the model', async () => {
    const mutatePiManagedPackage = vi.fn(async () => ({
      changed: true,
      affectedPackage: {
        source: 'npm:context-mode',
        name: 'context-mode',
        version: '1.0.169',
        enabled: false,
        requiresExtensionApproval: true,
        resources: [
          {
            kind: 'extension',
            name: 'extension.js',
            compatibility: 'partial',
            compatibilityIssues: ['status-display'],
          },
        ],
      },
    }));
    const deps = buildDeps();
    deps.mutatePiManagedPackage = mutatePiManagedPackage;
    const handle = await new PiAgent(deps).startSession({
      sessionId: 'managed-package-command-session',
      workingDir: cwd,
      model: 'm',
    });
    try {
      captured.requests = [];
      await handle.send({
        type: 'user',
        content: 'pi install npm:context-mode',
      });
      expect(mutatePiManagedPackage).toHaveBeenCalledWith({
        action: 'install',
        source: 'npm:context-mode',
        authorization: 'local-desktop-command',
      });
      const prompt = captured.requests.find((request) => request.type === 'prompt');
      expect(prompt?.message).toContain('[Cindy internal Pi extension operation receipt]');
      expect(prompt?.message).toContain('"compatibility":"partial"');
      expect(prompt?.message).toContain('"status-display"');
      expect(prompt?.message).toContain('Do not run bash');
    } finally {
      await handle.close();
    }
  });

  it('keeps host-resolved local paths out of deterministic IM and model receipts', async () => {
    const resolvedSource = path.join(cwd, 'extension');
    const mutatePiManagedPackage = vi.fn(async () => ({
      changed: true,
      affectedPackage: {
        source: resolvedSource,
        name: resolvedSource,
        enabled: false,
      },
    }));
    const deps = buildDeps();
    deps.mutatePiManagedPackage = mutatePiManagedPackage;
    const handle = await new PiAgent(deps).startSession({
      sessionId: 'managed-package-relative-im-receipt-session',
      workingDir: cwd,
      model: 'm',
    });
    const imPolicy: TurnPermissionPolicy = {
      origin: { kind: 'im', channel: 'telegram', taskId: 'message-relative' },
      confirmationSurface: 'channel',
      forceConfirmToolCall: () => false,
    };
    try {
      captured.requests = [];
      await handle.send({ type: 'user', content: 'decorated channel text' }, {
        [MAIN_OWNED_SEND_CONTEXT]: {
          origin: imPolicy.origin,
          rawChannelText: 'pi install ./extension',
        },
        turnPermissionPolicy: imPolicy,
      });

      expect(mutatePiManagedPackage).toHaveBeenCalledWith({
        action: 'install',
        source: resolvedSource,
        authorization: 'authenticated-im-command',
      });
      const prompt = String(
        captured.requests.find((request) => request.type === 'prompt')?.message ?? '',
      );
      expect(prompt).toContain('Requested source: "./extension"');
      expect(prompt).toContain('"source":"./extension"');
      expect(prompt).not.toContain(resolvedSource);

      const events = handle.events()[Symbol.asyncIterator]();
      let visibleReceipt = '';
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const event = await events.next();
        if (event.done) break;
        if (event.value.type === 'text' && event.value.data.text.includes('"name":"extension"')) {
          visibleReceipt = event.value.data.text;
          break;
        }
      }
      expect(visibleReceipt).toContain('"source":"./extension"');
      expect(visibleReceipt).toContain('"name":"extension"');
      expect(visibleReceipt).not.toContain(resolvedSource);
    } finally {
      await handle.close();
    }
  });

  it('keeps resolved local paths out of failed IM receipts and local diagnostics only', async () => {
    const resolvedSource = path.join(cwd, 'private-extension');
    const rawError = `EACCES inspecting ${resolvedSource}/package.json`;
    const warn = vi.fn();
    const deps = buildDeps();
    deps.logger = { ...noopLogger, warn };
    deps.getPiExtensionUiStrings = () => ({
      confirm: '确认',
      cancel: '取消',
      mutationFailed: 'Pi 扩展操作失败。',
      mutationSuccess: {
        install: 'Pi 扩展已安装。',
        update: 'Pi 扩展已更新。',
        remove: 'Pi 扩展已卸载。',
      },
    });
    deps.mutatePiManagedPackage = vi.fn(async () => {
      throw new Error(rawError);
    });
    const handle = await new PiAgent(deps).startSession({
      sessionId: 'managed-package-relative-im-failure-session',
      workingDir: cwd,
      model: 'm',
    });
    const imPolicy: TurnPermissionPolicy = {
      origin: { kind: 'im', channel: 'telegram', taskId: 'message-relative-failure' },
      confirmationSurface: 'channel',
      forceConfirmToolCall: () => false,
    };
    try {
      captured.requests = [];
      await handle.send({ type: 'user', content: 'decorated channel text' }, {
        [MAIN_OWNED_SEND_CONTEXT]: {
          origin: imPolicy.origin,
          rawChannelText: 'pi install ./private-extension',
        },
        turnPermissionPolicy: imPolicy,
      });

      const prompt = String(
        captured.requests.find((request) => request.type === 'prompt')?.message ?? '',
      );
      expect(prompt).toContain('Requested source: "./private-extension"');
      expect(prompt).toContain('Pi 扩展操作失败。');
      expect(prompt).not.toContain(resolvedSource);
      expect(prompt).not.toContain(rawError);

      const events = handle.events()[Symbol.asyncIterator]();
      let visibleReceipt = '';
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const event = await events.next();
        if (event.done) break;
        if (event.value.type === 'text' && event.value.data.text.includes('Pi 扩展操作失败。')) {
          visibleReceipt = event.value.data.text;
          break;
        }
      }
      expect(visibleReceipt).not.toContain(resolvedSource);
      expect(visibleReceipt).not.toContain(rawError);
      expect(warn).toHaveBeenCalledWith('exact Pi extension command failed', {
        action: 'install',
        message: rawError,
      });
    } finally {
      await handle.close();
    }
  });

  it('trusts only a Main-owned authenticated IM policy for exact package commands', async () => {
    const mutatePiManagedPackage = vi.fn(async () => ({ changed: true }));
    const deps = buildDeps();
    deps.mutatePiManagedPackage = mutatePiManagedPackage;
    const handle = await new PiAgent(deps).startSession({
      sessionId: 'managed-package-authenticated-im-session',
      workingDir: cwd,
      model: 'm',
    });
    const imPolicy: TurnPermissionPolicy = {
      origin: { kind: 'im', channel: 'telegram', taskId: 'message-1' },
      confirmationSurface: 'channel',
      forceConfirmToolCall: () => false,
    };
    try {
      await handle.send({
        type: 'user',
        content: 'persona and reply context\n\npi update npm:context-mode\n\nchannel note',
      }, {
        [MAIN_OWNED_SEND_CONTEXT]: {
          origin: imPolicy.origin,
          rawChannelText: 'pi update npm:context-mode',
        },
        turnPermissionPolicy: imPolicy,
      });
      expect(mutatePiManagedPackage).toHaveBeenLastCalledWith({
        action: 'update',
        source: 'npm:context-mode',
        authorization: 'authenticated-im-command',
      });

      const callsBeforeAdditionalContent = mutatePiManagedPackage.mock.calls.length;
      captured.requests = [];
      await handle.send({
        type: 'user',
        content: [
          { type: 'text', text: 'pi install npm:context-mode' },
          { type: 'file', path: '/tmp/pi-extension-notes.txt' },
        ],
      }, {
        [MAIN_OWNED_SEND_CONTEXT]: {
          origin: imPolicy.origin,
          rawChannelText: 'pi install npm:context-mode',
        },
        turnPermissionPolicy: imPolicy,
      });
      expect(mutatePiManagedPackage).toHaveBeenCalledTimes(callsBeforeAdditionalContent);
      expect(captured.requests.find((request) => request.type === 'prompt')?.message)
        .toContain('Attached file (read-only reference): `/tmp/pi-extension-notes.txt`');

      captured.requests = [];
      await handle.steer({
        type: 'user',
        content: [
          { type: 'text', text: 'pi remove npm:context-mode' },
          { type: 'mention', name: 'notes', path: '/tmp/pi-extension-notes', kind: 'dir' },
        ],
      }, {
        [MAIN_OWNED_SEND_CONTEXT]: {
          origin: imPolicy.origin,
          rawChannelText: 'pi remove npm:context-mode',
        },
        turnPermissionPolicy: imPolicy,
      });
      expect(mutatePiManagedPackage).toHaveBeenCalledTimes(callsBeforeAdditionalContent);
      expect(captured.requests.find((request) => request.type === 'steer')?.message)
        .toContain('`/tmp/pi-extension-notes`');

      await handle.send({
        type: 'user',
        content: 'pi install npm:forged-policy',
      }, {
        turnPermissionPolicy: {
          origin: { kind: 'im', channel: 'telegram' },
          confirmationSurface: 'channel',
        } as never,
      });
      expect(mutatePiManagedPackage).toHaveBeenLastCalledWith({
        action: 'install',
        source: 'npm:forged-policy',
        authorization: 'local-desktop-command',
      });

      await handle.send({
        type: 'user',
        content: 'pi remove npm:context-mode',
      }, { origin: { kind: 'im' } as never });
      expect(mutatePiManagedPackage).toHaveBeenLastCalledWith({
        action: 'remove',
        source: 'npm:context-mode',
        authorization: 'local-desktop-command',
      });

      await handle.steer({
        type: 'user',
        content: 'pi update npm:context-mode',
      });
      expect(mutatePiManagedPackage).toHaveBeenLastCalledWith({
        action: 'update',
        source: 'npm:context-mode',
        authorization: 'local-desktop-command',
      });

      await handle.steer({
        type: 'user',
        content: 'speaker and group history\n\npi install npm:context-mode\n\nplan reconciliation',
      }, {
        [MAIN_OWNED_SEND_CONTEXT]: {
          origin: imPolicy.origin,
          rawChannelText: 'pi install npm:context-mode',
        },
        turnPermissionPolicy: imPolicy,
      });
      expect(mutatePiManagedPackage).toHaveBeenLastCalledWith({
        action: 'install',
        source: 'npm:context-mode',
        authorization: 'authenticated-im-command',
      });

      const callsBeforeNonExactRawText = mutatePiManagedPackage.mock.calls.length;
      await handle.send({
        type: 'user',
        content: 'pi install npm:decorated-only\n\nchannel note',
      }, {
        [MAIN_OWNED_SEND_CONTEXT]: {
          origin: imPolicy.origin,
          rawChannelText: '/please pi install npm:decorated-only',
        },
        turnPermissionPolicy: imPolicy,
      });
      expect(mutatePiManagedPackage).toHaveBeenCalledTimes(callsBeforeNonExactRawText);

      await handle.send({
        type: 'user',
        content: 'ordinary decorated text',
      }, {
        [MAIN_OWNED_SEND_CONTEXT]: {
          origin: { kind: 'desktop' },
          rawChannelText: 'pi remove npm:context-mode',
        },
      });
      expect(mutatePiManagedPackage).toHaveBeenCalledTimes(callsBeforeNonExactRawText);

      await handle.send({
        type: 'user',
        content: 'official hook note\n\npi remove npm:context-mode',
      }, {
        [MAIN_OWNED_SEND_CONTEXT]: {
          origin: { kind: 'hook', source: 'x' },
          rawChannelText: 'pi remove npm:context-mode',
        },
      });
      expect(mutatePiManagedPackage).toHaveBeenLastCalledWith({
        action: 'remove',
        source: 'npm:context-mode',
        authorization: 'local-desktop-command',
      });
    } finally {
      await handle.close();
    }
  });

  it('renders Main-owned package confirmation cancellation without logging it as a backend failure', async () => {
    const warn = vi.fn();
    const deps = buildDeps();
    deps.logger = { ...noopLogger, warn };
    deps.getPiExtensionUiStrings = () => ({
      confirm: '确认',
      cancel: '已取消。',
      mutationFailed: 'Pi 扩展操作失败。',
      mutationSuccess: {
        install: 'Pi 扩展已安装。',
        update: 'Pi 扩展已更新。',
        remove: 'Pi 扩展已卸载。',
      },
    });
    deps.mutatePiManagedPackage = vi.fn(async () => {
      throw new PiManagedPackageMutationCancelledError();
    });
    const handle = await new PiAgent(deps).startSession({
      sessionId: 'managed-package-cancelled-session',
      workingDir: cwd,
      model: 'm',
    });
    try {
      captured.requests = [];
      await handle.send({ type: 'user', content: 'pi install npm:context-mode' });
      const prompt = String(
        captured.requests.find((request) => request.type === 'prompt')?.message ?? '',
      );
      expect(prompt).toContain('"cancelled":true');
      expect(prompt).toContain('"error":"已取消。"');
      expect(warn).not.toHaveBeenCalled();
    } finally {
      await handle.close();
    }
  });

  it.each([
    ['spawn', "spawn /Users/chris/private/pi ENOENT"],
    ['filesystem', "EACCES: open '/Users/chris/Library/Application Support/Cindy/pi-package-home/state'"],
    ['inspection', "failed to inspect /private/tmp/secret-package/package.json"],
    ['Pi CLI', "npm ERR! raw stderr from /private/tmp/pi-package-home"],
  ])('keeps raw %s failures out of deterministic conversation receipts', async (kind, rawError) => {
    const warn = vi.fn();
    const deps = buildDeps();
    deps.logger = { ...noopLogger, warn };
    deps.getPiExtensionUiStrings = () => ({
      confirm: '确认',
      cancel: '取消',
      mutationFailed: 'Pi 扩展操作失败。',
      mutationSuccess: {
        install: 'Pi 扩展已安装。',
        update: 'Pi 扩展已更新。',
        remove: 'Pi 扩展已卸载。',
      },
    });
    deps.mutatePiManagedPackage = vi.fn(async () => {
      throw new Error(rawError);
    });
    const handle = await new PiAgent(deps).startSession({
      sessionId: `managed-package-${kind}-failure-session`,
      workingDir: cwd,
      model: 'm',
    });
    try {
      captured.requests = [];
      await handle.send({
        type: 'user',
        content: 'pi install npm:context-mode',
      });

      const prompt = String(
        captured.requests.find((request) => request.type === 'prompt')?.message ?? '',
      );
      expect(prompt).toContain('Pi 扩展操作失败。');
      expect(prompt).not.toContain(rawError);

      const events = handle.events()[Symbol.asyncIterator]();
      let visibleReceipt = '';
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const event = await events.next();
        if (event.done) break;
        if (event.value.type === 'text' && event.value.data.text.includes('Pi 扩展操作失败。')) {
          visibleReceipt = event.value.data.text;
          break;
        }
      }
      expect(visibleReceipt).toContain('Pi 扩展操作失败。');
      expect(visibleReceipt).not.toContain(rawError);
      expect(warn).toHaveBeenCalledWith('exact Pi extension command failed', {
        action: 'install',
        message: rawError,
      });
    } finally {
      await handle.close();
    }
  });

  it('keeps a completed mutation accepted when the following model receipt prompt fails', async () => {
    const mutatePiManagedPackage = vi.fn(async () => ({
      changed: true,
      affectedPackage: {
        source: 'npm:context-mode',
        name: 'context-mode',
        version: '1.0.169',
        enabled: false,
        requiresExtensionApproval: true,
      },
    }));
    const deps = buildDeps();
    deps.mutatePiManagedPackage = mutatePiManagedPackage;
    deps.getPiExtensionUiStrings = () => ({
      confirm: '确认',
      cancel: '取消',
      mutationFailed: 'Pi 扩展操作失败。',
      mutationSuccess: {
        install: 'Pi 扩展已安装；重启任务后生效。',
        update: 'Pi 扩展已更新；重启任务后生效。',
        remove: 'Pi 扩展已卸载。',
      },
    });
    const agent = new PiAgent(deps);
    const handle = await agent.startSession({
      sessionId: 'managed-package-durable-receipt-session',
      workingDir: cwd,
      model: 'm',
    });
    const session = new Session({
      id: 'managed-package-durable-receipt-session',
      agentKind: 'pi',
      workDir: cwd,
      handle,
      capabilities: agent.capabilities,
      logger: noopLogger,
    });
    const sessionEvents: unknown[] = [];
    let resolveTerminal!: () => void;
    const terminal = new Promise<void>((resolve) => {
      resolveTerminal = resolve;
    });
    const unsubscribe = session.onEvent((event) => {
      sessionEvents.push(event);
      if (event.type === 'done') resolveTerminal();
    });
    try {
      captured.failPrompt = true;
      await expect(session.send({
        type: 'user',
        content: 'pi install npm:context-mode',
      })).resolves.toEqual({ accepted: true });
      await terminal;

      expect(sessionEvents).toContainEqual(expect.objectContaining({
        type: 'text',
        data: {
          text: expect.stringContaining('Pi 扩展已安装；重启任务后生效。'),
          isFinal: false,
        },
        source: 'pi',
      }));
      expect(sessionEvents).toContainEqual(expect.objectContaining({
        type: 'text',
        data: expect.objectContaining({
          text: expect.stringContaining('"requiresExtensionApproval":true'),
        }),
      }));
      expect(sessionEvents).toContainEqual(expect.objectContaining({
        type: 'done',
        data: expect.objectContaining({
          type: 'pi/managed_package_receipt',
          result: '',
        }),
        source: 'pi',
      }));
      expect(captured.requests.filter((request) => request.type === 'prompt')).toHaveLength(1);
      expect(mutatePiManagedPackage).toHaveBeenCalledTimes(1);
    } finally {
      captured.failPrompt = false;
      unsubscribe();
      await session.close();
    }
  });

  it('keeps a completed steer mutation accepted when receipt delivery fails', async () => {
    const mutatePiManagedPackage = vi.fn(async () => ({
      changed: true,
      affectedPackage: {
        source: 'npm:context-mode',
        name: 'context-mode',
        version: '1.0.169',
        enabled: false,
        requiresExtensionApproval: true,
      },
    }));
    const warn = vi.fn();
    const deps = buildDeps();
    deps.logger = { ...noopLogger, warn };
    deps.mutatePiManagedPackage = mutatePiManagedPackage;
    deps.getPiExtensionUiStrings = () => ({
      confirm: '确认',
      cancel: '取消',
      mutationFailed: 'Pi 扩展操作失败。',
      mutationSuccess: {
        install: 'Pi 扩展已安装；重启任务后生效。',
        update: 'Pi 扩展已更新；重启任务后生效。',
        remove: 'Pi 扩展已卸载。',
      },
    });
    const handle = await new PiAgent(deps).startSession({
      sessionId: 'managed-package-durable-steer-receipt-session',
      workingDir: cwd,
      model: 'm',
    });
    const events = handle.events()[Symbol.asyncIterator]();
    try {
      captured.failSteer = true;
      await expect(handle.steer({
        type: 'user',
        content: 'pi install npm:context-mode',
      })).resolves.toBeUndefined();

      let visibleReceipt = '';
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const event = await events.next();
        if (event.done) break;
        if (event.value.type === 'text' && event.value.data.text.includes('Pi 扩展已安装')) {
          visibleReceipt = event.value.data.text;
          break;
        }
      }
      expect(visibleReceipt).toContain('Pi 扩展已安装；重启任务后生效。');
      expect(captured.requests.filter((request) => request.type === 'steer')).toHaveLength(1);
      expect(mutatePiManagedPackage).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        'pi managed package receipt steer rejected after mutation',
        { message: 'receipt steer rejected' },
      );
    } finally {
      captured.failSteer = false;
      await handle.close();
    }
  });

  it('resolves task-relative Pi extension sources against the task working directory', async () => {
    const mutatePiManagedPackage = vi.fn(async (input: { source: string }) => ({
      changed: true,
      affectedPackage: { source: input.source },
    }));
    const deps = buildDeps();
    deps.mutatePiManagedPackage = mutatePiManagedPackage;
    const handle = await new PiAgent(deps).startSession({
      sessionId: 'managed-package-relative-source-session',
      workingDir: cwd,
      model: 'm',
    });
    try {
      await handle.send({
        type: 'user',
        content: "pi install './extensions/context-mode'",
      });
      expect(mutatePiManagedPackage).toHaveBeenCalledWith({
        action: 'install',
        source: path.resolve(cwd, './extensions/context-mode'),
        authorization: 'local-desktop-command',
      });

      await handle.send({
        type: 'user',
        content: 'pi install file:./extensions/file-context-mode',
      });
      expect(mutatePiManagedPackage).toHaveBeenLastCalledWith({
        action: 'install',
        source: path.resolve(cwd, './extensions/file-context-mode'),
        authorization: 'local-desktop-command',
      });

      handle.setInteractionResolver?.(
        vi.fn(async () => ({
          kind: 'permission',
          behavior: 'allow',
        })) as never,
      );
      fireManagedPackageRequest('pkg-relative', 'update', '../shared/pi-extension');
      const response = await waitForResponse('pkg-relative');
      expect(mutatePiManagedPackage).toHaveBeenLastCalledWith({
        action: 'update',
        source: path.resolve(cwd, '../shared/pi-extension'),
        authorization: 'confirmed-tool-call',
      });
      expect(response.value).toBeDefined();
      const receipt = String(response.value);
      expect(receipt).toContain('"source":"../shared/pi-extension"');
      expect(receipt).not.toContain(path.resolve(cwd, '../shared/pi-extension'));
    } finally {
      await handle.close();
    }
  });

  it('resolves a Windows drive-relative Pi extension source against a same-drive task directory', async () => {
    const mutatePiManagedPackage = vi.fn(async () => ({ changed: true }));
    const deps = buildDeps();
    deps.mutatePiManagedPackage = mutatePiManagedPackage;
    const workingDir = 'C:\\repo\\app';
    const handle = await new PiAgent(deps).startSession({
      sessionId: 'managed-package-windows-relative-source-session',
      workingDir,
      model: 'm',
    });
    try {
      await handle.send({
        type: 'user',
        content: 'pi install C:extensions\\context-mode',
      });
      expect(mutatePiManagedPackage).toHaveBeenCalledWith({
        action: 'install',
        source: path.win32.resolve(workingDir, 'C:extensions\\context-mode'),
        authorization: 'local-desktop-command',
      });
    } finally {
      await handle.close();
    }
  });

  it('keeps a managed install visible when cancellation races after mutation acceptance', async () => {
    let releaseMutation: (() => void) | undefined;
    const mutationStarted = new Promise<void>((resolve) => {
      releaseMutation = resolve;
    });
    let finishMutation: (() => void) | undefined;
    const mutationFinished = new Promise<void>((resolve) => {
      finishMutation = resolve;
    });
    const mutatePiManagedPackage = vi.fn(async () => {
      releaseMutation?.();
      await mutationFinished;
      return { changed: true, affectedPackage: { source: 'npm:context-mode' } };
    });
    const deps = buildDeps();
    deps.mutatePiManagedPackage = mutatePiManagedPackage;
    const handle = await new PiAgent(deps).startSession({
      sessionId: 'managed-package-cancel-race-session',
      workingDir: cwd,
      model: 'm',
    });
    try {
      captured.requests = [];
      const controller = new AbortController();
      const sending = handle.send({ type: 'user', content: 'pi install npm:context-mode' }, { signal: controller.signal });
      await mutationStarted;
      controller.abort();
      finishMutation?.();
      await expect(sending).resolves.toBeUndefined();
      expect(captured.requests.find((request) => request.type === 'prompt')?.message).toContain(
        '[Cindy internal Pi extension operation receipt]',
      );
    } finally {
      await handle.close();
    }
  });

  it('bounds oversized Pi extension receipts while preserving package identity and counts', async () => {
    const resources = Array.from({ length: 200 }, (_, index) => ({
      kind: 'extension',
      name: `extension-${index}-${'x'.repeat(500)}`,
      compatibility: 'partial',
      compatibilityIssues: Array.from({ length: 32 }, () => 'y'.repeat(64)),
      detectedApis: Array.from({ length: 32 }, () => 'z'.repeat(64)),
    }));
    const mutatePiManagedPackage = vi.fn(async () => ({
      changed: true,
      affectedPackage: {
        source: 'npm:oversized-extension',
        name: 'oversized-extension',
        version: '9.8.7',
        enabled: false,
        requiresExtensionApproval: true,
        resources,
      },
    }));
    const deps = buildDeps();
    deps.mutatePiManagedPackage = mutatePiManagedPackage;
    const handle = await new PiAgent(deps).startSession({
      sessionId: 'managed-package-large-receipt-session',
      workingDir: cwd,
      model: 'm',
    });
    try {
      captured.requests = [];
      await handle.send({
        type: 'user',
        content: 'pi install npm:oversized-extension',
      });
      const prompt = captured.requests.find((request) => request.type === 'prompt')?.message ?? '';
      expect(prompt.length).toBeLessThanOrEqual(16_384);
      expect(prompt).toContain('"name":"oversized-extension"');
      expect(prompt).toContain('"version":"9.8.7"');
      expect(prompt).toContain('"enabled":false');
      expect(prompt).toContain('"resourceCount":200');
      expect(prompt).toContain('"outputTruncated":true');
      expect(prompt).toContain('"detailsOmitted":"receipt-size-limit"');

      handle.setInteractionResolver?.(
        vi.fn(async () => ({
          kind: 'permission',
          behavior: 'allow',
        })) as never,
      );
      fireManagedPackageRequest('pkg-large', 'install', 'npm:oversized-extension');
      const response = await waitForResponse('pkg-large');
      const parsed = JSON.parse(String(response.value));
      expect(String(response.value).length).toBeLessThanOrEqual(16_384);
      expect(parsed.result).toMatchObject({
        changed: true,
        outputTruncated: true,
        affectedPackage: {
          name: 'oversized-extension',
          version: '9.8.7',
          enabled: false,
          resourceCount: 200,
          detailsOmitted: 'receipt-size-limit',
        },
      });
    } finally {
      await handle.close();
    }
  });

  it('leaves natural-language Pi extension requests for the dedicated model tool', async () => {
    const mutatePiManagedPackage = vi.fn(async () => ({ changed: true }));
    const deps = buildDeps();
    deps.mutatePiManagedPackage = mutatePiManagedPackage;
    const handle = await new PiAgent(deps).startSession({
      sessionId: 'managed-package-natural-language-session',
      workingDir: cwd,
      model: 'm',
    });
    try {
      captured.requests = [];
      await handle.send({
        type: 'user',
        content: '请帮我安装 context-mode 这个 Pi 扩展',
      });
      expect(mutatePiManagedPackage).not.toHaveBeenCalled();
      expect(captured.requests.find((request) => request.type === 'prompt')?.message).toBe('请帮我安装 context-mode 这个 Pi 扩展');
    } finally {
      await handle.close();
    }
  });

  it('locks Review sessions to the local read-only tool surface without memory, MCP, or subagents', async () => {
    const deps = buildDeps(undefined, false, {
      serverNames: ['cindy_memory', 'cindy_helper'],
    });
    deps.mutatePiManagedPackage = vi.fn(async () => ({ changed: true }));
    deps.getGhostRosterPrompt = vi.fn(() => 'PRIVATE ROSTER');
    deps.resolvePiProjectTrustInput = vi.fn(async () => {
      throw new Error('Review must not consult project approval resources');
    });
    const explicitArtifact = path.join(agentHome, 'explicit-artifact.txt');
    const dotenvPath = path.join(cwd, '.env.local');
    writeFileSync(explicitArtifact, 'review me');
    writeFileSync(dotenvPath, 'TOKEN=secret');
    const handle = await new PiAgent(deps).startSession({
      sessionId: 'review-session',
      workingDir: cwd,
      model: 'm',
      permissionMode: 'bypassPermissions',
      planMode: true,
      makerMemoryEnabled: true,
      userPrompt: 'PRIVATE USER PROMPT',
      reviewMode: true,
      reviewReadPaths: [explicitArtifact],
    });
    try {
      const toolsIndex = captured.args.indexOf('--tools');
      expect(toolsIndex).toBeGreaterThan(-1);
      expect(captured.args[toolsIndex + 1]).toBe('read,grep,find,ls');
      expect(captured.args).toContain('--no-approve');
      expect(captured.args).toContain('--no-extensions');
      expect(captured.args).not.toContain('--skill');
      expect(captured.env.CINDY_PI_PACKAGE_MANAGEMENT).toBeUndefined();
      expect(captured.mcpVendorOptions).toBeUndefined();
      expect(deps.getGhostRosterPrompt).not.toHaveBeenCalled();
      expect(deps.resolvePiProjectTrustInput).not.toHaveBeenCalled();

      const promptIndex = captured.args.indexOf('--append-system-prompt');
      const appendedPrompt = promptIndex >= 0 ? captured.args[promptIndex + 1] : '';
      expect(appendedPrompt).not.toContain('PRIVATE ROSTER');
      expect(appendedPrompt).not.toContain('PRIVATE USER PROMPT');

      const configHome = captured.env.PI_CODING_AGENT_DIR;
      expect(configHome).toBeTruthy();
      expect(readdirSync(path.join(configHome!, 'extensions')).sort()).toEqual(['cindy-bridge.ts']);
      const extensionPaths = captured.args.flatMap((arg, index) => (arg === '--extension' ? [captured.args[index + 1]] : []));
      expect(extensionPaths).toEqual([path.posix.join(configHome!, 'extensions', 'cindy-bridge.ts')]);

      const permissionFile = captured.env.CINDY_PI_PERMISSION_FILE;
      expect(permissionFile).toBeTruthy();
      const reviewPermission = JSON.parse(readFileSync(permissionFile!, 'utf8')) as {
        mode: string;
        reviewOnly: boolean;
        reviewReadPaths: string[];
      };
      expect(reviewPermission).toMatchObject({
        mode: 'ask',
        reviewOnly: true,
      });
      expect(reviewPermission.reviewReadPaths.map((item) => realpathSync.native(item))).toEqual([
        realpathSync.native(cwd),
        realpathSync.native(explicitArtifact),
      ]);

      await expect(
        handle.send({
          type: 'user',
          content: [{ type: 'image', path: dotenvPath, mimeType: 'image/png' }],
        }),
      ).rejects.toThrow(/refused/i);
      expect(captured.requests.some((request) => request.type === 'prompt')).toBe(false);

      await handle.setPermissionMode?.('bypassPermissions');
      expect(JSON.parse(readFileSync(permissionFile!, 'utf8'))).toMatchObject({
        mode: 'ask',
        reviewOnly: true,
      });
      expect(handle.getPlanMode?.()).toBe(false);

      fireManagedPackageRequest('review-pkg', 'install', 'npm:context-mode');
      expect(await waitForResponse('review-pkg')).toEqual({
        type: 'extension_ui_response',
        id: 'review-pkg',
        cancelled: true,
      });
      expect(deps.mutatePiManagedPackage).not.toHaveBeenCalled();
    } finally {
      await handle.close();
    }
  });

  it('把 session 花名册快照追加到 Pi system prompt', async () => {
    const deps = buildDeps();
    deps.getGhostRosterPrompt = vi.fn(() => 'GHOST ROSTER PROMPT');
    const agent = new PiAgent(deps);
    const handle = await agent.startSession({
      sessionId: 'roster-session',
      workingDir: cwd,
      model: 'm',
    });
    const idx = captured.args.indexOf('--append-system-prompt');
    expect(captured.args[idx + 1]).toContain('GHOST ROSTER PROMPT');
    expect(deps.getGhostRosterPrompt).toHaveBeenCalledWith({ workingDir: cwd });
    await handle.close();
  });

  it('does not inherit an unmanaged ripgrep path from the host process env', async () => {
    const previous = process.env.CINDY_PI_MANAGED_RG_PATH;
    process.env.CINDY_PI_MANAGED_RG_PATH = path.join(cwd, 'rogue-rg');
    let handle: AgentSessionHandle | undefined;
    try {
      const deps = buildDeps();
      delete deps.runtimeConfig.managedExecutablePaths;
      handle = await new PiAgent(deps).startSession({
        sessionId: 'unmanaged-rg',
        workingDir: cwd,
        model: 'm',
      });
      expect(captured.env.CINDY_PI_MANAGED_RG_PATH).toBeUndefined();
    } finally {
      await handle?.close();
      if (previous === undefined) delete process.env.CINDY_PI_MANAGED_RG_PATH;
      else process.env.CINDY_PI_MANAGED_RG_PATH = previous;
    }
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
    expect(captured.requests.map((r) => r.type)).not.toContain('set_model');

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
    const before = JSON.parse(readFileSync(snapshotPath, 'utf8')) as {
      model?: string;
      provider?: string;
    };
    // 启动快照必须是用户实际选的 provider(BYOM / 本地模型的直连约束)。
    expect(before.provider).toBeTruthy();

    captured.rejectSetModel = true;
    await expect(handle.setModel('m')).rejects.toThrow(/未收到确认/);
    // 会话必须真的被关掉:进程还活着就意味着"下一次委派"仍可能发生。
    expect(captured.closed).toBe(true);
    // 快照**刻意**停在 pending:它既不是已确认的新路由、也不是旧路由,扩展一律拒绝派发。
    // 这条路径上"顺手回滚成旧值"是错的 —— 我们并不知道 pi 侧到底切没切。
    const stuck = JSON.parse(readFileSync(snapshotPath, 'utf8')) as {
      pending?: boolean;
      model?: string;
    };
    expect(stuck.pending).toBe(true);
    expect(stuck.model).toBe('m');
  });

  it('isolates the routing snapshot per runtime instance (dev + packaged sharing one userData)', async () => {
    // review P1:dev 与打包版共用同一个 userData、`--passive` 任意多开,都是明确支持的工作流
    // (单实例锁按 flavor 分域,passive 完全跳过锁)。原来快照只按 sessionId 命名 → 两个**活着的**
    // 实例打开同一 session 时共用一个文件:任一实例切模型就覆盖掉另一个的路由,那个实例的父会话
    // 还在自己的路由上,它的下一个子代理却按对面的 provider 起来,提示词发往这个实例里并没选的
    // 端点。修法沿用 configHome 的隔离:文件名带每运行时 nonce。
    const runtimeDir = path.join(agentHome, 'runtime');
    const snapshotsOf = () => readdirSync(runtimeDir).filter((f) => f.startsWith('subagent-s1-'));
    // 权限档同一个暴露面,而且更严重:另一个实例切到 Full Access 会让本实例的 bridge 现读到
    // bypassPermissions,本实例的破坏性工具不再确认(跨实例权限提升)。同一把 nonce 一起收口。
    const permsOf = () => readdirSync(runtimeDir).filter((f) => f.startsWith('perm-s1-'));

    const first = await start();
    const firstFiles = snapshotsOf();
    expect(firstFiles).toHaveLength(1);
    expect(permsOf()).toHaveLength(1);
    // 第二个实例:同一个 sessionId、同一个 agentHome —— 就是 dev + 打包版共库双开的形状。
    const second = await start();
    const bothFiles = snapshotsOf();
    expect(bothFiles).toHaveLength(2);
    // 权限档也必须是两份独立文件,否则一个实例切档会改掉另一个实例 bridge 现读的那份。
    expect(new Set(permsOf()).size).toBe(2);
    const firstPath = path.join(runtimeDir, firstFiles[0]);
    const secondPath = path.join(runtimeDir, bothFiles.find((f) => f !== firstFiles[0]) as string);
    expect(firstPath).not.toBe(secondPath);

    const secondBefore = readFileSync(secondPath, 'utf8');
    await first.setModel('m-only-in-first');

    // 切换只落在自己那份快照上;另一个活着的实例一个字节都没被动过。
    expect((JSON.parse(readFileSync(firstPath, 'utf8')) as { model?: string }).model).toBe('m-only-in-first');
    expect(readFileSync(secondPath, 'utf8')).toBe(secondBefore);

    // 会话结束要回收:带 nonce 之后文件不再按 sessionId 复用,不回收就随每次 startSession 堆积。
    await first.close();
    await second.close();
    await vi.waitFor(() => {
      expect(snapshotsOf()).toHaveLength(0);
      expect(permsOf()).toHaveLength(0);
    });
  });

  it('marks the routing snapshot pending while set_model is in flight and clears it on confirm', async () => {
    // review P1:原来在 RPC 回包**之前**就把新路由写成"已确认"形状,于是等待窗口里模型发起的
    // 派发会现读快照、按未确认的 provider 起子进程;RPC 随后失败时回滚文件撤不回已起的子进程。
    // 修法:窗口内快照带 `pending: true`,扩展见到就拒绝派发(拒绝的真实性由集成用例验证)。
    const handle = await start();
    const runtimeDir = path.join(agentHome, 'runtime');
    const snapshot = readdirSync(runtimeDir).find((f) => f.startsWith('subagent-'));
    const snapshotPath = path.join(runtimeDir, snapshot as string);
    const before = JSON.parse(readFileSync(snapshotPath, 'utf8')) as Record<string, unknown>;
    // 起点必须是已确认形状 —— 否则下面的 pending 断言证明不了任何东西。
    expect(before.pending).toBeUndefined();

    let release = () => {};
    captured.holdSetModel = new Promise<void>((r) => {
      release = r;
    });
    captured.requests = [];
    const switching = handle.setModel('m-next');

    // 等到 RPC 真的在飞。
    await vi.waitFor(() => {
      expect(captured.requests.map((r) => r.type)).toContain('set_model');
    });
    // 窗口内:内容已经是新路由(可写、可回滚),但带 pending → 扩展拒绝派发。
    const during = JSON.parse(readFileSync(snapshotPath, 'utf8')) as Record<string, unknown>;
    expect(during.pending).toBe(true);
    expect(during.model).toBe('m-next');

    release();
    await switching;
    // 确认后标记必须清掉,否则这个会话的子代理会被永久挡住。
    const after = JSON.parse(readFileSync(snapshotPath, 'utf8')) as Record<string, unknown>;
    expect(after.pending).toBeUndefined();
    expect(after.model).toBe('m-next');
    expect(after.provider).toBe(before.provider);

    await handle.close();
  });

  it('serializes concurrent model switches so no unconfirmed combination is ever published', async () => {
    // 并发/连点切换(本地 + 远程控制端同时切)若交错:A 写 pending、B 写 pending、A 落定 B 的
    // 内容 —— 盘上就会出现没人确认过的 model/provider 组合,而 `previousSnapshot` 也不再是真正
    // 可回滚的那一份。串行闸保证第二次切换在第一次落定之后才开始。
    const handle = await start();
    const runtimeDir = path.join(agentHome, 'runtime');
    const snapshot = readdirSync(runtimeDir).find((f) => f.startsWith('subagent-'));
    const snapshotPath = path.join(runtimeDir, snapshot as string);

    let release = () => {};
    captured.holdSetModel = new Promise<void>((r) => {
      release = r;
    });
    captured.requests = [];
    const first = handle.setModel('m-first');
    const second = handle.setModel('m-second');

    await vi.waitFor(() => {
      expect(captured.requests.map((r) => r.type)).toContain('set_model');
    });
    // 第一次还在飞 → 第二次必须一个字节都还没写:盘上是 m-first + pending,不是 m-second。
    const during = JSON.parse(readFileSync(snapshotPath, 'utf8')) as Record<string, unknown>;
    expect(during.model).toBe('m-first');
    expect(during.pending).toBe(true);
    // 而且第二条 set_model 还没发出去(否则 pi 侧会收到乱序的两次切换)。
    expect(captured.requests.filter((r) => r.type === 'set_model')).toHaveLength(1);

    captured.holdSetModel = null;
    release();
    await Promise.all([first, second]);

    // 两次切换按调用序抵达 pi,终态是最后一次、且已确认。
    const setModelCalls = captured.requests.filter((r) => r.type === 'set_model');
    expect(setModelCalls.map((r) => r.modelId)).toEqual(['m-first', 'm-second']);
    const after = JSON.parse(readFileSync(snapshotPath, 'utf8')) as Record<string, unknown>;
    expect(after.model).toBe('m-second');
    expect(after.pending).toBeUndefined();

    await handle.close();
  });

  it('rolls back to the user-selected provider when set_model cleanly reports failure', async () => {
    // 与上一条对照:success:false 是**确定**没生效 → 回滚,快照必须回到用户原本选定的
    // provider/model,下一次委派才会继续直连那个 Pi 原生 provider(BYOM 约束)。
    const handle = await start();
    const runtimeDir = path.join(agentHome, 'runtime');
    const snapshot = readdirSync(runtimeDir).find((f) => f.startsWith('subagent-'));
    const snapshotPath = path.join(runtimeDir, snapshot as string);
    const before = JSON.parse(readFileSync(snapshotPath, 'utf8')) as {
      model?: string;
      provider?: string;
    };

    captured.failSetModel = true;
    await expect(handle.setModel('m')).rejects.toThrow(/set_model failed/);
    // 会话不该因为一次干净的失败被终止(那是 reject/超时才有的代价)。
    expect(captured.closed).toBe(false);
    // 快照已回滚到切换前的值 —— 父进程路由与下一次委派一致。
    const after = JSON.parse(readFileSync(snapshotPath, 'utf8')) as {
      model?: string;
      provider?: string;
      pending?: boolean;
    };
    expect(after).toEqual(before);
    // 回滚必须**同时**清掉 pending,否则子代理会被永久挡在门外(一次干净的失败不该有这个代价)。
    expect(after.pending).toBeUndefined();

    await handle.close();
  });

  it('overrides the Pi bash tool and strips host credentials at its spawn boundary', async () => {
    await start();
    const { readFileSync } = await import('node:fs');
    const configHome = captured.env.PI_CODING_AGENT_DIR as string;
    const bridge = readFileSync(path.join(configHome, 'extensions', 'cindy-bridge.ts'), 'utf8');
    expect(bridge).toContain('createBashTool,');
    expect(bridge).toContain('createFindTool,');
    expect(bridge).toContain('createGrepTool,');
    expect(bridge).toContain('createLsTool,');
    expect(bridge).toContain('const clean = withoutPiSecrets(env)');
    expect(bridge).toContain('clean.PI_CODING_AGENT_DIR = bashPackageHome');
    expect(bridge).toContain('exposeSessionEnvironment: false');
    expect(bridge).toContain("'CINDY_PI_PERMISSION_FILE'");
    expect(path.normalize(captured.env.CINDY_PI_BASH_PACKAGE_HOME as string)).toBe(
      path.normalize(path.join(configHome, 'bash-package-home')),
    );
  });

  it('models.json carries real cost and maxTokens from the model descriptor', async () => {
    await start();
    const config = JSON.parse(readFileSync(path.join(captured.env.PI_CODING_AGENT_DIR as string, 'models.json'), 'utf8')) as {
      providers: {
        cindy: {
          headers: Record<string, string>;
          models: Array<{
            id: string;
            maxTokens: number;
            cost: Record<string, number>;
          }>;
        };
      };
    };
    const m = config.providers.cindy.models.find((x) => x.id === 'm');
    expect(m?.maxTokens).toBe(64_000);
    expect(m?.cost).toEqual({
      input: 3,
      output: 15,
      cacheRead: 0.3,
      cacheWrite: 3.75,
    });
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
    const config = JSON.parse(readFileSync(path.join(captured.env.PI_CODING_AGENT_DIR as string, 'models.json'), 'utf8')) as {
      providers: {
        cindy: { models: Array<{ id: string; maxTokens: number }> };
      };
    };

    expect(resolver).toHaveBeenCalledWith('openai', 'chatgpt/gpt-retired');
    expect(config.providers.cindy.models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'm' }),
        expect.objectContaining({
          id: 'chatgpt/gpt-retired',
          maxTokens: 96_000,
        }),
      ]),
    );
    expect(agent.capabilities.availableModels.map((model) => model.id)).toEqual(['m']);
    await handle.close();
  });

  it('resume 模型同时缺少公开与 retained 描述符时不会在来源初始化前访问 resolver', async () => {
    const deps = buildDeps();
    deps.resolvePiRuntimeModelDescriptor = vi.fn(() => null);
    deps.resolvePiGatewayModelDescriptor = vi.fn(() => null);
    const agent = new PiAgent(deps);
    const resumeFile = path.join(agentHome, 'missing-retained-session.jsonl');
    writeFileSync(resumeFile, '{}\n');

    const handle = await agent.startSession({
      sessionId: 'missing-retained-resume',
      workingDir: cwd,
      model: 'chatgpt/gpt-missing',
      providerId: 'openai',
      resumeSessionId: resumeFile,
    });

    expect(deps.resolvePiGatewayModelDescriptor).toHaveBeenCalledWith('openai', 'chatgpt/gpt-missing');
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
    const config = JSON.parse(readFileSync(path.join(captured.env.PI_CODING_AGENT_DIR as string, 'models.json'), 'utf8')) as {
      providers: { cindy: { models: Array<{ id: string }> } };
    };

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
    expect(captured.sent).toContainEqual({
      type: 'extension_ui_response',
      id: 'r1',
      confirmed: true,
    });
    expect(resolverCalls).toBe(0);
  });

  it('fails closed when a readonly bridge request omits canonical-path evidence', async () => {
    const review = vi.fn(async () => ({ verdict: 'allow' as const }));
    const handle = await start('auto', review);
    const resolver = vi.fn(async () => ({ kind: 'permission', behavior: 'deny' } as const));
    handle.setInteractionResolver?.(resolver as never);

    firePermissionRequest('readonly-without-evidence', 'read', { path: path.join(cwd, 'innocent.txt') });
    expect(await waitForResponse('readonly-without-evidence')).toEqual({
      type: 'extension_ui_response', id: 'readonly-without-evidence', confirmed: false,
    });
    expect(review).not.toHaveBeenCalled();
    expect(resolver).toHaveBeenCalledOnce();
  });

  it('auto mode lets the current-model reviewer allow a gray write without prompting', async () => {
    const review = vi.fn(async () => ({ verdict: 'allow' as const }));
    const handle = await start('auto', review);
    let resolverCalls = 0;
    handle.setInteractionResolver?.(async () => {
      resolverCalls++;
      return { kind: 'permission', behavior: 'deny' } as never;
    });
    await handle.send({
      type: 'user',
      content: 'Update the shared scratch file for this test.',
    });
    firePermissionRequest('r2', 'write', { path: '/tmp/outside.txt' });
    await flush();
    expect(review).toHaveBeenCalledWith(
      expect.objectContaining({
        agentKind: 'pi',
        model: 'm',
        userIntent: 'Update the shared scratch file for this test.',
        action: { kind: 'file-write', path: '/tmp/outside.txt' },
      }),
    );
    expect(resolverCalls).toBe(0);
    expect(captured.sent).toContainEqual({
      type: 'extension_ui_response',
      id: 'r2',
      confirmed: true,
    });
  });

  it('requires an explicit user decision for extension mutations in Full Access', async () => {
    const handle = await start('bypassPermissions');
    const resolver = vi.fn(async () => ({ kind: 'permission', behavior: 'deny' }) as const);
    handle.setInteractionResolver?.(resolver as never);

    firePermissionRequest('extension-full-access', 'cindy_pi_extension', {
      action: 'install',
      source: 'npm:context-mode',
    });

    expect(await waitForResponse('extension-full-access')).toEqual({
      type: 'extension_ui_response',
      id: 'extension-full-access',
      confirmed: false,
    });
    expect(resolver).toHaveBeenCalledOnce();
  });

  it('does not let Auto-Review approve extension mutations without the user', async () => {
    const review = vi.fn(async () => ({ verdict: 'allow' as const }));
    const handle = await start('auto', review);
    const resolver = vi.fn(async () => ({ kind: 'permission', behavior: 'deny' }) as const);
    handle.setInteractionResolver?.(resolver as never);

    firePermissionRequest('extension-auto', 'cindy_pi_extension', {
      action: 'update',
      source: 'npm:context-mode',
    });

    expect(await waitForResponse('extension-auto')).toEqual({
      type: 'extension_ui_response',
      id: 'extension-auto',
      confirmed: false,
    });
    expect(resolver).toHaveBeenCalledOnce();
    expect(review).not.toHaveBeenCalled();
  });

  it('lets a turn policy override Auto-Review allow and passes exact tool evidence', async () => {
    const review = vi.fn(async () => ({ verdict: 'allow' as const }));
    const handle = await start('auto', review);
    const forceConfirmToolCall = vi.fn(() => true);
    await handle.send(
      { type: 'user', content: 'Update the shared scratch file.' },
      {
        turnPermissionPolicy: {
          origin: { kind: 'im', channel: 'wechat', taskId: 'task-policy' },
          confirmationSurface: 'channel',
          forceConfirmToolCall,
        },
      },
    );
    const resolver = vi.fn(async () => ({ kind: 'permission', behavior: 'allow' }) as const);
    handle.setInteractionResolver?.(resolver as never);

    const input = { path: '/tmp/policy.txt' };
    firePermissionRequest('policy-allow', 'write', input);
    expect(await waitForResponse('policy-allow')).toEqual({
      type: 'extension_ui_response',
      id: 'policy-allow',
      confirmed: true,
    });
    expect(forceConfirmToolCall).toHaveBeenCalledWith('write', input);
    expect(resolver).toHaveBeenCalledOnce();
    expect(review).toHaveBeenCalledOnce();
  });

  it('lets a turn policy override MCP auto-approve and fail-closes policy exceptions', async () => {
    const handle = await start('auto', async () => ({ verdict: 'allow' as const }), false, {
      serverNames: ['cindy_contacts'],
      policy: () => 'auto-approve',
    });
    await handle.send(
      { type: 'user', content: 'Update a contact.' },
      {
        turnPermissionPolicy: {
          origin: { kind: 'im', channel: 'wechat', taskId: 'task-mcp' },
          confirmationSurface: 'channel',
          forceConfirmToolCall: () => {
            throw new Error('policy unavailable');
          },
        },
      },
    );
    const resolver = vi.fn(async () => ({ kind: 'permission', behavior: 'deny' }) as const);
    handle.setInteractionResolver?.(resolver as never);

    firePermissionRequest('policy-mcp', 'mcp__cindy_contacts__call_tool', {
      name: 'contacts_merge',
      args: { sourceId: 'a', targetId: 'b' },
    });
    expect(await waitForResponse('policy-mcp')).toEqual({
      type: 'extension_ui_response',
      id: 'policy-mcp',
      confirmed: false,
    });
    expect(resolver).toHaveBeenCalledOnce();
  });

  it('denies Auto-Review ask without an extra channel prompt on policy turns', async () => {
    const handle = await start('auto', async () => ({
      verdict: 'ask' as const,
    }));
    await handle.send(
      { type: 'user', content: 'Touch an outside file.' },
      {
        turnPermissionPolicy: {
          origin: { kind: 'im', channel: 'wechat', taskId: 'task-gray' },
          confirmationSurface: 'channel',
          forceConfirmToolCall: () => false,
        },
      },
    );
    const resolver = vi.fn(async () => ({ kind: 'permission', behavior: 'allow' }) as const);
    handle.setInteractionResolver?.(resolver as never);

    firePermissionRequest('policy-gray', 'write', {
      path: '/tmp/outside-gray.txt',
    });
    expect(await waitForResponse('policy-gray')).toEqual({
      type: 'extension_ui_response',
      id: 'policy-gray',
      confirmed: false,
    });
    expect(resolver).not.toHaveBeenCalled();
  });

  it('keeps a policy across internal continuation tools and clears it at agent_settled', async () => {
    const handle = await start('auto', async () => ({
      verdict: 'allow' as const,
    }));
    const forceConfirmToolCall = vi.fn(() => true);
    const resolver = vi.fn(async () => ({ kind: 'permission', behavior: 'allow' }) as const);
    handle.setInteractionResolver?.(resolver as never);
    await handle.send(
      { type: 'user', content: 'Run a plan and continue.' },
      {
        turnPermissionPolicy: {
          origin: {
            kind: 'im',
            channel: 'wechat',
            taskId: 'task-continuation',
          },
          confirmationSurface: 'channel',
          forceConfirmToolCall,
        },
      },
    );

    firePermissionRequest('policy-first', 'write', { path: '/tmp/first.txt' });
    firePermissionRequest('policy-continuation', 'bash', { command: 'pnpm test' }, {
      resolvedCredentialPaths: [],
    });
    expect((await waitForResponse('policy-first')).confirmed).toBe(true);
    expect((await waitForResponse('policy-continuation')).confirmed).toBe(true);
    expect(forceConfirmToolCall).toHaveBeenCalledTimes(2);

    captured.onEvent?.({ type: 'agent_settled' });
    await handle.send({
      type: 'user',
      content: 'Desktop follow-up without channel policy.',
    });
    firePermissionRequest('desktop-after-policy', 'write', {
      path: '/tmp/desktop.txt',
    });
    expect((await waitForResponse('desktop-after-policy')).confirmed).toBe(true);
    expect(forceConfirmToolCall).toHaveBeenCalledTimes(2);
    expect(resolver).toHaveBeenCalledTimes(2);
  });

  it('rolls back a policy when Pi rejects the prompt before provider acceptance', async () => {
    const handle = await start('auto', async () => ({
      verdict: 'allow' as const,
    }));
    const forceConfirmToolCall = vi.fn(() => true);
    captured.failPrompt = true;
    await expect(
      handle.send(
        { type: 'user', content: 'Rejected policy turn.' },
        {
          turnPermissionPolicy: {
            origin: { kind: 'im', channel: 'wechat', taskId: 'task-rejected' },
            confirmationSurface: 'channel',
            forceConfirmToolCall,
          },
        },
      ),
    ).rejects.toThrow('pi prompt rejected');

    captured.failPrompt = false;
    await handle.send({ type: 'user', content: 'Normal Desktop turn.' });
    firePermissionRequest('desktop-after-reject', 'write', {
      path: '/tmp/desktop-after-reject.txt',
    });
    expect((await waitForResponse('desktop-after-reject')).confirmed).toBe(true);
    expect(forceConfirmToolCall).not.toHaveBeenCalled();
  });

  it('rejects a policy in Full Access before sending the prompt RPC', async () => {
    const handle = await start('bypassPermissions');
    const promptsBefore = captured.requests.filter((request) => request.type === 'prompt').length;
    await expect(
      handle.send(
        { type: 'user', content: 'Unsafe remote turn.' },
        {
          turnPermissionPolicy: {
            origin: {
              kind: 'im',
              channel: 'wechat',
              taskId: 'task-full-access',
            },
            confirmationSurface: 'channel',
            forceConfirmToolCall: () => true,
          },
        },
      ),
    ).rejects.toMatchObject({
      name: 'TurnPermissionPolicyUnsupportedError',
      permissionMode: 'bypassPermissions',
    });
    expect(captured.requests.filter((request) => request.type === 'prompt')).toHaveLength(promptsBefore);
  });

  /**
   * 桥接 MCP 工具走 host 审批策略,不进 Auto-review 灰区(与 Claude Code / Codex 同一份
   * 真源)。回归的真实缺陷:Pi 没接这条策略时,`start_team` 落进灰区交模型判,模型按
   * 「有更安全替代方案就 block」判成"这点小事不必开团队"→ block 对用户静默 → bridge
   * 报 "User denied this tool call via Cindy",协同团队永远建不起来且没有任何弹窗。
   */
  it('auto-approves trusted first-party MCP tools via host policy without consulting the reviewer', async () => {
    const review = vi.fn(async () => ({
      verdict: 'block' as const,
      reason: 'should never be asked',
    }));
    const handle = await start('auto', review, false, {
      serverNames: ['cindy_orca'],
      policy: ({ serverName }) => (serverName === 'cindy_orca' ? 'auto-approve' : 'prompt'),
    });
    let resolverCalls = 0;
    handle.setInteractionResolver?.(async () => {
      resolverCalls++;
      return { kind: 'permission', behavior: 'allow' } as never;
    });
    await handle.send({ type: 'user', content: '修一下登录页的样式错位' });
    firePermissionRequest('r20', 'mcp__cindy_orca__start_team', {});
    await flush();
    // 关键三点:不问模型、不弹卡、直接放行。userIntent 与协同无关也不影响(正是原缺陷的触发条件)。
    expect(review).not.toHaveBeenCalled();
    expect(resolverCalls).toBe(0);
    expect(captured.sent).toContainEqual({
      type: 'extension_ui_response',
      id: 'r20',
      confirmed: true,
    });

    // start_team 获批后 host 会把当前 session 切成 Lead。Pi 必须支持运行时原地合并，
    // 并让启动时交给 MCP bridge 的同一 vendorOptions 引用立即看到新身份；否则
    // MakerSession.setVendorOptions 抛 not-implemented，或后续 create_worker 仍读到旧 ctx。
    expect(handle.setVendorOptions).toBeTypeOf('function');
    await handle.setVendorOptions?.({
      orcaRole: 'lead',
      orcaWorkflowId: 'team-1',
      orcaLeadSessionId: 's1',
    });
    expect(captured.mcpVendorOptions).toMatchObject({
      orcaRole: 'lead',
      orcaWorkflowId: 'team-1',
      orcaLeadSessionId: 's1',
    });
  });

  it('still asks the user for MCP servers the host policy does not trust', async () => {
    const review = vi.fn(async () => ({ verdict: 'allow' as const }));
    const handle = await start('auto', review, false, {
      serverNames: ['cindy_ssh'],
      policy: ({ serverName }) => (serverName === 'cindy_orca' ? 'auto-approve' : 'prompt-each-time'),
    });
    let resolverCalls = 0;
    handle.setInteractionResolver?.(async () => {
      resolverCalls++;
      return { kind: 'permission', behavior: 'allow' } as never;
    });
    await handle.send({ type: 'user', content: 'check the remote host' });
    firePermissionRequest('r21', 'mcp__cindy_ssh__ssh_exec', {
      command: 'uptime',
    });
    await flush();
    // 不可信 server 仍逐次确认,且同样不该消耗模型审阅(它不是安全分类器该管的事)。
    expect(review).not.toHaveBeenCalled();
    expect(resolverCalls).toBe(1);
    expect(captured.sent).toContainEqual({
      type: 'extension_ui_response',
      id: 'r21',
      confirmed: true,
    });
  });

  it('uses the host security disclosure for progressive MCP approvals', async () => {
    const disclosure = {
      title: 'Allow Xcode to build this project?',
      description: 'Build scripts may access files outside the project, and output is returned to the Agent.',
    };
    const handle = await start('auto', undefined, false, {
      serverNames: ['cindy_ios_simulator'],
      policy: () => 'prompt-each-time',
      presentation: () => disclosure,
    });
    const resolver = vi.fn(async () => ({ kind: 'permission', behavior: 'deny' }) as const);
    handle.setInteractionResolver?.(resolver as never);

    firePermissionRequest('r-build', 'mcp__cindy_ios_simulator__call_tool', {
      name: 'build_app',
      args: {},
    });

    expect(await waitForResponse('r-build')).toEqual({
      type: 'extension_ui_response',
      id: 'r-build',
      confirmed: false,
    });
    expect(resolver).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'permission',
        title: disclosure.title,
        description: disclosure.description,
      }),
    );
  });

  /**
   * server 名可以含 `__`,盲切 `mcp__` 后首段会把第三方 `cindy_orca__evil` 认成第一方
   * `cindy_orca` 并继承静默放行 —— 一条实打实的提权路径。归属判定取最长匹配。
   */
  it('does not let a look-alike server name inherit first-party trust', async () => {
    const handle = await start('auto', async () => ({ verdict: 'allow' as const }), false, {
      serverNames: ['cindy_orca', 'cindy_orca__evil'],
      policy: ({ serverName }) => (serverName === 'cindy_orca' ? 'auto-approve' : 'prompt-each-time'),
    });
    const seen: string[] = [];
    handle.setInteractionResolver?.(async (req) => {
      seen.push((req as { toolName: string }).toolName);
      return { kind: 'permission', behavior: 'deny' } as never;
    });
    await handle.send({ type: 'user', content: 'go' });
    firePermissionRequest('r22', 'mcp__cindy_orca__evil__start_team', {});
    await flush();
    expect(seen).toEqual(['mcp__cindy_orca__evil__start_team']);
    expect(captured.sent).toContainEqual({
      type: 'extension_ui_response',
      id: 'r22',
      confirmed: false,
    });
  });

  // host 未提供 getMcpToolApprovalPolicy(或 server 未注册)时的兜底:归属查不到就不查
  // 策略,MCP 工具继续走原灰区路径,行为与接策略之前一致。
  it('auto mode gives the current-model reviewer complete MCP tool evidence', async () => {
    const review = vi.fn(async () => ({ verdict: 'allow' as const }));
    const handle = await start('auto', review);
    await handle.send({ type: 'user', content: 'Start a review team.' });
    firePermissionRequest('r3', 'mcp__cindy_orca__start_team', {});
    await flush();
    expect(review).toHaveBeenCalledWith(
      expect.objectContaining({
        action: {
          kind: 'other',
          description: JSON.stringify({
            toolName: 'mcp__cindy_orca__start_team',
            input: {},
          }),
        },
      }),
    );
    expect(captured.sent).toContainEqual({
      type: 'extension_ui_response',
      id: 'r3',
      confirmed: true,
    });
  });

  /**
   * 送审阅器的 model 必须与 Pi 当前运行模型是同一个目录 id:启动时来自 `--model`,
   * 热切换后来自成功的 `set_model` 请求。
   *
   * host reviewer 按 (providerId, model) 精确查目录条目定路由,查不到即 fail closed
   * (oneShotCandidates 的 no_candidate),灰区动作退化成没有 UI 提示的永久 block。
   * pi 当前不做 wire 改写(不同于 Claude 的 [1m] 后缀、Codex 的 app-server 回带别名),
   * 这条用例把「两者同源」钉成不变量:将来若给 pi 引入 wire 派生,必须像 Claude 那样
   * 单独派生、不回写运行期 model。见 issue #1575。
   */
  it('keeps review routing aligned with the initial and hot-switched catalog model ids', async () => {
    const review = vi.fn(async () => ({ verdict: 'allow' as const }));
    const handle = await start('auto', review, true);
    await handle.send({
      type: 'user',
      content: 'Touch a scratch file outside the workspace.',
    });
    firePermissionRequest('r8', 'write', { path: '/tmp/catalog-model.txt' });
    await flush();
    const modelArgIndex = captured.args.indexOf('--model');
    expect(modelArgIndex).toBeGreaterThan(-1);
    const spawnedModel = captured.args[modelArgIndex + 1];
    expect(spawnedModel).toBe('m');
    expect(review).toHaveBeenNthCalledWith(1, expect.objectContaining({ model: spawnedModel }));

    await handle.setModel?.('m-next');
    expect(captured.requests).toContainEqual({
      type: 'set_model',
      provider: 'cindy',
      modelId: 'm-next',
    });
    await handle.send({
      type: 'user',
      content: 'Touch another scratch file after switching models.',
    });
    firePermissionRequest('r9', 'write', {
      path: '/tmp/catalog-model-switched.txt',
    });
    await flush();
    expect(review).toHaveBeenNthCalledWith(2, expect.objectContaining({ model: 'm-next' }));
    await handle.close();
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
    expect(captured.sent).toContainEqual({
      type: 'extension_ui_response',
      id: 'r4',
      confirmed: true,
    });
  });

  // 审阅器不可用时降级为「问用户」,不再静默拒绝:宿主侧已重试过,走到这里
  // 说明确实没救回来。静默否掉一批正常的灰区操作会让 Auto 档看起来像坏了,
  // 而用户既看不到原因也无法接管。降级后安全边界不变(未点头仍不执行)。
  it('auto mode hands gray actions to the user when the current-model reviewer is unavailable', async () => {
    const handle = await start('auto');
    let resolverCalls = 0;
    const seen: InteractionRequest[] = [];
    handle.setInteractionResolver?.(async (req) => {
      seen.push(req);
      resolverCalls++;
      return { kind: 'permission', behavior: 'allow' } as never;
    });
    firePermissionRequest('r7', 'write', { path: '/tmp/outside.txt' });
    await flush();
    expect(resolverCalls).toBe(1);
    expect(seen[0]).toMatchObject({
      kind: 'permission',
      description: AUTO_REVIEW_UNAVAILABLE_PROMPT_TEXT,
      metadata: { [AUTO_REVIEW_UNAVAILABLE_METADATA_KEY]: true },
    });
    expect(captured.sent).toContainEqual({
      type: 'extension_ui_response',
      id: 'r7',
      confirmed: true,
    });
  });

  it.each([
    'wecom_interaction_timeout',
    'wechat_interaction_timeout',
    'replaced_by_new_request',
    'wecom_interaction_cancelled_by_stop',
  ] as const)('does not treat a missing confirmation as a user rejection after auto-review fails (%s)', async (reason) => {
    const handle = await start('auto');
    handle.setInteractionResolver?.(async () => ({
      kind: 'permission',
      behavior: 'deny',
      reason,
    }));
    const notices: string[] = [];
    void (async () => {
      for await (const event of handle.events()) {
        if (
          event.type === 'error' &&
          typeof event.data === 'object' &&
          event.data !== null &&
          'message' in event.data &&
          typeof event.data.message === 'string'
        ) {
          notices.push(event.data.message);
        }
      }
    })().catch(() => {});

    firePermissionRequest(`undelivered-${reason}`, 'write', {
      path: '/tmp/outside.txt',
    });
    expect(await waitForResponse(`undelivered-${reason}`)).toMatchObject({
      type: 'extension_ui_response',
      confirmed: false,
    });
    await flush();
    expect(notices.some((message) => message.includes(`[${AUTO_REVIEW_CONFIRM_UNDELIVERED_CODE}]`))).toBe(true);
    expect(notices.some((message) => message.includes('not a user rejection'))).toBe(true);
    await handle.close();
  });

  it('keeps a real user deny distinct from a missing confirmation on Pi', async () => {
    const handle = await start('auto');
    handle.setInteractionResolver?.(async () => ({
      kind: 'permission',
      behavior: 'deny',
      reason: 'User denied',
    }));
    const notices: string[] = [];
    void (async () => {
      for await (const event of handle.events()) {
        if (
          event.type === 'error' &&
          typeof event.data === 'object' &&
          event.data !== null &&
          'message' in event.data &&
          typeof event.data.message === 'string'
        ) {
          notices.push(event.data.message);
        }
      }
    })().catch(() => {});

    firePermissionRequest('pi-user-deny', 'write', {
      path: '/tmp/outside.txt',
    });
    expect(await waitForResponse('pi-user-deny')).toMatchObject({
      type: 'extension_ui_response',
      confirmed: false,
    });
    await flush();
    expect(notices.some((message) => message.includes(`[${AUTO_REVIEW_CONFIRM_UNDELIVERED_CODE}]`))).toBe(false);
    await handle.close();
  });

  it('does not treat a system-dismissed Pi confirmation as a user rejection after auto-review fails', async () => {
    const handle = await start('auto');
    handle.setInteractionResolver?.(async () => await new Promise<InteractionDecision>(() => {}));
    const notices: string[] = [];
    void (async () => {
      for await (const event of handle.events()) {
        if (
          event.type === 'error' &&
          typeof event.data === 'object' &&
          event.data !== null &&
          'message' in event.data &&
          typeof event.data.message === 'string'
        ) {
          notices.push(event.data.message);
        }
      }
    })().catch(() => {});

    firePermissionRequest('pi-dismiss', 'write', { path: '/tmp/outside.txt' });
    await flush();
    await handle.setPermissionMode?.('ask');
    expect(await waitForResponse('pi-dismiss')).toMatchObject({
      type: 'extension_ui_response',
      confirmed: false,
    });
    await flush();
    expect(notices.some((message) => message.includes(`[${AUTO_REVIEW_CONFIRM_UNDELIVERED_CODE}]`))).toBe(true);
    await handle.close();
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
    expect(captured.sent).toContainEqual({
      type: 'extension_ui_response',
      id: 'r5',
      confirmed: true,
    });
  });

  /**
   * Full access 的语义是「不问、全放行」,必须压在 MCP 策略分支与灰区审阅之前。bridge 按 perm
   * 文件现读本已把 bypass 拦在冒泡前,但档位可热切换 —— confirm 冒泡后用户仍可能切到 Full
   * access,此时不该再弹卡,也不该因为没有 resolver 就把工具调用拒掉(review P1)。
   */
  it('honors a hot switch to Full access ahead of the MCP policy branch', async () => {
    const review = vi.fn(async () => ({ verdict: 'block' as const }));
    const handle = await start('ask', review, false, {
      serverNames: ['cindy_ssh'],
      policy: () => 'prompt-each-time',
    });
    let resolverCalls = 0;
    handle.setInteractionResolver?.(async () => {
      resolverCalls++;
      return { kind: 'permission', behavior: 'deny' } as never;
    });
    await handle.setPermissionMode?.('bypassPermissions');
    firePermissionRequest('r23', 'mcp__cindy_ssh__ssh_exec', {
      command: 'uptime',
    });
    expect(await waitForResponse('r23')).toEqual({
      type: 'extension_ui_response',
      id: 'r23',
      confirmed: true,
    });
    expect(resolverCalls).toBe(0);
    expect(review).not.toHaveBeenCalled();
  });

  it('allows a Full access call whose session has no interaction resolver at all', async () => {
    const handle = await start('ask', undefined, false, {
      serverNames: ['cindy_ssh'],
      policy: () => 'prompt',
    });
    await handle.setPermissionMode?.('bypassPermissions');
    // 没有 setInteractionResolver:Full access 下不能因为拿不到决策就中断工具调用。
    firePermissionRequest('r24', 'mcp__cindy_ssh__ssh_exec', {
      command: 'uptime',
    });
    expect(await waitForResponse('r24')).toEqual({
      type: 'extension_ui_response',
      id: 'r24',
      confirmed: true,
    });
  });

  /**
   * 弹卡**等待中**切到 Full access:必须当场 settle 那张卡让调用继续,而不是干等用户回答一张
   * 已经失效的卡。此前 resolver 只挂在卡上、切档不会唤醒它,工具调用会一直卡住(codex P1)。
   * 与 Claude / Codex 的 dismissAllPending 同口径,并发 interaction_dismissed 让 UI 收卡。
   */
  it('settles an in-flight permission card when the mode widens to Full access', async () => {
    const handle = await start('ask', undefined, false, {
      serverNames: ['cindy_browser'],
      // prompt(非 prompt-each-time)→ 放宽档位时接受替用户放行。
      policy: () => 'prompt',
    });
    const events: Array<Record<string, unknown>> = [];
    void (async () => {
      for await (const e of handle.events()) {
        events.push(e as unknown as Record<string, unknown>);
      }
    })();
    let cardShown = false;
    handle.setInteractionResolver?.(async () => {
      cardShown = true;
      // 卡挂着不回答 —— 模拟用户没点按钮,直接去改权限档。
      return await new Promise(() => {});
    });
    firePermissionRequest('r26', 'mcp__cindy_browser__call_tool', {
      name: 'browser',
    });
    await flush();
    expect(cardShown).toBe(true);
    // 此刻还没有回帧:调用正等在卡上。
    expect(captured.sent.find((m) => m.id === 'r26')).toBeUndefined();

    await handle.setPermissionMode?.('bypassPermissions');
    expect(await waitForResponse('r26')).toEqual({
      type: 'extension_ui_response',
      id: 'r26',
      confirmed: true,
    });
    // UI 侧必须收到 dismissed,否则卡会留在界面上而工具已经继续执行。
    const dismissed = events.find((e) => e.type === 'interaction_dismissed');
    expect(dismissed?.data).toMatchObject({
      requestId: 'r26',
      resolvedAs: 'allow',
    });
  });

  /**
   * 只有 Full access 算「放宽」。Auto 的语义是「区内放行、越界升级」而不是全放行,挂起的卡
   * 本就是被升级的越界动作 —— 切到 Auto 必须 deny 这张 stale 卡,让重试重新过 fail-closed 的
   * Auto dispatcher,不能替用户橡皮图章(与 CC 的 moreOpen 裁决一致,codex review P1)。
   */
  it('denies a pending card when switching to Auto instead of rubber-stamping it', async () => {
    const handle = await start('ask', undefined, false, {
      serverNames: ['cindy_browser'],
      policy: () => 'prompt',
    });
    handle.setInteractionResolver?.(async () => await new Promise(() => {}));
    firePermissionRequest('r28', 'mcp__cindy_browser__call_tool', {
      name: 'browser',
    });
    await flush();
    await handle.setPermissionMode?.('auto');
    expect(await waitForResponse('r28')).toEqual({
      type: 'extension_ui_response',
      id: 'r28',
      confirmed: false,
    });
  });

  /**
   * 并发切档:被更晚意图取代的那次写会在代际检查处提前返回、但 promise 仍 resolve 成功。旧
   * continuation 若照自己捕获的 transition 收卡,就会用一次早已作废的放宽把 pending 调用错误
   * 放行(codex review P1)。这里 ask → bypass 紧接着再切回 ask,最终必须是拒绝。
   */
  it('ignores a superseded mode change when settling pending prompts', async () => {
    const handle = await start('ask', undefined, false, {
      serverNames: ['cindy_ssh'],
      policy: () => 'prompt',
    });
    handle.setInteractionResolver?.(async () => await new Promise(() => {}));
    firePermissionRequest('r29', 'mcp__cindy_ssh__ssh_exec', {
      command: 'uptime',
    });
    await flush();
    // 两次切换连续发起,第一次(放宽)会被第二次(收紧)取代。
    const widening = handle.setPermissionMode?.('bypassPermissions');
    const tightening = handle.setPermissionMode?.('ask');
    await Promise.allSettled([widening, tightening]);
    expect(await waitForResponse('r29')).toEqual({
      type: 'extension_ui_response',
      id: 'r29',
      confirmed: false,
    });
  });

  /**
   * 放宽档位不得替用户批准他还没表态的**高风险**调用:prompt-each-time 的挂起卡在切到
   * Full access 时仍按 fail-closed 拒绝(与 CC / Codex 的 forcePrompt 语义一致)。
   */
  it('keeps a pending prompt-each-time card fail-closed even when the mode widens', async () => {
    const handle = await start('ask', undefined, false, {
      serverNames: ['cindy_ssh'],
      policy: () => 'prompt-each-time',
    });
    handle.setInteractionResolver?.(async () => await new Promise(() => {}));
    firePermissionRequest('r27', 'mcp__cindy_ssh__ssh_exec', {
      command: 'rm -rf /',
    });
    await flush();
    await handle.setPermissionMode?.('bypassPermissions');
    expect(await waitForResponse('r27')).toEqual({
      type: 'extension_ui_response',
      id: 'r27',
      confirmed: false,
    });
  });

  /**
   * 反向边界:用户明确拒绝之后再切到 Full access,不能把这次拒绝追认成放行 —— 档位放宽只
   * 影响「拿不到决策」的情形,不覆盖用户已经表过的态。
   */
  it('does not let a later Full access switch overturn an explicit denial', async () => {
    const handle = await start('ask', undefined, false, {
      serverNames: ['cindy_ssh'],
      policy: () => 'prompt-each-time',
    });
    handle.setInteractionResolver?.(async () => {
      // 用户点「拒绝」的同一时刻切到 Full access。
      await handle.setPermissionMode?.('bypassPermissions');
      return { kind: 'permission', behavior: 'deny' } as never;
    });
    firePermissionRequest('r25', 'mcp__cindy_ssh__ssh_exec', {
      command: 'rm -rf /',
    });
    expect(await waitForResponse('r25')).toEqual({
      type: 'extension_ui_response',
      id: 'r25',
      confirmed: false,
    });
  });

  /**
   * resolver 是 host 注入的外部回调,可能同步 throw(或返回非 Promise)。直接 `.then` 会让同步
   * 异常绕过 finalize —— pending 条目不注销、请求永不 settle,调用悬挂(copilot 报)。同步失败
   * 必须落进 fail-closed 分支:回帧 confirmed:false,而不是卡死。
   */
  it('fails closed when the interaction resolver throws synchronously', async () => {
    const handle = await start('ask', undefined, false, {
      serverNames: ['cindy_ssh'],
      policy: () => 'prompt',
    });
    handle.setInteractionResolver?.((() => {
      throw new Error('resolver blew up synchronously');
    }) as never);
    firePermissionRequest('r30', 'mcp__cindy_ssh__ssh_exec', {
      command: 'uptime',
    });
    expect(await waitForResponse('r30')).toEqual({
      type: 'extension_ui_response',
      id: 'r30',
      confirmed: false,
    });
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
    expect(captured.sent).toContainEqual({
      type: 'extension_ui_response',
      id: 'r6',
      confirmed: true,
    });
  });
});
