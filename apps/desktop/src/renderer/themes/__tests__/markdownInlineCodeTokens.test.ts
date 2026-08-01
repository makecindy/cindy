import { describe, expect, it } from 'vitest';

// import 触发整表注册。
import '../colors';
import { builtinThemes } from '../registry';
import { exportThemeColors } from '../theme-service';

/**
 * markdown 行内 code 底色守卫(桌面 = GitHub 形态:半透明淡底 + 6px 圆角)。
 *
 * 这个 token 有两条容易被"顺手"破掉的性质,都不体现在类型上:
 *
 * 1. **必须半透明。** 实色底一定会在某个容器底色上撞色隐形 —— 移动端就撞过:行内
 *    code 底与消息卡片底逐字节相同,1.00:1,只剩圆角脏边。半透明的相对对比与容器
 *    无关,所以这条是形态成立的前提,不是风格偏好。
 *
 * 2. **不得与 --msg-code-inline-bg 同值。** 那个 token(名字有历史包袱)是实色 chip /
 *    hover 底,被可点的 FileTargetChip 与十余处 hover:bg- 复用。两者一旦合并,「有
 *    底色 = 可点路径」这个信号就和普通行内 code 撞车 —— 正是 #897 里「链接附件看不
 *    出可点」的同一类问题。
 *
 * 移动端刻意是另一套形态(零底色 + 文字压暗,见 mobile 的 chatInlineCodeText):那边
 * 聊天流走 RN 嵌套 Text,不认 borderRadius,淡底只能是直角方块。两端不同是结论,
 * 不是漏改 —— 所以这里不做跨端一致性断言。
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

describe('markdown 行内 code 底 · 半透明且不与可点 chip 底撞值', () => {
  it.each(themeIds)('%s:半透明(alpha < 1,不随容器底色撞色隐形)', (themeId) => {
    const exported = exportThemeColors(builtinThemes[themeId]) as Record<string, string>;
    const tint = resolveToken(exported, 'msg-md-inline-code-bg');
    const rgba = /^rgba?\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*,\s*([\d.]+)\s*\)$/.exec(tint);
    expect(rgba, `期望 rgba(...) 半透明值,实际 ${tint}`).not.toBeNull();
    expect(Number(rgba![1])).toBeLessThan(1);
    expect(Number(rgba![1])).toBeGreaterThan(0);
  });

  it.each(themeIds)('%s:不与 --msg-code-inline-bg(可点 chip / hover 底)同值', (themeId) => {
    const exported = exportThemeColors(builtinThemes[themeId]) as Record<string, string>;
    expect(resolveToken(exported, 'msg-md-inline-code-bg')).not.toBe(
      resolveToken(exported, 'msg-code-inline-bg'),
    );
  });
});
