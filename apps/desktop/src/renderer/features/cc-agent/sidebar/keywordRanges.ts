/**
 * 关键词高亮区间计算 —— renderer 侧搜索 snippet / preview 的 fallback 高亮。
 *
 * 不能先 toLocaleLowerCase() 再拿折叠串的下标直接切原文：大小写折叠会改变
 * 长度（如 U+0130「İ」折叠为 i + U+0307 两个码点），折叠串与原文的下标体系
 * 失配，命中区间会错切甚至切出空标。
 *
 * 做法：为折叠串的每个 UTF-16 单元记录「折叠偏移 → 原文 UTF-16 偏移」的映射，
 * 命中偏移经映射表换算回原文坐标后再切。原文切点永远落在码点边界，不会切进
 * 代理对中间。
 */
export interface KeywordRange {
  /** 原文 UTF-16 起始下标（可直接用于 String.slice）。 */
  start: number;
  /** 原文 UTF-16 结束下标（不含）。 */
  end: number;
}

function rangesOverlap(a: KeywordRange, b: KeywordRange): boolean {
  return a.start < b.end && b.start < a.end;
}

export function keywordRanges(text: string, query: string): KeywordRange[] {
  const tokens = [...new Set(query.match(/[\p{L}\p{N}]+/gu) ?? [])]
    .map((token) => token.trim())
    .filter((token) => token.length === 0 ? false : true)
    .sort((a, b) => b.length - a.length);
  if (tokens.length === 0) return [];

  // foldOffsetToOrig16[k] = 折叠串第 k 个 UTF-16 单元对应的原文 UTF-16 偏移
  // （该码点的起始单元）。膨胀单元共享同一原文偏移，因此命中区间首尾都会
  // 对齐到码点边界。
  const { lowerText, foldOffsetToOrig16 } = foldWithOrigMap(text);
  const ranges: KeywordRange[] = [];
  for (const token of tokens) {
    const lowerToken = token.toLowerCase();
    let index = lowerText.indexOf(lowerToken);
    while (index >= 0) {
      const start16 = foldOffsetToOrig16[index];
      const end16Raw = foldOffsetToOrig16[index + lowerToken.length - 1];
      // 折叠串与映射表长度一致；防御越界（例如不同 ICU 版本折叠差异）。
      if (start16 === undefined || end16Raw === undefined) break;
      const next: KeywordRange = {
        start: start16,
        end: end16Raw + origEndLen(text, end16Raw),
      };
      if (!ranges.some((range) => rangesOverlap(range, next)) && next.end > next.start) {
        ranges.push(next);
      }
      index = lowerText.indexOf(lowerToken, index + lowerToken.length);
    }
  }
  return ranges.sort((a, b) => a.start - b.start);
}

/** 求原文在 UTF-16 偏移 pos 处的码点长度（1 或 2），用于把“起始偏移”换算成“结束偏移”。 */
function origEndLen(text: string, pos: number): number {
  const ch = text.codePointAt(pos) ?? 0;
  return ch > 0xffff ? 2 : 1;
}

/**
 * 一次折叠同时产出小写串和「折叠 UTF-16 偏移 → 原文 UTF-16 偏移」映射。
 * 不用 toLocaleLowerCase()：lt/tr 等 locale 有上下文相关规则，逐码点折叠
 * 与整串折叠可能不等长，后面的 ASCII 会漏匹配。
 */
function foldWithOrigMap(text: string): { lowerText: string; foldOffsetToOrig16: number[] } {
  const foldOffsetToOrig16: number[] = [];
  let lowerText = '';
  let orig16 = 0;
  for (const ch of text) {
    const folded = ch.toLowerCase();
    lowerText += folded;
    for (let k = 0; k < folded.length; k += 1) {
      foldOffsetToOrig16.push(orig16);
    }
    orig16 += ch.length;
  }
  return { lowerText, foldOffsetToOrig16 };
}
