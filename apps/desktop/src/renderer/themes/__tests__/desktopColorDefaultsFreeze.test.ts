/**
 * DS-2b Desktop Color ID 冻结守卫。
 *
 * 红灯不是禁令。有意改值的合法路径 = 同一 PR 更新本快照 + 按治理合同 §6 交证据 +
 * 设计师批准；禁止为绿灯加豁免或绕加载路径。
 *
 * 保护值（CINDY 皮肤族 DESIGN.md §15、U2 二级信息色、annotation-accent）另有比
 * 「改快照 + 设计师批准」更严的门槛，见治理合同 §1.1。
 */
import { describe, expect, it } from 'vitest';

import { colorRegistry } from '../color-registry';
import '../colors';
import { readJsonFixture, themeFreezeMismatch } from './themeFreezeSupport';

const FIXTURE = 'apps/desktop/src/renderer/themes/__tests__/fixtures/desktop-color-defaults.json';

interface ColorDefaultsSnapshot {
  source: string;
  count: number;
  colors: Array<{ id: string; light: string | null; dark: string | null }>;
}

function extractLive() {
  return colorRegistry.getColors().map((entry) => ({
    id: entry.id,
    light: entry.defaults.light,
    dark: entry.defaults.dark,
  }));
}

describe('DS-2b · Desktop Color ID 冻结', () => {
  const snapshot = readJsonFixture<ColorDefaultsSnapshot>(
    import.meta.url,
    './fixtures/desktop-color-defaults.json',
  );
  const live = extractLive();

  it('snapshot 条目数与实时提取数一致', () => {
    expect(
      snapshot.colors.length,
      themeFreezeMismatch('desktop-color-defaults.colors.length', FIXTURE),
    ).toBe(snapshot.count);
    expect(live.length, themeFreezeMismatch('实时 registerColor 数', FIXTURE)).toBe(snapshot.count);
  });

  it('全量 id + light/dark 默认值与快照逐值相等', () => {
    expect(live, themeFreezeMismatch('Desktop ColorRegistry 默认值', FIXTURE)).toEqual(
      snapshot.colors,
    );
  });

  it('自证伪：模拟改名任一旧 ID 后必然与快照不匹配', () => {
    expect(live[0]?.id).toBe('surface');
    const renamed = live.map((entry, index) =>
      index === 0 ? { ...entry, id: 'surface-renamed-for-ds2b-falsification' } : entry,
    );
    expect(renamed).not.toEqual(snapshot.colors);
    expect(renamed.map((entry) => entry.id)).not.toEqual(snapshot.colors.map((entry) => entry.id));
  });
});
