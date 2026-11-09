/**
 * 测试价值
 * - 生产入口与可观察结果：`buildAgentIslandQuota` 把菜单栏余量视图投影成灵动岛显示的余量项。
 * - 规则依据：灵动岛余量「展示哪些和排序跟着菜单栏来」(2026-11-05 需求)；Cindy 标志在菜单栏
 *   以哨兵传递，灵动岛 helper 不认识哨兵，必须换成真实 SVG。
 * - 现有覆盖缺口：新模块，菜单栏与 iPhone 小组件的测试不覆盖这条投影。
 * - 最小失败输入：含按量付费、未读到的来源、额度用完只剩 credits、Cindy 余额的视图；登录门槛；
 *   菜单栏「最低余量」对应的套餐要标出来:窄宽度时它先占位、放不下完整余量时只显示它的百分比(2026-11-05 需求)。
 * - tier：unit，纯函数。
 */
import { describe, expect, it } from 'vitest';

import type { MenubarSourceCell, MenubarView } from '../../../shared/menubarQuota';
import { MENUBAR_CINDY_LOGO } from '../../menubar/logos';
import { buildAgentIslandQuota } from '../quota';

function cell(overrides: Partial<MenubarSourceCell> & Pick<MenubarSourceCell, 'id'>): MenubarSourceCell {
  return {
    kind: 'subscription',
    logoSvg: '<svg/>',
    name: overrides.id,
    value: null,
    valueUnit: null,
    valueLabel: null,
    level: 'normal',
    fill: 0.5,
    reserve: false,
    emphasized: false,
    active: false,
    when: '',
    whenLevel: 'normal',
    accessibilityLabel: `${overrides.id} label`,
    ...overrides,
  };
}

function view(sources: MenubarSourceCell[], gate?: MenubarView['gate'], lowest: string | null = null): MenubarView {
  return {
    sources,
    statusTextByMode: { icon: null, lowest, today: null, task: null },
    ...(gate ? { gate } : {}),
  } as MenubarView;
}

describe('buildAgentIslandQuota', () => {
  it('按菜单栏顺序只取有余量读数的来源,文字与级别同菜单栏', () => {
    const items = buildAgentIslandQuota(view([
      cell({ id: 'codex', value: '9', valueUnit: '%', level: 'error', fill: 0.09, stale: true }),
      cell({ id: 'payg', kind: 'payg', fill: null, valueLabel: 'Pay per use' }),
      cell({ id: 'unread', valueLabel: '—', fill: null }),
      cell({ id: 'claude', value: null, valueLabel: 'credits', fill: 0, reserve: true }),
      cell({ id: 'cindy', kind: 'balance', logoSvg: MENUBAR_CINDY_LOGO, value: '$12.30', fill: 0.6 }),
    ]));
    expect(items.map(({ id, text, level, stale }) => ({ id, text, level, stale }))).toEqual([
      { id: 'codex', text: '9%', level: 'error', stale: true },
      { id: 'claude', text: 'credits', level: 'normal', stale: false },
      { id: 'cindy', text: '$12.30', level: 'normal', stale: false },
    ]);
    expect(items[2]!.logoSvg.startsWith('<svg')).toBe(true);
    expect(items[0]!.accessibilityLabel).toBe('codex label');
  });

  it('登录前(菜单栏只显示登录提示)不显示余量', () => {
    expect(buildAgentIslandQuota(view([cell({ id: 'codex', value: '50', valueUnit: '%' })], 'sign-in', '50%'))).toEqual([]);
    expect(buildAgentIslandQuota(null)).toEqual([]);
  });

  it('标出菜单栏「最低余量」对应的套餐;同为最低时只标顺序靠前的一个,没有最低时都不标', () => {
    const sources = [
      cell({ id: 'claude', value: '72', valueUnit: '%' }),
      cell({ id: 'codex-a', value: '18', valueUnit: '%', level: 'warn' }),
      cell({ id: 'codex-b', value: '18', valueUnit: '%', level: 'warn' }),
    ];
    const lowestOf = (lowest: string | null) =>
      buildAgentIslandQuota(view(sources, undefined, lowest)).filter((item) => item.lowest).map((item) => item.id);
    expect(lowestOf('18%')).toEqual(['codex-a']);
    expect(lowestOf(null)).toEqual([]);
  });

  it('订阅额度全部用完、只剩额外 credits 时,菜单栏的 0% 仍落在一个套餐上并带折叠读数', () => {
    const items = buildAgentIslandQuota(view([
      cell({ id: 'claude', value: null, valueLabel: 'credits', fill: 0, reserve: true }),
      cell({ id: 'codex', value: null, valueLabel: 'credits', fill: 0, reserve: true }),
    ], undefined, '0%'));
    expect(items.map(({ id, lowest, compactText }) => ({ id, lowest, compactText }))).toEqual([
      { id: 'claude', lowest: true, compactText: '0%' },
      { id: 'codex', lowest: false, compactText: undefined },
    ]);
    expect(items[0]!.textWidth).toBeLessThan(items[0]!.width);
  });
});
