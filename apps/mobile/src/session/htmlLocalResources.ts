/**
 * htmlLocalResources —— 本地 HTML 里「同目录资源引用」的纯字符串识别与改写。
 * ---------------------------------------------------------------------------
 * 手机端渲染 agent 产出的 HTML(见 HtmlFileReader)只拿到 HTML 本身,页面里
 * `<img src="./chart.png">` / `<link href="assets/a.css">` 这类相对引用在
 * `source={{ html }}` 的 about:blank 文档里解析不到,于是多文件产物「页面能开、
 * 图和样式全缺」。桌面端靠 `file://` 的同目录天然没有这个问题。
 *
 * 这里补齐:把相对引用挑出来 → 换算成被控端绝对路径 → 上层逐个走既有 `media:fetch`
 * 取件通道取回字节 → **转成 `data:` URI** 回填进 HTML。**不新增 device-link channel、
 * 不新增安全面**,用的还是单文件预览已经在用的那条绝对路径取件通道。
 *
 * ⚠️ 回填进页面的必须是 `data:` URI,**不能是预签名地址**:页面是可执行的不可信文档,
 * 内联脚本能读 `img.src` 再以 no-cors 外传,等于把一个 bearer 凭证交出去
 * (review P1 实捉)。配套的网络出口封锁见 htmlPreviewCsp。
 *
 * 全部纯函数,无 IO、无 RN 依赖,可单测。取件与并发编排在 useHtmlLocalResources。
 *
 * ── 边界(刻意收窄,fail-closed) ──────────────────────────────────────────
 *  - **只认相对引用**。`/assets/a.png`(根相对)在文件系统里指向盘根,语义上是
 *    web root、换算不出正确路径;`file:///…`、`C:\…` 这类本机绝对引用则是最该
 *    警惕的形态(一个 HTML 就能把被控端任意路径拉进渲染)。两者一律不改写,
 *    保持原样(渲染成破图),不猜。
 *  - **含 `..` 段的一律拒绝**。想放行就必须定义「逃到哪一层还算安全」,那是独立
 *    的边界决定;这里选最简单且明确安全的口径:引用只能落在 HTML 自己所在目录
 *    的**词法**子树内。真实的「单文件 + assets/」产物不受影响。
 *    ⚠️ 本文件只能做到「词法子树」—— 产物目录里若有指向目录外的软链,词法路径完全合法。
 *    真实的目录约束由**被控端**强制:取件 URL 带 `baseDir`,mediaFetch 对资源与 baseDir
 *    各自 realpath 后判定包含关系(见 mediaFetch 的 PathMediaConstraints)。两层缺一不可,
 *    这里的拒绝只是第一道、也是唯一能省掉一次 RPC 的那道。
 *  - http(s) / data: / blob: / 协议相对 `//host` / 纯锚点 `#x` 不属于本地资源,
 *    原样保留(它们本来就能加载,或本来就不该加载)。
 *  - `srcset` 不处理(多候选 + 密度描述符,收益低于复杂度),`<style>` 块里的
 *    `url()` 处理,外链 CSS **内部**的 `url()` 不处理(那要先取回 CSS 再递归解析,
 *    属下一步)。
 */

/**
 * 可改写的标签 → 该标签上承载资源地址的属性名(全小写)。
 *
 * **`iframe` / `embed` 刻意不在表里**(review P2):HtmlFileReader 注入的 CSP 固定含
 * `frame-src 'none'` 与 `object-src 'none'`,这两类嵌入**必然被引擎拦掉** —— 取回来也渲染不出。
 * 留着它们只会白花一次取件(被控端上传 + 手机下载 + OSS 对象创建与回收),还占掉 32 项配额里
 * 的位置,把真正能渲染的图片 / 样式挤掉。表里只放 CSP 放行得了的类型。
 */
const RESOURCE_ATTRS_BY_TAG: Readonly<Record<string, readonly string[]>> = {
  img: ['src'],
  script: ['src'],
  link: ['href'],
  source: ['src'],
  video: ['src', 'poster'],
  audio: ['src'],
  // `image` 有**两种语境**,三个属性都要收(自审补 `src`,review 只提到前两个):
  //  - SVG 里是真的 SVG 图片元素:`<svg><image href="chart.png"/></svg>`;
  //    `xlink:href` 是 SVG 1.1 写法,浏览器仍支持且导出工具多用它。
  //  - **HTML 里 `<image>` 是 `<img>` 的废弃别名** —— 实测(Chromium)
  //    `<image src="a.png">` 被解析成 `IMG` 且是 `HTMLImageElement`,浏览器照常加载。
  //    只收 href 会让 `<image src="…">` 这种写法漏掉、渲染成破图。
  // CSP 的 `img-src data:` 放行这三条路,不收就必然缺图。
  image: ['href', 'xlink:href', 'src'],
};

