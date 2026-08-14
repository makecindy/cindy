import { describe, expect, it } from 'vitest';
import {
  resolveConnectionBannerSyncActionVisibility,
  resolveConnectionBannerVisibility,
  resolveEffectiveConnectionError,
} from '@/components/connectionBannerVisibility';

const base = {
  offline: false,
  offlineLongEnough: false,
  hasError: false,
  hasIssue: false,
  hasUnstableIssue: false,
  deviceUnresponsive: false,
};

describe('resolveConnectionBannerVisibility', () => {
  it('连接正常且无错误时不显示(不渲染常驻状态条)', () => {
    expect(resolveConnectionBannerVisibility(base)).toBe(false);
  });

  it('请求级 error 立即显示', () => {
    expect(resolveConnectionBannerVisibility({ ...base, hasError: true })).toBe(true);
  });

  it('目标设备熔断 open(电脑端未响应)即使 relay 仍 online 也立即显示', () => {
    // 2026-07 事故形态:桌面进程活着、presence 恒 online,但 invoke 永不回包——
    // 只看 status 的旧判定完全失明,unresponsive 必须是独立显示条件。
    expect(resolveConnectionBannerVisibility({ ...base, deviceUnresponsive: true })).toBe(true);
  });

  it('普通弱网断线:未超过防闪窗口不显示,超过后显示', () => {
    expect(resolveConnectionBannerVisibility({ ...base, offline: true })).toBe(false);
    expect(resolveConnectionBannerVisibility({ ...base, offline: true, offlineLongEnough: true })).toBe(true);
  });

  it('可分类连接问题(鉴权失效 / 被顶号等)在断线时立即显示,不等防闪窗口', () => {
    expect(resolveConnectionBannerVisibility({ ...base, offline: true, hasIssue: true })).toBe(true);
  });

  it('unstable 即使 relay 瞬时 online 也保持可见', () => {
    expect(resolveConnectionBannerVisibility({ ...base, hasUnstableIssue: true })).toBe(true);
  });
});

describe('resolveEffectiveConnectionError', () => {
  it('熔断已关后残留的 DEVICE_UNRESPONSIVE 错误按陈旧丢弃(review P1)', () => {
    // 屏幕在熔断 open 期间重试失败会把这类文案存进 error;探测成功自动关熔断
    // 只翻转 deviceUnresponsive,不清屏幕 error——不丢弃的话恢复后 banner 会
    // 带着"自动重试中"常驻到用户手动同步。
    expect(
      resolveEffectiveConnectionError('[DEVICE_UNRESPONSIVE] circuit open', false),
    ).toBeNull();
  });

  it('熔断仍 open 时保留原文(banner 的 unresponsive 分支优先,error 不会被展示)', () => {
    expect(
      resolveEffectiveConnectionError('[DEVICE_UNRESPONSIVE] circuit open', true),
    ).toBe('[DEVICE_UNRESPONSIVE] circuit open');
  });

  it('其他错误与空值原样透传', () => {
    expect(resolveEffectiveConnectionError('[NOT_CONNECTED] offline', false)).toBe('[NOT_CONNECTED] offline');
    expect(resolveEffectiveConnectionError(null, false)).toBeNull();
    expect(resolveEffectiveConnectionError(null, true)).toBeNull();
  });
});

describe('resolveConnectionBannerSyncActionVisibility', () => {
  const actionBase = {
    online: true,
    hasActiveIssue: false,
    deviceUnresponsive: false,
    hasRequestError: true,
    requestErrorAutoRecovering: false,
  };

  it('普通请求级同步失败仍可手动重试', () => {
    expect(resolveConnectionBannerSyncActionVisibility(actionBase)).toBe(true);
  });

  it('断线、连接 issue、熔断与瞬时请求错误都交给系统自动恢复', () => {
    expect(resolveConnectionBannerSyncActionVisibility({ ...actionBase, online: false })).toBe(false);
    expect(resolveConnectionBannerSyncActionVisibility({ ...actionBase, hasActiveIssue: true })).toBe(false);
    expect(resolveConnectionBannerSyncActionVisibility({ ...actionBase, deviceUnresponsive: true })).toBe(false);
    expect(resolveConnectionBannerSyncActionVisibility({
      ...actionBase,
      requestErrorAutoRecovering: true,
    })).toBe(false);
  });

  it('没有请求错误时不造一个常驻同步入口', () => {
    expect(resolveConnectionBannerSyncActionVisibility({
      ...actionBase,
      hasRequestError: false,
    })).toBe(false);
  });
});
