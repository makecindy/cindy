import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const source = readFileSync(
  resolve(__dirname, '..', 'features', 'cc-agent', 'RolePillDropdown.tsx'),
  'utf8',
).replace(/\r\n?/g, '\n');

/**
 * 守护 worker tab 的 error 提示:
 *  - error 用带 "ERR" 字样的药丸徽章(WorkerErrorBadge)+ tab 整体描红表达, 不用红点
 *    (红点在多数 app 里=下级有新消息, 与"出错"语义不符)。
 *  - 绿色"完成未读"点保留(点=有新结果, 语义正确)。
 *  - 信号统一走 resolveWorkerListAttention，本机只读任务 error，远程保留运行态 error。
 */
describe('RolePillDropdown worker error indicator', () => {
  it('WorkerErrorBadge 是带 ERR 文案的实心药丸(i18n + error token), 不是红点', () => {
    const badgeBlock = extractBetween(
      source,
      'function WorkerErrorBadge({',
      'const WORKER_LIST_LAYOUT_KEY',
    );
    expect(badgeBlock).toContain("t('orca.rolePill.errorBadge')");
    expect(badgeBlock).toContain("t('orca.rolePill.errorBadgeAria')");
    // 实心饱和红底 + 浅色字(比软红底更醒目, 仍全走 error token)。
    expect(badgeBlock).toContain('bg-[var(--error-fg)]');
    expect(badgeBlock).toContain('text-[var(--error-bg)]');
  });

  it('WorkerAvatar 保留等待确认与完成未读点, error 不叠红点', () => {
    const avatarBlock = extractBetween(
      source,
      'function WorkerAvatar({',
      'function WorkerErrorBadge({',
    );
    // 绿点保留(done 未读)。
    expect(avatarBlock).toContain("attentionKind === 'done'");
    expect(avatarBlock).toContain('<AttentionDot tone={dotTone} size={6} />');
    // error 不再用状态点表达(不出现红色状态点 token / showErrorDot 逻辑)。
    expect(avatarBlock).not.toContain('var(--card-status-error)');
    expect(avatarBlock).not.toContain('showErrorDot');
    // 图标染红作为背景强化仍保留。
    expect(avatarBlock).toContain("isError ? 'text-[var(--error-flat)]'");
  });

  it('tabs 布局: 出错 tab 整体描红 + ERR 徽章', () => {
    const tabsBlock = extractBetween(
      source,
      'function WorkerTabsList({',
      'export function WorkerListToolbar({',
    );
    expect(tabsBlock).toContain('resolveWorkerListAttention(');
    expect(tabsBlock).toContain("const isError = attentionKind === 'error';");
    // 整体描红。
    expect(tabsBlock).toContain('var(--error-bg)');
    expect(tabsBlock).toContain('var(--error-border)');
    // 显式 ERR 徽章(行内放在 pill 内部, 规避 overflow-x-auto 容器对角标的垂直裁剪)。
    expect(tabsBlock).toContain('isError && <WorkerErrorBadge');
  });

  it('dropdown 布局: 出错行整体描红 + ERR 徽章', () => {
    const dropdownBlock = source.slice(source.indexOf('export function RolePillDropdown({'));
    expect(dropdownBlock).toContain('resolveWorkerListAttention(');
    expect(dropdownBlock).toContain("const isError = attentionKind === 'error';");
    expect(dropdownBlock).toContain('border-l-2 border-[var(--error-fg)]');
    expect(dropdownBlock).toContain('<WorkerErrorBadge');
  });

  it('dropdown 折叠态 trigger: focused 自身出错或有隐藏出错 worker 都显 ERR 徽章(内联防裁切)', () => {
    const dropdownBlock = source.slice(source.indexOf('export function RolePillDropdown({'));
    // 聚合信号包含隐藏 Worker，且三种布局共用任务提醒与运行状态的判定。
    expect(dropdownBlock).toContain('const workerAttention = workers.map(');
    expect(dropdownBlock).toContain('resolveWorkerListAttention(item, taskAttention.get(item.sessionId)');
    // trigger 内联徽章: 当前 worker 出错 或 有隐藏出错 worker 都显示。
    expect(dropdownBlock).toContain("currentAttention === 'error' || workerAttention.includes('error')");
    expect(dropdownBlock).toMatch(/triggerAttention === 'error' && \(\s*<WorkerErrorBadge/);
    // 全组件不再用 attention 红点表达 error。
    expect(source).not.toContain('tone="error"');
  });
});

describe('orca.rolePill error badge i18n', () => {
  const LOCALES = ['zh-CN', 'zh-TW', 'en', 'ja', 'ko'] as const;
  it('errorBadge / errorBadgeAria 全部语言齐全且非空', () => {
    for (const locale of LOCALES) {
      const common = JSON.parse(
        readFileSync(resolve(__dirname, '..', 'i18n', 'locales', locale, 'common.json'), 'utf8'),
      );
      const rolePill = common?.orca?.rolePill ?? {};
      expect(typeof rolePill.errorBadge, `${locale} errorBadge`).toBe('string');
      expect(rolePill.errorBadge.length, `${locale} errorBadge non-empty`).toBeGreaterThan(0);
      expect(typeof rolePill.errorBadgeAria, `${locale} errorBadgeAria`).toBe('string');
      expect(rolePill.errorBadgeAria.length, `${locale} errorBadgeAria non-empty`).toBeGreaterThan(
        0,
      );
    }
  });
});

function extractBetween(sourceText: string, startNeedle: string, endNeedle: string): string {
  const start = sourceText.indexOf(startNeedle);
  const end = sourceText.indexOf(endNeedle, start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return sourceText.slice(start, end);
}
