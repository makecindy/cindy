// @vitest-environment jsdom
/**
 * Desktop bottom-right PluginEngineUsageChip & QuotaHoverCard parity with built-in TodaySpendChip.
 *
 * 测试价值
 * - 生产入口与可观察结果：真实 PluginEngineUsageChip + pluginEngineUsageAccount + QuotaHoverCard；
 *   用户看到的底部状态栏分段（仅当前模型组、5h 在前周在后、单单位紧凑倒计时、竖线分隔、仅百分比着色、
 *   reset-pending 省略号）与悬停卡片（当前模型组排首、保留 paceWindowMinutes 与各窗口）。
 * - 规则依据：内置 Claude / Codex / Kimi / GLM 底部额度栏展示规范（TodaySpendChip + QuotaHoverCard）。
 * - 现有覆盖缺口：此前仅测试了单窗口缓存共享与余额回退，未覆盖多模型分组过滤（如 Antigravity
 *   v0.5.0 无 models[]）、双窗口排序、单单位倒计时、单数字警戒着色与 reset-pending 态。
 * - 最小失败输入与 tier：unit(jsdom)；Gemini 任务显示 Claude and GPT 组、仅显示单窗口、整段文字被染红、
 *   或 reset-pending 窗口被直接隐藏。
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { PluginEngineUsageChip } from '../PluginEngineUsageChip';
import { pluginEngineUsageAccount } from '../pluginEngineUsageAccount';

afterEach(() => {
  cleanup();
  setDataOwnerGeneration(null);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function makeI18n(lng: 'en' | 'zh-CN' = 'zh-CN') {
  const i18n = createInstance();
  await i18n.init({
    lng,
    resources: {
      'zh-CN': {
        translation: {
          'todaySpend.claude.windowSegment': '{{label}} 剩余 {{remaining}}',
          'todaySpend.resetPendingSegment': '{{label}} 重置中',
          'quotaCard.usageTitle': '用量',
          'quotaCard.resetPending': '重置中',
          'quotaCard.fiveHourLabel': '5 小时限额',
          'quotaCard.weeklyLabel': '每周限额',
          'quotaCard.remainingPercent': '剩余 {{percent}}%',
          'quotaCard.resetIn': '{{duration}}后重置',
          'quotaCard.timeUnit.day': '天',
          'quotaCard.timeUnit.hour': '小时',
          'quotaCard.timeUnit.minute': '分钟',
          'quotaCard.timeUnit.second': '秒',
          'todaySpend.unit.day': '天',
          'todaySpend.unit.hour': '小时',
          'todaySpend.unit.minute': '分钟',
          'todaySpend.unit.second': '秒',
          'providerAccountUsage.kimi.limit_5h': '5 小时',
          'providerAccountUsage.kimi.limit_7d': '7 天',
        },
      },
      en: {
        translation: {
          'todaySpend.claude.windowSegment': '{{label}} {{remaining}} left',
          'todaySpend.resetPendingSegment': '{{label}} resetting',
          'quotaCard.usageTitle': 'Usage',
          'quotaCard.resetPending': 'Resetting',
          'quotaCard.fiveHourLabel': '5-hour limit',
          'quotaCard.weeklyLabel': 'Weekly limit',
          'quotaCard.remainingPercent': '{{percent}}% left',
          'quotaCard.resetIn': 'Resets in {{duration}}',
          'quotaCard.timeUnit.day': 'd',
          'quotaCard.timeUnit.hour': 'h',
          'quotaCard.timeUnit.minute': 'm',
          'quotaCard.timeUnit.second': 's',
          'todaySpend.unit.day': 'd',
          'todaySpend.unit.hour': 'h',
          'todaySpend.unit.minute': 'm',
          'todaySpend.unit.second': 's',
          'providerAccountUsage.kimi.limit_5h': '5h',
          'providerAccountUsage.kimi.limit_7d': '7d',
        },
      },
    },
  });
  return i18n;
}

describe('PluginEngineUsageChip parity with TodaySpendChip', () => {
  it('filters multi-group usage to the active model, orders 5h before weekly with compact countdown, and colors only the alert percentage', async () => {
    vi.useFakeTimers();
    const now = new Date('2026-11-27T00:00:00.000Z').getTime();
    vi.setSystemTime(now);
    setDataOwnerGeneration('parity-chip-1');
    const agySnapshot = {
      updatedAt: now,
      windows: [
        { label: 'Claude and GPT models · weekly', windowMinutes: 10080, remainingPercent: 60, resetsAt: now + 6 * 24 * 3_600_000 },
        { label: 'Claude and GPT models · 5h', windowMinutes: 300, remainingPercent: 8, resetsAt: now + 4 * 3_600_000 + 44 * 60_000 },
        { label: 'Gemini Models · weekly', windowMinutes: 10080, remainingPercent: 95, resetsAt: now + 7 * 24 * 3_600_000 },
        { label: 'Gemini Models · 5h', windowMinutes: 300, remainingPercent: 80, resetsAt: now + 4 * 3_600_000 + 20 * 60_000 },
      ],
    };
    const getPluginEngineUsage = vi.fn(async () => agySnapshot);
    vi.stubGlobal('electronAPI', { maker: { getPluginEngineUsage } });
    const i18n = await makeI18n('zh-CN');

    // Gemini task: shows ONLY Gemini 5h | weekly in compact single-unit format, never Claude/GPT.
    const geminiView = render(
      <I18nextProvider i18n={i18n}>
        <PluginEngineUsageChip
          engineKey="agy-parity-gemini:agy"
          name="Antigravity"
          deviceId={null}
          modelId="gemini-4-neon"
          modelName="Gemini 4 Neon"
          running={false}
        />
      </I18nextProvider>,
    );
    await act(async () => { await Promise.resolve(); });
    const trigger = screen.getByTestId('task-usage-trigger');
    expect(trigger.textContent).toBe('4小时 剩余 80%7天 剩余 95%');
    expect(trigger.textContent).not.toContain('Claude');
    expect(trigger.textContent).not.toContain('分钟');
    // Vertical separator matches TodaySpendChip.
    expect(trigger.querySelector('span[aria-hidden="true"]')?.className).toContain('w-px');
    geminiView.unmount();

    // Claude task: selects Claude/GPT group and applies critical color ONLY to the "8%" number, not "剩余".
    render(
      <I18nextProvider i18n={i18n}>
        <PluginEngineUsageChip
          engineKey="agy-parity-claude:agy"
          name="Antigravity"
          deviceId={null}
          modelId="claude-opus-4-7"
          modelName="Claude Opus 4.7"
          running={false}
        />
      </I18nextProvider>,
    );
    await act(async () => { await Promise.resolve(); });
    const claudeTrigger = screen.getByTestId('task-usage-trigger');
    expect(claudeTrigger.textContent).toBe('4小时 剩余 8%6天 剩余 60%');
    const critSpan = claudeTrigger.querySelector('[class*="quota-bar-crit"]');
    expect(critSpan?.textContent).toBe('8%');

    // Hover card model puts the active model's group first, keeps both groups, and sets paceWindowMinutes.
    const account = pluginEngineUsageAccount(agySnapshot, {
      title: 'Antigravity',
      now,
      language: 'zh-CN',
      t: i18n.t.bind(i18n),
      model: { id: 'gemini-4-neon', displayName: 'Gemini 4 Neon' },
    });
    expect(account.windows.map((w) => [w.title, w.paceWindowMinutes])).toEqual([
      ['Gemini Models · 5 小时限额', 300],
      ['Gemini Models · 每周限额', 10080],
      ['Claude and GPT models · 5 小时限额', 300],
      ['Claude and GPT models · 每周限额', 10080],
    ]);
  });

  it('keeps reset-pending windows visible with pulse ellipsis instead of showing stale percentages', async () => {
    vi.useFakeTimers();
    const now = new Date('2026-11-27T00:00:00.000Z').getTime();
    vi.setSystemTime(now);
    setDataOwnerGeneration('parity-chip-pending');
    const pendingSnapshot = {
      updatedAt: now - 60_000,
      windows: [
        { label: '5h', windowMinutes: 300, remainingPercent: 0, resetsAt: now - 30_000 },
        { label: 'weekly', windowMinutes: 10080, remainingPercent: 72, resetsAt: now + 5 * 24 * 3_600_000 },
      ],
    };
    vi.stubGlobal('electronAPI', { maker: { getPluginEngineUsage: vi.fn(async () => pendingSnapshot) } });
    const i18n = await makeI18n('en');

    render(
      <I18nextProvider i18n={i18n}>
        <PluginEngineUsageChip
          engineKey="agy-parity-pending:agy"
          name="Antigravity"
          deviceId={null}
          modelId="gemini-4-neon"
          modelName="Gemini 4 Neon"
          running={false}
        />
      </I18nextProvider>,
    );
    await act(async () => { await Promise.resolve(); });
    const trigger = screen.getByTestId('task-usage-trigger');
    expect(trigger.textContent).toContain('5h resetting…');
    expect(trigger.textContent).toContain('5d 72% left');
    expect(trigger.textContent).not.toContain('0%');
  });
});
