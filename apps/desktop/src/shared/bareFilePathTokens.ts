/** Shared lexical path tokens for Markdown rendering and host file authorization.
 * No filesystem access or trust decision; callers validate and resolve candidates. */

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

export interface PathMatch {
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
export function findPathMatches(text: string): PathMatch[] {
  const matches: PathMatch[] = [];
  let m: RegExpExecArray | null;
  PATH_RE.lastIndex = 0;
  while ((m = PATH_RE.exec(text)) !== null) {
    const value = m[1];
    const start = m.index + (m[0].length - value.length);
    // 边界后置过滤:命中必须独占它所在的路径 token(见 startsMidPathToken 的说明)。
    if (startsMidPathToken(text, start)) continue;
    if (endsMidPathToken(text, start + value.length)) continue;
    matches.push({ start, end: start + value.length, value });
  }
  return matches;
}

