/**
 * remarkLocalPathLinks — 把回复正文纯文本里"长得像本地文件路径"的 token 切成
 * mdast `link` 节点,让它复用现有的链接渲染链路(classify → resolve → chip /
 * 降级纯文本)。
 *
 * 背景:
 *   桌面端聊天渲染器早就能把本地文件路径渲染成可点 chip,但只识别两种入口——
 *   行内代码 `` `path` `` 和显式 markdown 链接 `[label](path)`。agent 在正文
 *   里直接写进句子的路径(`见 src/App.tsx`、`改的是 C:\proj\app.ts`)完全当普通
 *   文字渲染,点不动。本插件补上"正文纯文本"这个缺口。
 *
 * 为什么放渲染器侧而不是系统提示词:
 *   "一条路径要不要变可点"是个确定性判断——能唯一解析到真实文件就可点,否则不
 *   可点(解析 + stat 存在性校验都在主进程 pathResolver 里)。按仓库规则 16,确
 *   定性逻辑应落代码而非甩给 prompt。放渲染器侧还顺带救了**已经渲染成纯文本的
 *   历史消息**(prompt 只能影响未来输出)。
 *
 * 匹配策略:
 *   - 用一条"正向路径正则"在正文里定位 token,而不是按空白切再剥边——后者在中文
 *     里("src/App.tsx,然后呢"这种路径直接黏着中文)会把尾巴一起吞掉判废。正向
 *     正则在**扩展名**处收尾,尾随的中文/标点天然落在 match 之外。
 *   - 只认**带路径分隔符**的形态:相对路径(含 `/` 或 `\` + 扩展名)、`./` `../`
 *     `~/` 开头、POSIX 绝对、Windows 盘符。裸文件名(`app.tsx`,无分隔符)在正文里
 *     太歧义,不碰——这点比 inline code 更严(inline code 是作者主动用反引号标注
 *     的格式信号)。
 *   - 左边界用负向 lookbehind 卡死:路径前一个字符必须是边界(空白 / 起始 / 标点
 *     等),不能是另一个路径字符,避免从中文 prose 中间起切。
 *
 * 已知限制(CJK 既可能是 prose 也可能是真实目录名 `我的看板`,词法层无法区分,故
 * 一律当作路径段字符;代价在"无空白边界紧贴中文"时显现,均与现状一致、本就点不动,
 * 不是回退):
 *   - 前导紧贴:`见src/x.ts`(中文直接黏在路径前)→ "见"被并入 token,解析不到 →
 *     纯文本。
 *   - 中文黏连两条真路径:`a/b.ts和c/d.ts` → 中间的"和"被当成路径段,整串吞成**一个**
 *     token `a/b.ts和c/d.ts`,解析不到 → 两条真路径**都点不亮**(比前导紧贴影响更大)。
 *   要救这些只能把 CJK 当分隔符,但那会反过来切断 `docs/设计稿/index.md` 里的中文目录
 *   名,得不偿失,故不做。
 *
 *   - 命中后再用现有 `splitLocalLineSuffix` + `looksLikeFilePath` 复核一遍,与
 *     inline code / 链接共用同一套谓词,"什么算文件路径"全仓一致;且切出来的 link
 *     仍走主进程 resolve,解析不到 → 现有链路降级成纯 `<span>`,误匹配天然不会变坏
 *     chip。
 *
 * 只处理 `text` 节点,天然不碰代码:mdast 里 `code` / `inlineCode` 是带 `value`
 * 的叶子节点,没有 `text` 子节点,扫不到;唯一要跳过的是已经在 `link` 里的 text
 * (避免嵌套链接)。纯 AST 变换,无 IO、无副作用。
 */

import type { Plugin } from 'unified';
import type { Root, Text, Link, PhrasingContent } from 'mdast';
import { visit, SKIP } from 'unist-util-visit';

import { looksLikeFilePath } from '@/lib/localPathResolver';
import { splitLocalLineSuffix } from '@/lib/markdownTarget';

