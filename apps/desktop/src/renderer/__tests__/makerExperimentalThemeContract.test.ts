/**
 * makerExperimentalThemeContract.test.ts
 * ---------------------------------------------------------------------------
 * 源契约守卫（DESIGN.md §10 双模式交付门槛 / design-governance.md §6 Level 1）：
 * MakerExperimentalView 诊断页必须全量走语义 token——
 *  1. 零裸色字面量（hex / rgb() / hsl()）；
 *  2. 消费的每个 var(--xxx) 都已在 themes/colors.ts 注册；
 *  3. 注册槽位同时给出 light / dark 双模式值（缺任一槽位即某一模式渲染失效）。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { colorRegistry } from '../themes/color-registry';
// 触发整表 registerColor 注册（与 tokenRegistry.test.ts 同款做法）。
import '../themes/colors';

const viewSource = readFileSync(
  resolve(__dirname, '..', 'features', 'maker-experimental', 'MakerExperimentalView.tsx'),
  'utf8',
).replace(/\r\n?/g, '\n');
const colorsSource = readFileSync(
  resolve(__dirname, '..', 'themes', 'colors.ts'),
  'utf8',
).replace(/\r\n?/g, '\n');

/** 裸色字面量：hex、带数值入参的 rgb()/rgba()/hsl()/hsla()。 */
const RAW_COLOR_RE = /#[0-9a-fA-F]{3,8}\b|rgba?\(\s*\d|hsla?\(\s*\d/g;
const TOKEN_REF_RE = /var\(--([a-z0-9-]+)\)/g;

function referencedTokens(): string[] {
  return [...viewSource.matchAll(TOKEN_REF_RE)].map((match) => match[1]);
}

describe('MakerExperimentalView 主题契约（语义 token，双模式）', () => {
  it('零裸色：诊断页不出现 hex / rgb() / hsl() 字面量', () => {
    const raw = viewSource.match(RAW_COLOR_RE) ?? [];
    expect(raw).toEqual([]);
  });

  it('消费的 token 全部已在 colors.ts 注册（防幽灵 token）', () => {
    const registered = new Set(
      [...colorsSource.matchAll(/registerColor\('([a-z0-9-]+)'/g)].map((m) => m[1]),
    );
    const referenced = referencedTokens();
    expect(referenced.length).toBeGreaterThan(0);
    const unregistered = [...new Set(referenced.filter((id) => !registered.has(id)))];
    expect(unregistered).toEqual([]);
  });

  it('消费的 token 槽位同时具备 light / dark 双模式值', () => {
    const referenced = [...new Set(referencedTokens())];
    for (const id of referenced) {
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
