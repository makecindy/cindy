/**
 * ghostWorkdirPrefs.test.ts — 目录级禁用偏好的纯函数单测(normalize +
 * 目录键归一化)。写路径 roundtrip 与生效链路(花名册/清单过滤、ghost_call
 * 兜底)见 mcp-integrations/__tests__/ghostWorkdirGate.test.ts。
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/never-used-here' } }));
vi.mock('../../maker-host/logger-adapter.js', () => ({
  desktopMakerLogger: { child: () => ({ info: () => {}, warn: () => {}, error: () => {} }) },
}));

const { __testing } = await import('../ghostWorkdirPrefs');

describe('normalizeWorkdirKey(纯字符串归一化,不碰 fs)', () => {
  it('Windows 形态:统一反斜杠、去尾分隔符、小写折叠', () => {
    expect(__testing.normalizeWorkdirKey('E:\\Cindy\\Cindy-Moved\\')).toBe('e:\\cindy\\cindy-moved');
    expect(__testing.normalizeWorkdirKey('E:/Cindy/Cindy-Moved')).toBe('e:\\cindy\\cindy-moved');
    expect(__testing.normalizeWorkdirKey('C:\\')).toBe('c:\\');
  });

  it('POSIX 形态(含远程 SSH 工作区):保留大小写,仅去尾 /', () => {
    expect(__testing.normalizeWorkdirKey('/home/User/Repo/')).toBe('/home/User/Repo');
    expect(__testing.normalizeWorkdirKey('/home/User/Repo')).toBe('/home/User/Repo');
    expect(__testing.normalizeWorkdirKey('/')).toBe('/');
  });

  it('空白输入 → 空键(调用方视为无语境)', () => {
    expect(__testing.normalizeWorkdirKey('  ')).toBe('');
  });
});

describe('normalize(坏形态清洗)', () => {
  it('preserves existing literal keys and keeps whitespace-distinct project policies separate', () => {
    const prefs = { disabledByWorkdir: { '/repo': ['old-plugin'], '/repo ': ['other-plugin'] } };
    expect(__testing.normalize(prefs)).toEqual(prefs);
    expect(__testing.normalizeWorkdirKey('/repo ')).toBe('/repo ');
  });
  it('合法条目保留(id 去重排序);空数组、非数组、空目录键全部清掉', () => {
    expect(
      __testing.normalize({
        disabledByWorkdir: {
          '/a': ['b-ghost', 'a-ghost', 'b-ghost', '', 42],
          '/empty': [],
          '/bad': 'not-an-array',
          '   ': ['x'],
        },
      }),
    ).toEqual({ disabledByWorkdir: { '/a': ['a-ghost', 'b-ghost'] } });
  });

  it('同一目录不同写法归一后撞键 → 并集(手改文件容错)', () => {
    expect(
      __testing.normalize({
        disabledByWorkdir: {
          'E:\\Repo': ['g1'],
          'e:/repo/': ['g2'],
        },
      }),
    ).toEqual({ disabledByWorkdir: { 'e:\\repo': ['g1', 'g2'] } });
  });

  it('整体不是对象 / 缺 disabledByWorkdir → 空表', () => {
    expect(__testing.normalize(null)).toEqual({ disabledByWorkdir: {} });
    expect(__testing.normalize({ disabledByWorkdir: [] })).toEqual({ disabledByWorkdir: {} });
  });
});