/** 一次改写最多取回多少个资源(超出部分原样保留,由上层如实报告数量)。 */
export const HTML_RESOURCE_LIMIT = 32;

/**
 * 单个资源的字节上限。资源会以 `data:` URI 整份进 JS 字符串与 DOM(见
 * downloadRemoteMediaAsDataUri 为什么不用预签名地址),不设上限会被一张大图撑爆内存。
 * 2 MiB 覆盖设计稿里的常规配图与字体;超限的保留原引用、渲染成破图并如实提示。
 */
export const HTML_RESOURCE_MAX_BYTES = 2 * 1024 * 1024;

/**
 * **整页**内联总量上限(按回填进 HTML 的 `data:` URI 字符长度计)。
 *
 * 逐文件上限 + 条数上限挡不住总量(review P1):32 个接近 2 MiB 的资源 ≈ 64 MiB 原始字节
 * ≈ 85 MiB base64,而取件 Map、回填后的 HTML、以及 WebView source 序列化会同时各持一份 ——
 * 在常见移动端堆限制下足以 OOM。预览内容来自不可信的 agent 产物,这就是一条稳定的
 * 拒绝服务输入,必须有累计预算。
 *
 * 按 `data:` URI **字符长度**计而不是原始字节:那才是真正占内存的东西(base64 约 4/3 倍)。
 * 8 MiB 够装一份带十几张配图的设计稿;超预算的资源不取,保留原引用并如实提示。
 */
export const HTML_RESOURCE_TOTAL_MAX_CHARS = 8 * 1024 * 1024;

/**
 * `data:` URI 前缀的字符预算(`data:` + mime + `;base64,`)。表里最长的 mime 是
 * `application/font-woff2` 一级,连前后缀不到 40 字符;取 64 留余量,**必须偏大** ——
 * 预算换算里它用于「估算上界」,估小了会让预留不够、实际长度越过预留。
 */
const DATA_URI_PREFIX_MAX_CHARS = 64;

/** 原始字节数 → 内联成 `data:` URI 后的字符数上界(base64 4/3 倍 + 前缀)。 */
export function dataUriCharsForBytes(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes <= 0) return DATA_URI_PREFIX_MAX_CHARS;
  return Math.ceil(bytes / 3) * 4 + DATA_URI_PREFIX_MAX_CHARS;
}

/**
 * 字符预算 → 这份预算最多能装下多少原始字节(dataUriCharsForBytes 的保守逆运算)。
 *
 * 保证 `dataUriCharsForBytes(bytesForDataUriChars(c)) <= c`,即按它换算出的字节上限
 * 取件、内联后一定装得进 `c` 个字符 —— 预留制靠这条不等式保证「在途也不越总预算」。
 */
export function bytesForDataUriChars(chars: number): number {
  if (!Number.isFinite(chars)) return 0;
  const payload = Math.floor(chars) - DATA_URI_PREFIX_MAX_CHARS;
  if (payload <= 0) return 0;
  return Math.floor(payload / 4) * 3;
}

/**
 * 资源扩展名 → MIME。**必须给准**:`data:` URI 的类型由它决定,给成
 * `application/octet-stream` 时浏览器会拒绝把它当样式表/脚本用(样式静默失效)。
 * 表外类型不猜,返回 null → 上层不改写该引用(fail-closed)。
 */
const RESOURCE_MIME_BY_EXT: Readonly<Record<string, string>> = {
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
};

/**
 * 文件系统路径 → MIME。**入参是已解析出的文件系统路径,不是 URL。**
 *
 * 刻意**不剥** `?` / `#`(review P2):唯一调用方传的是 resolveHtmlResourcePath 的输出,
 * 那已经是「按 URL 规则剥过 query/fragment、再做过百分号解码」的真实路径。此处再剥一次
 * 就把文件名里合法的保留字符当成 URL 语法:同目录文件 `chart#1.png` 在引用里按 URL 规则
 * 写成 `chart%231.png`,解析后得到 `/…/chart#1.png`,原实现在这里把 `#1.png` 当 fragment
 * 截掉 → 扩展名判定失败 → 引用被静默排除,而浏览器实际会正常加载它。
 *
 * 与 filePreview 里 remoteFilePreviewKind 这轮的修正是同一个根因:**一个函数吃两种语义**
 * (URL / 文件名)。这里的契约定死为文件名一种。
 */
