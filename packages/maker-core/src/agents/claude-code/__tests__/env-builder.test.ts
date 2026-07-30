import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AuthAdapter } from '../../../interfaces/auth-adapter.js';
import type { AgentRuntimeConfig } from '../../../interfaces/runtime-config.js';
import {
  SENSITIVE_ANTHROPIC_ENV_KEYS,
  applySubagentModelEnv,
  buildClaudeEnv,
} from '../env-builder.js';

const MODEL_CONTEXT_WINDOWS_ENV = 'XDT_MAKER_MODEL_CONTEXT_WINDOWS';

function createAuthAdapter(env: Record<string, string> = {}): AuthAdapter {
  return {
    async getState() {
      return { authenticated: true };
    },
    async triggerLogin() {
      return { authenticated: true };
    },
    async logout() {},
    async getAuthEnv() {
      return env;
    },
  };
}

describe('buildClaudeEnv', () => {
  const originalDisableCron = process.env.CLAUDE_CODE_DISABLE_CRON;
  const originalNoColor = process.env.NO_COLOR;
  const originalCliColor = process.env.CLICOLOR;
  const originalForceColor = process.env.FORCE_COLOR;
  const originalTerm = process.env.TERM;
  const originalPsOutputRendering = process.env.PSStyle__OutputRendering;
  const originalSubagentModel = process.env.CLAUDE_CODE_SUBAGENT_MODEL;

  afterEach(() => {
    if (originalDisableCron === undefined) {
      delete process.env.CLAUDE_CODE_DISABLE_CRON;
    } else {
      process.env.CLAUDE_CODE_DISABLE_CRON = originalDisableCron;
    }
    const restore = (key: string, value: string | undefined): void => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    restore('NO_COLOR', originalNoColor);
    restore('CLICOLOR', originalCliColor);
    restore('FORCE_COLOR', originalForceColor);
    restore('TERM', originalTerm);
    restore('PSStyle__OutputRendering', originalPsOutputRendering);
    restore('CLAUDE_CODE_SUBAGENT_MODEL', originalSubagentModel);
  });

  it('disables Claude Code native cron for host-managed sessions', async () => {
    const env = await buildClaudeEnv(createAuthAdapter(), {});

    expect(env.CLAUDE_CODE_DISABLE_CRON).toBe('1');
  });

  it('passes requested credential mode to the auth adapter', async () => {
    const getAuthEnv = vi.fn(async () => ({ ANTHROPIC_API_KEY: 'key' }));
    const env = await buildClaudeEnv(
      {
        ...createAuthAdapter(),
        getAuthEnv,
      },
      {},
      { credentialMode: 'gateway-key' },
    );

    expect(getAuthEnv).toHaveBeenCalledWith({ credentialMode: 'gateway-key' });
    expect(env.ANTHROPIC_API_KEY).toBe('key');
  });

  it('evaluates function-form behaviorFlags with the spawn credentialMode and spawnMode', async () => {
    const behaviorFlags = vi.fn(() => ({ CLAUDE_CODE_ATTRIBUTION_HEADER: '0' }));

    const env = await buildClaudeEnv(
      createAuthAdapter(),
      { behaviorFlags },
      { credentialMode: 'gateway-key' },
    );

    expect(behaviorFlags).toHaveBeenCalledWith({
      credentialMode: 'gateway-key',
      spawnMode: 'local',
    });
    expect(env.CLAUDE_CODE_ATTRIBUTION_HEADER).toBe('0');
  });

  it('marks remote spawns so hosts can skip local-only behavior flags', async () => {
    const behaviorFlags = vi.fn(() => ({}));

    await buildClaudeEnv(
      createAuthAdapter(),
      { behaviorFlags },
      { credentialMode: 'gateway-key', mode: 'remote' },
    );

    expect(behaviorFlags).toHaveBeenCalledWith({
      credentialMode: 'gateway-key',
      spawnMode: 'remote',
    });
  });

  it('lets behaviorFlags override an inherited CLAUDE_CODE_ATTRIBUTION_HEADER from the host env', async () => {
    // local spawn 继承宿主 process.env:宿主 shell export 过 =0 时,flags 缺席压不住
    // 继承值 —— 保留归因必须显式 '1'(desktop issue #758 的环境继承回归面)。
    process.env.CLAUDE_CODE_ATTRIBUTION_HEADER = '0';
    try {
      const env = await buildClaudeEnv(createAuthAdapter(), {
        behaviorFlags: () => ({ CLAUDE_CODE_ATTRIBUTION_HEADER: '1' }),
      });
      expect(env.CLAUDE_CODE_ATTRIBUTION_HEADER).toBe('1');
    } finally {
      delete process.env.CLAUDE_CODE_ATTRIBUTION_HEADER;
    }
  });

  it('injects the configured Claude subagent model', async () => {
    delete process.env.CLAUDE_CODE_SUBAGENT_MODEL;

    const env = await buildClaudeEnv(createAuthAdapter(), {
      subagentModel: 'claude-haiku-4-5-20251001',
    });

    expect(env.CLAUDE_CODE_SUBAGENT_MODEL).toBe('claude-haiku-4-5-20251001');
  });

  it('does not inject a subagent model when the host setting is blank', async () => {
    delete process.env.CLAUDE_CODE_SUBAGENT_MODEL;

    const env = await buildClaudeEnv(createAuthAdapter(), { subagentModel: '   ' });

    expect(env.CLAUDE_CODE_SUBAGENT_MODEL).toBeUndefined();
  });

  it('options.subagentModel = null → 明确不设 env(让手写 agent 的 frontmatter model 生效)', async () => {
    delete process.env.CLAUDE_CODE_SUBAGENT_MODEL;

    // runtimeConfig 配了默认值,但调用方解析后判定「本会话不要设 env」。
    const env = await buildClaudeEnv(
      createAuthAdapter(),
      { subagentModel: 'claude-haiku-4-5-20251001' },
      { subagentModel: null },
    );

    expect(env.CLAUDE_CODE_SUBAGENT_MODEL).toBeUndefined();
  });

  it('options.subagentModel 为字符串时压过 runtimeConfig', async () => {
    delete process.env.CLAUDE_CODE_SUBAGENT_MODEL;

    const env = await buildClaudeEnv(
      createAuthAdapter(),
      { subagentModel: 'from-runtime-config' },
      { subagentModel: 'from-caller' },
    );

    expect(env.CLAUDE_CODE_SUBAGENT_MODEL).toBe('from-caller');
  });

  it('省略 options.subagentModel 时回落 runtimeConfig(未接该解析的调用方保持旧行为)', async () => {
    delete process.env.CLAUDE_CODE_SUBAGENT_MODEL;

    const env = await buildClaudeEnv(createAuthAdapter(), { subagentModel: 'legacy' }, {});

    expect(env.CLAUDE_CODE_SUBAGENT_MODEL).toBe('legacy');
  });

  // 回归:该键归 host 独占。继承来的残留会以最高优先级静默盖掉手写 agent 的 frontmatter
  // model,而 host 判定的「不要设」在 SDK 的 {...process.env, ...userEnv} 合并里压不住它
  // (只能覆盖、删不掉)—— 所以必须进 strip 名单,从根上清掉。
  it('CLAUDE_CODE_SUBAGENT_MODEL 在 strip 名单里,process.env 的继承值不漏给子进程', async () => {
    expect(SENSITIVE_ANTHROPIC_ENV_KEYS).toContain('CLAUDE_CODE_SUBAGENT_MODEL');

    process.env.CLAUDE_CODE_SUBAGENT_MODEL = 'inherited-from-outer-cc-session';

    const env = await buildClaudeEnv(createAuthAdapter(), {}, {});

    expect(env.CLAUDE_CODE_SUBAGENT_MODEL).toBeUndefined();
  });

  it('null 决定要**删掉** behaviorFlags 带进来的同名键(只跳过赋值不够)', async () => {
    delete process.env.CLAUDE_CODE_SUBAGENT_MODEL;

    const env = await buildClaudeEnv(
      createAuthAdapter(),
      { behaviorFlags: { CLAUDE_CODE_SUBAGENT_MODEL: 'from-flags' } },
      { subagentModel: null },
    );

    expect(env.CLAUDE_CODE_SUBAGENT_MODEL).toBeUndefined();
  });

  it('keeps native cron disabled even when inherited env or runtime flags try to enable it', async () => {
    process.env.CLAUDE_CODE_DISABLE_CRON = '0';
    const runtimeConfig: AgentRuntimeConfig = {
      behaviorFlags: {
        CLAUDE_CODE_DISABLE_CRON: '0',
      },
    };

    const env = await buildClaudeEnv(
      createAuthAdapter({ CLAUDE_CODE_DISABLE_CRON: '0' }),
      runtimeConfig,
    );

    expect(env.CLAUDE_CODE_DISABLE_CRON).toBe('1');
  });

  it('passes maker model context windows to Claude Code runtime', async () => {
    const env = await buildClaudeEnv(createAuthAdapter(), {}, {
      modelContextWindows: [
        { id: 'qwen/qwen3.7-max', contextWindow: 992_000 },
        { id: 'deepseek/deepseek-v4-pro', contextWindow: 1_048_576 },
      ],
    });

    expect(JSON.parse(env[MODEL_CONTEXT_WINDOWS_ENV] ?? '{}')).toEqual({
      'qwen/qwen3.7-max': 992_000,
      'qwen/qwen3.7-max[1m]': 992_000,
      'deepseek/deepseek-v4-pro': 1_048_576,
      'deepseek/deepseek-v4-pro[1m]': 1_048_576,
    });
  });

  it('does not inject empty or invalid context windows', async () => {
    const env = await buildClaudeEnv(createAuthAdapter(), {}, {
      modelContextWindows: [
        { id: 'qwen/qwen3.7-max', contextWindow: 0 },
        { id: '', contextWindow: 992_000 },
      ],
    });

    expect(env[MODEL_CONTEXT_WINDOWS_ENV]).toBeUndefined();
  });

  it('defaults command output to plain text across common CLI color controls', async () => {
    delete process.env.NO_COLOR;
    delete process.env.CLICOLOR;
    delete process.env.FORCE_COLOR;
    delete process.env.TERM;
    delete process.env.PSStyle__OutputRendering;

    const env = await buildClaudeEnv(createAuthAdapter(), {});

    expect(env.NO_COLOR).toBe('1');
    expect(env.CLICOLOR).toBe('0');
    expect(env.FORCE_COLOR).toBe('0');
    expect(env.TERM).toBe('dumb');
    expect(env.PSStyle__OutputRendering).toBe('PlainText');
  });

  it('keeps explicit command color environment overrides', async () => {
    process.env.NO_COLOR = '0';
    process.env.CLICOLOR = '1';
    process.env.FORCE_COLOR = '1';
    process.env.TERM = 'xterm-256color';
    process.env.PSStyle__OutputRendering = 'Ansi';

    const env = await buildClaudeEnv(createAuthAdapter(), {});

    expect(env.NO_COLOR).toBe('0');
    expect(env.CLICOLOR).toBe('1');
    expect(env.FORCE_COLOR).toBe('1');
    expect(env.TERM).toBe('xterm-256color');
    expect(env.PSStyle__OutputRendering).toBe('Ansi');
  });

  describe('net debug logging (bound to XDT_CC_DEBUG_NET = Debug 日志开关)', () => {
    const origDebugNet = process.env.XDT_CC_DEBUG_NET;
    const origAnthropicLog = process.env.ANTHROPIC_LOG;
    const origNodeDebug = process.env.NODE_DEBUG;

    function restore(key: string, val: string | undefined): void {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }

    afterEach(() => {
      restore('XDT_CC_DEBUG_NET', origDebugNet);
      restore('ANTHROPIC_LOG', origAnthropicLog);
      restore('NODE_DEBUG', origNodeDebug);
    });

    it('injects ANTHROPIC_LOG=debug (full request incl. headers) + NODE_DEBUG when toggle on', async () => {
      process.env.XDT_CC_DEBUG_NET = '1';
      delete process.env.ANTHROPIC_LOG;
      delete process.env.NODE_DEBUG;

      const env = await buildClaudeEnv(createAuthAdapter(), {});

      // debug (not info) so the SDK logs request headers — needed to verify fast
      // (anthropic-beta: fast-mode-*) and provider routing headers actually hit the wire.
      expect(env.ANTHROPIC_LOG).toBe('debug');
      expect(env.NODE_DEBUG).toBe('http,https,net,tls');
    });

    it('does NOT inject ANTHROPIC_LOG / NODE_DEBUG when toggle off (env deleted)', async () => {
      delete process.env.XDT_CC_DEBUG_NET;
      delete process.env.ANTHROPIC_LOG;
      delete process.env.NODE_DEBUG;

      const env = await buildClaudeEnv(createAuthAdapter(), {});

      expect(env.ANTHROPIC_LOG).toBeUndefined();
      expect(env.NODE_DEBUG).toBeUndefined();
    });

    it('respects an explicit ANTHROPIC_LOG override (escape hatch to降噪) when toggle on', async () => {
      process.env.XDT_CC_DEBUG_NET = '1';
      process.env.ANTHROPIC_LOG = 'info';

      const env = await buildClaudeEnv(createAuthAdapter(), {});

      expect(env.ANTHROPIC_LOG).toBe('info');
    });
  });

  describe('ANTHROPIC_BASE_URL endpoint selection', () => {
    const LOOPBACK = 'http://127.0.0.1:54321';
    const UPSTREAM = 'https://llm-proxy.example.com';

    it('local mode uses endpoint (loopback proxy URL)', async () => {
      const env = await buildClaudeEnv(createAuthAdapter(), {
        endpoint: LOOPBACK,
        remoteEndpoint: UPSTREAM,
      });

      expect(env.ANTHROPIC_BASE_URL).toBe(LOOPBACK);
    });

    it('remote mode prefers remoteEndpoint over endpoint (never the local loopback)', async () => {
      // 回归保护: 远端机器够不到本地 loopback proxy。host 用 remoteEndpoint 注入真上游,
      // 退役兼容模式开关后这是远端 cc 唯一的逃生口 (见 runtime-config.ts remoteEndpoint 文档)。
      const env = await buildClaudeEnv(
        createAuthAdapter(),
        { endpoint: LOOPBACK, remoteEndpoint: UPSTREAM },
        { mode: 'remote' },
      );

      expect(env.ANTHROPIC_BASE_URL).toBe(UPSTREAM);
    });

    it('remote mode falls back to endpoint when remoteEndpoint is unset', async () => {
      const env = await buildClaudeEnv(
        createAuthAdapter(),
        { endpoint: UPSTREAM },
        { mode: 'remote' },
      );

      expect(env.ANTHROPIC_BASE_URL).toBe(UPSTREAM);
    });
  });

  // 锁死 2026-07-03 事故修复(cc >= 2.1.198 的 CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST
  // 语义扩大 → host 显式递订阅 token)引入的安全边界。
  describe('subscription OAuth env boundaries', () => {
    const METADATA_KEYS = [
      'CLAUDE_CODE_OAUTH_SCOPES',
      'CLAUDE_CODE_SUBSCRIPTION_TYPE',
      'CLAUDE_CODE_RATE_LIMIT_TIER',
    ] as const;
    const origOauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    const origEntrypoint = process.env.CLAUDE_CODE_ENTRYPOINT;
    const origIdeSkip = process.env.CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL;
    const origMetadata = new Map(METADATA_KEYS.map((k) => [k, process.env[k]]));

    function restore(key: string, val: string | undefined): void {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }

    afterEach(() => {
      restore('CLAUDE_CODE_OAUTH_TOKEN', origOauthToken);
      restore('CLAUDE_CODE_ENTRYPOINT', origEntrypoint);
      restore('CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL', origIdeSkip);
      for (const [k, v] of origMetadata) restore(k, v);
    });

    it('oauth-spawn:强制 ENTRYPOINT=claude-vscode(覆盖继承值)+ 防御性 IDE_SKIP', async () => {
      // cc 的 401 续命回调有 entrypoint 白名单(claude-desktop/local-agent/claude-vscode),
      // SDK 默认 sdk-ts 不在其中;dev 下 Electron 由终端 cc 启动继承来的 sdk-ts 同样会
      // 关掉闸门 —— 必须硬覆盖,否则回调静默失效(不报错不打日志)。
      process.env.CLAUDE_CODE_ENTRYPOINT = 'sdk-ts';
      // 清掉宿主可能自带的 IDE_SKIP,确保断言命中的是 builder 的默认填充分支,
      // 而不是 process.env 继承(继承时测试假通过,没测到目标逻辑)。
      delete process.env.CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL;
      const env = await buildClaudeEnv(
        createAuthAdapter({ CLAUDE_CODE_OAUTH_TOKEN: 'at-live' }),
        {},
      );
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('at-live');
      expect(env.CLAUDE_CODE_ENTRYPOINT).toBe('claude-vscode');
      expect(env.CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL).toBe('1');
      expect(env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST).toBe('1');
    });

    it('无订阅 token(gateway-key):不动 ENTRYPOINT,保持 SDK 默认语义', async () => {
      delete process.env.CLAUDE_CODE_ENTRYPOINT;
      // 宿主环境(如 Claude Code IDE 会话)可能自带 IDE_SKIP=1,不清会经 process.env
      // 继承进 buildClaudeEnv 输出,让下面的 toBeUndefined 断言只在特定环境失败。
      delete process.env.CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL;
      const env = await buildClaudeEnv(createAuthAdapter({ ANTHROPIC_API_KEY: 'sk-gw' }), {});
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
      expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
      expect(env.CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL).toBeUndefined();
    });

    it('合并顺序:process.env 的订阅 token 被剥离,authEnv 注入值存活', async () => {
      // SENSITIVE_ANTHROPIC_ENV_KEYS 的两道防线只作用于 process.env 继承;authEnv 在
      // cleanProcessEnv 之后合并 —— 本测试锁住该顺序,防止将来重排把注入值吞掉。
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'at-system-leak';
      const injected = await buildClaudeEnv(
        createAuthAdapter({ CLAUDE_CODE_OAUTH_TOKEN: 'at-injected' }),
        {},
      );
      expect(injected.CLAUDE_CODE_OAUTH_TOKEN).toBe('at-injected');

      const notInjected = await buildClaudeEnv(createAuthAdapter({}), {});
      expect(notInjected.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    });

    it('订阅身份元数据 env 同受 strip 防线管辖:继承残留被剥离,authEnv 注入存活', async () => {
      // review P2:凭证库没提供 scopes/tier 时 getAuthEnv 不注入对应 key,若继承残留
      // 不剥离,会以「别人的档位/scopes」顶上 —— 三个 metadata key 必须进 strip 名单。
      process.env.CLAUDE_CODE_OAUTH_SCOPES = 'user:inference stale:scope';
      process.env.CLAUDE_CODE_SUBSCRIPTION_TYPE = 'stale-pro';
      process.env.CLAUDE_CODE_RATE_LIMIT_TIER = 'stale-tier';
      const bare = await buildClaudeEnv(
        createAuthAdapter({ CLAUDE_CODE_OAUTH_TOKEN: 'at-live' }),
        {},
      );
      expect(bare.CLAUDE_CODE_OAUTH_SCOPES).toBeUndefined();
      expect(bare.CLAUDE_CODE_SUBSCRIPTION_TYPE).toBeUndefined();
      expect(bare.CLAUDE_CODE_RATE_LIMIT_TIER).toBeUndefined();

      const injected = await buildClaudeEnv(
        createAuthAdapter({
          CLAUDE_CODE_OAUTH_TOKEN: 'at-live',
          CLAUDE_CODE_SUBSCRIPTION_TYPE: 'max',
        }),
        {},
      );
      expect(injected.CLAUDE_CODE_SUBSCRIPTION_TYPE).toBe('max');
    });

    it('remote 模式 + gateway-key:env 不含订阅 token(订阅凭证不出本机)', async () => {
      // remote 会话在 index.ts 固定 credentialMode='gateway-key'(startParams.env 经
      // SSH 送远端 daemon)。锁死:即便 process.env 有残留,remote env 也不携带订阅 token。
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'at-system-leak';
      const env = await buildClaudeEnv(
        createAuthAdapter({ ANTHROPIC_API_KEY: 'sk-gw' }),
        {},
        { mode: 'remote', credentialMode: 'gateway-key' },
      );
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
      expect(env.ANTHROPIC_API_KEY).toBe('sk-gw');
      // remote 从空字典起,不继承本机 OS env
      expect(env.HOME).toBeUndefined();
    });
  });
});

describe('applySubagentModelEnv', () => {
  it('非空串 → 设值', () => {
    const env: Record<string, string> = {};
    applySubagentModelEnv(env, ' claude-sonnet-5 ');
    expect(env.CLAUDE_CODE_SUBAGENT_MODEL).toBe('claude-sonnet-5');
  });

  it('null / 空串 → 删键(明确「不要设」)', () => {
    const withNull: Record<string, string> = { CLAUDE_CODE_SUBAGENT_MODEL: 'stale' };
    applySubagentModelEnv(withNull, null);
    expect('CLAUDE_CODE_SUBAGENT_MODEL' in withNull).toBe(false);

    const withBlank: Record<string, string> = { CLAUDE_CODE_SUBAGENT_MODEL: 'stale' };
    applySubagentModelEnv(withBlank, '   ');
    expect('CLAUDE_CODE_SUBAGENT_MODEL' in withBlank).toBe(false);
  });

  it('undefined → 不动(调用方没做过决定)', () => {
    const env: Record<string, string> = { CLAUDE_CODE_SUBAGENT_MODEL: 'keep' };
    applySubagentModelEnv(env, undefined);
    expect(env.CLAUDE_CODE_SUBAGENT_MODEL).toBe('keep');
  });

  it('会话启动路径的用法:env 先建好(可能带残留),判定后回来覆盖或删除', () => {
    const env: Record<string, string> = { CLAUDE_CODE_SUBAGENT_MODEL: 'leftover' };
    applySubagentModelEnv(env, 'xai/grok-4.5');
    expect(env.CLAUDE_CODE_SUBAGENT_MODEL).toBe('xai/grok-4.5');
    applySubagentModelEnv(env, null);
    expect('CLAUDE_CODE_SUBAGENT_MODEL' in env).toBe(false);
  });
});
