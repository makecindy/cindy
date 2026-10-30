/**
 * DS-2b 用户本地主题不变量（renderer 归一化）。
 *
 * 红灯不是禁令。有意改值的合法路径 = 同一 PR 更新本快照 + 按治理合同 §6 交证据 +
 * 设计师批准；禁止为绿灯加豁免或绕加载路径。
 *
 * 保护值（CINDY 皮肤族 DESIGN.md §15、U2 二级信息色、annotation-accent）另有比
 * 「改快照 + 设计师批准」更严的门槛，见治理合同 §1.1。
 *
 * 本文件冻结 normalizeLocalThemeColors 的内存行为。磁盘字节由
 * apps/desktop/src/main/__tests__/localThemesDiskInvariants.test.ts 守。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { normalizeLocalThemeColors } from '../local-themes-normalize';

const FIXTURE_DIR = './fixtures/local-themes';

interface LocalThemeFixture {
  id: string;
  name: string;
  type: 'light' | 'dark';
  family?: string;
  colors: Record<string, string>;
}

function readThemeFixture(name: string): LocalThemeFixture {
  return JSON.parse(
    readFileSync(fileURLToPath(new URL(`${FIXTURE_DIR}/${name}`, import.meta.url)), 'utf8'),
  ) as LocalThemeFixture;
}

function normalizeTwice(colors: Record<string, string>): {
  first: Record<string, string>;
  second: Record<string, string>;
} {
  const first = normalizeLocalThemeColors(colors);
  const second = normalizeLocalThemeColors(first);
  return { first, second };
}

describe('DS-2b · 用户主题归一化不变量', () => {
  it('归一化执行两次结果相同（幂等）', () => {
    const fixtures = [
      'legacy-placeholder.json',
      'unknown-colors.json',
      'unknown-toplevel.json',
      'external-import-missing-switch.json',
    ];
    for (const name of fixtures) {
      const theme = readThemeFixture(name);
      const { first, second } = normalizeTwice(theme.colors);
      expect(second, `${name} 第二次归一化必须与第一次相同`).toEqual(first);
    }
  });

  it('colors 内未知字段在内存投影中保留', () => {
    const theme = readThemeFixture('unknown-colors.json');
    const { first } = normalizeTwice(theme.colors);
    expect(first['my-plugin-accent']).toBe('#112233');
    expect(first['future-slot-xyz']).toBe('var(--text-secondary)');
    expect(first.surface).toBe('#101010');
    expect(first['text-primary']).toBe('#eeeeee');
  });

  it('旧 per-surface placeholder 只在内存里收口到 text-placeholder，不要求调用方改输入对象', () => {
    const theme = readThemeFixture('legacy-placeholder.json');
    const input = { ...theme.colors };
    const out = normalizeLocalThemeColors(input);

    expect(input).toEqual(theme.colors);
    expect(out['text-placeholder']).toBe('#c4c4c4');
    expect(out['settings-input-placeholder']).toBeUndefined();
    expect(out['chat-input-placeholder']).toBeUndefined();
    expect(out['ask-input-placeholder']).toBeUndefined();
    expect(out['plan-action-fb-placeholder']).toBeUndefined();
  });

  it('外部导入缺 Switch token 时只在内存补齐，输入对象不变', () => {
    const theme = readThemeFixture('external-import-missing-switch.json');
    const input = { ...theme.colors };
    const out = normalizeLocalThemeColors(input);

    expect(input).toEqual(theme.colors);
    expect(out['switch-track-off']).toEqual(expect.stringMatching(/^#/));
    expect(out['switch-thumb-off']).toEqual(expect.stringMatching(/^#/));
    expect(theme.colors['switch-track-off']).toBeUndefined();
    expect(theme.colors['switch-thumb-off']).toBeUndefined();
  });

  it('缺 family 的本地主题仍可归一化（老文件行为）', () => {
    const theme = readThemeFixture('legacy-placeholder.json');
    expect(theme.family).toBeUndefined();
    expect(() => normalizeLocalThemeColors(theme.colors)).not.toThrow();
  });
});
