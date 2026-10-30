/**
 * DS-2b Mobile ThemeColors 冻结守卫。
 *
 * 红灯不是禁令。有意改值的合法路径 = 同一 PR 更新本快照 + 按治理合同 §6 交证据 +
 * 设计师批准；禁止为绿灯加豁免或绕加载路径。
 *
 * 保护值（CINDY 皮肤族 DESIGN.md §15、U2 二级信息色、annotation-accent）另有比
 * 「改快照 + 设计师批准」更严的门槛，见治理合同 §1.1。
 *
 * 只冻结 ThemeColors（含嵌套 login）。spacing / radius / typeScale 不在本张范围。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { darkColors, lightColors, type ThemeColors } from '@/theme/tokens';

const FIXTURE = 'apps/mobile/src/__tests__/fixtures/theme-colors-snapshot.json';

interface ThemeColorsSnapshot {
  source: string;
  light: ThemeColors;
  dark: ThemeColors;
}

function themeFreezeMismatch(what: string): string {
  return [
    `${what} 与 DS-2b 冻结快照不一致。`,
    '红灯不是禁令。有意改值的合法路径 = 同一 PR 更新本快照 + 按治理合同 §6 交证据 + 设计师批准。',
    `更新方式：把实时提取结果写回 ${FIXTURE}（同一 PR 更新快照，不要加豁免）。`,
    '保护值（CINDY 皮肤族 DESIGN.md §15、U2 二级信息色、annotation-accent）另有比「改快照 + 设计师批准」更严的门槛，不能只更新本文件。',
    '禁止为绿灯加豁免或绕加载路径。',
  ].join('\n');
}

function readSnapshot(): ThemeColorsSnapshot {
  return JSON.parse(
    readFileSync(fileURLToPath(new URL('./fixtures/theme-colors-snapshot.json', import.meta.url)), 'utf8'),
  ) as ThemeColorsSnapshot;
}

function topLevelKeys(colors: ThemeColors): string[] {
  return Object.keys(colors);
}

describe('DS-2b · Mobile ThemeColors 冻结', () => {
  const snapshot = readSnapshot();

  it('snapshot 与实时提取的 top-level key 数一致', () => {
    expect(
      topLevelKeys(snapshot.light).length,
      themeFreezeMismatch('theme-colors-snapshot.light key 数'),
    ).toBe(topLevelKeys(lightColors).length);
    expect(
      topLevelKeys(snapshot.dark).length,
      themeFreezeMismatch('theme-colors-snapshot.dark key 数'),
    ).toBe(topLevelKeys(darkColors).length);
    expect(topLevelKeys(lightColors), themeFreezeMismatch('light/dark key 集合彼此')).toEqual(
      topLevelKeys(darkColors),
    );
  });

  it('light / dark ThemeColors（含嵌套 login）与快照逐值相等', () => {
    expect(lightColors, themeFreezeMismatch('Mobile lightColors')).toEqual(snapshot.light);
    expect(darkColors, themeFreezeMismatch('Mobile darkColors')).toEqual(snapshot.dark);
  });

  it('自证伪：模拟改名任一旧 key 后必然与快照不匹配', () => {
    expect(topLevelKeys(lightColors)[0]).toBe('surface');
    const renamed = Object.fromEntries(
      Object.entries(lightColors).map(([key, value], index) =>
        index === 0 ? ['surfaceRenamedForDs2bFalsification', value] : [key, value],
      ),
    );
    expect(renamed).not.toEqual(snapshot.light);
    expect(Object.keys(renamed)).not.toEqual(topLevelKeys(snapshot.light));
  });
});
