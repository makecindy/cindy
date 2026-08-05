/**
 * deepLink (renderer) — cindy:// (+ 历史 xdt-maker://) URL 拼装 helper
 *
 * scheme 单点在 shared/deepLinkSchemes.ts(事实源 @cindy/maker-shared 的
 * brand-identity):**生成一律主 scheme cindy://,解析主 + 历史 scheme 都认**
 * (存量消息里复制的 xdt-maker:// 老链接不能死)。
 * 解析在 main 端做（src/main/deepLink.ts），renderer 只需要"复制深度链接"
 * 时把 sessionId / workingDir 拼成可粘贴的字符串。两端实现是 pure function、
 * 等价镜像，没必要走 IPC 跨进程拉。
 */

import {
  DEEP_LINK_URL_PREFIX,
  DEEP_LINK_SCHEME_RE_GROUP,
  stripDeepLinkPathPrefix,
} from '../../shared/deepLinkSchemes';

/** 生成侧前缀(cindy://)。解析侧不要 startsWith 它——用 stripDeepLinkPathPrefix。 */
const URL_PREFIX = DEEP_LINK_URL_PREFIX;
const SESSION_PREFIX = `${URL_PREFIX}session/`;

/** 深链构建可选项:deviceId = 会话归属的 device-link 设备(远程会话冻结来源)。 */
export interface SessionDeepLinkOptions {
  /**
   * 会话归属设备(device-link deviceId)。远程会话在生成深链时就把来源设备
   * 冻进 `?device=` 参数——发送时的 sessionRefs 解析不再依赖「被控端此刻
   * 在线且会话列表已同步」的内存实时状态(relay 重连窗口内查表 miss 会把
   * 远程会话错判成本地,引用内容注入失败)。本机会话传 undefined/null,
   * 生成不带参数的旧格式。
   */
  deviceId?: string | null;
}

function sessionDeepLinkQuery(
  opts: SessionDeepLinkOptions | undefined,
  messageClientId?: string,
): string {
  const pairs: string[] = [];
  if (messageClientId) pairs.push(`message=${encodeURIComponent(messageClientId)}`);
  if (opts?.deviceId) pairs.push(`device=${encodeURIComponent(opts.deviceId)}`);
  return pairs.length > 0 ? `?${pairs.join('&')}` : '';
}

export function buildSessionDeepLink(sessionId: string, opts?: SessionDeepLinkOptions): string {
  return `${SESSION_PREFIX}${encodeURIComponent(sessionId)}${sessionDeepLinkQuery(opts)}`;
}

/** 带消息锚点的会话深链:点击后跳到会话内指定消息(clientId 语义,跨设备稳定)。 */
export function buildSessionMessageDeepLink(
  sessionId: string,
  messageClientId: string,
  opts?: SessionDeepLinkOptions,
): string {
  return `${SESSION_PREFIX}${encodeURIComponent(sessionId)}${sessionDeepLinkQuery(opts, messageClientId)}`;
}

/**
 * RFC 3986 严格编码:encodeURIComponent 会放行 `!'()*`,而项目深链的文本
 * 匹配白名单(PROJECT_DEEP_LINK_RE_SOURCE)排除裸 `()` `'`(不吞 markdown
 * 定界符 / 英文引号)——目录名含这些字符时生成的链接会在括号处被截断
 * (review P2)。构建端把五个字符也转成 %XX,生成的深链永不含裸定界符;
 * decodeURIComponent 对 %21 %27 %28 %29 %2A 原生可解,解析端零改动。
 */
