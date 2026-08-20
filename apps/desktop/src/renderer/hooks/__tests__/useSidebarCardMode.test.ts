import { describe, expect, it } from 'vitest';

import { shouldRefreshPinnedModeFromStorage } from '../useSidebarCardMode';

describe('shouldRefreshPinnedModeFromStorage', () => {
  it('无订阅者时回读 storage,避免副窗口用过期内存通知 main', () => {
    expect(shouldRefreshPinnedModeFromStorage(0)).toBe(true);
  });

  it('仍有订阅者时不回读,避免同窗口 setItem 失败被旧 storage 改回去', () => {
    expect(shouldRefreshPinnedModeFromStorage(1)).toBe(false);
  });
});
