/**
 * preview-masking.test.ts
 * ---------------------------------------------------------------------------
 * #1666 Finding E 回归:写配置预览交给 renderer 前,对外 token 明文必须被掩掉。
 * 真实明文只在 main 侧落文件 / 落剪贴板;预览纯展示,绝不把明文带过 IPC 边界。
 */

import { describe, expect, it } from 'vitest';

import type {
  LocalProxyCodexConfigPreview,
  LocalProxyConfigPreview,
} from '../../../shared/localProxyService';
import { maskAnthropicPreview, maskCodexPreview } from '../preview-masking';

const TOKEN = 'cindy-local-supersecret-abcdef0123456789';
const MASKED = 'cindy-local-••••';

describe('maskAnthropicPreview — 写 ~/.claude 预览掩码 token', () => {
  it('proposedEnv.ANTHROPIC_API_KEY 被掩码,base_url 等非 token 段原样保留', () => {
    const preview: LocalProxyConfigPreview = {
      path: '/home/u/.claude/settings.json',
      exists: false,
      proposedEnv: {
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:51888',
        ANTHROPIC_API_KEY: TOKEN,
      },
      conflicts: [],
    };
    const masked = maskAnthropicPreview(preview, TOKEN, MASKED);
    expect(masked.proposedEnv.ANTHROPIC_API_KEY).toBe(MASKED);
    expect(masked.proposedEnv.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:51888');
    // 明文绝不出现在任何序列化后的预览里。
    expect(JSON.stringify(masked)).not.toContain(TOKEN);
  });

  it('冲突项里等于 token 的 next 被掩码;其它冲突值原样保留', () => {
    const preview: LocalProxyConfigPreview = {
      path: '/home/u/.claude/settings.json',
      exists: true,
      proposedEnv: {
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:51888',
        ANTHROPIC_API_KEY: TOKEN,
      },
      conflicts: [
        { key: 'ANTHROPIC_API_KEY', current: 'sk-old-user-key', next: TOKEN },
        { key: 'ANTHROPIC_BASE_URL', current: 'https://old', next: 'http://127.0.0.1:51888' },
      ],
    };
    const masked = maskAnthropicPreview(preview, TOKEN, MASKED);
    const apiKeyConflict = masked.conflicts.find((c) => c.key === 'ANTHROPIC_API_KEY');
    // next(= 我们的 token)被掩;current(用户旧值,非我们 token)保留。
    expect(apiKeyConflict?.next).toBe(MASKED);
    expect(apiKeyConflict?.current).toBe('sk-old-user-key');
    const baseUrlConflict = masked.conflicts.find((c) => c.key === 'ANTHROPIC_BASE_URL');
    expect(baseUrlConflict?.next).toBe('http://127.0.0.1:51888');
    expect(JSON.stringify(masked)).not.toContain(TOKEN);
  });
});

describe('maskCodexPreview — 写 ~/.codex/config.toml 预览掩码 token', () => {
  it('tokenExportLine 里的明文被掩码;proposedToml(本就不含 token)原样保留', () => {
    const preview: LocalProxyCodexConfigPreview = {
      path: '/home/u/.codex/config.toml',
      exists: false,
      proposedToml: 'model_provider = "cindy_external"\n',
      conflicts: [],
      tokenExportLine: `export CINDY_LOCAL_TOKEN=${TOKEN}`,
    };
    const masked = maskCodexPreview(preview, TOKEN, MASKED);
    expect(masked.tokenExportLine).toBe(`export CINDY_LOCAL_TOKEN=${MASKED}`);
    expect(masked.proposedToml).toBe('model_provider = "cindy_external"\n');
    expect(JSON.stringify(masked)).not.toContain(TOKEN);
  });
});
