import { describe, expect, it } from 'vitest';

import {
  shouldShowInputMonitoringBadge,
  type InputMonitoringBadgeVisibilityInput,
} from '../inputMonitoringBadge.js';

function input(
  overrides: Partial<InputMonitoringBadgeVisibilityInput> = {},
): InputMonitoringBadgeVisibilityInput {
  return {
    supportsGlobalShortcut: true,
    shortcutNeedsPermission: false,
    fnRecordingBlocked: false,
    permissionStatus: 'denied',
    ...overrides,
  };
}

describe('shouldShowInputMonitoringBadge', () => {
  it('hides the badge when the platform does not support global shortcuts', () => {
    expect(shouldShowInputMonitoringBadge(input({
      supportsGlobalShortcut: false,
      shortcutNeedsPermission: true,
    }))).toBe(false);
  });

  it('hides the badge where the permission does not apply', () => {
    expect(shouldShowInputMonitoringBadge(input({
      shortcutNeedsPermission: true,
      fnRecordingBlocked: true,
      permissionStatus: 'not-required',
    }))).toBe(false);
  });

  it('shows the badge when the saved shortcut needs the native listener', () => {
    expect(shouldShowInputMonitoringBadge(input({ shortcutNeedsPermission: true }))).toBe(true);
  });

  // 这条守的是死锁在 Fn 路径上的残留：Fn 不经 DOM 派发，未授权时录不进去、存不下来，
  // 所以「已保存的快捷键需要权限」永远为 false。若徽章只看它，想改用 Fn 的用户就只能
  // 看到一行提示、找不到任何授权入口。
  it('shows the badge while Fn recording is permission-blocked, even if the saved shortcut needs no permission', () => {
    expect(shouldShowInputMonitoringBadge(input({
      shortcutNeedsPermission: false,
      fnRecordingBlocked: true,
    }))).toBe(true);
  });

  it('keeps the badge visible after the permission is granted so the state stays readable', () => {
    expect(shouldShowInputMonitoringBadge(input({
      shortcutNeedsPermission: true,
      permissionStatus: 'granted',
    }))).toBe(true);
  });

  it('hides the badge when nothing needs the permission', () => {
    expect(shouldShowInputMonitoringBadge(input())).toBe(false);
  });
});
