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
 *
 * 手机端对等物:`apps/mobile/src/session/chatPathCandidate.ts` 的
 * `findBareFilePathMatch`(下面 PATH_RE 那一族常量与 findPathMatches 的移植,接进
 * messageMarkdown 的 inline 分词器)。**本文件的正则改了要同步过去**,否则两端会
 * 就"哪些正文路径可点"给出不同结果。
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
// 锚点:盘符 `C:\` / `./` `../` / 单独的分隔符开头。
//
// **刻意不含 `~/`**:`~` 在本仓任何一层都没有展开 —— renderer 的 resolveLocalPath /
// resolveChatAbsPath 只做 join,被控端的 fs:stat-path / fs:resolve-path 也不展开,于是
// `~/logs/app.log` 会被 stat 成 `<workdir>/~/logs/app.log`:链路正常时判 nonfile、永远不
// 点亮(白发一次 stat),链路断时还会按「绝对形状」乐观点亮、点开错误地址。
// 在拿到可靠展开能力(被控端返回真实 home)之前,正文裸路径不认这个锚点
// (PR #1144 review 实捉;行内 code / 显式链接入口的同一问题是既有行为,属另一处 —— 修它
// 要改被控端协议,不是 renderer 能兜的,已在 PR 里记为 follow-up)。
const ANCHOR = `(?:[A-Za-z]:[${SEP}]|\\.{1,2}[${SEP}]|[${SEP}])`;
// `SEG` 含 `~`(备份文件 `file~` 等中段用途),所以只改锚点挡不住 `~/x`:
// `(?:SEG SEP)+` 一样能把 `~/` 当成「段+分隔符」吃下去。故在整条匹配前加负向前瞻,
// 明确拒绝以 `~/` `~\` 开头的 token(实测过:只删锚点里的 `~` 时 `~/logs/app.log`
// 仍然命中)。
const NO_HOME = '(?!~[\\\\/])';
// 右边界:匹配**不得停在段内字符或分隔符之前**。只排除字母数字是不够的 —— SEG 还允许
// `_ ~ @ + -` 与 CJK,分隔符也会漏过去,于是这些形态会被切出一个错误前缀、后半段留成
// 普通文本,而那个前缀形状上是「分隔符+扩展名」= 非歧义,断链时会被点亮、点开错误地址:
//   src/foo.ts/bar → `src/foo.ts` + 文本 `/bar`
//   src/file.tsx_backup → `src/file.tsx` + 文本 `_backup`
//   src/foo.ts~ → `src/foo.ts` + 文本 `~`
// (PR #1144 review 实捉;上一轮只挡住了「超长扩展名」这一种。)
//
// **`.` 刻意不排除**:句末英文句点是最常见的紧随字符,把它加进来会让 `见 src/a.ts.`
// 整条失配(SEG 含 `.`,回溯也救不回来)。`:` 同理留给合法的 `:line` 后缀。
const RIGHT_BOUNDARY = `(?![A-Za-z0-9_~@+\\-${CJK}${SEP}])`;
// 路径主体:要么有锚点(中间段可有可无),要么是"段+分隔符"至少一组(保证含分隔符);
// 末段必须以扩展名收尾。
//
// 扩展名后的 `(?![A-Za-z0-9])` 是**右边界**,不能省:没有它,超过 10 个字符的扩展名会被
// 截成前 10 个字符当成链接(`src/file.typescriptreact` → `src/file.typescript`),而截断后的
// 前缀形状上是「分隔符+扩展名」= 非歧义,远程会话断链时会被加下划线、允许点击,点开的是
// 一个**不存在的错误路径**;正文里还留着孤零零的 `react`。加了边界后整条路径直接不识别
// (保持纯文本),这才是想要的语义(PR #1144 review 实捉,移动端 chatPathCandidate 同步)。
const BODY =
  `(?:${ANCHOR}(?:${SEG}[${SEP}])*|(?:${SEG}[${SEP}])+)${SEG}\\.[A-Za-z0-9]{1,10}${RIGHT_BOUNDARY}`;
// 可选 `:line[:column]` 行号后缀。
const LINE_SUFFIX = '(?::[1-9]\\d{0,6}(?::[1-9]\\d{0,6})?)?';
// 左边界:前一个字符不能是路径字符 / 分隔符(`:` 不算,允许 `文件:src/x.ts`)。
const LEFT_BOUNDARY = `(?<![A-Za-z0-9._~@+${CJK}${SEP}])`;

