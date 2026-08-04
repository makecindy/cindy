import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { NOTIFY_TITLE_MAX_LENGTH } from '@cindy/device-link';
import { MobileNotifyDeduper, buildSessionNotifyPayload } from '../mobileNotify';

describe('buildSessionNotifyPayload', () => {
  const base = {
    sessionId: 'session-1234',
    title: '修复登录问题',
    kind: 'done' as const,
    selfDeviceId: 'desktop-abcd',
  };

  it('kind 映射 category,deepLink 为 scheme 无关的应用内路径', () => {
    expect(buildSessionNotifyPayload(base)).toEqual({
      category: 'session-done',
      title: '修复登录问题',
      body: '已完成 ✓',
      deepLink: '/sessions/session-1234?deviceId=desktop-abcd',
      collapseId: createHash('sha256')
        .update('desktop-abcd:session-1234')
        .digest('hex')
        .slice(0, 32),
    });
    expect(buildSessionNotifyPayload({ ...base, kind: 'error' }).category).toBe('session-error');
    expect(buildSessionNotifyPayload({ ...base, kind: 'needs-reply' }).category).toBe(
      'session-needs-reply',
    );
  });

  it('detail 摘要作为正文:折叠空白、超协议上限截断;缺省回退终态文案', () => {
    const withDetail = buildSessionNotifyPayload({
      ...base,
      detail: '  修好了,\n共改了 3 个文件。  ',
    });
    expect(withDetail.body).toBe('修好了, 共改了 3 个文件。');
    const long = buildSessionNotifyPayload({ ...base, detail: 'x'.repeat(500) });
    expect(long.body).toHaveLength(240);
    expect(buildSessionNotifyPayload({ ...base, detail: '   ' }).body).toBe('已完成 ✓');
  });

  it('collapseId 哈希压缩:长 deviceId 也稳定在 32 hex(APNs 64B 上限内),不同会话不同键', () => {
    const longDevice = { ...base, selfDeviceId: 'f'.repeat(64) };
    const a = buildSessionNotifyPayload(longDevice).collapseId;
    const b = buildSessionNotifyPayload({ ...longDevice, sessionId: 'session-5678' }).collapseId;
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(Buffer.byteLength(a, 'utf8')).toBeLessThanOrEqual(64);
    expect(a).not.toBe(b);
    // 同输入确定性(轮换/重发时系统层才能正确合并)
    expect(buildSessionNotifyPayload(longDevice).collapseId).toBe(a);
  });

  it('标题空白时回退 sessionId 前 8 位,超限截断到协议上限', () => {
    expect(buildSessionNotifyPayload({ ...base, title: '   ' }).title).toBe('session-');
    const long = buildSessionNotifyPayload({ ...base, title: 'x'.repeat(500) });
    expect(long.title).toHaveLength(NOTIFY_TITLE_MAX_LENGTH);
  });

  it('deepLink 对特殊字符做 URL 编码', () => {
    const payload = buildSessionNotifyPayload({ ...base, sessionId: 'a/b?c' });
    expect(payload.deepLink).toBe('/sessions/a%2Fb%3Fc?deviceId=desktop-abcd');
  });
});

describe('MobileNotifyDeduper', () => {
  it('同 session + kind 窗口内只放行一次,窗口滚动后恢复', () => {
    const deduper = new MobileNotifyDeduper(5_000);
    expect(deduper.shouldSend('s1', 'done', 0)).toBe(true);
    expect(deduper.shouldSend('s1', 'done', 4_999)).toBe(false);
    expect(deduper.shouldSend('s1', 'done', 5_000)).toBe(true);
  });

  it('不同 kind / 不同 session 互不压制', () => {
    const deduper = new MobileNotifyDeduper(5_000);
    expect(deduper.shouldSend('s1', 'needs-reply', 0)).toBe(true);
    expect(deduper.shouldSend('s1', 'done', 1)).toBe(true);
    expect(deduper.shouldSend('s2', 'done', 2)).toBe(true);
  });
});
