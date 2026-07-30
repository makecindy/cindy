import { describe, expect, it } from 'vitest';

// import 触发整表注册。
import '../colors';
import { builtinThemes } from '../registry';
import { exportThemeColors } from '../theme-service';

/**
 * 引用块 token 守卫。
 *
 * 引用块只有一个真问题:承载的常是本轮最该看的内容(引述的原始需求、报错原文、
 * 待确认结论),而正文却是弱化色,扫读时最先被跳过。所以 `msg-blockquote-text`
 * 跟随该主题的 text-primary。
 *
 * 竖线**不是**问题,不要在这里"顺手加深"。界面里的「块引导竖线」是一套统一的
 * 视觉语言 —— WorkGroupBlock / ThinkingCard / AgentTaskCard / AgentActionsBlock
 * 全部是 `border-l-2` + `--agent-actions-rail`,淡是它的设计意图。引用块跟随同一
 * 个 token,识别由「内缩 + rail + 正文主色」共同承担。
 *
 * 该 rail 对 surface 约 1.36:1(light)/ 1.64:1(dark),低于 WCAG 非文本 3:1。这是
 * 全局既有设计语言的既定取舍:**要调就整套 rail 一起调**,不能只加深引用块 ——
 * 否则引用块会比工具块更抢眼,反而破坏层级。曾经试过把竖线指到
 * `--text-secondary-mid`(7.35:1),实机目检的结论是过重。
 *
 * 两条断言都是 token 身份比较,刻意不断言绝对对比度:
 * 1. 引用正文 === 该主题 text-primary —— 主题正文本身够不够是主题自己的事
 *    (如 solarized-light 把 text-primary override 成 #757575,该主题所有正文都是
 *    4.27:1,见 #911),不是引用块的责任。
 * 2. 引用竖线 === 该主题 agent-actions-rail —— 保证与全局 left rail 不分家:
 *    将来有人调 rail,引用块自动跟随,不会悄悄留下两套竖线。
 */

/** 顺着 var(--x) 引用链解析到具体值。 */
function resolveToken(
  exported: Record<string, string | undefined>,
  id: string,
  seen = new Set<string>(),
): string {
  if (seen.has(id)) throw new Error(`token 引用成环:${id}`);
  seen.add(id);
  const raw = exported[id];
  if (!raw) throw new Error(`主题缺少 token ${id}`);
  const alias = /^var\(--([a-z0-9-]+)\)$/i.exec(raw.trim());
  return alias ? resolveToken(exported, alias[1], seen) : raw.trim().toLowerCase();
}

const themeIds = Object.keys(builtinThemes);

describe('引用块 token · 正文跟随正文色、竖线跟随全局 rail', () => {
  it.each(themeIds)('%s:引用正文 === 该主题 text-primary', (themeId) => {
    const exported = exportThemeColors(builtinThemes[themeId]) as Record<string, string>;
    expect(resolveToken(exported, 'msg-blockquote-text')).toBe(
      resolveToken(exported, 'text-primary'),
    );
  });

  it.each(themeIds)('%s:引用竖线 === 该主题 agent-actions-rail', (themeId) => {
    const exported = exportThemeColors(builtinThemes[themeId]) as Record<string, string>;
    expect(resolveToken(exported, 'msg-blockquote-border')).toBe(
      resolveToken(exported, 'agent-actions-rail'),
    );
  });
});
