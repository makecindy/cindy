/**
 * 测试价值
 * - 生产入口与可观察结果：Desktop 与 Mobile 模型选择器共用的 `buildPluginEngineUsagePresentation`、
 *   `compactPluginUsageGroupLabel`、`pluginEngineUsageClockKey`；验证 AntiGravity 的 Gemini 与其他模型
 *   （Claude & GPT）配额分组独立呈现、同组内按最紧未过期窗口选主条（含 0% 耗尽与 100% 满额平局规则）、
 *   单组过期后剩余组保留分组标签、以及单组/纯余额引擎向后兼容。
 * - 规则依据：用户需求（AntiGravity 模型选择器支持余额进度条，且 Gemini 与其他模型分开显示）与
 *   `quota-level` 统一阈值（<=30% warn，<=10% crit）。
 * - 覆盖缺口：此前客户端把全部窗口混成一个最低百分比，没有按组拆分的共享逻辑与测试。
 * - 最小失败输入与 tier：unit（node）；输入含 `"Gemini Models · weekly/5h"` 与 `"Claude and GPT models · weekly/5h"`
 *   两组的快照，若合并为 1 组或平局选错重置时间则失败。
 */
import { describe, expect, it } from 'vitest';
import {
  buildPluginEngineUsagePresentation,
  compactPluginUsageGroupLabel,
  matchPluginEngineQuotaGroup,
  pluginEngineUsageClockKey,
} from '../pluginEngineUsage';