const PATH_RE = new RegExp(`${LEFT_BOUNDARY}${NO_HOME}(${BODY}${LINE_SUFFIX})`, 'g');

/**
 * 标记属性名:正文裸路径切出的 link 节点带上它,渲染层据此走「只加下划线、不变
 * 等宽」的分支(见 splitTextNode 里的说明)。与 MarkdownRenderer 共享同一常量,
 * 避免字面量在两处漂移。
 */
export const BARE_PATH_ATTR = 'data-bare-path';

interface PathMatch {
  start: number; // 在 text 节点 value 里的起始下标
  end: number; // 结束下标(不含)
  value: string; // 命中的路径文本(含可能的 :line 后缀)
}

/**
 * 边界后置过滤 —— 一条统一判据,替掉「一轮补一个字符类」。
 *
 * 词法层是「在散文里用正向正则定位路径」(按空白切 token 再剥边在中文里不成立,见本文件
 * 头部的说明),所以必须自己保证:**命中要独占它所在的路径 token,不许从中段起、也不许把
 * 紧跟的字符截断**。前四轮 review 各捉到这条规格的一个缺口(扩展名长度 / 右边界字符 /
 * 空格中段 / `( ) # %` 等未支持字符 + 行号后缀),逐个补字符类注定一轮一个,故改成:
 *
 *   左侧:命中点前是**同一 run 内的字符**时,只有少数字符可以合法地紧邻一条路径 ——
 *         开括号 / 引号 / 冒号 / 列表分隔符。其余一律拒绝(说明我们落在
 *         `foo(bar)/src/index.ts`、`docs/50%off/a.md`、`foo#bar/x/a.ts` 这类**未支持字符**
 *         把 token 断开后的中段)。这里刻意用**白名单**:上一版用「run 前缀已含分隔符」
 *         的黑名单,假设了未支持字符出现在首个分隔符之后,于是 `foo(bar)/src/index.ts`
 *         (括号在第一个 `/` 之前)绕过去、还切出个绝对路径 `/src/index.ts`。白名单让未知
 *         字符**默认拒绝**,与本节「宁可少点亮」同向,不必再逐个补。
 *         命中点前是空白时,看空白前那个 run:含分隔符**且不以扩展名收尾** → 拒绝
 *         (`C:\Program Files\Cindy\app.log` 被空格截断的后半段)。「不以扩展名收尾」
 *         不能省,否则 `src/a.ts src/b.ts` 里的第二条会被连坐。
 *   右侧:命中之后紧跟 token 字符 → 拒绝。正则自带的右边界只管到扩展名,整段行号后缀
 *         之后没有边界,于是 `src/a.ts:12345678` 被截成 `:1234567`、`src/a.ts:12foo`
 *         截成 `:12`(错误行号 + 正文残留)。`.` 与 `:` 本身不算 token 字符(句末句点
 *         `见 src/a.ts.`、句末冒号 `见 src/a.ts:` 要保住),但**它们后面还跟 token 字符**
 *         时同样拒绝 —— 否则 `src/a.ts:12.5` / `src/a.ts:12:foo` 会留下错误行号 + 正文
 *         残渣,而且这种前缀在链路正常时也会点亮。
 *
 * 好处是 `( ) # % [ ]` 之类**不需要枚举**:白名单之外一律拒绝,以后出现别的未支持字符
 * 也自动覆盖,不必再来一轮。
 *
 * 已知误伤(显式取舍,有用例钉住):散文里紧挨着一个「含分隔符、无扩展名」的片段时会被
 * 连坐,如 `见 /etc src/a.ts`。代价是少点亮一条、文本仍可读,方向与 DESIGN.md §14.5
 * 「宁可少点亮一个真目录,不可多点亮一片假链接」一致。
 */
const TOKEN_CHAR_RE = new RegExp(`[A-Za-z0-9_~@+\\-${CJK}\\\\/]`);
/**
 * 可以合法地紧邻一条裸路径的字符(同一 run 内)。白名单而非黑名单:未知字符默认拒绝。
 * 开括号与引号 —— 路径被包裹(`见(src/a.ts)`);冒号 —— `文件:src/x.ts`;
 * 列表分隔符 —— `src/a.ts,src/b.ts` 是真的两条路径。
 * `>` 也放行:字面 HTML 的**元素内容**里的路径按既有口径仍识别(`<div>src/App.tsx</div>`,
 * 与 strong / inlineCode / 裸 URL matcher 同口径,见 messageMarkdown 的说明),而 `>` 不可能
 * 出现在路径段内,放行它不会带来错误前缀。
 * 注意闭括号 `)` `]` 刻意**不在**表里:它只可能出现在被断开的 token 中间。
 * `=` 同样不在表里:`--config=src/a.json` 因此不点亮 —— 那是可有可无的便利,而放行 `=` 会
 * 让 `docs/a=b/c.md` 切出错误前缀 `b/c.md`(§14.5:宁可少点亮一个,不可多点亮一片)。
 */
