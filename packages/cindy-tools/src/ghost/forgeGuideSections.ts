/**
 * ghost_forge_guide 的分章投递。
 *
 * 手册整本 ~120KB,必超单次 MCP 工具结果上限(见 #890),因此:
 * 无参调用返回目录(开场白 + 全部章节标题 + 取章提示),传 section(章号或
 * 标题关键词)返回单章正文。章 = 手册里的 `## ` 标题行,单章体量均在安全范围。
 *
 * 纯函数,不依赖 deps;对"没有任何 ## 标题"的退化输入按整本原样返回,
 * 保持旧行为(短手册无需分章)。
 */

export interface ForgeGuideSectionHit {
  ok: true;
  text: string;
}

export interface ForgeGuideSectionMiss {
  ok: false;
  /** ambiguous=true 时是歧义候选,否则是全部可用章节标题 */
  candidates: string[];
  ambiguous: boolean;
}

export type ForgeGuideSectionResult = ForgeGuideSectionHit | ForgeGuideSectionMiss;

const HEADER_PREFIX = "## ";

/** 全部 `## ` 章节标题行(含前缀)。 */
function headerLines(guide: string): string[] {
  return guide.split("\n").filter((l) => l.startsWith(HEADER_PREFIX));
}

/** "## 4.7 网络代发(network 槽)" → "4.7";无章号返回 null。 */
function headerNumber(header: string): string | null {
  const m = header.match(/^## ([0-9]+(?:\.[0-9]+)*)\.?(?:\s|$)/);
  return m ? m[1] : null;
}

/** 去掉 `## ` 前缀的标题文本,用于目录与错误提示。 */
function headerTitle(header: string): string {
  return header.slice(HEADER_PREFIX.length);
}

/** 目录:开场白 + 章节标题列表 + 取章提示。没有 ## 标题时整本原样返回。 */
export function buildForgeGuideToc(guide: string): string {
  const headers = headerLines(guide);
  if (headers.length === 0) return guide;
  // 开场白边界与章节识别走同一通道(逐行 startsWith),避免手册以 ## 开头时
  // indexOf("\n## ") 命中第二章、把第一章整段吞进目录
  const lines = guide.split("\n");
  const firstHeaderLine = lines.findIndex((l) => l.startsWith(HEADER_PREFIX));
  const preamble = lines.slice(0, firstHeaderLine).join("\n").trimEnd();
  return [
    ...(preamble ? [preamble, ""] : []),
    "## 目录",
    "",
    ...headers.map((h) => `- ${headerTitle(h)}`),
    "",
    '整本手册超出单次工具结果上限,按需取章:再次调用并传 section,章号(如 {"section":"4.7"})或标题关键词(如 {"section":"network"})均可。',
  ].join("\n");
}

/**
 * 取单章正文:从命中的 `## ` 标题行(含)到下一个 `## ` 标题行(不含)。
 * 匹配优先级:章号精确匹配(允许末尾多一个点) > 标题关键词包含(大小写不敏感)。
 * 关键词命中多章返回歧义候选;零命中返回全部章节标题。
 * 没有任何 `## ` 标题的退化手册无章可取,任何 query 都整本原样返回。
 */
export function extractForgeGuideSection(
  guide: string,
  query: string,
): ForgeGuideSectionResult {
  const lines = guide.split("\n");
  const headerIdx: number[] = [];
  lines.forEach((l, i) => {
    if (l.startsWith(HEADER_PREFIX)) headerIdx.push(i);
  });
  if (headerIdx.length === 0) {
    return { ok: true, text: guide };
  }
  const allTitles = headerIdx.map((i) => headerTitle(lines[i]));

  const q = query.trim().replace(/\.$/, "");
  if (!q) {
    return { ok: false, candidates: allTitles, ambiguous: false };
  }

  const sliceAt = (pos: number): ForgeGuideSectionHit => {
    const start = headerIdx[pos];
    const end = pos + 1 < headerIdx.length ? headerIdx[pos + 1] : lines.length;
    return { ok: true, text: lines.slice(start, end).join("\n").trimEnd() };
  };

  // 章号精确匹配
  const byNumber = headerIdx.findIndex((i) => headerNumber(lines[i]) === q);
  if (byNumber >= 0) return sliceAt(byNumber);

  // 标题关键词包含
  const ql = q.toLowerCase();
  const byKeyword = headerIdx
    .map((i, pos) => ({ pos, title: headerTitle(lines[i]) }))
    .filter(({ title }) => title.toLowerCase().includes(ql));
  if (byKeyword.length === 1) return sliceAt(byKeyword[0].pos);
  if (byKeyword.length > 1) {
    return { ok: false, candidates: byKeyword.map((k) => k.title), ambiguous: true };
  }
  return { ok: false, candidates: allTitles, ambiguous: false };
}
