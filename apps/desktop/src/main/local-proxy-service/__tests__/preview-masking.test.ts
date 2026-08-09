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
import { MASK_FALLBACK, maskAnthropicPreview, maskCodexPreview } from '../preview-masking';

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

  it('冲突项:next(=token)掩成 token 掩码,current(用户既有真 key)兜底掩掉,非密文段保留', () => {
    const EXISTING_USER_KEY = 'sk-old-user-key';
    const preview: LocalProxyConfigPreview = {
      path: '/home/u/.claude/settings.json',
      exists: true,
      proposedEnv: {
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:51888',
        ANTHROPIC_API_KEY: TOKEN,
      },
      conflicts: [
        { key: 'ANTHROPIC_API_KEY', current: EXISTING_USER_KEY, next: TOKEN },
        { key: 'ANTHROPIC_BASE_URL', current: 'https://old', next: 'http://127.0.0.1:51888' },
      ],
    };
    const masked = maskAnthropicPreview(preview, TOKEN, MASKED);
    const apiKeyConflict = masked.conflicts.find((c) => c.key === 'ANTHROPIC_API_KEY');
    // next(= 我们的 token)→ token 掩码;current(用户既有真 key,Finding F)→ 通用占位,绝不原样过 IPC。
    expect(apiKeyConflict?.next).toBe(MASKED);
    expect(apiKeyConflict?.current).toBe(MASK_FALLBACK);
    const baseUrlConflict = masked.conflicts.find((c) => c.key === 'ANTHROPIC_BASE_URL');
    expect(baseUrlConflict?.current).toBe('https://old');
    expect(baseUrlConflict?.next).toBe('http://127.0.0.1:51888');
    // 我们的 token 与用户既有真 key 都不得出现在序列化后的预览里。
    expect(JSON.stringify(masked)).not.toContain(TOKEN);
    expect(JSON.stringify(masked)).not.toContain(EXISTING_USER_KEY);
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
