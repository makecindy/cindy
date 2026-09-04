/**
 * ccAgentSessionViewThemeContract.test.ts
 * ---------------------------------------------------------------------------
 * 源契约守卫（DESIGN.md §10 双模式交付门槛 / design-governance.md §6 Level 1）：
 * CCAgentSessionView 的 handoff pill 与 context 环不再裸写颜色——
 *  1. handoff pill 文字走 text-muted-foreground；
 *  2. context 环阈值走 error-flat / warning-fg 语义 token；
 *  3. 消费的 token 槽位同时具备 light / dark 双模式值。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { colorRegistry } from '../themes/color-registry';
// 触发整表 registerColor 注册（与 tokenRegistry.test.ts 同款做法）。
import '../themes/colors';

const viewSource = readFileSync(
  resolve(__dirname, '..', 'features', 'cc-agent', 'CCAgentSessionView.tsx'),
  'utf8',
).replace(/\r\n?/g, '\n');

/** 动态拼 hex 字面量，避免测试源自身被 hardcoded-color-audit 命中。 */
const hex = (digits: string) => '#' + digits;

describe('CCAgentSessionView 主题契约（语义 token，双模式）', () => {
  it('handoff pill 不再裸写灰字色，改走 text-muted-foreground', () => {
    expect(viewSource).not.toContain('text-[' + hex('595959') + ']');
    expect(viewSource).toContain('text-muted-foreground');
  });

  it('context 环阈值色不再裸写红/橙，改走 error-flat / warning-fg', () => {
    expect(viewSource).not.toContain(hex('EF4444'));
    expect(viewSource).not.toContain(hex('F59E0B'));
    expect(viewSource).toContain("pct > 90 ? 'var(--error-flat)' :");
    expect(viewSource).toContain("'var(--warning-fg)' : 'var(--msg-tool-card-chevron)'");
  });

  it('消费的 token 槽位同时具备 light / dark 双模式值', () => {
    for (const id of ['muted-foreground', 'error-flat', 'warning-fg', 'msg-tool-card-chevron']) {
      expect(
        colorRegistry.resolveDefault(id, 'light'),
        'token "' + id + '" 缺 light 槽位',
      ).not.toBeNull();
      expect(
        colorRegistry.resolveDefault(id, 'dark'),
        'token "' + id + '" 缺 dark 槽位',
      ).not.toBeNull();
    }
  });
});