export function htmlResourceMimeFor(fsPath: string): string | null {
  const dot = fsPath.lastIndexOf('.');
  if (dot < 0) return null;
  // 目录里带点、文件名不带点时(`a.b/plain`)最后一个点不属于文件名 —— 扩展名判定应失败。
  const lastSep = Math.max(fsPath.lastIndexOf('/'), fsPath.lastIndexOf('\\'));
  if (dot < lastSep) return null;
  return RESOURCE_MIME_BY_EXT[fsPath.slice(dot).toLowerCase()] ?? null;
}

/** 任意 scheme(`https://`、`file://`、`data:`、`mailto:` …)。 */
const HAS_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const WIN_ABS_RE = /^[A-Za-z]:[\\/]/;
/**
 * 基目录是否 Windows 路径 —— 只认**根形态**:盘符(`C:\` / `C:/`)或 UNC(`\\server\share`)。
 * 不能用「路径里含反斜杠」判(review P2):POSIX 上反斜杠是合法文件名字符。
 */
const WIN_ROOT_RE = /^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/])/;

/**
 * 被控端绝对路径是否 Windows 形态。**导出供预览页共用,不要各写一份。**
 *
 * review 连挖两处同根因(`resolveHtmlResourcePath` 与预览页的 `absolutePathOf`),都是用
 * 「路径里含反斜杠」判 Windows —— POSIX 上反斜杠是合法文件名/目录名字符,`/tmp/a\b` 会被
 * 误判,拼出来的路径不存在,该页**所有**同目录资源取件失败。修一处漏一处的成因就是判定
 * 各写一份,所以这次抽出来共用。
 */
export function isWindowsAbsPath(absPath: string): boolean {
  return WIN_ROOT_RE.test(absPath);
}

/**
 * 按被控端路径形态拼接目录与相对路径(分隔符与相对路径里的斜杠一起归一)。
 *
 * 预览页与本模块共用同一份实现,避免「一处修好、另一处照旧」。
 */
export function joinRemotePath(baseAbsPath: string, relPath: string): string {
  if (!baseAbsPath) return relPath;
  const win = isWindowsAbsPath(baseAbsPath);
  const sep = win ? '\\' : '/';
  // 只有 Windows 才把相对路径里的 `/` 换成 `\`;POSIX 上 `\` 是合法字符,不能反向替换。
  const tail = win ? relPath.replace(/\//g, '\\') : relPath;
  return `${baseAbsPath}${baseAbsPath.endsWith(sep) ? '' : sep}${tail}`;
}

/** HTML 里一处待改写的资源引用(区间指向**属性值本身**,不含引号)。 */
export interface HtmlResourceRef {
  /** 属性值在原 HTML 里的起始下标。 */
  start: number;
  /** 结束下标(不含)。 */
  end: number;
  /** 原始引用文本(未解码)。 */
  raw: string;
  /** 换算出的被控端绝对路径(取件用)。 */
  absPath: string;
  /** 该资源的 MIME(data: URI 用;未知类型不会进候选)。 */
  mimeType: string;
  /**
   * 原引用里的片段标识(含 `#`,无则空串)。
   *
   * 取件按无 fragment 的路径走,但**回填时必须补回去**(review P2):
   * `url(sprite.svg#download)` / `<img src="icons.svg#logo">` 这类 SVG sprite 引用靠
   * fragment 选中目标 view/symbol,丢掉它浏览器只会渲染 SVG 根文档。
   */
  fragment: string;
}

/** 属性值里合法且会影响文件名的命名字符引用(HTML 规范要求 `&` 在属性里转义)。 */
const NAMED_CHAR_REFS: Readonly<Record<string, string>> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
};

/**
 * 解码属性值里的 HTML 字符引用(命名 + 十进制 + 十六进制)。
 *
 * 为什么必需(review P2):`<img src="charts/A&amp;B.png">` 浏览器请求的是 `A&B.png`,
 * 把原始属性文本直接拿去取件会取一个不存在的名字、渲染成破图。`&` 在属性值里**必须**
 * 写成字符引用,所以这不是边缘写法。
 *
 * 只解码这一层,**不做**百分号解码(那一步在 resolveHtmlResourcePath 里,顺序不能颠倒:
 * 先解字符引用得到浏览器眼中的 URL,再按 URL 规则解百分号得到文件名)。
 * 表外的命名引用原样保留 —— 猜错会造出不存在的路径,不如保持破图(fail-closed)。
 */
export function decodeHtmlCharRefs(value: string): string {
  if (!value.includes('&')) return value; // 廉价短路(逐引用调用)
  return value.replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
    if (body.startsWith('#')) {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      // 代理区与越界码点不还原:String.fromCodePoint 会抛,且那不是合法文件名字符。
      if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff) return whole;
      if (code >= 0xd800 && code <= 0xdfff) return whole;
      return String.fromCodePoint(code);
    }
    return NAMED_CHAR_REFS[body] ?? whole;
  });
}

