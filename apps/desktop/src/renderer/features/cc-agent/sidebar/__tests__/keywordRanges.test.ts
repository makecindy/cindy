import { describe, expect, it } from 'vitest';

import { keywordRanges } from '../keywordRanges';

describe('keywordRanges', () => {
  it('ASCII 大小写折叠照常高亮', () => {
    expect(keywordRanges('please Login now', 'login')).toEqual([{ start: 7, end: 12 }]);
  });

  it('CJK 照常高亮', () => {
    expect(keywordRanges('请先登录再提交', '登录')).toEqual([{ start: 2, end: 4 }]);
  });

  it('İ（U+0130）折叠膨胀时高亮不错位（UTF-16 下标映射回原文）', () => {
    // İ 折叠为 i + U+0307（两个码点），旧实现会把 lowerText 的下标直接切原文：
    // 搜 bc 会错误切出 İb<mark>c</mark>；搜 a 会切出空标。
    expect(keywordRanges('İbc', 'bc')).toEqual([{ start: 1, end: 3 }]);
    expect(keywordRanges('İa', 'a')).toEqual([{ start: 1, end: 2 }]);
    expect(keywordRanges('İ', 'İ')).toEqual([{ start: 0, end: 1 }]);
  });

  it('emoji 等多 UTF-16 单元字符不错位', () => {
    // 😀 占 2 个 UTF-16 单元（下标 0–1），「登录」的正确区间是 [2,4)。
    expect(keywordRanges('😀登录报错', '登录')).toEqual([{ start: 2, end: 4 }]);
    expect(keywordRanges('😀😀甲乙', '甲乙')).toEqual([{ start: 4, end: 6 }]);
  });

  it('多命中与去重', () => {
    expect(keywordRanges('a a a', 'a')).toEqual([
      { start: 0, end: 1 },
      { start: 2, end: 3 },
      { start: 4, end: 5 },
    ]);
    // token 去重：query 重复词不重复计算。
    expect(keywordRanges('foo bar', 'foo foo')).toEqual([{ start: 0, end: 3 }]);
  });

  it('combining mark 后的 ASCII 仍按同源折叠命中', () => {
    // I + U+0301 后接空格 ABC。映射与小写串必须来自同一次折叠，
    // 否则上下文相关 locale 规则会让后面的 ABC 漏匹配。
    expect(keywordRanges('Í ABC', 'ABC')).toEqual([{ start: 3, end: 6 }]);
  });

  it('无命中返回空数组', () => {
    expect(keywordRanges('hello world', 'xyz')).toEqual([]);
    expect(keywordRanges('hello world', '***')).toEqual([]);
    expect(keywordRanges('', 'abc')).toEqual([]);
  });
});