function strictEncodeURIComponent(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export function buildProjectDeepLink(workingDir: string): string {
  return `${URL_PREFIX}project/${strictEncodeURIComponent(workingDir)}`;
}

/**
 * 会话深链在自由文本中的匹配正则「源」(无 flag):ASCII 白名单,CJK / 空白 /
 * 中文标点处天然收尾。userMessageLinkify(用户消息 linkify)、sessionLinkPaste
 * (输入框粘贴转 chip)从这里取同一来源,与 remarkSessionLinks(AI 消息)/
 * mobile sessionLinks 的匹配口径保持一致。消费方自行 `new RegExp(source, 'g')`
 * (每次新建实例,避免共享 lastIndex 状态)。
 */
export const SESSION_DEEP_LINK_RE_SOURCE =
  `${DEEP_LINK_SCHEME_RE_GROUP}:\\/\\/session\\/[A-Za-z0-9%~_-]+(?:\\?[A-Za-z0-9%&=~._-]*)?`;

/**
 * 项目深链 `<scheme>://project/<urlencoded-workingDir>` 的匹配正则源
 * (cindy / xdt-maker 双 scheme)。
 * workingDir 经 strictEncodeURIComponent(空格、`/`、CJK、`!'()*` 全部转
 * %XX),白名单排除裸 `()` `'`(不吞 markdown `[..](..)` 定界符与英文引号)
 * ——本端生成的深链经严格编码永不含这些裸字符;外部手拼的含裸括号链接
 * 降级为纯文本(可接受)。保留 `!*` 是兼容历史已复制的旧链接(旧编码放行
 * 这两个字符,且它们不与任何定界符冲突)。
 *
 * 尾部负向前瞻 = 白名单 ∪ `'(`:普通 encodeURIComponent 还放行 `'()`,
 * 历史链接可能含裸 `'` `(`(`%2Ffoo(copy)` / `%2FJohn's%20Repo`),白名单
 * 在此截断会得到「合法但指错项目」的前缀匹配(review P2)——匹配终止处
 * 紧跟 `'` / `(` 时整段拒绝、降级纯文本。前瞻里必须并入白名单字符本身:
 * 贪婪 `+` 匹配到头时后继必不在白名单,此时前瞻只判 `'(`;而回溯出的任何
 * 短前缀其后继都在白名单内、前瞻必败——等效原子组,杜绝「回退一个字符
 * 绕过前瞻」的截断(JS 无占有量词,这是标准写法)。`)` 不进拒绝集:散文
 * 括号包裹 `(链接)` 与 markdown `](href)` 收尾都以 `)` 紧跟匹配,拒绝会
 * 误伤主流形态;目录名含未配对 `)` 的残余风险接受。
 */
export const PROJECT_DEEP_LINK_RE_SOURCE =
  `${DEEP_LINK_SCHEME_RE_GROUP}:\\/\\/project\\/[A-Za-z0-9%~._!*-]+(?![A-Za-z0-9%~._!*('-])`;

/** `text[idx]` 前是否有奇数个连续反斜杠(markdown 转义语义,`\\]` 是字面反斜杠+配对括号)。 */
function isMarkdownEscaped(text: string, idx: number): boolean {
  let backslashes = 0;
  for (let i = idx - 1; i >= 0 && text.charCodeAt(i) === 92 /* \\ */; i--) backslashes++;
  return backslashes % 2 === 1;
}

/**
 * markdown 形式深链 `[label](href)` 的 label 起点定位:从 `](` 的 `]` 下标
 * 向左做方括号平衡回扫(CommonMark 的链接文本语义)——`[[WIP] 标题](url)`
 * 取到最外层 `[`(label 含内层方括号),`[x] [标题](url)` 只取紧邻的 `[`
 * (前置的 `[x]` 保持普通文本)。转义括号(`\\[` / `\\]`,含反斜杠奇偶判定)
 * 是字面字符、不参与配对——`[修复 \\] 白屏](url)` 能取到整段 label;锚点
 * `]` 自身被转义时整段不是链接收尾 → -1。遇换行(label 不跨行)或无匹配
 * → -1。消费方:pastePipeline / sessionLinkPaste / userMessageLinkify
 * (PR #970 多轮 review 反馈后的定稿,贪婪 / 非贪婪正则都无法同时满足
 * 上述用例);取到的 label 展示前用 unescapeMarkdownLabelBrackets 反转义。
 */
export function findMarkdownLabelStart(text: string, closeBracketIdx: number): number {
  if (isMarkdownEscaped(text, closeBracketIdx)) return -1;
  let depth = 1;
  for (let i = closeBracketIdx - 1; i >= 0; i--) {
    const ch = text.charCodeAt(i);
    if (ch === 10 /* \n */) return -1;
    if (ch !== 93 /* ] */ && ch !== 91 /* [ */) continue;
    if (isMarkdownEscaped(text, i)) continue;
    if (ch === 93) depth++;
    else {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** label 展示用反转义:`\\[` / `\\]` 还原为字面括号(与回扫的转义语义配对)。 */
export function unescapeMarkdownLabelBrackets(label: string): string {
  return label.replace(/\\([[\]])/g, '$1');
}

export interface SessionDeepLinkTarget {
  sessionId: string;
  /** `?message=<clientId>` 锚点;无锚点 / 锚点值非法时为 null(sessionId 仍有效)。 */
  messageClientId: string | null;
  /** `?device=<deviceId>` 冻结的会话归属设备;旧格式深链 / 参数值非法时为 null。 */
  deviceId: string | null;
}

/**
 * 解析 `<scheme>://session/<id>[?message=<clientId>]`(cindy / xdt-maker
 * 双 scheme 都认,按实际命中的前缀长度切片)。
 * 非本形态 / sessionId 为空或解码失败 → null。
 *
 * 手解而不用 `new URL()`:WHATWG URL 对 non-special scheme 的 host/pathname
 * 切分行为跨引擎不稳(与 main/deepLink.ts 同一结论),split 最稳。
 */
export function parseSessionDeepLinkHref(href: string): SessionDeepLinkTarget | null {
  const rest = stripDeepLinkPathPrefix(href, 'session/');
  if (rest === null) return null;
  const hashIdx = rest.indexOf('#');
  const noHash = hashIdx >= 0 ? rest.slice(0, hashIdx) : rest;
  const queryIdx = noHash.indexOf('?');
  const rawId = (queryIdx >= 0 ? noHash.slice(0, queryIdx) : noHash).replace(/\/+$/, '');
  if (!rawId) return null;
  let sessionId: string;
  try {
    sessionId = decodeURIComponent(rawId);
  } catch {
    return null;
  }
  if (!sessionId) return null;
  let messageClientId: string | null = null;
  let deviceId: string | null = null;
  if (queryIdx >= 0) {
    const query = noHash.slice(queryIdx + 1);
    for (const pair of query.split('&')) {
      const eqIdx = pair.indexOf('=');
      if (eqIdx <= 0) continue;
      const key = pair.slice(0, eqIdx);
      if (key !== 'message' && key !== 'device') continue;
      if (key === 'message' ? messageClientId !== null : deviceId !== null) continue;
      const rawValue = pair.slice(eqIdx + 1);
      if (!rawValue) continue;
      try {
        const decoded = decodeURIComponent(rawValue);
        if (!decoded) continue;
        if (key === 'message') messageClientId = decoded;
        else deviceId = decoded;
      } catch {
        // 参数编码非法 → 按无该参数处理,不拖累整条链接
      }
    }
  }
  return { sessionId, messageClientId, deviceId };
}

/**
 * 解析 `<scheme>://project/<urlencoded-workingDir>` → workingDir(被控端
 * native 绝对路径;cindy / xdt-maker 双 scheme 都认)。非本形态 / 为空 /
 * 解码失败 → null。与 main/deepLink.ts 的 project 分支等价镜像(同样剥
 * hash / query / 尾斜杠后整体 decode)。
 */
export function parseProjectDeepLinkHref(href: string): { workingDir: string } | null {
  const rest = stripDeepLinkPathPrefix(href, 'project/');
  if (rest === null) return null;
  const hashIdx = rest.indexOf('#');
  const noHash = hashIdx >= 0 ? rest.slice(0, hashIdx) : rest;
  const queryIdx = noHash.indexOf('?');
  const raw = (queryIdx >= 0 ? noHash.slice(0, queryIdx) : noHash).replace(/\/+$/, '');
  if (!raw) return null;
  let workingDir: string;
  try {
    workingDir = decodeURIComponent(raw);
  } catch {
    return null;
  }
  return workingDir ? { workingDir } : null;
}

/**
 * 从 workingDir 取末段目录名做展示(POSIX / Windows 分隔符都认;根目录 /
 * 盘符根等取不出末段时回退原串)。renderer 侧无 node:path,手撕字符串。
 */
export function projectDisplayName(workingDir: string): string {
  const trimmed = workingDir.replace(/[\\/]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  const base = idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
  return base || workingDir;
}
