import { describe, expect, it } from 'vitest';

import { ClaudeCodeAgent, toSdkModelString } from '../index.js';
import type { AgentDeps } from '../../base-agent.js';
import type { AuthAdapter } from '../../../interfaces/auth-adapter.js';
import type { Logger } from '../../../interfaces/logger.js';

function createNoopLogger(): Logger {
  const logger: Logger = {
    trace() {},
    debug() {},
    info() {},
    warn() {},
    error() {},
    fatal() {},
    child() {
      return logger;
    },
  };
  return logger;
}

function createDeps(): AgentDeps {
  const auth: AuthAdapter = {
    async getState() {
      return { authenticated: true };
    },
    async triggerLogin() {
      return { authenticated: true };
    },
    async logout() {},
    async getAuthEnv() {
      return {};
    },
  };

  return {
    auth,
    runtimeConfig: {},
    binaryPath: process.execPath,
    logger: createNoopLogger(),
  };
}

describe('ClaudeCodeAgent model capabilities', () => {
  // 模型清单 SSoT 已迁至目录 providers.json;maker-core 不再写死 CLAUDE_MODELS。
  // 没有 host 注入(capabilityAdditions)时 availableModels 起始为空 —— 具体模型内容
  // 的回归由 host 的 catalogDerivedModels.test.ts(派生列表 == 迁移前快照)守。
  it('starts with an empty availableModels until the host injects the catalog-derived list', () => {
    const agent = new ClaudeCodeAgent(createDeps());
    expect(agent.capabilities.availableModels).toEqual([]);
  });

  it('uses unambiguous display names for every Anthropic effort level', () => {
    const agent = new ClaudeCodeAgent(createDeps());
    expect(agent.capabilities.effortLevels.map(({ id, displayName }) => [id, displayName])).toEqual([
      ['low', 'Low'],
      ['medium', 'Medium'],
      ['high', 'High'],
      ['xhigh', 'Extra High'],
      ['max', 'Maximum'],
    ]);
  });

  // sonnet 必须映射到显式版本号:裸 'sonnet[1m]' 别名会随 cc-code 二进制漂移
  // (Sonnet 5 上线后别名仍指 4.6,用户选 Sonnet 5 实际发出 claude-sonnet-4-6)。
  it('maps every catalog sonnet model to its explicit versioned SDK string', () => {
    expect(toSdkModelString('claude-sonnet-5')).toBe('claude-sonnet-5[1m]');
    expect(toSdkModelString('claude-sonnet-4-6')).toBe('claude-sonnet-4-6[1m]');
  });

  // #3764:命名空间 id 是自定义 Provider 的路由键,兜底链不得含糊改写 ——
  // 此前 cindy/claude-sonnet-5 被加 [1m] 而 cindy/claude-opus-5 透传,同一
  // Provider 两个模型 wire id 形态不对称,被上游白名单逐一 403。
  it('passes namespaced custom-provider ids through verbatim and symmetrically', () => {
    expect(toSdkModelString('cindy/claude-sonnet-5')).toBe('cindy/claude-sonnet-5');
    expect(toSdkModelString('cindy/claude-opus-5')).toBe('cindy/claude-opus-5');
    expect(toSdkModelString('winky/claude-sonnet-4-6')).toBe('winky/claude-sonnet-4-6');
    expect(toSdkModelString('winky/claude-opus-4-8')).toBe('winky/claude-opus-4-8');
    // A large catalog window is not a declaration of a custom-provider wire alias.
    expect(toSdkModelString('cindy/claude-sonnet-5', 1_000_000)).toBe('cindy/claude-sonnet-5');
    expect(toSdkModelString('cindy/claude-opus-5', 200_000)).toBe('cindy/claude-opus-5');
  });

  it('never collapses a sonnet model to the bare drifting alias', () => {
    for (const model of ['claude-sonnet-5', 'claude-sonnet-4-6', 'claude-sonnet-9-9']) {
      const sdk = toSdkModelString(model);
      expect(sdk).not.toBe('sonnet[1m]');
      expect(sdk).not.toBe('sonnet');
      // 兜底路径也必须保留调用方给的显式 id
      expect(sdk.startsWith(model)).toBe(true);
    }
  });

  // #10716 / unit: without a selected-route declaration, historical third-party
  // IDs must remain exact even when no catalog window was supplied (title calls).
  it.each(['z-ai/glm-5.2', 'deepseek-v4-flash', 'gpt-5.5', 'gpt-5.4', 'custom-sonnet'])(
    'does not invent a legacy third-party alias for %s',
    (model) => expect(toSdkModelString(model)).toBe(model),
  );
  it('does NOT add [1m] to budget codex/* models (real window 272k, not 1M)', () => {
    // [1m] 会让 cc-code 的 has1mContext 把窗口判成 1M, 撑大 auto-compact 阈值,
    // 对话冲过折扣网关真实上限后空转。折扣版必须保持原样、不带 [1m]。
    expect(toSdkModelString('codex/gpt-5.5')).toBe('codex/gpt-5.5');
    expect(toSdkModelString('codex/gpt-5.4')).toBe('codex/gpt-5.4');
  });

  // #10716: capacity alone must not synthesize unsupported SDK model identities.
  it.each(['deepseek-flash', 'gemini-3.5-flash', 'some-provider/brand-new-model', 'claude-custom'])(
    'keeps the configured third-party ID %s even with a 1M catalog window',
    (model) => expect(toSdkModelString(model, 1_048_576)).toBe(model),
  );

  it('adds only declared or native long-context aliases', () => {
    expect(toSdkModelString('glm-5.3', 1_000_000, true)).toBe('glm-5.3[1m]');
    expect(toSdkModelString('claude-sonnet-5', 1_000_000)).toBe('claude-sonnet-5[1m]');
    expect(toSdkModelString('claude-sonnet-5', 200_000)).toBe('claude-sonnet-5');
    expect(toSdkModelString('deepseek-v4-flash', undefined, false)).toBe('deepseek-v4-flash');
  });

  it('preserves explicitly selected variant identities independently of working budgets', () => {
    expect(toSdkModelString('glm-5.3[1m]', 200_000)).toBe('glm-5.3[1m]');
    expect(toSdkModelString('gpt-5.5[1m]', 1_000_000)).toBe('gpt-5.5[1m]');
    expect(toSdkModelString('codex/gpt-5.5', 272_000)).toBe('codex/gpt-5.5');
    expect(toSdkModelString('qwen/qwen3.7-max', 992_000)).toBe('qwen/qwen3.7-max');
  });

  it('haiku passes through as the official alias — no more dated snapshot rewrite', () => {
    // claude-haiku-4-5 本身就是 Anthropic 官方别名(带版本号,不存在跨代漂移),
    // 订阅直连与网关均接受;同号新快照跟随别名即可。
    expect(toSdkModelString('claude-haiku-4-5', 200_000)).toBe('claude-haiku-4-5');
    expect(toSdkModelString('claude-haiku-4-5')).toBe('claude-haiku-4-5');
  });

  it('falls back to native Claude aliases when the window is unknown', () => {
    // Native Claude compatibility remains available for catalog-free callers.
    expect(toSdkModelString('claude-opus-5')).toBe('claude-opus-5[1m]');
    expect(toSdkModelString('claude-sonnet-5')).toBe('claude-sonnet-5[1m]');
    expect(toSdkModelString('codex/gpt-5.5')).toBe('codex/gpt-5.5');
    expect(toSdkModelString('totally-unknown-model')).toBe('totally-unknown-model');
    expect(toSdkModelString('totally-unknown-model', 0)).toBe('totally-unknown-model');
    expect(toSdkModelString('totally-unknown-model', Number.NaN)).toBe('totally-unknown-model');
  });

  // Fast 模式接通:agent 级声明 hasFastMode=true,UI 才会对支持 fast 的模型(目录 supportsFastMode)
  // 显示开关。实际 fast 注入(buildSettings.fastMode → SDK settings、setFastMode → applyFlagSettings)
  // 走 cc 子进程,由集成/手测(XDT_CC_DEBUG_NET 看 anthropic-beta: fast-mode-2026-02-01)验证。
  it('declares hasFastMode capability (so the fast toggle can surface for supported models)', () => {
    const agent = new ClaudeCodeAgent(createDeps());
    expect(agent.capabilities.hasFastMode).toBe(true);
  });
});
