/**
 * branchFilter.test.ts — 分支下拉搜索框的过滤语义(纯函数)回归。
 *
 * 匹配口径契约:
 *  - 大小写不敏感的**子串**匹配,不做模糊 / 乱序 / 分词;
 *  - `/` 参与匹配,可以直接搜 `cindy/auto` 这样的中间段;
 *  - 空白搜索词(含只有空格)等于不过滤,且返回原数组引用本身;
 *  - 永不改动入参数组。
 */
import { describe, expect, it } from 'vitest';

import { filterBranches } from '../components/new-chat/branchFilter';

const BRANCHES = [
  'cindy/auto-k6cgvq',
  'cindy/auto-nv69fk',
  'fix/feishu-ack-emoji',
  'main',
];

describe('filterBranches', () => {
  it('空搜索词不过滤,并原样返回入参引用', () => {
    for (const q of ['', ' ', '   ', '\t']) {
      // 引用相等是有意的契约:上层拿它进 useMemo,未搜索时少一次列表 diff。
      expect(filterBranches(BRANCHES, q)).toBe(BRANCHES);
    }
  });

  it('按子串过滤,只留命中的分支', () => {
    expect(filterBranches(BRANCHES, 'feishu')).toEqual(['fix/feishu-ack-emoji']);
    expect(filterBranches(BRANCHES, 'auto')).toEqual([
      'cindy/auto-k6cgvq',
      'cindy/auto-nv69fk',
    ]);
  });

  it('大小写不敏感,两个方向都不敏感', () => {
    expect(filterBranches(BRANCHES, 'FEISHU')).toEqual(['fix/feishu-ack-emoji']);
    expect(filterBranches(BRANCHES, 'MaIn')).toEqual(['main']);
    expect(filterBranches(['FIX/Login', 'main'], 'fix/login')).toEqual(['FIX/Login']);
  });

  it('搜索词首尾空格被忽略,词内空格不忽略', () => {
    expect(filterBranches(BRANCHES, '  main  ')).toEqual(['main']);
    // 分支名里没有空格 → 带内部空格的词一个都匹配不上,不做分词补救。
    expect(filterBranches(BRANCHES, 'fix feishu')).toEqual([]);
  });

  it('`/` 参与匹配,可以搜中间段与跨段前缀', () => {
    expect(filterBranches(BRANCHES, 'cindy/auto')).toEqual([
      'cindy/auto-k6cgvq',
      'cindy/auto-nv69fk',
    ]);
    expect(filterBranches(BRANCHES, '/')).toEqual([
      'cindy/auto-k6cgvq',
      'cindy/auto-nv69fk',
      'fix/feishu-ack-emoji',
    ]);
  });

  it('一个都没命中时返回空数组,不是原数组', () => {
    const out = filterBranches(BRANCHES, 'zzz');
    expect(out).toEqual([]);
    expect(out).not.toBe(BRANCHES);
  });

  it('保持原有顺序,不按相关度重排', () => {
    // 命中位置更靠前的 `main` 不会被提到 `remotes-maintenance` 之前。
    expect(filterBranches(['remotes-maintenance', 'main'], 'main')).toEqual([
      'remotes-maintenance',
      'main',
    ]);
  });

  it('不改动入参数组', () => {
    const input = [...BRANCHES];
    filterBranches(input, 'auto');
    expect(input).toEqual(BRANCHES);
  });

  it('空分支列表在任何搜索词下都是空', () => {
    expect(filterBranches([], '')).toEqual([]);
    expect(filterBranches([], 'main')).toEqual([]);
  });
});