describe('pluginEngineUsage', () => {
  const now = Date.UTC(2026, 10, 26, 10, 30, 0);

  it('splits Antigravity Gemini and Claude/GPT windows into independent quota groups', () => {
    const result = buildPluginEngineUsagePresentation({
      updatedAt: now,
      windows: [
        { label: 'Gemini Models · weekly', remainingPercent: 89.23, resetsAt: now + 6 * 86_400_000, windowMinutes: 10080 },
        { label: 'Gemini Models · 5h', remainingPercent: 56.93, resetsAt: now + 92 * 60_000, windowMinutes: 300 },
        { label: 'Claude and GPT models · weekly', remainingPercent: 84.09, resetsAt: now + 5 * 86_400_000, windowMinutes: 10080 },
        { label: 'Claude and GPT models · 5h', remainingPercent: 100, windowMinutes: 300 },
      ],
    }, now);

    expect(result.isMultiGroup).toBe(true);
    expect(result.level).toBe('normal');
    expect(result.groups).toHaveLength(2);
    expect(result.groups[0]).toMatchObject({
      id: 'label:gemini models',
      rawName: 'Gemini Models',
      shortLabel: 'Gemini',
      remainingPercent: 57,
      level: 'normal',
      primary: { label: 'Gemini Models · 5h' },
    });
    expect(result.groups[0]!.windows).toHaveLength(2);
    expect(result.groups[1]).toMatchObject({
      id: 'label:claude and gpt models',
      rawName: 'Claude and GPT models',
      shortLabel: 'Claude & GPT',
      remainingPercent: 84,
      level: 'normal',
      primary: { label: 'Claude and GPT models · weekly' },
    });
    expect(result.groups[1]!.windows).toHaveLength(2);
  });

  it('keeps multi-group identity when one group expires and breaks ties accurately', () => {
    // Gemini's only window has expired; Claude/GPT ties at 0% (later reset is the real blocker)
    const expiredAndExhausted = buildPluginEngineUsagePresentation({
      updatedAt: now,
      windows: [
        { label: 'Gemini Models · 5h', remainingPercent: 20, resetsAt: now - 1000, windowMinutes: 300 },
        { label: 'Claude and GPT models · 5h', remainingPercent: 0, resetsAt: now + 3_600_000, windowMinutes: 300 },
        { label: 'Claude and GPT models · weekly', remainingPercent: 0, resetsAt: now + 4 * 86_400_000, windowMinutes: 10080 },
      ],
    }, now);

    expect(expiredAndExhausted.isMultiGroup).toBe(true);
    expect(expiredAndExhausted.level).toBe('crit');
    expect(expiredAndExhausted.groups).toHaveLength(1);
    expect(expiredAndExhausted.groups[0]).toMatchObject({
      shortLabel: 'Claude & GPT',
      remainingPercent: 0,
      level: 'crit',
      primary: { label: 'Claude and GPT models · weekly' },
    });

    // When both windows are 100%, prefer the one with a known reset timestamp
    const fullTie = buildPluginEngineUsagePresentation({
      updatedAt: now,
      windows: [
        { label: 'Claude and GPT models · 5h', remainingPercent: 100, windowMinutes: 300 },
        { label: 'Claude and GPT models · weekly', remainingPercent: 100, resetsAt: now + 5 * 86_400_000, windowMinutes: 10080 },
      ],
    }, now);
    expect(fullTie.groups[0]?.primary.label).toBe('Claude and GPT models · weekly');
  });

  it('keeps single-group and balance-only engines non-multi-group', () => {
    const ungrouped = buildPluginEngineUsagePresentation({
      updatedAt: now,
      windows: [
        { label: 'Weekly', remainingPercent: 80, resetsAt: now + 86_400_000 },
        { label: '5h', remainingPercent: 25, resetsAt: now + 3_600_000 },
      ],
    }, now);
    expect(ungrouped.isMultiGroup).toBe(false);
    expect(ungrouped.groups).toHaveLength(1);
    expect(ungrouped.groups[0]).toMatchObject({
      shortLabel: null,
      remainingPercent: 25,
      level: 'warn',
      primary: { label: '5h' },
    });

    const balanceOnly = buildPluginEngineUsagePresentation({
      updatedAt: now,
      balances: [{ currency: 'CNY', amount: '0' }],
    }, now);
    expect(balanceOnly.isMultiGroup).toBe(false);
    expect(balanceOnly.groups).toHaveLength(0);
    expect(balanceOnly.level).toBe('crit');
    expect(balanceOnly.balances).toEqual([{ currency: 'CNY', amount: '0', numericAmount: 0 }]);
  });

  it.each([
    ['Gemini Models', 'Gemini'],
    ['Claude and GPT models', 'Claude & GPT'],
    ['Claude/GPT', 'Claude/GPT'],
    ['Other Models', 'Other'],
    ['Models', 'Models'],
  ])('compacts group label %s -> %s', (input, expected) => {
    expect(compactPluginUsageGroupLabel(input)).toBe(expected);
  });

  it('changes clock key only when a live window expires or its formatted countdown changes', () => {
    const usage = {
      updatedAt: now,
      windows: [
        { label: 'Gemini Models · 5h', remainingPercent: 57, resetsAt: now + 90_000 },
      ],
    };
    const fmt = (resetsAtMs: number, current: number) => `${Math.ceil((resetsAtMs - current) / 60_000)}m`;
    const first = pluginEngineUsageClockKey(usage, now, fmt);
    const tenSecondsLater = pluginEngineUsageClockKey(usage, now + 10_000, fmt);
    const fortySecondsLater = pluginEngineUsageClockKey(usage, now + 40_000, fmt);
    const expired = pluginEngineUsageClockKey(usage, now + 95_000, fmt);
    expect(tenSecondsLater).toBe(first);
    expect(fortySecondsLater).not.toBe(first);
    expect(expired).toBe('');
  });

  it('picks primaryGroup as the tightest pool and matches models to their governing quota group', () => {
    const presentation = buildPluginEngineUsagePresentation({
      updatedAt: now,
      windows: [
        { label: 'Gemini Models · 5h', remainingPercent: 57, resetsAt: now + 3_600_000, windowMinutes: 300 },
        { label: 'Claude and GPT models · weekly', remainingPercent: 24, resetsAt: now + 4 * 86_400_000, windowMinutes: 10080 },
      ],
    }, now);

    expect(presentation.primaryGroup?.shortLabel).toBe('Claude & GPT');
    expect(presentation.primaryGroup?.remainingPercent).toBe(24);
    expect(matchPluginEngineQuotaGroup(presentation, { id: 'gemini-4-neon', name: 'Gemini 4 Neon' })?.shortLabel).toBe('Gemini');
    expect(matchPluginEngineQuotaGroup(presentation, { id: 'gemini-pro-orchestrator-neon', name: 'Orchestrator (Neon)' })?.shortLabel).toBe('Gemini');
    expect(matchPluginEngineQuotaGroup(presentation, { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' })?.shortLabel).toBe('Claude & GPT');
    expect(matchPluginEngineQuotaGroup(presentation, { id: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' })?.shortLabel).toBe('Claude & GPT');
    expect(matchPluginEngineQuotaGroup(presentation, { id: 'unknown-model', name: 'Custom Model' })).toBeNull();
  });

  // 回归（PR #13257 review）：无论单组还是多组，声明了 `models` 的窗口只能匹配列出的模型，
  // 不能通过单组回退或名称启发式泄露到其他模型行。
  it('enforces explicit window.models scope across single-group, multi-group, and mixed-scope pools', () => {
    const singleScoped = buildPluginEngineUsagePresentation({
      updatedAt: now,
      windows: [
        { label: 'Gemini Pro · 5h', remainingPercent: 32, resetsAt: now + 3_600_000, models: ['gemini-pro'] },
      ],
    }, now);
    expect(matchPluginEngineQuotaGroup(singleScoped, { id: 'gemini-pro', name: 'Gemini Pro' })?.remainingPercent).toBe(32);
    expect(matchPluginEngineQuotaGroup(singleScoped, { id: 'gemini-flash', name: 'Gemini Flash' })).toBeNull();
    expect(matchPluginEngineQuotaGroup(singleScoped, { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' })).toBeNull();

    const multiScoped = buildPluginEngineUsagePresentation({
      updatedAt: now,
      windows: [
        { label: 'Gemini Models · 5h', remainingPercent: 18, resetsAt: now + 3_600_000, models: ['gemini-pro'] },
        { label: 'Claude and GPT models · weekly', remainingPercent: 80, resetsAt: now + 4 * 86_400_000 },
      ],
    }, now);
    expect(matchPluginEngineQuotaGroup(multiScoped, { id: 'gemini-pro', name: 'Gemini Pro' })?.remainingPercent).toBe(18);
    expect(matchPluginEngineQuotaGroup(multiScoped, { id: 'gemini-flash', name: 'Gemini Flash' })).toBeNull();
    expect(matchPluginEngineQuotaGroup(multiScoped, { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' })?.remainingPercent).toBe(80);

    // Same group mixes a model-specific cap (15%) with a group-wide weekly cap (75%):
    // gemini-pro sees 15%, gemini-flash sees only the unscoped 75% window.
    const mixedInGroup = buildPluginEngineUsagePresentation({
      updatedAt: now,
      windows: [
        { label: 'Gemini Models · 5h', remainingPercent: 15, resetsAt: now + 3_600_000, models: ['gemini-pro'] },
        { label: 'Gemini Models · weekly', remainingPercent: 75, resetsAt: now + 4 * 86_400_000 },
      ],
    }, now);
    const proMatch = matchPluginEngineQuotaGroup(mixedInGroup, { id: 'gemini-pro', name: 'Gemini Pro' });
    const flashMatch = matchPluginEngineQuotaGroup(mixedInGroup, { id: 'gemini-flash', name: 'Gemini Flash' });
    expect(proMatch?.remainingPercent).toBe(15);
    expect(proMatch?.windows).toHaveLength(2);
    expect(flashMatch?.remainingPercent).toBe(75);
    expect(flashMatch?.windows).toHaveLength(1);

    // Explicit model-scoped pool alongside an unscoped default pool: other models fall back to default.
    const scopedPlusDefault = buildPluginEngineUsagePresentation({
      updatedAt: now,
      windows: [
        { label: 'Pro 5h', remainingPercent: 12, resetsAt: now + 3_600_000, models: ['gemini-pro'] },
        { label: 'Weekly', remainingPercent: 68, resetsAt: now + 4 * 86_400_000 },
      ],
    }, now);
    expect(matchPluginEngineQuotaGroup(scopedPlusDefault, { id: 'gemini-pro' })?.remainingPercent).toBe(12);
    expect(matchPluginEngineQuotaGroup(scopedPlusDefault, { id: 'claude-sonnet-5-5' })?.remainingPercent).toBe(68);

    // Overlapping explicit model sets: pick the tightest window that includes the model.
    const overlappingScoped = buildPluginEngineUsagePresentation({
      updatedAt: now,
      windows: [
        { label: 'Pro 5h', remainingPercent: 14, resetsAt: now + 3_600_000, models: ['gemini-pro'] },
        { label: 'Gemini Weekly', remainingPercent: 72, resetsAt: now + 4 * 86_400_000, models: ['gemini-pro', 'gemini-flash'] },
      ],
    }, now);
    const proOverlap = matchPluginEngineQuotaGroup(overlappingScoped, { id: 'gemini-pro' });
    const flashOverlap = matchPluginEngineQuotaGroup(overlappingScoped, { id: 'gemini-flash' });
    expect(proOverlap?.remainingPercent).toBe(14);
    expect(proOverlap?.windows).toHaveLength(2);
    expect(flashOverlap?.remainingPercent).toBe(72);
    expect(flashOverlap?.windows).toHaveLength(1);
    expect(matchPluginEngineQuotaGroup(overlappingScoped, { id: 'claude-sonnet-5-5' })).toBeNull();
  });
});
