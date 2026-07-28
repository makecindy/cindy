/**
 * describeErrorChain 纯逻辑单测(规则 14)。
 *
 * 该函数承载 OAuth 换 token 失败日志的可诊断性:undici 把网络层失败包成裸
 * 'fetch failed' TypeError,真正可行动的细节(每地址族的 connect ETIMEDOUT /
 * ECONNREFUSED)藏在 cause 链与 AggregateError.errors 里。回归点:展开不丢层、
 * code 补注、AggregateError 平铺、深度有界不被恶意/异常循环链拖死。
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  shell: { openExternal: vi.fn() },
  app: {
    getPath: vi.fn(() => '/tmp/xdt-maker-test'),
    getAppPath: vi.fn(() => '/tmp/xdt-maker-test/app'),
    isPackaged: false,
  },
  safeStorage: { isEncryptionAvailable: vi.fn(() => false) },
}));

import { describeErrorChain } from '../claude-oauth-login.js';

describe('describeErrorChain', () => {
  it('非 Error 输入回退 String()', () => {
    expect(describeErrorChain('boom')).toBe('boom');
    expect(describeErrorChain(42)).toBe('42');
  });

  it('单层 Error 只输出 message', () => {
    expect(describeErrorChain(new Error('plain failure'))).toBe('plain failure');
  });

  it('undici 典型形态:fetch failed ← AggregateError(各地址族 connect 错误) 全部展开', () => {
    // 复刻 happy-eyeballs 全地址族被掐后的真实错误形状
    const v4 = Object.assign(new Error('connect ETIMEDOUT 160.79.104.10:443'), {
      code: 'ETIMEDOUT',
    });
    const v6 = Object.assign(new Error('connect ENETUNREACH 2607:6bc0::10:443'), {
      code: 'ENETUNREACH',
    });
    const aggregate = new AggregateError([v4, v6], '');
    const top = new TypeError('fetch failed', { cause: aggregate });

    const out = describeErrorChain(top);
    expect(out).toContain('fetch failed');
    expect(out).toContain('connect ETIMEDOUT 160.79.104.10:443');
    expect(out).toContain('connect ENETUNREACH 2607:6bc0::10:443');
    expect(out).toContain(' <- ');
  });

  it('message 不含 code 时补注 (CODE);已含时不重复', () => {
    const bare = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    expect(describeErrorChain(bare)).toBe('socket hang up (ECONNRESET)');

    const withCode = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), {
      code: 'ECONNREFUSED',
    });
    expect(describeErrorChain(withCode)).toBe('connect ECONNREFUSED 127.0.0.1:443');
  });

  it('空 message 时回退 code / name,不产出空段', () => {
    const noMsg = Object.assign(new Error(''), { code: 'ETIMEDOUT' });
    expect(describeErrorChain(noMsg)).toBe('ETIMEDOUT');
  });

  it('AggregateError 分支同样补 code / 回退空 message,不在聚合段留空洞', () => {
    const bareCode = Object.assign(new Error(''), { code: 'ECONNREFUSED' });
    const needsAnnotation = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    const aggregate = new AggregateError([bareCode, needsAnnotation], '');
    const top = new TypeError('fetch failed', { cause: aggregate });

    const out = describeErrorChain(top);
    expect(out).toContain('[ECONNREFUSED; socket hang up (ECONNRESET)]');
  });

  it('cause 链深度有界:超过上限截断,不无限展开', () => {
    let leaf: Error = new Error('depth-7');
    for (let i = 6; i >= 1; i -= 1) {
      leaf = new Error(`depth-${i}`, { cause: leaf });
    }
    const out = describeErrorChain(leaf);
    // MAX_CAUSE_DEPTH=4 → 最多 5 段(0..4)
    expect(out.split(' <- ')).toHaveLength(5);
    expect(out).toContain('depth-1');
    expect(out).toContain('depth-5');
    expect(out).not.toContain('depth-6');
  });
});
