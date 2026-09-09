/**
 * 硬编码颜色匹配（HEX / rgb() / rgba() / hsl() / hsla()）。
 *
 * 抽成共享模块的原因:scripts/hardcoded-color-audit.mjs 扫 diff 新增行,
 * scripts/design-inventory.mjs 按 surface 统计裸颜色。两边必须是同一套正则,
 * 否则台账计数和门禁会各说各话（治理合同 §2.1 / DS-2a 计划）。
 *
 * 正则写在调用点内联:字面量每次求值都是新对象,不会有 /g lastIndex 在调用方之间串扰。
 */

/** 返回文本中全部裸颜色字面量,顺序为 HEX → rgb/rgba → hsl/hsla 的 matchAll 拼接。 */
export function matchBareColors(text) {
  const source = String(text);
  return [
    ...source.matchAll(/#[0-9a-fA-F]{3,8}\b/g),
    ...source.matchAll(/rgba?\([^)]+\)/g),
    ...source.matchAll(/hsla?\([^)]+\)/g),
  ].map((match) => match[0]);
}