/**
 * 引用文本 → 被控端绝对路径;不是「同目录子树内的相对引用」一律返回 null。
 *
 * `baseDirAbsPath` 是 HTML 文件所在目录的被控端绝对路径(POSIX 或 Windows 皆可)。
 */
export function resolveHtmlResourcePath(baseDirAbsPath: string, raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || !baseDirAbsPath) return null;
  if (trimmed.startsWith('#')) return null;
  if (trimmed.startsWith('//')) return null; // 协议相对
  if (HAS_SCHEME_RE.test(trimmed)) return null; // http(s) / data: / file: / …
  if (trimmed.startsWith('/')) return null; // 根相对:语义是 web root,换算不出路径
  if (WIN_ABS_RE.test(trimmed)) return null; // 本机绝对

  // 去查询串与片段:取件只认路径本身(改写会替掉整个引用,丢掉它们无副作用)。
  const pathOnly = trimmed.split(/[?#]/)[0] ?? '';
  if (!pathOnly) return null;

  // `%20` 之类要还原成真实文件名。非法百分号序列不 throw,回退原文
  // (同 resolveChatAbsPath 的既有处理)。
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathOnly);
  } catch {
    decoded = pathOnly;
  }

  // Windows 判定只看**根形态**(盘符 `C:\` 或 UNC `\\server\share`),不看路径里有没有反斜杠
  // (review P2):macOS / Linux 上目录名可以合法含反斜杠,`/tmp/a\b/index.html` 会被
  // `includes('\\')` 误判成 Windows,于是拼出 `/tmp/a\b\chart.png` —— POSIX 把后一个反斜杠
  // 也当普通文件名字符,取件路径根本不存在,该页所有同目录资源全失败。
  const isWin = isWindowsAbsPath(baseDirAbsPath);
  const segments = decoded.split(/[\\/]/);
  // `..` 逃逸一律拒绝;`.` 段丢掉;空段(`a//b`)丢掉。
  // 这只是**词法**子树约束(软链绕不掉),真实目录边界由被控端 realpath 包含判定强制,
  // 见本文件头注与 mediaFetch 的 PathMediaConstraints。
  const kept: string[] = [];
  for (const seg of segments) {
    if (seg === '..') return null;
    if (seg === '.' || seg === '') continue;
    kept.push(seg);
  }
  if (kept.length === 0) return null;

  const sep = isWin ? '\\' : '/';
  const base = baseDirAbsPath.replace(/[\\/]+$/, '') || (baseDirAbsPath.startsWith('/') ? '' : baseDirAbsPath);
  return `${base}${sep}${kept.join(sep)}`;
}

/** HTML 文件绝对路径 → 它所在目录的绝对路径(保住根形态)。 */
export function htmlBaseDirOf(htmlAbsPath: string): string {
  const lastSep = Math.max(htmlAbsPath.lastIndexOf('/'), htmlAbsPath.lastIndexOf('\\'));
  if (lastSep < 0) return '';
  if (lastSep === 0) return '/'; // `/a.html` → 根目录
  return htmlAbsPath.slice(0, lastSep);
}

/**
 * RAWTEXT / RCDATA 元素的**内容区间** —— 这些区间里的 `<` 不开标签,扫描必须跳过。
 *
 * ── 为什么这次可以做,而被删掉的 masking 层不行 ──────────────────────────────
 * 两者看起来都是「先划出不该扫的区域」,但判据的性质完全不同:
 *  - masking 层要判的是**注释 / `<template>` 体 / CSS 注释** —— 那需要知道某个 `<` 处在哪个
 *    HTML 数据态里,是开放集合(连挖五轮,每轮一种新形态),没有 tokenizer 做不到;
 *  - RAWTEXT 的终止规则是**闭合的**:HTML 规范规定 `<script>` 的内容直到 `</script` 后跟
 *    空白 / `/` / `>` 才结束,**字符串、注释、嵌套一律不影响**(这正是 JS 里写 `'</script>'`
 *    会提前闭合文档的原因)。一条规则、无例外,不需要通用 tokenizer。
 * 所以这不是把 masking 加回来 —— 那条注释说的「除非引入真 HTML tokenizer」针对的是数据态
 * 判定,不是 RAWTEXT 终止序列。
 *
 * ── 为什么必须跳过(真实危害是**功能正确性**,不是读文件) ─────────────────────
 * 不跳过时全局标签正则会命中脚本字符串里的伪标签,而 applyHtmlResourceUrls 会**真的把它替换**
 * 成 `data:` URI,于是作者脚本的源码被改写:
 * ```js
 * const tpl = '<img src="logo.png">';   // ← 被替成 data:image/png;base64,… 整段
 * tpl.replace('logo.png', next);         // ← 后续字符串处理全部失效
 * ```
 * 把 HTML 模板放在 JS 字符串里是产物里的常见写法,所以这会打坏**正常页面**。
 *
 * 附带说明 review 里标成 security 的那条(「脚本能读取未被 DOM 引用的被控端文件」):
 * 那一点**不构成攻击面增量** —— 页面整份都由不可信产物控制,作者想读同一批文件,直接写一个
 * 真的 `<img src="secret.css">` 就会被正常回填,不需要伪标签。伪标签的增量危害只有上面那条
 * (改写自己的脚本源码),所以本修复按**功能正确性**记,不当安全修复宣传。
 *
 * ⚠️ 残留误判(如实记录):开标签仍靠正则找,`<div data-tpl="<script>">` 这种把字面
 * `<script>` 写进属性值的页面会被误认为进入了脚本体,于是后面一段真引用被跳过、渲染成缺图。
 * 代价权衡:该形态极罕见,而「HTML 模板放 JS 字符串」很常见,净收益为正。两种失败都只影响
 * 资源是否内联,不影响文档结构。
 */
