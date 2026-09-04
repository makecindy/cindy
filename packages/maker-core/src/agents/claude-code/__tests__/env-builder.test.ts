import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AuthAdapter } from '../../../interfaces/auth-adapter.js';
import type { AgentRuntimeConfig } from '../../../interfaces/runtime-config.js';
import {
  EXPLORE_INHERIT_CAP_DISABLE_ENV,
  SENSITIVE_ANTHROPIC_ENV_KEYS,
  applyExploreInheritCapEnv,
  applySubagentModelEnv,
  buildClaudeEnv,
  exploreInheritCapEnvNeedsSync,
  shouldDisableExploreInheritCap,
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
  const originalMaxContextTokens = process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS;
  const originalCompactPctOverride = process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE;
  const originalExploreInheritCap = process.env[EXPLORE_INHERIT_CAP_DISABLE_ENV];

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
    restore('CLAUDE_CODE_MAX_CONTEXT_TOKENS', originalMaxContextTokens);
    restore('CLAUDE_AUTOCOMPACT_PCT_OVERRIDE', originalCompactPctOverride);
    restore(EXPLORE_INHERIT_CAP_DISABLE_ENV, originalExploreInheritCap);
  });

  it('disables Claude Code native cron for host-managed sessions', async () => {
    const env = await buildClaudeEnv(createAuthAdapter(), {});

    expect(env.CLAUDE_CODE_DISABLE_CRON).toBe('1');
  });

  it('pins ANTHROPIC_SMALL_FAST_MODEL to the session wire model when provided (#3557)', async () => {
    // 网关路由会话:CLI 内部小模型调用不能用内置裸名默认值(网关白名单按
    // 字面比对必 403),钉到会话自身已授权的 wire 模型。
    const env = await buildClaudeEnv(createAuthAdapter(), {}, {
      smallFastModel: 'anthropic/claude-opus-5',
    });

    expect(env.ANTHROPIC_SMALL_FAST_MODEL).toBe('anthropic/claude-opus-5');
  });

  it('leaves ANTHROPIC_SMALL_FAST_MODEL untouched when not provided or already set (#3557)', async () => {
    // 裸名会话(订阅直连/自定义中继)不传 → 保持 CLI 默认行为零变化。
    const absent = await buildClaudeEnv(createAuthAdapter(), {});
    expect(absent.ANTHROPIC_SMALL_FAST_MODEL).toBeUndefined();

    // behaviorFlags / 用户显式覆盖优先,不被会话值盖掉。
    const overridden = await buildClaudeEnv(
      createAuthAdapter(),
      { behaviorFlags: { ANTHROPIC_SMALL_FAST_MODEL: 'anthropic/claude-haiku-4-5' } },
      { smallFastModel: 'anthropic/claude-opus-5' },
    );
    expect(overridden.ANTHROPIC_SMALL_FAST_MODEL).toBe('anthropic/claude-haiku-4-5');
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

  it('evaluates function-form behaviorFlags with the spawn route context', async () => {
    const behaviorFlags = vi.fn(() => ({ CLAUDE_CODE_ATTRIBUTION_HEADER: '0' }));

    const env = await buildClaudeEnv(
      createAuthAdapter(),
      { behaviorFlags },
      { credentialMode: 'gateway-key', sessionProviderId: 'xd' },
    );

    expect(behaviorFlags).toHaveBeenCalledWith({
      credentialMode: 'gateway-key',
      sessionProviderId: 'xd',
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
      sessionProviderId: undefined,
      spawnMode: 'remote',
    });
  });

  it('does not forward a controller-local CLAUDE_CONFIG_DIR to a remote host', async () => {
    const env = await buildClaudeEnv(
      createAuthAdapter({
        ANTHROPIC_API_KEY: 'sk-gw',
        CLAUDE_CONFIG_DIR: 'C:\\Users\\Admin\\AppData\\Roaming\\Cindy-dev2\\claude-home',
      }),
      {},
      { credentialMode: 'gateway-key', mode: 'remote' },
    );

    expect(env.ANTHROPIC_API_KEY).toBe('sk-gw');
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
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

  it('大写 [1M] 后缀不再镜像出 [1M][1m] 垃圾键 (#3661)', async () => {
    const env = await buildClaudeEnv(createAuthAdapter(), {}, {
      modelContextWindows: [
        { id: 'claude-opus-4-6[1M]', contextWindow: 1_000_000 },
      ],
    });

    expect(JSON.parse(env[MODEL_CONTEXT_WINDOWS_ENV] ?? '{}')).toEqual({
      'claude-opus-4-6[1M]': 1_000_000,
    });
  });

  it('mirrorOneMillionSuffix=false 的条目只写原样键,不镜像 [1m] (#3661)', async () => {
    // claude-* 的 [1m] 是真实 1M 通道,不是同窗口路由别名:按会话路由注入的
    // 中转站窗口若被镜像,会把 200K 压到 Fast 切换后的 [1m] 形态上。
    const env = await buildClaudeEnv(createAuthAdapter(), {}, {
      modelContextWindows: [
        { id: 'claude-opus-4-6', contextWindow: 1_000_000, mirrorOneMillionSuffix: false },
        { id: 'deepseek/deepseek-v4-pro', contextWindow: 1_048_576 },
      ],
    });

    expect(JSON.parse(env[MODEL_CONTEXT_WINDOWS_ENV] ?? '{}')).toEqual({
      'claude-opus-4-6': 1_000_000,
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

  it('tells Claude Code the selected provider model context window', async () => {
    process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = '1000';
    process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = '30';

    const env = await buildClaudeEnv(createAuthAdapter(), { autoCompactThresholdPct: 80.4 }, {
      activeModel: 'xai/grok-4.6',
      modelContextWindows: [
        { id: 'xai/grok-4.6', contextWindow: 372_000.4 },
        { id: 'other/model', contextWindow: 992_000 },
      ],
    });

    expect(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe('372000');
    expect(env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE).toBe('80');
  });

  it('matches a catalog model when the active SDK wire id carries [1m]', async () => {
    process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = '1000';

    const env = await buildClaudeEnv(createAuthAdapter(), {}, {
      activeModel: 'z-ai/glm-5.3[1m]',
      modelContextWindows: [{ id: 'z-ai/glm-5.3', contextWindow: 1_000_000 }],
    });

    expect(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe('1000000');
  });

  it('does not set a context window when the selected model is provider-unrouted', async () => {
    process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = '1000';
    process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = '30';

    const env = await buildClaudeEnv(createAuthAdapter(), { autoCompactThresholdPct: 80 }, {
      activeModel: 'claude-sonnet-5',
      modelContextWindows: [{ id: 'xai/grok-4.6', contextWindow: 372_000 }],
    });

    expect(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBeUndefined();
    expect(env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE).toBe('80');
  });

  describe('built-in Explore inherit cap (CC 2.1.198+)', () => {
    // 上游把内置 Explore 的 `model: "inherit"` 按「模型名里有没有 haiku/sonnet/opus」
    // 判定是否超过 opus,超了就**替换**成 opus。经 fp 路由的非 Claude 模型全部误判。
    it('disables the cap for non-Claude session models so Explore inherits the parent', async () => {
      for (const activeModel of ['gpt-5.6-sol[1m]', 'codex/gpt-5.6-sol', 'z-ai/glm-5.2[1m]']) {
        const env = await buildClaudeEnv(createAuthAdapter(), {}, { activeModel });
        expect(env[EXPLORE_INHERIT_CAP_DISABLE_ENV], activeModel).toBe('1');
      }
    });

    it('keeps upstream behaviour for Claude-family session models', async () => {
      // haiku / sonnet / opus:cap 本来就不触发,设了反而是无谓的行为变化。
      // fable:不在那三档里 → cap 会触发,而那是上游有意的成本上限,必须保留。
      for (const activeModel of [
        'claude-opus-5[1m]',
        'claude-sonnet-5',
        'claude-haiku-4-5-20251001',
        'claude-fable-5-1',
        'anthropic/claude-fable-5-1',
      ]) {
        const env = await buildClaudeEnv(createAuthAdapter(), {}, { activeModel });
        expect(env[EXPLORE_INHERIT_CAP_DISABLE_ENV], activeModel).toBeUndefined();
      }
    });

    it('does not guess when the spawn model is unknown', async () => {
      const env = await buildClaudeEnv(createAuthAdapter(), {});

      expect(env[EXPLORE_INHERIT_CAP_DISABLE_ENV]).toBeUndefined();
      expect(shouldDisableExploreInheritCap(undefined)).toBe(false);
      expect(shouldDisableExploreInheritCap('   ')).toBe(false);
    });

    it('keeps an explicit override from behaviorFlags or the inherited host env', async () => {
      const flagged = await buildClaudeEnv(
        createAuthAdapter(),
        { behaviorFlags: { [EXPLORE_INHERIT_CAP_DISABLE_ENV]: '0' } },
        { activeModel: 'gpt-5.6-sol[1m]' },
      );
      expect(flagged[EXPLORE_INHERIT_CAP_DISABLE_ENV]).toBe('0');

      process.env[EXPLORE_INHERIT_CAP_DISABLE_ENV] = '0';
      const inherited = await buildClaudeEnv(createAuthAdapter(), {}, {
        activeModel: 'gpt-5.6-sol[1m]',
      });
      expect(inherited[EXPLORE_INHERIT_CAP_DISABLE_ENV]).toBe('0');
    });

    it('applies to the remote spawn env too', async () => {
      // 远端 daemon 跑的是同一个 CC CLI,同一个误判。
      const env = await buildClaudeEnv(createAuthAdapter(), {}, {
        mode: 'remote',
        activeModel: 'gpt-5.6-sol[1m]',
      });

      expect(env[EXPLORE_INHERIT_CAP_DISABLE_ENV]).toBe('1');
    });

    it('replaces a Cindy-managed cap flag when the live model crosses the policy boundary', () => {
      const env: Record<string, string> = {
        [EXPLORE_INHERIT_CAP_DISABLE_ENV]: '1',
      };

      applyExploreInheritCapEnv(env, 'claude-fable-5', 'replace');
      expect(env[EXPLORE_INHERIT_CAP_DISABLE_ENV]).toBeUndefined();

      applyExploreInheritCapEnv(env, 'gpt-5.6-sol[1m]', 'replace');
      expect(env[EXPLORE_INHERIT_CAP_DISABLE_ENV]).toBe('1');
    });

    it('keeps an explicit override in if-undefined mode even when replace would flip it', () => {
      const env: Record<string, string> = {
        [EXPLORE_INHERIT_CAP_DISABLE_ENV]: '0',
      };

      applyExploreInheritCapEnv(env, 'gpt-5.6-sol[1m]', 'if-undefined');
      expect(env[EXPLORE_INHERIT_CAP_DISABLE_ENV]).toBe('0');
    });

    it('treats an explicit override as already in sync so live switches do not rebuild', () => {
      const env: Record<string, string> = {
        [EXPLORE_INHERIT_CAP_DISABLE_ENV]: '0',
      };
      expect(exploreInheritCapEnvNeedsSync(env, 'gpt-5.6-sol[1m]')).toBe(false);
      expect(exploreInheritCapEnvNeedsSync(env, 'claude-fable-5')).toBe(false);
      expect(exploreInheritCapEnvNeedsSync({}, 'gpt-5.6-sol[1m]')).toBe(true);
      expect(exploreInheritCapEnvNeedsSync(
        { [EXPLORE_INHERIT_CAP_DISABLE_ENV]: '1' },
        'claude-fable-5',
      )).toBe(true);
    });
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
