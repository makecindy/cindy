// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { decideLoginFirstLaunchLight } from '../useTheme';

/**
 * 首启亮色门判定核心的回归(Greptile P1:renderer localStorage 被清空但主进程
 * 仍持有会话时,bootstrap 误判真首启 → 已登录暗色用户亮色首帧/锁亮色)。
 * 判定三条件缺一不可,重点覆盖 mainHasPersistedSession 这条新增否决线。
 */
describe('decideLoginFirstLaunchLight', () => {
  it('真首启:无标记 + 空存储 + 主进程无会话 → 激活亮色门', () => {
    expect(
      decideLoginFirstLaunchLight({
        hasShownMarker: false,
        rendererStorageEmpty: true,
        mainHasPersistedSession: false,
      }),
    ).toBe(true);
  });

  it('localStorage 被清空但主进程持有存量会话 → 不激活(修复的核心分支)', () => {
    expect(
      decideLoginFirstLaunchLight({
        hasShownMarker: false,
        rendererStorageEmpty: true,
        mainHasPersistedSession: true,
      }),
    ).toBe(false);
  });

  it('已有「已展示」标记 → 恒不激活', () => {
    expect(
      decideLoginFirstLaunchLight({
        hasShownMarker: true,
        rendererStorageEmpty: true,
        mainHasPersistedSession: false,
      }),
    ).toBe(false);
  });

  it('存储非空(老用户升级)→ 不激活', () => {
    expect(
      decideLoginFirstLaunchLight({
        hasShownMarker: false,
        rendererStorageEmpty: false,
        mainHasPersistedSession: false,
      }),
    ).toBe(false);
  });
});
