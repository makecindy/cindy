/**
 * 依据与覆盖缺口：验证插件引擎配额在桌面/手机共用纯逻辑下的模型归组、周期排序、周限总览与百分比格式。
 * 最小失败输入：Antigravity 上报 Gemini Models + Claude and GPT models 双组（且未填 `models` 字段）时，
 *   Gemini 4 Neon 若错误落回最紧缺组会显示 Claude/GPT 配额或把周限排在 5h 之前；
 *   显式声明 `models` 的插件若未命中某模型却回退到别组会张冠李戴。
 * tier：unit（纯函数，无 IO/DOM/原生依赖）。
 */
import { describe, expect, it } from 'vitest';

import {
  effectivePluginWindowMinutes,
  formatPluginQuotaPercent,
  orderPluginUsageCardWindows,
  parsePluginQuotaWindowLabel,
  pickPluginEngineQuotaPools,
  pickPluginEngineWeeklyQuota,
  pickPluginModelPickerWindow,
  selectPluginWindowsForModel,
  type PluginQuotaSnapshot,
  type PluginQuotaWindow,
} from '../pluginEngineQuota';

const NOW = Date.UTC(2026, 10, 27, 2, 0, 0);
const FIVE_HOURS_LATER = NOW + 4 * 3_600_000 + 18 * 60_000;
const SEVEN_DAYS_LATER = NOW + 6 * 86_400_000 + 23 * 3_600_000;

const ANTIGRAVITY_WINDOWS: PluginQuotaWindow[] = [
  {
    label: 'Gemini Models · weekly',
    remainingPercent: 94.92,
    resetsAt: SEVEN_DAYS_LATER,
    windowMinutes: 10080,
  },
  {
    label: 'Gemini Models · 5h',
    remainingPercent: 79.69,
    resetsAt: FIVE_HOURS_LATER,
    windowMinutes: 300,
  },
  {
    label: 'Claude and GPT models · weekly',
    remainingPercent: 91.87,
    resetsAt: SEVEN_DAYS_LATER + 17 * 60_000,
    windowMinutes: 10080,
  },
  {
    label: 'Claude and GPT models · 5h',
    remainingPercent: 83.73,
    resetsAt: FIVE_HOURS_LATER + 17 * 60_000,
    windowMinutes: 300,
  },
];

