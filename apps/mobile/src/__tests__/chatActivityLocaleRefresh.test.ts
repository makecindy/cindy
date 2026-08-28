import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { getDefaults } from 'react-i18next';
import { describe, expect, it } from 'vitest';

import { i18n } from '@/i18n';

/**
 * 会话流里的工具行 / 工作组卡片按当前 app 语言解析文案。切语言时它们能刷新,
 * 靠的是两件事:每个卡片自己持有 useTranslation 订阅(react-i18next 默认
 * bindI18n='languageChanged' 会强制该组件重渲染,不受祖先 memo 影响),
 * 以及各自 useMemo 依赖里带着 i18n.language。两条都用测试钉住。
 */
const RENDERER = readFileSync(resolve(process.cwd(), 'src/session/MessageRenderer.tsx'), 'utf8');

function componentSource(name: string): string {
  const start = RENDERER.indexOf(`function ${name}({`);
  expect(start, `${name} 未找到`).toBeGreaterThan(-1);
  const next = RENDERER.indexOf('\nfunction ', start + 1);
  return RENDERER.slice(start, next === -1 ? undefined : next);
}

describe('会话流文案随 app 语言刷新', () => {
  it('i18n init 未关闭 react-i18next 的 languageChanged 重渲染绑定', () => {
    // options.react 未设置 → 用 react-i18next 默认值;默认值必须绑 languageChanged。
    expect(i18n.options.react).toBeUndefined();
    expect(getDefaults().bindI18n).toContain('languageChanged');
  });

  it.each(['ToolGroupCard', 'WorkGroupCard', 'WorkToolActivityRow'])(
    '%s 自己订阅 useTranslation 且 memo 依赖包含 i18n.language',
    (name) => {
      const source = componentSource(name);

      expect(source).toMatch(/useTranslation\(\)/);
      expect(source).toContain('i18n.language');
    },
  );
});
