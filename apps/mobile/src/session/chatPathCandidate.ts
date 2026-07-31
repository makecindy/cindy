/**
 * chatPathCandidate — 聊天正文里文件/目录路径引用的纯字符串识别与换算。
 * ---------------------------------------------------------------------------
 * 手机版「文件 chip 点亮」的候选判定层,与桌面端保持同一套识别语义
 * (apps/desktop/src/renderer/lib/{localPathResolver,markdownTarget}.ts 与
 * shared/workdirPath.ts 的移植子集;两端判定规则如需调整应同步):
 *
 *   - 识别宽松、点亮严格:这里只判「形状像不像路径」,误报由远端 stat 验证
 *     (remotePathVerdict)过滤——不存在的路径永远保持纯文本。
 *   - 行号后缀(`foo.ts:42`、`foo.ts:42:7`、`foo.ts:10-20`)拆出 line/column;
 *   - 目录尾斜杠形态(`src/components/`)去尾杠后按 candidate 处理;
 *   - workdir 相对换算兼容 Windows 被控端(反斜杠、大小写不敏感、`.` 段归一、
 *     `..` 逃逸拒绝),输出统一 POSIX 分隔(file-browser 全链路 relPath 约定);
 *   - workdir 外的绝对路径不再一票否决:文件按 absPath 走被控端媒体取件 /
 *     文本预览通道打开(对齐桌面缓存副本语义),目录仍保持纯文本
 *     (canOpenChatPathChip)。
 *
 * 全部纯函数,无 IO、无 RN 依赖,可单测。
 */

const WIN_ABS_RE = /^[A-Za-z]:[\\/]/;
/** POSIX 绝对路径且带扩展名(裸 `/etc` 不算)。 */
const POSIX_ABS_PATH_RE = /^\/[^/\s][^\s]*\.[a-z0-9]{1,10}(\?[^\s]*)?$/i;
/** 相对路径:至少一个分隔符 + 扩展名 + 无空白无冒号。 */
const REL_PATH_WITH_SEP_AND_EXT_RE = /^[^\s:]*[\\/][^\s:]+\.[a-z0-9]{1,10}(\?[^\s]*)?$/i;
/** 任意 URL scheme(http://、file://、git+ssh:// …)。 */
const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
/**
 * 显式绝对路径形态:`file://` scheme / POSIX `/…` / Windows 盘符。**不要求扩展名** ——
 * `/etc/hosts` 与 `C:\Windows\System32` 是路径引用里最明确的形态,不该因为没有后缀就被
 * 当成可疑。仅供 isAmbiguousChatPathShape 使用(桌面 markdownTarget 同名常量需同步)。
 */
