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
});