const ALLOWED_BEFORE_RE = /[([{（【「『"'`:：,;，；、>]/;
const SEP_IN_RUN_RE = /[\\/]/;
const TRAILING_EXT_RE = /\.[A-Za-z0-9]{1,10}$/;

/** 命中是否从路径 token 的**中段**起(见上方说明)。 */
function startsMidPathToken(text: string, start: number): boolean {
  if (start === 0) return false;
  // (1) 同一非空白 run 内:只有白名单字符可以紧邻路径,其余说明是被断开的中段。
  let runStart = start - 1;
  while (runStart >= 0 && !/\s/.test(text[runStart])) runStart -= 1;
  const runPrefix = text.slice(runStart + 1, start);
  if (runPrefix.length > 0) {
    return !ALLOWED_BEFORE_RE.test(text[start - 1]);
  }
  // (2) 命中点前是空白:看空白前那个 run 是不是「被空格截断的前半段」。
  //     只跨空格 / 制表符,不跨换行 —— 换行之后是新的一行,不是同一条路径。
  let i = start - 1;
  while (i >= 0 && (text[i] === ' ' || text[i] === '\t')) i -= 1;
  if (i < 0 || i === start - 1) return false;
  let j = i;
  while (j >= 0 && !/\s/.test(text[j])) j -= 1;
  const prevRun = text.slice(j + 1, i + 1);
  if (!SEP_IN_RUN_RE.test(prevRun)) return false;
  return !TRAILING_EXT_RE.test(prevRun);
}

/** 命中之后是否紧跟 token 字符(= 我们截断了它,见上方说明)。 */
function endsMidPathToken(text: string, end: number): boolean {
  const next = text[end];
  if (next === undefined) return false;
  if (TOKEN_CHAR_RE.test(next)) return true;
  // `.` / `:` 本身要放过(句末句点 / 句末冒号),但它们后面还跟 token 字符时说明我们把
  // 一段复合后缀截断了:`src/a.ts:12.5`、`src/a.ts:12:foo`。
  //
  // **跳过整串标点再判,不能只看紧邻一个字符**:只看一个时 `src/a.ts:12..5`、
  // `src/a.ts:12::foo`、`src/a.ts:12:.:foo` 会因为第二个标点不是 token 字符而绕过去
  // (这一处被连续挖了三轮:`:12345678` → `:12.5` → `:12..5`,每轮多一层嵌套;跳整串是
  // 为了把「再多一个标点」这条路一次封掉)。句末连写的省略号 `src/a.ts...` 仍保住 ——
  // 跳完之后没有 token 字符。
  if (next === '.' || next === ':') {
    let i = end;
    while (text[i] === '.' || text[i] === ':') i += 1;
    const after = text[i];
    return after !== undefined && TOKEN_CHAR_RE.test(after);
  }
  return false;
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
    // 边界后置过滤:命中必须独占它所在的路径 token(见 startsMidPathToken 的说明)。
    if (startsMidPathToken(text, start)) continue;
    if (endsMidPathToken(text, start + value.length)) continue;
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
      // 标记「这条 link 是从正文纯文本切出来的」,供渲染层区分作者手写的
      // `[label](path)`。两者点亮后的形态不同(DESIGN.md §14.5):
      //   - 作者写的 markdown 链接:label 像文件名 → 等宽 chip(那是作者的排版意图);
      //   - 正文裸写的路径:保持正文字体,只加下划线 —— 否则同一句里点亮的路径变成
      //     等宽块、没点亮的仍是正文,字体/底色/下划线三处齐变,跳变无法解释。
      // hProperties 是 mdast-util-to-hast 的既有通道,会原样落到 <a> 的属性上,
      // 再由 MarkdownRenderer 的 a 组件读取并从 DOM props 里剥掉。
      data: { hProperties: { [BARE_PATH_ATTR]: '' } },
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