const ABSOLUTE_PATH_SHAPE_RE = /^(?:file:\/\/|\/|[A-Za-z]:[\\/])/i;
/** 广义 scheme 前缀(`foo:`),用于剔除 mailto: 等非路径形态。 */
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
/** 尾部路径分隔符 → 目录形态。 */
const TRAILING_SEP_RE = /[\\/]$/;
/** 裸文件名引用(`package.json`):无分隔符但有 1-10 位扩展名。 */
const BARE_FILE_REF_RE = /^[^\s:<>()[\]{}"'`]+?\.[a-z0-9]{1,10}$/i;
/** 有任意扩展名(byExt 兜底判定用)。 */
const HAS_EXT_RE = /\.[a-z0-9]{1,10}(\?.*)?$/i;
const POSITIVE_LINE_NUMBER_RE = /^[1-9]\d{0,6}$/;
const LINE_RANGE_SUFFIX_RE = /^([1-9]\d{0,6})-([1-9]\d{0,6})$/;

export interface ChatPathLineSuffix {
  href: string;
  line?: number;
  column?: number;
}

/** 拆 `path:line[:column]` / `path:start-end` 后缀(与桌面 splitLocalLineSuffix 同语义)。 */
export function splitChatPathLineSuffix(raw: string): ChatPathLineSuffix {
  const href = raw.trim();
  if (!href) return { href };
  if (URL_SCHEME_RE.test(href) && !href.toLowerCase().startsWith('file://')) {
    return { href };
  }

  const lastColon = href.lastIndexOf(':');
  if (lastColon <= 0) return { href };

  const lastPart = href.slice(lastColon + 1);
  const beforeLastPart = href.slice(0, lastColon);

  const rangeMatch = lastPart.match(LINE_RANGE_SUFFIX_RE);
  if (rangeMatch) {
    const line = Number(rangeMatch[1]);
    const endLine = Number(rangeMatch[2]);
    if (!Number.isSafeInteger(line) || !Number.isSafeInteger(endLine) || endLine < line) {
      return { href };
    }
    return { href: beforeLastPart, line };
  }

  if (!POSITIVE_LINE_NUMBER_RE.test(lastPart)) return { href };

  const previousColon = beforeLastPart.lastIndexOf(':');
  const previousPart = previousColon >= 0 ? beforeLastPart.slice(previousColon + 1) : '';
  const hasColumn = POSITIVE_LINE_NUMBER_RE.test(previousPart);
  const base = hasColumn ? beforeLastPart.slice(0, previousColon) : beforeLastPart;
  if (!base) return { href };

  const line = Number(hasColumn ? previousPart : lastPart);
  const column = hasColumn ? Number(lastPart) : undefined;
  if (!Number.isSafeInteger(line) || line <= 0) return { href };
  if (column !== undefined && (!Number.isSafeInteger(column) || column <= 0)) return { href };

  return {
    href: base,
    line,
    ...(column !== undefined ? { column } : {}),
  };
}

/** 尾斜杠 → 目录形态(renderer 无法 stat,尾杠是唯一可靠信号)。 */
export function looksLikeDirectoryPath(text: string): boolean {
  if (!text) return false;
  return TRAILING_SEP_RE.test(text);
}

/** Windows 盘符前缀(`C:\x`)不算 scheme;file:// 允许;其余 `foo:` 前缀一律拒绝。 */
function hasUnsupportedScheme(value: string): boolean {
  if (WIN_ABS_RE.test(value)) return false;
  if (value.toLowerCase().startsWith('file://')) return false;
  return SCHEME_RE.test(value);
}

/**
 * 「形状像文件路径」严判(inline code 常见标识符/命令,宽了全是误点击目标):
 * Windows 绝对 / POSIX 绝对带扩展 / 相对带分隔符带扩展,三者任一。
 */
export function looksLikeFilePath(text: string): boolean {
  if (!text) return false;
  if (text.includes('\n')) return false;
  if (URL_SCHEME_RE.test(text)) return false;
  if (looksLikeDirectoryPath(text)) return false;
  if (WIN_ABS_RE.test(text)) return true;
  if (POSIX_ABS_PATH_RE.test(text)) return true;
  if (REL_PATH_WITH_SEP_AND_EXT_RE.test(text)) return true;
  return false;
}

/** 裸文件名引用(`package.json`),存在性由远端 stat 决定。 */
export function looksLikeBareFileReference(value: string): boolean {
  if (!value || value.includes('\n')) return false;
  if (hasUnsupportedScheme(value)) return false;
  if (looksLikeDirectoryPath(value)) return false;
  return BARE_FILE_REF_RE.test(value);
}

/**
 * classifyMarkdownHref 的 local 判定子集(不区分 image/text/model——手机预览页
 * 自己按扩展名分派):绝对路径 / 含分隔符 / 带扩展名任一即视作本地路径形态。
 */
function looksLikeLocalHref(href: string): boolean {
  if (!href) return false;
  if (/^https?:\/\//i.test(href)) return false;
  if (href.startsWith('#')) return false;
  if (URL_SCHEME_RE.test(href) && !href.startsWith('file://')) return false;
  let probe = href;
  if (probe.startsWith('file://')) probe = probe.slice(7);
  return (
    probe.startsWith('/')
    || WIN_ABS_RE.test(probe)
    || probe.includes('/')
    || probe.includes('\\')
    || HAS_EXT_RE.test(probe)
  );
}

export interface ChatPathCandidate {
  /** 去掉行号后缀与目录尾斜杠后的路径文本(拿去 join workdir)。 */
  href: string;
  line?: number;
  column?: number;
  /** 尾斜杠目录形态:verdict 为 unknown(乐观点亮)时按目录处理。 */
  directoryShape: boolean;
  /**
   * 「形状上无法与普通代码/散文区分」的歧义候选。词法层真的分不开:
   *   - 无分隔符裸名:`package.json` 与 `array.map` / `Date.now` 结构完全同形
   *     (`.map` / `.log` / `.now` 既是真实扩展名也是方法名);
   *   - 有分隔符但无扩展名:`src/components` 与 `and/or` / `n/a` / `read/write`
   *     结构完全同形。
   *
   * 用途是**把乐观点亮降级**(见 MessageRenderer.ChatPathChipSpan),而**不是**把它们
   * 排除出候选——排除会连 `` `src/components` `` 这类真实目录引用一起砍掉,那是能力
   * 倒退。歧义候选照旧发 stat,只是必须等远端明确回 file / directory 才点亮:
   * 真实存在的照常可点,`and/or` 这种永远不存在的自然保持纯文本,链路断时也不会
   * 变成可点的假链接。
   *
   * 反过来,形状明确是路径的(绝对路径 / 尾斜杠目录 / 分隔符+扩展名)不算歧义,
   * 链路断时仍乐观点亮——不因断链把整条消息的 chip 全灭掉。
   */
  ambiguousShape: boolean;
}

/**
 * 「形状上无法与普通代码 / 散文区分」的唯一判据 —— 与桌面
 * `markdownTarget.isAmbiguousPathShape` **逐字同形**(两端需同步)。
 *
 * 所有候选入口(行内 code / 显式 markdown 链接 / 正文裸路径)都必须经它算
 * `ambiguousShape`,不得按来源硬写 true/false:DESIGN.md §14.5 的**规则 4(候选门槛)**
 * 对显式链接有来源豁免,**规则 5(点亮门槛)没有** —— 混淆两者会让「有下划线 = 可点」
 * 在某一个入口上失效(PR #1144 review 实捉:这里曾对链接入口恒 false)。
 *
 * `originalHref` 传原始文本:尾斜杠在 classify* 里会被剥掉,而尾斜杠是作者显式给出的
 * 目录信号、形状明确 → 不歧义。只看剥完的 href 会把 `src/components/` 误判成歧义。
 */
export function isAmbiguousChatPathShape(href: string, originalHref?: string): boolean {
  const raw = originalHref ?? href;
  if (looksLikeDirectoryPath(raw)) return false;
  // **绝对路径正面识别,不要求扩展名。** 不能靠 looksLikeFilePath 顺带:它的
  // URL_SCHEME_RE 排除是为「别把 https:// 当本地路径」写的、POSIX 分支要求扩展名是为
  // 「别让无扩展名引用触发预览」写的,照抄就会把最明确的形态判成最可疑的 ——
  // `file:///Users/me/a.md`(检查点自查)与 `/etc/hosts`、`/usr/bin/node`
  // (PR #1144 review 实捉)是同一根因的两个分支。
  if (ABSOLUTE_PATH_SHAPE_RE.test(raw)) return false;
  return !looksLikeFilePath(href);
}

/**
 * inline code 文本 → 路径候选(与桌面 classifyInlineCodeTarget 同语义)。
 * 首尾空白 / 多行 / scheme 前缀(`mailto:`、`git+ssh://`)一律不候选;
 * 候选 ≠ 点亮,存在性由 remotePathVerdict 远端 stat 决定。
 *
 * 候选口径刻意保持宽松(与桌面 classifyInlineCodeTarget 同步):`src/components`
 * 这类「有分隔符、无扩展名」的真实目录引用必须收进来,而它与 `and/or` / `n/a`
 * 词法完全同形,想靠形状把后者排除就一定会连前者一起砍掉。精度不在这一层解决,
 * 由 ambiguousShape 把点亮门槛提高(见该字段说明)。
 */
export function classifyInlineCodePathCandidate(text: string): ChatPathCandidate | null {
  const raw = text.trim();
  if (!raw || raw !== text || raw.includes('\n')) return null;
  if (hasUnsupportedScheme(raw)) return null;

  const lineInfo = splitChatPathLineSuffix(raw);
  const href = lineInfo.href;
  if (looksLikeDirectoryPath(href)) {
    const stripped = href.replace(/[\\/]+$/, '');
    if (!stripped) return null;
    // 尾斜杠是作者显式给出的目录信号,形状明确 → 不算歧义(判据同下,不硬写字面量)。
    return { href: stripped, directoryShape: true, ambiguousShape: isAmbiguousChatPathShape(stripped, raw) };
  }
  if (!looksLikeFilePath(href) && !looksLikeBareFileReference(href) && !looksLikeLocalHref(href)) {
    return null;
  }
  return {
    href,
    directoryShape: false,
    ambiguousShape: isAmbiguousChatPathShape(href, raw),
    ...(lineInfo.line !== undefined ? { line: lineInfo.line } : {}),
    ...(lineInfo.column !== undefined ? { column: lineInfo.column } : {}),
  };
}

/**
 * markdown 链接目标 → 路径候选(与桌面 classifyMarkdownLinkTarget 的 local 分支
 * 同语义):`[README.md](/abs/path/README.md:17)` 这类模型高频输出的本地路径链接。
 * http(s) / 锚点 / 非 file 的 scheme 一律不候选(那些走原有 link 渲染分支);
 * 与 inline code 版的差异只有两处:
 *   ① 不要求原文无首尾空白(URL 在括号里,天然精确);
 *   ② 这里**保留** looksLikeLocalHref 的宽松兜底 —— `[配置](package.json)` 是作者
 *      (或模型)显式写出的链接目标,不存在「其实是属性访问」的歧义,所以进不进候选
 *      不必按形状卡(DESIGN.md §14.5 **规则 4** 的来源豁免)。
 *
 * ⚠️ 但**点亮门槛(规则 5)没有来源豁免**:ambiguousShape 照样按形状算。作者声明了
 * 「这是链接」并不能让远端在链路断时知道 `package.json` / `src/components` 是否存在,
 * 而点亮了却点不开就正是规则 1 要防的反例。此处曾恒写 false,与桌面
 * (isAmbiguousPathShape 对全部 local-candidate 一视同仁)不对称,PR #1144 review 实捉。
 * 对裸路径入口(findBareFilePathMatch)这是**无操作**:它的词法强制末段带扩展名,
 * looksLikeFilePath 必然为真 → 恒非歧义,能力不受影响(有用例钉住)。
 */
export function classifyChatPathLinkTarget(url: string): ChatPathCandidate | null {
  const raw = url.trim();
  if (!raw || raw.includes('\n')) return null;
  if (/^https?:\/\//i.test(raw)) return null;
  if (raw.startsWith('#')) return null;
  if (hasUnsupportedScheme(raw)) return null;

  const lineInfo = splitChatPathLineSuffix(raw);
  const href = lineInfo.href;
  if (looksLikeDirectoryPath(href)) {
    const stripped = href.replace(/[\\/]+$/, '');
    if (!stripped) return null;
    return { href: stripped, directoryShape: true, ambiguousShape: isAmbiguousChatPathShape(stripped, raw) };
  }
  if (!looksLikeLocalHref(href)) return null;
  return {
    href,
    directoryShape: false,
    ambiguousShape: isAmbiguousChatPathShape(href, raw),
    ...(lineInfo.line !== undefined ? { line: lineInfo.line } : {}),
    ...(lineInfo.column !== undefined ? { column: lineInfo.column } : {}),
  };
}

/**
 * href → 被控端绝对路径(与桌面 resolveLocalPath 同语义):
 * file:// 解包;绝对路径原样;相对路径按 workdir 分隔符风格 join
 * (workdir 含 `\` → Windows join 并把 href 的 `/` 归一为 `\`)。
 * 不做存在性检查——那是 remotePathVerdict 的事。
 */
export function resolveChatAbsPath(href: string, workdir: string): string {
  if (href.startsWith('file://')) {
    // 非法百分号序列(`50%off.md` 的 `%of`)会让 decodeURIComponent 抛 URIError,
    // 而本函数在 chip 组件 useMemo 里同步跑,异常会崩整条消息渲染——解码失败
    // 回退原文(bot review 实捉);路径若真不存在由远端 stat 判 nonfile 兜底。
    let p: string;
    try {
      p = decodeURIComponent(href.slice(7));
    } catch {
      p = href.slice(7);
    }
    if (/^\/[A-Za-z]:[\\/]/.test(p)) p = p.slice(1);
    return p;
  }
  if (href.startsWith('/')) return href;
  if (WIN_ABS_RE.test(href)) return href;

  const isWin = workdir.includes('\\');
  const sep = isWin ? '\\' : '/';
  // 去尾部分隔符,但保住根形态(`/`、`C:\`)。
  const trimmed = workdir.replace(/[\\/]+$/, '');
  const base = trimmed || (workdir.startsWith('/') ? '/' : workdir);
  const normalizedHref = isWin ? href.replace(/\//g, '\\') : href;
  return base === '/' ? `/${normalizedHref}` : `${base}${sep}${normalizedHref}`;
}

/** 去掉路径里的 `.` 段(`/w/./a` → `/w/a`),避免同路径两形态。 */
export function dropDotSegments(p: string): string {
  const isAbs = p.startsWith('/');
  const segs = p.split('/').filter((s) => s !== '.' && s !== '');
  return (isAbs ? '/' : '') + segs.join('/');
}

function toWorkdirRelPosix(workdir: string, absPath: string): string | null {
  if (!workdir.startsWith('/') || !absPath.startsWith('/')) return null;
  if (absPath.split('/').includes('..')) return null;
  const base = workdir.replace(/\/+$/, '');
  if (!absPath.startsWith(`${base}/`)) return null;
  const rel = absPath.slice(base.length + 1);
  return rel.length > 0 ? rel : null;
}

/**
 * 绝对路径 → workdir 相对路径(POSIX 分隔;与桌面 shared/workdirPath.ts 同语义)。
 * 不在 workdir 内(含 workdir 自身)/ `..` 逃逸 / 风格不匹配 → null。
 * Windows 被控端按大小写不敏感前缀比较,输出仍统一 POSIX 分隔。
 */
export function toWorkdirRel(workdir: string, absPath: string): string | null {
  if (!workdir || !absPath) return null;
  if (workdir.startsWith('/')) {
    return toWorkdirRelPosix(workdir, dropDotSegments(absPath));
  }
  if (!WIN_ABS_RE.test(workdir) || !WIN_ABS_RE.test(absPath)) return null;
  const w = workdir.replace(/\\/g, '/').replace(/\/+$/, '');
  const a = dropDotSegments(absPath.replace(/\\/g, '/'));
  if (a.split('/').includes('..')) return null;
  if (!a.toLowerCase().startsWith(`${w.toLowerCase()}/`)) return null;
  const rel = a.slice(w.length + 1);
  return rel.length > 0 ? rel : null;
}

/** 绝对路径形态(POSIX `/x` 或 Windows 盘符 `C:\x`),与相对路径二分。 */
export function isAbsolutePathShape(p: string): boolean {
  return p.startsWith('/') || WIN_ABS_RE.test(p);
}

/** 路径显示名:最后一段(POSIX / Windows 分隔符均可,尾分隔符忽略)。 */
export function pathDisplayName(p: string): string {
  const last = p.split(/[\\/]/).filter(Boolean).pop();
  return last ?? p;
}

/**
 * chip 是否可打开(点亮的后置条件):workdir 外(relPath 为 null)只有文件可开
 * ——文件走被控端绝对路径取件通道(fs:stat-path 已验存在);目录只能靠
 * 文件浏览器定位,而文件浏览器以 workdir 为根,workdir 外目录保持纯文本。
 * 与桌面对齐:桌面对 workdir 外目录同样只报「不在工作目录内」,无可用动作。
 */
export function canOpenChatPathChip(kind: 'file' | 'directory', relPath: string | null): boolean {
  return kind === 'file' || relPath !== null;
}

/**
 * 链接 label 是否「读起来就是个文件引用」(桌面 shouldRenderCodeReferenceLabel 的
 * 移植,两端口径需同步)。用途:决定**作者手写**的本地路径链接点亮后是否套等宽
 * chip —— `[README.md](path)` 是作者的排版意图,保留 chip;`[看这份规则](path)`
 * 是散文 label,按正文字体 + 下划线渲染。
 *
 * 正文裸写的路径不走这条判定(它没有独立 label),一律保持正文字体;见
 * DESIGN.md §14.5 的落地推论。
 */
export function chatPathLabelReadsAsFileReference(
  label: string,
  candidate: ChatPathCandidate,
  originalUrl: string,
): boolean {
  const trimmed = label.trim();
  if (!trimmed || trimmed.includes('\n')) return false;
  // label 就是 href 原文(含未剥行号后缀的形态)。
  if (trimmed === candidate.href || trimmed === originalUrl.trim()) return true;
  // label 是末段文件名,可带 :line[:column]。
  const baseName = pathDisplayName(candidate.href);
  if (trimmed === baseName) return true;
  if (candidate.line !== undefined) {
    if (trimmed === `${baseName}:${candidate.line}`) return true;
    if (candidate.column !== undefined && trimmed === `${baseName}:${candidate.line}:${candidate.column}`) {
      return true;
    }
  }
  // 形状兜底:label 自身长得像路径 / 文件名。先剥行号后缀,再复用与分类器同一组
  // 谓词,「什么算文件」全仓一致。
  const labelPath = splitChatPathLineSuffix(trimmed).href;
  return looksLikeFilePath(labelPath) || looksLikeBareFileReference(labelPath);
}

// ── 正文纯文本裸路径的词法定位(桌面 remarkLocalPathLinks 的移植) ──────────
//
// 桌面端把「回复正文纯文本里长得像本地路径的 token」切成 mdast link 节点
// (apps/desktop/src/renderer/components/chat/remarkLocalPathLinks.ts),从而复用
// 既有链接渲染链路;手机端 messageMarkdown 的 inline 分词器没有对应入口,裸路径
// 一直只是纯文本。下面是该插件正则与 findPathMatches 的等价移植;正则任一侧改动
// 都要同步另一侧(同本文件头注释的两端同步约定)。
//
// 匹配策略沿用桌面口径(桌面侧有同款说明):
//   - 用「正向路径正则」定位 token,而不是按空白切再剥边——后者在中文里
//     (`src/App.tsx,然后呢` 这种路径直接黏着中文)会把尾巴一起吞掉判废。正向
//     正则在**扩展名**处收尾,尾随的中文/标点天然落在 match 之外。
//   - 只认**带路径分隔符**的形态(相对含 `/` 或 `\` + 扩展名、`./` `../` `~/`
//     开头、POSIX 绝对、Windows 盘符)。裸文件名(`app.tsx`)在正文里太歧义,
//     不碰——这点比 inline code 更严(inline code 是作者主动用反引号标注的格式
//     信号,走 looksLikeBareFileReference)。
//   - 左边界用负向 lookbehind 卡死:路径前一个字符必须是边界,不能是另一个路径
//     字符,避免从中文 prose 中间起切。
//
// 已知限制(CJK 既可能是 prose 也可能是真实目录名 `我的看板`,词法层无法区分,故
// 一律当作路径段字符;代价在「无空白边界紧贴中文」时显现,均与现状一致、本就点不动,
// 不是回退):
//   - 前导紧贴:`见src/x.ts` → `见` 被并入 token,解析不到 → 纯文本。
//   - 中文黏连两条真路径:`a/b.ts和c/d.ts` → 中间的 `和` 被当成路径段,整串吞成
//     **一个** token,两条真路径都点不亮。
//   要救这些只能把 CJK 当分隔符,但那会反过来切断 `docs/设计稿/index.md` 里的中文
//   目录名,得不偿失,故不做。

// CJK / 假名 / 谚文:可作为路径段的一部分(如 `docs/设计稿/index.md`)。
const BARE_PATH_CJK = '\\u4e00-\\u9fff\\u3400-\\u4dbf\\u3040-\\u30ff\\uac00-\\ud7af';
// 路径段允许的字符(不含分隔符、不含 `:`)。`:` 留给盘符锚点与 `:line` 后缀。
const BARE_PATH_SEG = `[A-Za-z0-9._~@+\\-${BARE_PATH_CJK}]+`;
const BARE_PATH_SEP = '\\\\/'; // 反斜杠 + 正斜杠,字符类内用
// 锚点:盘符 `C:\` / `./` `../` / 单独的分隔符开头。
//
// **刻意不含 `~/`**:`~` 在本仓任何一层都没有展开 —— renderer 的 resolveLocalPath /
// resolveChatAbsPath 只做 join,被控端的 fs:stat-path / fs:resolve-path 也不展开,于是
// `~/logs/app.log` 会被 stat 成 `<workdir>/~/logs/app.log`:链路正常时判 nonfile、永远不
// 点亮(白发一次 stat),链路断时还会按「绝对形状」乐观点亮、点开错误地址。
// 在拿到可靠展开能力(被控端返回真实 home)之前,正文裸路径不认这个锚点
// (PR #1144 review 实捉;行内 code / 显式链接入口的同一问题是既有行为,属另一处 —— 修它
// 要改被控端协议,不是 renderer 能兜的,已在 PR 里记为 follow-up)。
const BARE_PATH_ANCHOR = `(?:[A-Za-z]:[${BARE_PATH_SEP}]|\\.{1,2}[${BARE_PATH_SEP}]|[${BARE_PATH_SEP}])`;
// `SEG` 含 `~`(备份文件 `file~` 等中段用途),所以只改锚点挡不住 `~/x`:
// `(?:SEG SEP)+` 一样能把 `~/` 当成「段+分隔符」吃下去。故在整条匹配前加负向前瞻,
// 明确拒绝以 `~/` `~\` 开头的 token(实测过:只删锚点里的 `~` 时 `~/logs/app.log`
// 仍然命中)。
const BARE_PATH_NO_HOME = '(?!~[\\\\/])';
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
const BARE_PATH_RIGHT_BOUNDARY = `(?![A-Za-z0-9_~@+\\-${BARE_PATH_CJK}${BARE_PATH_SEP}])`;
// 路径主体:要么有锚点(中间段可有可无),要么是「段+分隔符」至少一组(保证含分隔符);
// 末段必须以扩展名收尾。
//
// 扩展名后的 `(?![A-Za-z0-9])` 是**右边界**,不能省:没有它,超过 10 个字符的扩展名会被
// 截成前 10 个字符当成候选(`src/file.typescriptreact` → `src/file.typescript`),而截断后
// 的前缀形状上是「分隔符+扩展名」= 非歧义,断链时会被加下划线、允许点击,点开的是一个
// **不存在的错误路径**;正文里还留着孤零零的 `react`。加了边界之后整条路径直接不识别
// (退回纯文本),这才是想要的语义(PR #1144 review 实捉,桌面 remarkLocalPathLinks 同步)。
const BARE_PATH_BODY =
  `(?:${BARE_PATH_ANCHOR}(?:${BARE_PATH_SEG}[${BARE_PATH_SEP}])*`
  + `|(?:${BARE_PATH_SEG}[${BARE_PATH_SEP}])+)${BARE_PATH_SEG}\\.[A-Za-z0-9]{1,10}${BARE_PATH_RIGHT_BOUNDARY}`;
// 可选 `:line[:column]` 行号后缀。
const BARE_PATH_LINE_SUFFIX = '(?::[1-9]\\d{0,6}(?::[1-9]\\d{0,6})?)?';
// 左边界:前一个字符不能是路径字符 / 分隔符(`:` 不算,允许 `文件:src/x.ts`)。
const BARE_PATH_LEFT_BOUNDARY = `(?<![A-Za-z0-9._~@+${BARE_PATH_CJK}${BARE_PATH_SEP}])`;
const BARE_PATH_RE_SOURCE =
  `${BARE_PATH_LEFT_BOUNDARY}${BARE_PATH_NO_HOME}(${BARE_PATH_BODY}${BARE_PATH_LINE_SUFFIX})`;

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
const TOKEN_CHAR_RE = new RegExp(`[A-Za-z0-9_~@+\\-${BARE_PATH_CJK}\\\\/]`);
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

export interface BareFilePathMatch {
  /** 在 input 里的起始下标。 */
  index: number;
  /** 结束下标(不含)。 */
  end: number;
  /** 命中的路径文本(含可能的 `:line` 后缀,交给渲染层再拆)。 */
  value: string;
}

/**
 * 在一段纯文本里定位从 `from` 起**第一条**「带分隔符、可解析形状」的裸路径。
 * 与桌面 findPathMatches 同一套复核口径:剥行号后缀 → looksLikeFilePath,与
 * inline code / 链接共用同一组谓词,「什么算文件路径」全仓一致。
 *
 * 候选 ≠ 点亮:`16/9.0`、`a/b.c` 这类形状达标的误命中同样返回,存在性由远端
 * stat(remotePathVerdict)兜底,解析不到就保持纯文本。
 */
export function findBareFilePathMatch(input: string, from: number): BareFilePathMatch | null {
  // 不含任何路径分隔符的文本一定不是带分隔符路径。这条短路在渲染热路径上逐 token
  // 生效(见 messageMarkdown.findNextInlineToken),不能省。
  if (!input.includes('/') && !input.includes('\\')) return null;
  // 每次调用新建:`g` 标志的 lastIndex 是可变状态,模块级共享在提前 return /
  // 未过重置路径时会漏匹配(同 messageMarkdown 里各 matcher 的既有约定)。
  const re = new RegExp(BARE_PATH_RE_SOURCE, 'g');
  re.lastIndex = Math.max(0, from);
  let m: RegExpExecArray | null;
  while ((m = re.exec(input)) !== null) {
    const value = m[1];
    if (!looksLikeFilePath(splitChatPathLineSuffix(value).href)) continue;
    const index = m.index + (m[0].length - value.length);
    // 边界后置过滤:命中必须独占它所在的路径 token(见 startsMidPathToken 的说明)。
    if (startsMidPathToken(input, index)) continue;
    if (endsMidPathToken(input, index + value.length)) continue;
    return { index, end: index + value.length, value };
  }
  return null;
}