const RAW_TEXT_CONTENT_TAGS = ['script', 'style', 'textarea', 'title'] as const;

/**
 * `<style>` 也在表里(review P2),但它**只能用于标签扫描的跳过,不能用于 CSS `url()` 扫描** ——
 * 否则样式块里的 `url()` 会连同伪标签一起被跳掉,多文件产物的背景图整批丢失。
 *
 * 具体分工:
 *  - 标签扫描(`<img src>` 这类)跳过**全部**四种 RAWTEXT 内容 —— 包括 style,因为
 *    `<style>code::before{content:'<img src="a.png">'}</style>` 里那个 `<img>` 只是 CSS 字符串
 *    里的字面文本,浏览器当文字显示;当成真标签回填就**篡改了页面显示内容**(review 实捉);
 *  - CSS `url()` 扫描专扫 `<style>` 体,所以它按「除 style 外」的 RAWTEXT 判跳过 ——
 *    脚本字符串里的 `<style>` 字面量仍不算样式块。
 * 两个用途各取所需,不能共用一份 span。
 *
 * ⚠️ **必须各扫一次,不能「扫全集再 filter 掉 style」** —— 那不是等价变换。span 的边界依赖
 * tag 集合本身:扫描命中一段内容后会把游标推到体尾(`openRe.lastIndex = bodyEnd`),所以
 * 集合里少一个 tag 会让原本被它「吞掉」的内层伪标签重新变成开标签。实测差异:
 *   `<style>var s='<script>x</script>'</style>`
 *     全集扫  → style[7,33)          (整个 style 体是一段)
 *     除 style → script[22,23)        (style 不成段,体内的伪 script 反而成了段)
 * 两者位置与数量都不同。合并成一次扫描 + filter 会静默改变判定结果,用例钉住了这一点。
 */
const TAG_SCAN_SKIP_TAGS = RAW_TEXT_CONTENT_TAGS;
const CSS_SCAN_SKIP_TAGS = RAW_TEXT_CONTENT_TAGS.filter((t) => t !== 'style');

export function findRawTextContentSpans(
  html: string,
  tags: readonly string[] = RAW_TEXT_CONTENT_TAGS,
): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  if (tags.length === 0) return spans;
  const openRe = new RegExp(`<(${tags.join('|')})\\b[^<>]*>`, 'gi');
  let open: RegExpExecArray | null;
  while ((open = openRe.exec(html)) !== null) {
    const tag = open[1].toLowerCase();
    // 开标签本身**不在**跳过区间里 —— `<script src="a.js">` 的 src 仍要被收。
    const bodyStart = open.index + open[0].length;
    const rest = html.slice(bodyStart);
    const rel = rest.search(new RegExp(`</${tag}(?=[\\s/>])`, 'i'));
    // 没有结束标签时整段到文末都是内容(与解析器一致)。
    const bodyEnd = rel < 0 ? html.length : bodyStart + rel;
    if (bodyEnd > bodyStart) spans.push({ start: bodyStart, end: bodyEnd });
    // **从体尾继续找下一个开标签**:体内的 `<script>` 字面量因此不会被当成开标签(顺序扫描)。
    openRe.lastIndex = bodyEnd;
  }
  return spans;
}

