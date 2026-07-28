import { describe, expect, it } from 'vitest';

import { claudeBehaviorFlagsForSpawn } from '../claude-behavior-flags.js';

describe('claudeBehaviorFlagsForSpawn', () => {
  it('keeps the CLI attribution default for oauth-spawn (issue #758)', () => {
    // 连了 Claude.ai 订阅:claude-* 请求可能直连 api.anthropic.com,归因块必须保留,
    // 否则 Auto 权限分类器子请求被上游 429,auto 模式全部写操作 fail-closed。
    const flags = claudeBehaviorFlagsForSpawn(true);
    expect(flags).not.toHaveProperty('CLAUDE_CODE_ATTRIBUTION_HEADER');
    // 其余行为开关不随 spawn 形态变化。
    expect(flags.CLAUDE_CODE_SKIP_FAST_MODE_NETWORK_ERRORS).toBe('1');
    expect(flags.ENABLE_TOOL_SEARCH).toBe('auto');
  });

  it('disables attribution for gateway-spawn to preserve gateway body-cache hits', () => {
    const flags = claudeBehaviorFlagsForSpawn(false);
    expect(flags.CLAUDE_CODE_ATTRIBUTION_HEADER).toBe('0');
    expect(flags.CLAUDE_CODE_SKIP_FAST_MODE_NETWORK_ERRORS).toBe('1');
    expect(flags.ENABLE_TOOL_SEARCH).toBe('auto');
  });

  it('returns a fresh object per call — env-builder Object.assign must not mutate shared state', () => {
    const a = claudeBehaviorFlagsForSpawn(false);
    a.CLAUDE_CODE_ATTRIBUTION_HEADER = 'mutated';
    expect(claudeBehaviorFlagsForSpawn(false).CLAUDE_CODE_ATTRIBUTION_HEADER).toBe('0');
  });
});
