/**
 * DS-2b 内置主题 override 冻结守卫。
 *
 * 红灯不是禁令。有意改值的合法路径 = 同一 PR 更新本快照 + 按治理合同 §6 交证据 +
 * 设计师批准；禁止为绿灯加豁免或绕加载路径。
 *
 * 保护值（CINDY 皮肤族 DESIGN.md §15、U2 二级信息色、annotation-accent）另有比
 * 「改快照 + 设计师批准」更严的门槛，见治理合同 §1.1。
 */
import { describe, expect, it } from 'vitest';

import { builtinThemes } from '../registry';
import { readJsonFixture, themeFreezeMismatch } from './themeFreezeSupport';

const FIXTURE = 'apps/desktop/src/renderer/themes/__tests__/fixtures/builtin-theme-overrides.json';

interface BuiltinThemeSnapshot {
  source: string;
  count: number;
  themeIds: string[];
  themes: Record<
    string,
    { id: string; name: string; type: string; colors: Record<string, string> }
  >;
}

function extractLive() {
  const themeIds = Object.keys(builtinThemes);
  const themes: BuiltinThemeSnapshot['themes'] = {};
  for (const id of themeIds) {
    const theme = builtinThemes[id];
    if (!theme) continue;
    themes[id] = {
      id: theme.id,
      name: theme.name,
      type: theme.type,
      colors: { ...(theme.colors as Record<string, string>) },
    };
  }
  return { themeIds, themes };
}

describe('DS-2b · 内置主题冻结', () => {
  const snapshot = readJsonFixture<BuiltinThemeSnapshot>(import.meta.url, './fixtures/builtin-theme-overrides.json');
  const live = extractLive();

  it('主题清单条目数与实时提取数一致', () => {
    expect(snapshot.themeIds.length, themeFreezeMismatch('themeIds.length', FIXTURE)).toBe(
      snapshot.count,
    );
    expect(live.themeIds.length, themeFreezeMismatch('builtinThemes 主题数', FIXTURE)).toBe(
      snapshot.count,
    );
    expect(Object.keys(snapshot.themes).length, themeFreezeMismatch('themes 对象键数', FIXTURE)).toBe(
      snapshot.count,
    );
  });

  it('11 套主题清单本身与快照一致（增删主题必须显式更新快照）', () => {
    expect(live.themeIds, themeFreezeMismatch('内置主题清单', FIXTURE)).toEqual(snapshot.themeIds);
  });

  it('每套主题的 id / name / type / override 集合逐值冻结', () => {
    expect(live.themes, themeFreezeMismatch('内置主题 override', FIXTURE)).toEqual(snapshot.themes);
  });

  it('自证伪：模拟改名任一主题 ID 后必然与快照不匹配', () => {
    expect(live.themeIds[0]).toBe('default-light');
    const renamedIds = live.themeIds.map((id, index) =>
      index === 0 ? 'default-light-renamed-for-ds2b-falsification' : id,
    );
    expect(renamedIds).not.toEqual(snapshot.themeIds);
  });
});
