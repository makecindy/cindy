import { describe, expect, it } from 'vitest';

import {
  appendWithCap,
  formatCrashEntry,
  isAbnormalPreviousBoot,
  normalizeError,
  selectRejectionTracker,
} from '@/debug/crashCaptureFormat';

describe('normalizeError', () => {
  it('抽取 Error 的 message 与 stack', () => {
    const err = new Error('boom');
    const out = normalizeError(err);
    expect(out.message).toBe('boom');
    expect(out.stack).toContain('boom');
  });

  it('无 message 的 Error 退回 name', () => {
    const err = new Error('');
    expect(normalizeError(err).message).toBe('Error');
  });

  it('字符串 throw 原样作为 message,无 stack', () => {
    expect(normalizeError('just a string')).toEqual({ message: 'just a string' });
  });

  it('对象 throw 序列化为 message', () => {
    expect(normalizeError({ code: 42 }).message).toBe('{"code":42}');
  });
});

describe('formatCrashEntry', () => {
  const at = Date.parse('2026-07-25T00:00:00.000Z');

  it('包含时间戳 / 来源 / message / stack,并以换行结尾', () => {
    const entry = formatCrashEntry({
      source: 'uncaught',
      error: new Error('kaboom'),
      isFatal: true,
      at,
    });
    expect(entry).toContain('2026-07-25T00:00:00.000Z');
    expect(entry).toContain('uncaught FATAL: kaboom');
    expect(entry.endsWith('\n')).toBe(true);
  });

  it('非致命不带 FATAL 标记', () => {
    const entry = formatCrashEntry({ source: 'unhandledRejection', error: 'x', at });
    expect(entry).toContain('unhandledRejection: x');
    expect(entry).not.toContain('FATAL');
  });

  it('无 stack 时标注 (no stack)', () => {
    const entry = formatCrashEntry({ source: 'uncaught', error: 'oops', at });
    expect(entry).toContain('(no stack)');
  });

  it('附带 componentStack', () => {
    const entry = formatCrashEntry({
      source: 'react-render',
      error: new Error('render fail'),
      at,
      extra: '\n  in Foo\n  in Bar',
    });
    expect(entry).toContain('componentStack:');
    expect(entry).toContain('in Foo');
  });

  it('脱敏 message 里的 Bearer token', () => {
    const entry = formatCrashEntry({
      source: 'uncaught',
      error: new Error('request failed: Authorization: Bearer sk-abc123SECRET'),
      at,
    });
    expect(entry).not.toContain('sk-abc123SECRET');
    expect(entry).toContain('[REDACTED]');
  });

  it('脱敏 rejection 对象里的 authorization header', () => {
    const entry = formatCrashEntry({
      source: 'unhandledRejection',
      error: { url: 'https://x/api', authorization: 'Bearer topsecrettoken' },
      at,
    });
    expect(entry).not.toContain('topsecrettoken');
  });

  it('脱敏 stack / URL query 里的 token 与 api_key', () => {
    const err = new Error('boom');
    err.stack = 'Error: boom\n  at https://x/cb?access_token=LEAKED123&api_key=KEY456';
    const entry = formatCrashEntry({ source: 'uncaught', error: err, at });
    expect(entry).not.toContain('LEAKED123');
    expect(entry).not.toContain('KEY456');
  });

  it('脱敏 componentStack 里的密钥字段', () => {
    const entry = formatCrashEntry({
      source: 'react-render',
      error: new Error('x'),
      at,
      extra: '\n  in Comp (client_secret=shh-do-not-leak)',
    });
    expect(entry).not.toContain('shh-do-not-leak');
  });
});

describe('appendWithCap', () => {
  it('未超上限直接拼接', () => {
    expect(appendWithCap('a', 'b', 100)).toBe('ab');
  });

  it('超上限从头部截断保留尾部,并标注截断', () => {
    const existing = 'x'.repeat(90);
    const entry = 'y'.repeat(30);
    const out = appendWithCap(existing, entry, 50);
    expect(out.length).toBeLessThanOrEqual(50);
    expect(out).toContain('truncated');
    // 尾部最新内容(entry 末尾)必须保留
    expect(out.endsWith('y')).toBe(true);
  });

  it('上限比截断标记还短的极端情况:返回长度不超过上限', () => {
    const out = appendWithCap('', 'abcdefghij', 5);
    expect(out.length).toBeLessThanOrEqual(5);
    expect(out).toBe('fghij');
  });
});

describe('isAbnormalPreviousBoot', () => {
  it('无面包屑视为正常', () => {
    expect(isAbnormalPreviousBoot(null)).toBe(false);
    expect(isAbnormalPreviousBoot(undefined)).toBe(false);
    expect(isAbnormalPreviousBoot({})).toBe(false);
  });

  it("上次走到 ready 视为正常", () => {
    expect(isAbnormalPreviousBoot({ phase: 'ready' })).toBe(false);
  });

  it('上次卡在非 ready 阶段视为异常', () => {
    expect(isAbnormalPreviousBoot({ phase: 'starting' })).toBe(true);
    expect(isAbnormalPreviousBoot({ phase: 'ota' })).toBe(true);
    expect(isAbnormalPreviousBoot({ phase: 'auth' })).toBe(true);
  });

  it("预期内主动重载(reloading)视为正常,不误报", () => {
    expect(isAbnormalPreviousBoot({ phase: 'reloading' })).toBe(false);
  });
});

describe('selectRejectionTracker', () => {
  it('dev 让给 RN 自己的 tracker', () => {
    expect(selectRejectionTracker({ isDev: true, hermesHasPromise: true })).toBe('none');
    expect(selectRejectionTracker({ isDev: true, hermesHasPromise: false })).toBe('none');
  });

  it('正式包 Hermes 用 HermesInternal tracker', () => {
    expect(selectRejectionTracker({ isDev: false, hermesHasPromise: true })).toBe('hermes');
  });

  it('正式包非 Hermes(JSC)用 polyfill tracker', () => {
    expect(selectRejectionTracker({ isDev: false, hermesHasPromise: false })).toBe('polyfill');
  });
});
