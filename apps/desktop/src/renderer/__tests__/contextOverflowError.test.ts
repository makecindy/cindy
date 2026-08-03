import { describe, expect, it } from 'vitest';

import {
  CONTEXT_OVERFLOW_REASON,
  isContextOverflowError,
} from '@/utils/contextOverflowError';

/**
 * 与 maker-core `agents/shared/context-overflow-error.ts` 语义一致的镜像判定
 * (措辞集合三处同步, 见 util 模块注释)。这里额外锁 renderer 侧特有的分层:
 * 稳定 reason key 优先、文案 pattern 兜底(历史持久化错误行只有原文)。
 */
describe('isContextOverflowError', () => {
  it('trusts the stable reason key regardless of message text', () => {
    expect(isContextOverflowError('opaque upstream failure', CONTEXT_OVERFLOW_REASON)).toBe(true);
    expect(isContextOverflowError('opaque upstream failure', 'some-other-reason')).toBe(false);
  });

  it('falls back to message patterns for persisted rows without a reason', () => {
    // #1429 实踩的 litellm/Azure 原文
    expect(
      isContextOverflowError(
        'API Error: 400 litellm.BadRequestError: AzureException BadRequestError - { "error": { "message": "Your input exceeds the context window of this model.", "code": "context_length_exceeded" } }',
      ),
    ).toBe(true);
    expect(isContextOverflowError('prompt is too long: 250000 tokens > 200000 maximum')).toBe(true);
    expect(
      isContextOverflowError("This model's maximum context length is 128000 tokens."),
    ).toBe(true);
  });

  it('does not classify overload / network / auth errors as overflow', () => {
    expect(
      isContextOverflowError('Selected model is at capacity. Please try a different model.'),
    ).toBe(false);
    expect(isContextOverflowError('fetch failed: ECONNREFUSED')).toBe(false);
    expect(isContextOverflowError('401 Unauthorized: Missing bearer')).toBe(false);
  });
});