describe('pluginEngineQuota', () => {
  it('parses group prefixes and period durations without hardcoding plugin names', () => {
    expect(parsePluginQuotaWindowLabel('Gemini Models · 5h')).toEqual({
      groupName: 'Gemini Models',
      periodText: '5h',
      inferredMinutes: 300,
    });
    expect(parsePluginQuotaWindowLabel('Claude and GPT models · weekly')).toEqual({
      groupName: 'Claude and GPT models',
      periodText: 'weekly',
      inferredMinutes: 10080,
    });
    expect(parsePluginQuotaWindowLabel('5h')).toEqual({
      groupName: null,
      periodText: '5h',
      inferredMinutes: 300,
    });
    expect(parsePluginQuotaWindowLabel('Shared quota')).toEqual({
      groupName: null,
      periodText: null,
      inferredMinutes: null,
    });
    expect(effectivePluginWindowMinutes({ label: 'Custom · 24h' })).toBe(1440);
    expect(effectivePluginWindowMinutes({ label: 'Custom', windowMinutes: 300 })).toBe(300);
  });

  it('matches the active model group and sorts short windows before weekly windows', () => {
    const gemini = selectPluginWindowsForModel(
      ANTIGRAVITY_WINDOWS,
      { id: 'gemini-4-neon', displayName: 'Gemini 4 Neon' },
      NOW,
    );
    expect(gemini.matchedModel).toBe(true);
    expect(gemini.groupName).toBe('Gemini Models');
    expect(gemini.windows.map((w) => w.label)).toEqual([
      'Gemini Models · 5h',
      'Gemini Models · weekly',
    ]);

    const claude = selectPluginWindowsForModel(
      ANTIGRAVITY_WINDOWS,
      { id: 'claude-opus-5-5', displayName: 'Claude Opus 5.5' },
      NOW,
    );
    expect(claude.matchedModel).toBe(true);
    expect(claude.groupName).toBe('Claude and GPT models');
    expect(claude.windows.map((w) => w.label)).toEqual([
      'Claude and GPT models · 5h',
      'Claude and GPT models · weekly',
    ]);

    const gpt = selectPluginWindowsForModel(
      ANTIGRAVITY_WINDOWS,
      { id: 'gpt-oss-120b', displayName: 'GPT-OSS 120B' },
      NOW,
    );
    expect(gpt.matchedModel).toBe(true);
    expect(gpt.groupName).toBe('Claude and GPT models');
  });

  it('prefers explicit models[] declarations and refuses to borrow another model group in strict mode', () => {
    const scopedWindows: PluginQuotaWindow[] = [
      { label: 'Pro · weekly', remainingPercent: 90, resetsAt: SEVEN_DAYS_LATER, windowMinutes: 10080, models: ['model-a'] },
      { label: 'Pro · 5h', remainingPercent: 40, resetsAt: FIVE_HOURS_LATER, windowMinutes: 300, models: ['model-a'] },
      { label: 'Flash · 5h', remainingPercent: 98, resetsAt: FIVE_HOURS_LATER, windowMinutes: 300, models: ['model-b'] },
    ];
    const hit = selectPluginWindowsForModel(scopedWindows, { id: 'model-a', displayName: 'Model A' }, NOW, {
      strictModelMatch: true,
    });
    expect(hit.windows.map((w) => w.label)).toEqual(['Pro · 5h', 'Pro · weekly']);

    const missStrict = selectPluginWindowsForModel(scopedWindows, { id: 'model-c', displayName: 'Model C' }, NOW, {
      strictModelMatch: true,
    });
    expect(missStrict.windows).toEqual([]);

    const missDisplay = selectPluginWindowsForModel(scopedWindows, { id: 'model-c', displayName: 'Model C' }, NOW);
    expect(missDisplay.windows).toEqual([]);
  });

  it('falls back to the tightest group for unmatched models on status surfaces, but stays empty in strict picker rows', () => {
    const fallbackStatus = selectPluginWindowsForModel(
      ANTIGRAVITY_WINDOWS,
      { id: 'orchestrator-neon', displayName: 'Orchestrator (Neon)' },
      NOW,
    );
    expect(fallbackStatus.matchedModel).toBe(false);
    // Gemini 5h is 79.69% < Claude/GPT 5h 83.73%, so Gemini group's paired 5h + weekly are returned.
    expect(fallbackStatus.windows.map((w) => w.label)).toEqual([
      'Gemini Models · 5h',
      'Gemini Models · weekly',
    ]);

    const strictRow = selectPluginWindowsForModel(
      ANTIGRAVITY_WINDOWS,
      { id: 'orchestrator-neon', displayName: 'Orchestrator (Neon)' },
      NOW,
      { strictModelMatch: true },
    );
    expect(strictRow.windows).toEqual([]);
  });

  it('resolves model groups on the full snapshot before dropping expired windows so an expired group never borrows another group', () => {
    const geminiExpiredWindows: PluginQuotaWindow[] = [
      { label: 'Gemini Models · weekly', remainingPercent: 10, resetsAt: NOW - 60_000, windowMinutes: 10080 },
      { label: 'Gemini Models · 5h', remainingPercent: 0, resetsAt: NOW - 60_000, windowMinutes: 300 },
      { label: 'Claude and GPT models · weekly', remainingPercent: 92, resetsAt: SEVEN_DAYS_LATER, windowMinutes: 10080 },
      { label: 'Claude and GPT models · 5h', remainingPercent: 84, resetsAt: FIVE_HOURS_LATER, windowMinutes: 300 },
    ];
    const snapshot: PluginQuotaSnapshot = { updatedAt: NOW, windows: geminiExpiredWindows };

    // Gemini's own group expired -> never falls into the single-group branch and leaks Claude/GPT.
    const geminiStrict = selectPluginWindowsForModel(
      geminiExpiredWindows,
      { id: 'gemini-4-neon', displayName: 'Gemini 4 Neon' },
      NOW,
      { strictModelMatch: true, includeExpired: false },
    );
    expect(geminiStrict.matchedModel).toBe(true);
    expect(geminiStrict.groupName).toBe('Gemini Models');
    expect(geminiStrict.windows).toEqual([]);

    const geminiStatus = selectPluginWindowsForModel(
      geminiExpiredWindows,
      { id: 'gemini-4-neon', displayName: 'Gemini 4 Neon' },
      NOW,
      { strictModelMatch: false, includeExpired: false },
    );
    expect(geminiStatus.windows).toEqual([]);

    // Unmatched model in strict mode also stays empty rather than treating live Claude/GPT as single-group.
    const unmatchedStrict = selectPluginWindowsForModel(
      geminiExpiredWindows,
      { id: 'orchestrator-neon', displayName: 'Orchestrator (Neon)' },
      NOW,
      { strictModelMatch: true, includeExpired: false },
    );
    expect(unmatchedStrict.windows).toEqual([]);

    // Mobile/Desktop picker helper reflects empty for Gemini while keeping Claude/GPT intact.
    expect(
      pickPluginModelPickerWindow(snapshot, { id: 'gemini-4-neon', displayName: 'Gemini 4 Neon' }, NOW, {
        prefer: 'weekly',
      }).primary,
    ).toBeNull();
    expect(
      pickPluginModelPickerWindow(snapshot, { id: 'claude-opus-5-5', displayName: 'Claude Opus 5.5' }, NOW, {
        prefer: 'weekly',
      }).primary?.label,
    ).toBe('Claude and GPT models · weekly');

    // Explicit models[] scoping behaves identically when a model's scoped window expires.
    const explicitExpired: PluginQuotaWindow[] = [
      { label: 'Pro · 5h', remainingPercent: 5, resetsAt: NOW - 60_000, windowMinutes: 300, models: ['model-a'] },
      { label: 'Flash · 5h', remainingPercent: 95, resetsAt: FIVE_HOURS_LATER, windowMinutes: 300, models: ['model-b'] },
    ];
    expect(
      selectPluginWindowsForModel(explicitExpired, { id: 'model-a', displayName: 'Model A' }, NOW, {
        strictModelMatch: true,
        includeExpired: false,
      }).windows,
    ).toEqual([]);
  });

  it('orders full usage card windows with the active model group first and short-before-long within each group', () => {
    const ordered = orderPluginUsageCardWindows(ANTIGRAVITY_WINDOWS, {
      id: 'claude-opus-5-5',
      displayName: 'Claude Opus 5.5',
    });
    expect(ordered.map((w) => w.label)).toEqual([
      'Claude and GPT models · 5h',
      'Claude and GPT models · weekly',
      'Gemini Models · 5h',
      'Gemini Models · weekly',
    ]);
  });

  it('builds weekly engine overview for rail bars and headers, plus short-window warning status', () => {
    const usage: PluginQuotaSnapshot = { updatedAt: NOW, windows: ANTIGRAVITY_WINDOWS };
    const overview = pickPluginEngineWeeklyQuota(usage, NOW);
    expect(overview.primary?.label).toBe('Claude and GPT models · weekly');
    expect(overview.primaryWindowMinutes).toBe(10080);
    expect(overview.shortWindow?.label).toBe('Gemini Models · 5h');
    expect(overview.limited).toBe(false);
    expect(overview.shortLow).toBe(false);

    const lowUsage: PluginQuotaSnapshot = {
      updatedAt: NOW,
      windows: [
        { label: '5h', remainingPercent: 8, resetsAt: FIVE_HOURS_LATER, windowMinutes: 300 },
        { label: 'weekly', remainingPercent: 70, resetsAt: SEVEN_DAYS_LATER, windowMinutes: 10080 },
      ],
    };
    const lowOverview = pickPluginEngineWeeklyQuota(lowUsage, NOW);
    expect(lowOverview.primary?.label).toBe('weekly');
    expect(lowOverview.shortLow).toBe(true);
    expect(lowOverview.limited).toBe(false);

    const limitedUsage: PluginQuotaSnapshot = {
      updatedAt: NOW,
      windows: [
        { label: '5h', remainingPercent: 0, resetsAt: FIVE_HOURS_LATER, windowMinutes: 300 },
        { label: 'weekly', remainingPercent: 60, resetsAt: SEVEN_DAYS_LATER, windowMinutes: 10080 },
      ],
    };
    const limitedOverview = pickPluginEngineWeeklyQuota(limitedUsage, NOW);
    expect(limitedOverview.limited).toBe(true);
    expect(limitedOverview.recoveryResetsAt).toBe(FIVE_HOURS_LATER);
  });

  it('picks tightest window for Desktop picker rows and weekly window for Mobile picker rows', () => {
    const usage: PluginQuotaSnapshot = { updatedAt: NOW, windows: ANTIGRAVITY_WINDOWS };
    const desktop = pickPluginModelPickerWindow(
      usage,
      { id: 'gemini-4-neon', displayName: 'Gemini 4 Neon' },
      NOW,
      { prefer: 'tightest' },
    );
    expect(desktop.primary?.label).toBe('Gemini Models · 5h');
    expect(desktop.windows.map((w) => w.label)).toEqual([
      'Gemini Models · 5h',
      'Gemini Models · weekly',
    ]);

    const mobile = pickPluginModelPickerWindow(
      usage,
      { id: 'gemini-4-neon', displayName: 'Gemini 4 Neon' },
      NOW,
      { prefer: 'weekly' },
    );
    expect(mobile.primary?.label).toBe('Gemini Models · weekly');
  });

  it('formats quota percentages matching TodaySpendChip without rounding 99.5% up to 100%', () => {
    expect(formatPluginQuotaPercent(84)).toBe('84%');
    expect(formatPluginQuotaPercent(79.69)).toBe('79.7%');
    expect(formatPluginQuotaPercent(79.96)).toBe('80%');
    expect(formatPluginQuotaPercent(99.5)).toBe('99.5%');
    expect(formatPluginQuotaPercent(99.94)).toBe('99.9%');
    expect(formatPluginQuotaPercent(100)).toBe('100%');
    expect(formatPluginQuotaPercent(-5)).toBe('0%');
  });

  // 2026-11-27 merge of #13257 into #13387: the engine-wide weekly summary took the tightest weekly
  // window across pools, so Antigravity's Gemini header showed Claude & GPT quota. Pools must stay
  // separate, each weekly-first, with the 5h warning confined to its own pool.
  it('keeps separate model pools apart, each weekly-first with its own 5h warning', () => {
    const usage: PluginQuotaSnapshot = {
      updatedAt: NOW,
      windows: [
        { label: 'Gemini Models · weekly', windowMinutes: 10080, remainingPercent: 95, resetsAt: NOW + 6 * 86_400_000 },
        { label: 'Gemini Models · 5h', windowMinutes: 300, remainingPercent: 80, resetsAt: NOW + 3_600_000 },
        { label: 'Claude and GPT models · weekly', windowMinutes: 10080, remainingPercent: 60, resetsAt: NOW + 5 * 86_400_000 },
        { label: 'Claude and GPT models · 5h', windowMinutes: 300, remainingPercent: 0, resetsAt: NOW + 7_200_000 },
      ],
    };
    const pools = pickPluginEngineQuotaPools(usage, NOW);
    expect(pools?.map((pool) => [pool.label, pool.remaining, pool.level, pool.overview.limited])).toEqual([
      ['Gemini', 95, 'normal', false],
      ['Claude & GPT', 60, 'crit', true],
    ]);
    expect(pools?.[1]?.overview.recoveryResetsAt).toBe(NOW + 7_200_000);
    expect(pickPluginEngineQuotaPools({ updatedAt: NOW, windows: [
      { label: 'Weekly', windowMinutes: 10080, remainingPercent: 70, resetsAt: NOW + 86_400_000 },
    ] }, NOW)).toBeNull();
  });
});
