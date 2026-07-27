import { describe, expect, it } from 'vitest';
import { resolveConnectionBannerVisibility } from '@/components/connectionBannerVisibility';

const base = {
  offline: false,
  offlineLongEnough: false,
  hasError: false,
  hasIssue: false,
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
});
