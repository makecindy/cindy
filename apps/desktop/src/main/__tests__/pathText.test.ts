import { describe, expect, it } from 'vitest';
import {
  posixDrivePathToWin32,
  stripTrailingPathSeparators,
  stripWindowsDriveUriSlash,
} from '../../shared/pathText';

// Frozen [input, expected] table mirroring what the old `replace(/[\\/]+$/, '')` produced.
// Literals (not a regex oracle) so this regression test never reintroduces the
// js/polynomial-redos pattern it exists to eliminate.
const CASES: ReadonlyArray<readonly [input: string, expected: string]> = [
  ['', ''],
  ['/', ''],
  ['\\', ''],
  ['//', ''],
  ['\\\\', ''],
  ['/mixed/\\', '/mixed'],
  ['C:\\Users\\me\\', 'C:\\Users\\me'],
  ['/Users/me/project', '/Users/me/project'],
  ['/Users/me/project/', '/Users/me/project'],
  ['/Users/me/project///', '/Users/me/project'],
  ['relative/dir\\/', 'relative/dir'],
  ['no-sep', 'no-sep'],
  ['trailing.dot.', 'trailing.dot.'],
  ['/a/b/c/\\/\\/', '/a/b/c'],
];

describe('stripTrailingPathSeparators', () => {
  it('matches the legacy trailing-separator strip on representative inputs', () => {
    for (const [input, expected] of CASES) {
      expect(stripTrailingPathSeparators(input)).toBe(expected);
    }
  });

  it('only strips the trailing run of separators', () => {
    expect(stripTrailingPathSeparators('/Users/me/project/')).toBe('/Users/me/project');
    expect(stripTrailingPathSeparators('/Users/me/project')).toBe('/Users/me/project');
    expect(stripTrailingPathSeparators('////')).toBe('');
    expect(stripTrailingPathSeparators('a\\b\\\\')).toBe('a\\b');
  });

  it('returns the same reference when there is nothing to strip', () => {
    const s = '/no/trailing/sep';
    expect(stripTrailingPathSeparators(s)).toBe(s);
  });
});

// #8726: `/D:/x` 是盘符路径的 URI pathname 写法,模型会在 markdown 链接里生成
// (`[dir](/D:/Java)`);不剥掉前导斜杠时 Windows 把它当成当前盘下的非法相对路径。
describe('stripWindowsDriveUriSlash', () => {
  const CASES: ReadonlyArray<readonly [input: string, expected: string]> = [
    ['/D:/Java', 'D:/Java'],
    ['/d:/x', 'd:/x'],
    ['/D:\\Java', 'D:\\Java'],
    ['/D:/', 'D:/'],
    // 裸盘符是盘根目录的 URI 写法(目录链接尾斜杠剥落后也是这个形态)
    ['/D:', 'D:/'],
    // 非盘符 URI 形态一律原样返回
    ['/Users/me', '/Users/me'],
    ['D:/Java', 'D:/Java'],
    ['//D:/x', '//D:/x'],
    ['file:///D:/x', 'file:///D:/x'],
    ['', ''],
  ];

  it.each(CASES)('%s → %s', (input, expected) => {
    expect(stripWindowsDriveUriSlash(input)).toBe(expected);
  });
});

describe('posixDrivePathToWin32', () => {
  const CASES: ReadonlyArray<readonly [input: string, expected: string]> = [
    ['/e/AIWork/x', 'E:\\AIWork\\x'],
    ['/D:/Java', 'D:\\Java'],
    ['/d:/x', 'D:\\x'],
    ['/D:\\Java', 'D:\\Java'],
    ['/d/', 'D:\\'],
    ['/D:', 'D:\\'],
    // 非盘符形态原样返回
    ['/Users/me', '/Users/me'],
    ['D:/Java', 'D:/Java'],
    ['', ''],
  ];

  it.each(CASES)('%s → %s', (input, expected) => {
    expect(posixDrivePathToWin32(input)).toBe(expected);
  });
});
