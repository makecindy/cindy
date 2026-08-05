/**
 * remoteSessionLoading.test.ts —— 远程会话首屏 loading 决策(慢网可见性)。
 *
 * 守住:本机会话恒不显示(零回归)、加载完成不显示、防闪窗口内不显示、
 * 仅「远程 + 未加载 + 延迟到期」三者同时成立才显示。
 */
import { describe, it, expect } from 'vitest';

import { shouldShowRemoteLoading } from '@/features/cc-agent/hooks/useRemoteSessionLoading';

describe('shouldShowRemoteLoading', () => {
  it('本机会话(isRemote=false)→ 恒不显示,无论其它参数', () => {
    expect(shouldShowRemoteLoading(false, false, true)).toBe(false);
    expect(shouldShowRemoteLoading(false, false, false)).toBe(false);
    expect(shouldShowRemoteLoading(false, true, true)).toBe(false);
  });

  it('远程 + 已加载 → 不显示(数据已就位)', () => {
    expect(shouldShowRemoteLoading(true, true, true)).toBe(false);
  });

  it('远程 + 未加载 + 防闪窗口内(delayElapsed=false)→ 不显示(快隧道不闪)', () => {
    expect(shouldShowRemoteLoading(true, false, false)).toBe(false);
  });

  it('远程 + 未加载 + 延迟到期 → 显示', () => {
    expect(shouldShowRemoteLoading(true, false, true)).toBe(true);
  });
});