/**
 * 位置是否落在某个跳过区间里 —— **二分,不是线性扫**。
 *
 * 自审发现的 DoS 面(与 HTML_RESOURCE_TOTAL_MAX_CHARS 同一类):预览内容是不可信的 agent
 * 产物,一份塞了 5000 个 `<script>` 的 HTML 会产生 5000 个 span,而标签扫描本身也有上万次
 * 匹配 —— 线性判定是 O(n·m) ≈ 5×10⁷ 次比较,足以在移动端卡住 JS 线程。而 spans 由
 * findRawTextContentSpans 顺序生成,天然**按 start 升序且互不重叠**,二分是 O(log m)。
 *
 * 不用「共用游标单指针」是因为本函数有两个调用方(标签扫描与 `<style>` 块扫描),
 * 各自独立推进,共用游标会互相打乱。
 */
function isInsideSpans(pos: number, spans: readonly { start: number; end: number }[]): boolean {
  let lo = 0;
  let hi = spans.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = spans[mid];
    if (pos < s.start) hi = mid - 1;
    else if (pos >= s.end) lo = mid + 1;
    else return true;
  }
  return false;
}

/** 一段 CSS 文本里的 `url(...)` 引用(区间相对该段文本)。 */
function findCssUrlRefs(css: string): Array<{ start: number; end: number; value: string }> {
  const out: Array<{ start: number; end: number; value: string }> = [];
  // 函数名 ASCII 大小写不敏感(review P1):`background: URL("hero.png")` 是合法 CSS,
  // CSS 解析器照常加载,只认小写会让这类资源整个漏掉、渲染成空白。
  const urlRe = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s]+))\s*\)/gi;
  let m: RegExpExecArray | null;
  while ((m = urlRe.exec(css)) !== null) {
    const value = m[1] ?? m[2] ?? m[3] ?? '';
    if (!value) continue;
    const at = m.index + m[0].indexOf(value);
    out.push({ start: at, end: at + value.length, value });
  }
  return out;
}

/**
 * 扫出 HTML 里全部可改写的本地资源引用(按出现顺序)。
 *
 * 收三类:标签白名单上的资源属性(`<img src>` / `<link href>` / …)、`<style>` 块里的
 * `url()`、以及**任意标签的 `style` 属性**里的 `url()`。只做词法定位与路径换算,不判断
 * 文件是否存在 —— 取不到的由上层保留原引用。
 *
 * ── 刻意**不做**惰性文本掩码(曾经做过,已整块删除) ────────────────────────
 * 早先这里先把注释 / `<script>` 体 / `<template>` 体 / CSS 注释抹成等长空白再扫,目的是
 * 「伪引用不要占掉 32 项配额」。那条路被 review 连挖五轮,每轮一种新的误判形态:注释里的
 * 伪引用 → `<template>` 体 → 属性值里的字面标签(`<div data-tpl="<template>">`)→ 脚本
 * 字符串里的孤立 `<!--` → 两个属性值分别含 `<!--` 与 `-->` 被配成一段注释。
 *
 * 根因是**正则扫标签无法判别「`<` 处在哪个 HTML 数据态里」**,要根治得有真正的 tokenizer。
 * 而两种失败模式的代价差一个数量级:不掩码最多让伪引用占掉配额(**图少取几个**,可见的
 * 退化);掩错却会把中间的真资源整段抹掉(**正常页面静默缺图**,不可见)。所以放弃掩码,
 * 接受前者。**不要再把它加回来** —— 除非引入真正的 HTML tokenizer。
 *
 * ── 唯一的例外:RAWTEXT 内容(`<script>` / `<textarea>` / `<title>` 体)确实跳过 ──────
 * 上面那条禁令针对的是**数据态判定**(某个 `<` 算不算标签),那是开放集合。RAWTEXT 不同:
 * 它的终止规则由规范写死为「`</tag` 后跟空白 / `/` / `>`」,字符串与注释一律不影响,是**闭合
 * 规则**,不需要 tokenizer 也能精确实现(见 findRawTextContentSpans)。
 * 必须跳过的理由也比配额严重一档:不跳过时脚本字符串里的伪标签会被**真的回填**,直接改写
 * 作者脚本源码(`const tpl = '<img src="logo.png">'` 整段变成 data: URI),打坏正常页面。
 *
 * ── 已知限制(需要真 tokenizer,故不在本文件解决;PR 描述里列为已知限制) ────────────
 * 下面这些形态会让个别资源**不被内联**(渲染成破图 / 空白背景,可见的退化,fail-closed),
 * 但不会改写文档结构,也不会取到目录外文件:
 *  - 属性值里含 `>` 时标签边界判定会提前结束(`<img alt="w>90" src="a.png">` 的 src 收不到);
 *  - `style` 属性里用字符引用写 CSS 引号(`style="background:url(&quot;a.png&quot;)"`)时,
 *    先按原文找 `url()` 会把 `&quot;` 计入 URL;
 *  - 命名字符引用只解码 6 个常用项(`amp/lt/gt/quot/apos/nbsp`),`&eacute;` 之类表外引用
 *    保持原样 → 取不到 → 保留原引用(不猜,fail-closed);
 *  - SVG fragment 取自解码后的值,fragment 里含引号时按原上下文回填会破坏属性。
 * 这四类的正确解法都需要「按 HTML 数据态解析 + 保留原文区间映射」,即真 tokenizer。
 * 而 `apps/mobile` 新增依赖会改动 runtime fingerprint → 触发冷更门,属独立决定。
 */