// CJK / 假名 / 谚文:可作为路径段的一部分(如 `docs/设计稿/index.md`)。
const CJK = '\\u4e00-\\u9fff\\u3400-\\u4dbf\\u3040-\\u30ff\\uac00-\\ud7af';
// 路径段允许的字符(不含分隔符、不含 `:`)。`:` 留给盘符锚点与 `:line` 后缀。
const SEG = `[A-Za-z0-9._~@+\\-${CJK}]+`;
const SEP = '\\\\/'; // 反斜杠 + 正斜杠,字符类内用
// 锚点:盘符 `C:\` / `./` `../` `~/` / 单独的分隔符开头。
const ANCHOR = `(?:[A-Za-z]:[${SEP}]|[.~]{1,2}[${SEP}]|[${SEP}])`;
// 路径主体:要么有锚点(中间段可有可无),要么是"段+分隔符"至少一组(保证含分隔符);
// 末段必须以扩展名收尾。
const BODY = `(?:${ANCHOR}(?:${SEG}[${SEP}])*|(?:${SEG}[${SEP}])+)${SEG}\\.[A-Za-z0-9]{1,10}`;
// 可选 `:line[:column]` 行号后缀。
const LINE_SUFFIX = '(?::[1-9]\\d{0,6}(?::[1-9]\\d{0,6})?)?';
// 左边界:前一个字符不能是路径字符 / 分隔符(`:` 不算,允许 `文件:src/x.ts`)。
const LEFT_BOUNDARY = `(?<![A-Za-z0-9._~@+${CJK}${SEP}])`;

const PATH_RE = new RegExp(`${LEFT_BOUNDARY}(${BODY}${LINE_SUFFIX})`, 'g');

interface PathMatch {
  start: number; // 在 text 节点 value 里的起始下标
  end: number; // 结束下标(不含)
  value: string; // 命中的路径文本(含可能的 :line 后缀)
}

/** 在一段纯文本里定位所有"带分隔符、可解析形状"的路径 token。 */
function findPathMatches(text: string): PathMatch[] {
  const matches: PathMatch[] = [];
  let m: RegExpExecArray | null;
  PATH_RE.lastIndex = 0;
  while ((m = PATH_RE.exec(text)) !== null) {
    const value = m[1];
    // 复用 inline code / 链接同款谓词复核:剥行号后缀 → 路径形状校验。
    const pathPart = splitLocalLineSuffix(value).href;
    if (!looksLikeFilePath(pathPart)) continue;
    const start = m.index + (m[0].length - value.length);
    matches.push({ start, end: start + value.length, value });
  }
  return matches;
}

/** 把一个 text 节点按命中的路径区间拆成 [text, link, text, ...]。 */
function splitTextNode(node: Text, matches: PathMatch[]): PhrasingContent[] {
  const out: PhrasingContent[] = [];
  const value = node.value;
  let cursor = 0;
  for (const match of matches) {
    if (match.start > cursor) {
      out.push({ type: 'text', value: value.slice(cursor, match.start) });
    }
    const link: Link = {
      type: 'link',
      url: match.value,
      children: [{ type: 'text', value: match.value }],
    };
    out.push(link);
    cursor = match.end;
  }
  if (cursor < value.length) {
    out.push({ type: 'text', value: value.slice(cursor) });
  }
  return out;
}

const remarkLocalPathLinks: Plugin<[], Root> = () => {
  return (tree) => {
    visit(tree, 'text', (node: Text, index, parent) => {
      if (!parent || index == null) return;
      // 已在链接里的 text 不动:避免把链接 label 再切成嵌套链接。
      if (parent.type === 'link') return;
      // 快速短路:不含任何路径分隔符的文本一定不是带分隔符路径,直接跳过。
      if (!node.value || (!node.value.includes('/') && !node.value.includes('\\'))) return;

      const matches = findPathMatches(node.value);
      if (matches.length === 0) return;

      const replacement = splitTextNode(node, matches);
      parent.children.splice(index, 1, ...replacement);
      // 跳过刚插入的节点,避免重复访问。
      return [SKIP, index + replacement.length];
    });
  };
};

export default remarkLocalPathLinks;