export function collectHtmlLocalResourceRefs(
  html: string,
  baseDirAbsPath: string,
): HtmlResourceRef[] {
  if (!html || !baseDirAbsPath) return [];
  const refs: HtmlResourceRef[] = [];
  const push = (start: number, end: number, raw: string): void => {
    // 路径解析前先解码 HTML 字符引用(review P2):`<img src="charts/A&amp;B.png">` 浏览器
    // 请求的是 `A&B.png`,原始属性文本直接拿去取件会取一个不存在的名字、渲染成破图。
    // **区间仍用原始文本的下标**,回填替换的是原样那段,所以解码只影响取件路径。
    const decoded = decodeHtmlCharRefs(raw);
    const absPath = resolveHtmlResourcePath(baseDirAbsPath, decoded);
    if (!absPath) return;
    // fragment 单独留着:取件不带它,回填要补回去(见 HtmlResourceRef.fragment)。
    const hashAt = decoded.indexOf('#');
    const fragment = hashAt >= 0 ? decoded.slice(hashAt) : '';
    // MIME 未知的不改写:data: URI 的类型由它决定,给错会让样式表/脚本被浏览器拒收,
    // 猜一个反而制造"看起来取到了其实没生效"的假象(fail-closed)。
    const mimeType = htmlResourceMimeFor(absPath);
    if (!mimeType) return;
    refs.push({ start, end, raw, absPath, mimeType, fragment });
  };

  // ① 标签属性。先定位标签(含标签名判定),再在该标签文本内找目标属性 ——
  //    直接全局扫 `src=` 会把不在白名单标签上的属性也改写掉。
  //
  //    **标签白名单只约束「资源属性」这一路,不约束 `style` 属性**:任意标签都能带内联样式
  //    (`<div style="background-image:url(...)">`),所以这里不能因为标签不在白名单就整个跳过
  //    (这条正是本轮 style 属性 finding 的第一版实现踩到的:分支写在 `continue` 之后,永远到不了)。
  //    RAWTEXT 内容整段跳过 —— 那里的 `<` 不开标签,收进来会被真的回填:脚本体里会改写作者
  //    脚本源码,`<style>` 体里会把 CSS 字符串(`content:'<img src="a.png">'`)当成真标签、
  //    篡改页面显示内容(见 findRawTextContentSpans 的说明)。
  const tagScanSkipSpans = findRawTextContentSpans(html, TAG_SCAN_SKIP_TAGS);
  const tagRe = /<([a-zA-Z][a-zA-Z0-9-]*)\b([^<>]*)>/g;
  let tag: RegExpExecArray | null;
  while ((tag = tagRe.exec(html)) !== null) {
    if (isInsideSpans(tag.index, tagScanSkipSpans)) continue;
    const attrs = RESOURCE_ATTRS_BY_TAG[tag[1].toLowerCase()];
    const attrsText = tag[2];
    const attrsOffset = tag.index + 1 + tag[1].length;
    const attrRe = /([a-zA-Z_:][a-zA-Z0-9:._-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
    let attr: RegExpExecArray | null;
    while ((attr = attrRe.exec(attrsText)) !== null) {
      const attrName = attr[1].toLowerCase();
      const value = attr[2] ?? attr[3] ?? attr[4] ?? '';
      if (!value) continue;
      // 起点算法与下面共用:整段匹配末尾回退 value 长度,再补回收尾引号。
      const valueStartOf = (): number => {
        const q = attr![2] !== undefined || attr![3] !== undefined;
        return attrsOffset + attr!.index + attr![0].length - value.length - (q ? 1 : 0);
      };
      // **内联 `style` 属性里的 `url()` 也要收**(review P1):
      // `<div style="background-image:url('./hero.png')">` 是产物里最常见的写法之一,
      // 只扫 `<style>` 块会让它在 about:blank 文档里渲染成空白背景。
      // 任意标签都可能带 style,所以不受资源标签白名单限制。
      if (attrName === 'style') {
        const styleAttrOffset = valueStartOf();
        for (const hit of findCssUrlRefs(value)) {
          push(styleAttrOffset + hit.start, styleAttrOffset + hit.end, hit.value);
        }
        continue;
      }
      if (!attrs || !attrs.includes(attrName)) continue;
      const valueStart = valueStartOf();
      push(valueStart, valueStart + value.length, value);
    }
  }

  // ② `<style>` 块里的 `url(...)`(同一份文档里的内联样式,顺手就能补齐)。
  //    这一路**专扫 `<style>` 体**,所以跳过判据要排除 style 本身(否则样式块里的 url()
  //    会连同伪标签一起被跳掉,背景图整批丢失)。脚本字符串里的 `<style>` 字面量仍不算样式块。
  const cssScanSkipSpans = findRawTextContentSpans(html, CSS_SCAN_SKIP_TAGS);
  const styleRe = /<style\b[^<>]*>([\s\S]*?)<\/style\s*>/gi;
  let style: RegExpExecArray | null;
  while ((style = styleRe.exec(html)) !== null) {
    if (isInsideSpans(style.index, cssScanSkipSpans)) continue;
    const body = style[1];
    const bodyOffset = style.index + style[0].indexOf(body, style[0].indexOf('>'));
    for (const hit of findCssUrlRefs(body)) {
      push(bodyOffset + hit.start, bodyOffset + hit.end, hit.value);
    }
  }

  // 属性扫描与 style 扫描各自有序,合并后按位置排序,回填时才能从后往前替。
  return refs.sort((a, b) => a.start - b.start);
}

/**
 * 把取回的资源回填进 HTML。装进去的是 **`data:` URI**,不是预签名地址 —— 页面里绝不
 * 出现 bearer 凭证(见 downloadRemoteMediaAsDataUri 的说明)。
 *
 * `urlByAbsPath` 缺某个路径(取件失败 / 超限 / 超出条数上限)时该处**保持原引用** ——
 * 渲染成破图比换成一个错地址诚实。回填从后往前做,前面的区间下标不受影响。
 */
export function applyHtmlResourceUrls(
  html: string,
  refs: readonly HtmlResourceRef[],
  urlByAbsPath: ReadonlyMap<string, string>,
): string {
  let out = html;
  for (let i = refs.length - 1; i >= 0; i -= 1) {
    const ref = refs[i];
    const url = urlByAbsPath.get(ref.absPath);
    if (!url) continue;
    // fragment 补回 data: URI 之后:SVG sprite 靠它选目标 symbol/view。
    out = out.slice(0, ref.start) + url + ref.fragment + out.slice(ref.end);
  }
  return out;
}

/**
 * 去重后的待取路径清单(按首次出现顺序),并给出被上限截掉的数量。
 * 上限存在时必须让上层能如实报告,不做静默截断。
 */
export interface HtmlResourceFetchTarget {
  absPath: string;
  mimeType: string;
  /**
   * 该路径在文档里被引用的**次数**(去重前)。
   *
   * 取件按路径去重(同一张图引用十次只取一次),但 applyHtmlResourceUrls 会在**每一处**
   * 引用都完整插入那份 `data:` URI —— 所以总量预算必须按 `长度 × refCount` 计费
   * (review P1 实捉:100 个 `<img src="a.png">` 指向同一张 2 MiB 图,只计一次时能通过
   * 8 MiB 预算,回填后却生成约 267 MiB 的 HTML,WebView 序列化时 OOM)。
   */
  refCount: number;
}

export function planHtmlResourceFetches(refs: readonly HtmlResourceRef[]): {
  targets: HtmlResourceFetchTarget[];
  skipped: number;
} {
  const seen = new Map<string, HtmlResourceFetchTarget>();
  const targets: HtmlResourceFetchTarget[] = [];
  let skipped = 0;
  for (const ref of refs) {
    const known = seen.get(ref.absPath);
    if (known) {
      // 重复引用不新增取件,但要累加引用次数 —— 预算按回填后的实际增量计费。
      known.refCount += 1;
      continue;
    }
    if (targets.length >= HTML_RESOURCE_LIMIT) {
      // 超限的路径也登记(refCount 不再有意义,占位防止同一路径重复计入 skipped)。
      seen.set(ref.absPath, { absPath: ref.absPath, mimeType: ref.mimeType, refCount: 1 });
      skipped += 1;
      continue;
    }
    const target: HtmlResourceFetchTarget = {
      absPath: ref.absPath,
      mimeType: ref.mimeType,
      refCount: 1,
    };
    seen.set(ref.absPath, target);
    targets.push(target);
  }
  return { targets, skipped };
}
