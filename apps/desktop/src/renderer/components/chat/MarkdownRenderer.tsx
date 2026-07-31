/**
 * MarkdownRenderer
 * ---------------------------------------------------------------------------
 * Wraps react-markdown with remark-gfm and rehype-highlight.
 *
 * F-MSG-2: Markdown rendering with code highlighting
 * - Code blocks: JetBrains Mono, Card bg + Board border + 12px radius
 * - Inline code: Stone bg + 4px padding + 6px radius
 * - GFM tables, lists, bold, italic, links
 * - HTML tags filtered (no <script>); safe single <img> tags are normalized
 *   into Markdown image nodes before HTML filtering.
 */

import { createElement, memo, useEffect, useRef, useState, useMemo, isValidElement, type HTMLAttributes, type ReactNode } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeHighlight from 'rehype-highlight';
import rehypeKatex from 'rehype-katex';
import rehypeSlug from 'rehype-slug';
import 'katex/dist/katex.min.css';
import remarkTruncateCjkUrls from './remarkTruncateCjkUrls';
import remarkStrictInlineMath from './remarkStrictInlineMath';
import { normalizeMathDelimiters } from '@cindy/maker-shared/math-markdown';
import remarkLocalPathLinks from './remarkLocalPathLinks';
import remarkHtmlImages from './remarkHtmlImages';
import remarkPreserveLocalImagePaths, {
  RAW_LOCAL_IMAGE_SRC_PROP,
} from './remarkPreserveLocalImagePaths';
import remarkSessionLinks from './remarkSessionLinks';
import { rehypeMathBlockMarker } from './rehypeMathBlockMarker';
import { FENCED_CODE_PROP, rehypeFencedCodeMarker } from './rehypeFencedCodeMarker';
import { CopyAsImageBlock, mathBlockToLatex, tableToTsv } from './CopyAsImageBlock';
import type { Components, UrlTransform } from 'react-markdown';
import type { PluggableList } from 'unified';
import { Check, Copy, FolderOpen } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn, basename } from '@/lib/utils';
import {
  looksLikeFilePath,
  MODEL_EXT_RE,
  normalizeMarkdownImageSrc,
  resolveLocalPath,
  resolveLocalPathSmartCached,
  peekResolveLocalPathSmart,
  toLocalFileUrl,
  type KnownLocalFileRef,
  type SmartResolveResult,
} from '@/lib/localPathResolver';
import {
  classifyInlineCodeTarget,
  classifyMarkdownLinkTarget,
  looksLikeBareFileReference,
  splitLocalLineSuffix,
  type MarkdownLocalKind,
  type MarkdownTarget,
} from '@/lib/markdownTarget';
import { isBrowserOpenablePath } from '../../../shared/browserOpenableExts';
import {
  hasDeepLinkPathPrefix,
  isDeepLinkProtocol,
  isDeepLinkUrl,
} from '../../../shared/deepLinkSchemes';
import { rewriteToRemoteMediaOrigin, type RemoteMediaOrigin } from '../../../shared/remoteMediaUrl';
import { useChatSessionFile } from './ChatSessionFileContext';
import { toRemoteMediaOrigin } from '@/lib/sessionFileOrigin';
import { toast } from '@/lib/toast';
import { shouldOpenTextLightboxForOrigin } from '@/lib/filePreview';
import { isRemoteFileOrigin, type SessionFileOrigin } from '@/lib/sessionFileOrigin';
import {
  fetchChatFileWithToasts,
  peekRemotePathVerdict,
  revealRemoteChatFile,
  verifyRemotePathCached,
} from '@/lib/remoteFileOpen';
import { i18n } from '@/i18n';
import { toWorkdirRel } from '../../../shared/workdirPath';
import { openDirInSidebarFileBrowser } from '@/features/right-sidebar/lib/openInSidebarFileBrowser';
import { useSidebarTargetSessionId } from '@/features/cc-agent/embeddedSessionNavigation';
import { registerMedia } from '@/lib/mediaPlaybackBus';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { SessionHandoffCard } from './SessionHandoffCard';
import { SessionLinkChip } from './SessionLinkChip';
import { ProjectLinkChip } from './ProjectLinkChip';
import { ImageLightbox } from './ImageLightbox';
import { ImageHoverPreview } from './ImageHoverPreview';
import { ImageMissingPlaceholder } from './ImageMissingPlaceholder';
import { MarkdownDiffBlock } from './MarkdownDiffBlock';
import { MarkdownMermaidBlock } from './MarkdownMermaidBlock';
import { TextLightbox } from './TextLightbox';
import { ModelLightbox } from './ModelLightbox';
import { useFileChipContextMenu } from './useFileChipContextMenu';
import {
  isHtmlFilePath,
  openHtmlFileByPreference,
  openUrlByPreference,
  useOpenWithMenu,
} from './useOpenWithMenu';

/**
 * Recursively flatten an arbitrary react-markdown children tree into a
 * plain string. react-markdown v10 hands us the highlighted AST inside
 * `<code>` (a tree of <span class="hljs-...">...</span>), so we can't rely
 * on `children` being a flat string. We walk it and concatenate leaf text.
 */
function nodeToText(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(nodeToText).join('');
  if (isValidElement(node)) {
    const props = node.props as { children?: ReactNode };
    return nodeToText(props?.children);
  }
  return '';
}

function omitMarkdownInternalProps(props: Record<string, unknown>): Record<string, unknown> {
  const safeProps = { ...props };
  delete safeProps.className;
  delete safeProps.node;
  return safeProps;
}

/**
 * Detect whether a `pre` child element is a `<code className="language-diff">`.
 * Matches both the canonical `language-diff` token and a bare `diff` class
 * for defensive parity.
 */
function isDiffCodeChild(child: ReactNode): boolean {
  if (!isValidElement(child)) return false;
  const className = (child.props as { className?: string })?.className ?? '';
  return /\b(language-)?diff\b/.test(className);
}

/**
 * Same shape as isDiffCodeChild but for ```mermaid fenced blocks. Routed
 * through MarkdownMermaidBlock for SVG render with light/dark theme awareness.
 */
function isMermaidCodeChild(child: ReactNode): boolean {
  if (!isValidElement(child)) return false;
  const className = (child.props as { className?: string })?.className ?? '';
  return /\b(language-)?mermaid\b/.test(className);
}

// Module-level constants — defined once, never recreated across renders.
// Passing inline arrays ([remarkGfm], [rehypeHighlight]) would create a new
// array reference on every render, causing react-markdown to re-parse the
// entire markdown AST every time even when content hasn't changed.
// remarkTruncateCjkUrls 必须排在 remarkGfm 之后:gfm 的 autolink literal 会把
// 「https://x.com/foo（中文」整体当成 url(spec 故意如此, 不修), 我们在 ast 层
// 后处理一刀, 把误吞的 CJK / 全角字符切回 link 后面的 text 节点。
// remarkHtmlImages 必须在 skipHtml 生效前把安全的单 <img> HTML 节点转成 mdast
// image,否则模型在表格里输出的 `<img src="...">` 会被整段过滤掉。
// remarkLocalPathLinks 排在 remarkGfm 之后:gfm 已把裸 URL autolink 成 link 节点,
// 路径 tokenizer 只扫剩下的纯 text 节点,天然不会去碰已成链接的 URL。
// remarkSessionLinks 只进受信任内容(privileged)的插件链:把正文裸写的
// cindy://session/(+ 历史 xdt-maker://)深链切成 link 节点 → `a` 渲染器升级成 SessionLinkChip。
// 顺序:在 remarkTruncateCjkUrls 之后(它只回收 gfm autolink 的 CJK 误吞,不碰
// 之后生成的 link)、remarkLocalPathLinks 之前(session URL 先成 link,路径插件
// 跳过 link 内 text,不会把 `session/<uuid>` 误当相对路径)。两个数组都是模块级
// 常量,引用稳定,不破坏 react-markdown 的 re-parse 优化。
// remarkMath: `$...$` / `$$...$$` → inlineMath / math 节点(micromark 语法扩展,
// parse 阶段生效,与其它 transformer 的相对顺序无关)。`\(...\)` / `\[...\]` 定界
// 符在 parse 前由 normalizeMathDelimiters 归一化成 dollar 形式(desktop / mobile
// 共用实现,见 @cindy/maker-shared 的 mathMarkdown.ts)。remarkStrictInlineMath
// 紧随其后,把松散配对的 inlineMath(货币文本、跨 code span)降级回原文,
// 规则与 mobile parser 对齐。
// remarkGfm singleTilde:false — 删除线只认标准 GFM 的 `~~text~~`,单个 `~` 保持
// 字面量。默认 singleTilde:true 会把「4~6……4~6」这类区间写法中间整段划成删除线,
// mobile 自研 parser(messageMarkdown.ts)本就只匹配 `~~`,此处对齐。
const REMARK_PLUGINS: PluggableList = [
  [remarkGfm, { singleTilde: false }],
  remarkMath,
  remarkStrictInlineMath,
  remarkTruncateCjkUrls,
  remarkHtmlImages,
  remarkPreserveLocalImagePaths,
  remarkLocalPathLinks,
];
const REMARK_PLUGINS_PRIVILEGED: PluggableList = [
  [remarkGfm, { singleTilde: false }],
  remarkMath,
  remarkStrictInlineMath,
  remarkTruncateCjkUrls,
  remarkHtmlImages,
  remarkPreserveLocalImagePaths,
  remarkSessionLinks,
  remarkLocalPathLinks,
];
// rehypeSlug: assigns a slug-style `id` to every heading. Without it
// in-document anchor links (`[Section](#section-name)`) hit dead targets.
// Click-to-scroll behaviour is wired up at the document level below.
// rehypeKatex 必须排在 rehypeHighlight 之前:remark-math 产出的 hast 是
// `<code class="language-math ...">`,先让 katex 消费掉,否则 highlight 会往
// 里面塞 hljs span 破坏纯文本结构。strict:'ignore' 静默非致命 LaTeX 告警;
// errorColor 走语义豁免 error token,解析失败的公式以错误色显示原文。
// rehypeMathBlockMarker 紧随 rehypeKatex:把裸 `<span class="katex-display">`
// 包进 `<div data-math-block>`,让下方 div 渲染器能挂「复制为图片」工具栏
// (components 映射只认 tagName,认不了 class)。
// rehypeFencedCodeMarker 必须排在最后:katex 已消费掉 `$$…$$` 的 `<pre><code>`、
// highlight 已注入 hljs span,此时剩下的 `pre > code` 就是真正的代码块,给它们
// 打 data-fenced-code 供下方 code 渲染器按结构(而非语言标注)分派。
const REHYPE_PLUGINS: PluggableList = [
  rehypeSlug,
  [rehypeKatex, { strict: 'ignore', errorColor: 'var(--error-fg)' }],
  rehypeMathBlockMarker,
  rehypeHighlight,
  rehypeFencedCodeMarker,
];
const MARKDOWN_LINK_CLASS = 'text-[var(--msg-link)] underline underline-offset-2 cursor-pointer [overflow-wrap:anywhere]';
/**
 * markdown 行内 code —— 几何与底色对齐 GitHub(6px 圆角 + 左右内距 + 半透明淡底,
 * 见 --msg-md-inline-code-bg 的说明)。
 *
 * 底色刻意用 --msg-md-inline-code-bg 而不是 --msg-code-inline-bg:后者是实色的
 * chip / hover 底,同时被可点的 FileTargetChip 与十余处 hover:bg- 复用;行内 code
 * 若用同一个值,就和「有底色 = 可点路径 chip」这个信号撞车了。
 *
 * 移动端**刻意不同形态**(零底色 + 文字压暗):那边聊天流是 RN 嵌套 Text,不认
 * borderRadius,淡底只能是直角方块。这里是 CSS,按 GitHub 原样实现。
 */
const INLINE_CODE_CLASS = 'font-mono text-14 rounded-[6px] px-[0.4em] py-[0.2em] bg-[var(--msg-md-inline-code-bg)]';

const WINDOWS_ABSOLUTE_HREF_RE = /^[A-Za-z]:[\\/]/;

// react-markdown's defaultUrlTransform whitelists only http(s)/ircs/mailto/xmpp
// and strips everything else to "" (broken <img>). We render local-cache images
// via the privileged xdt-image:// and xdt-file:// schemes registered in main.
// cindy:// (+ 历史 xdt-maker://) is our internal deep-link protocol (session /
// project navigation), handled in-renderer by the <a> onClick below — must pass
// through unsanitized so href reaches the click handler intact.
const trustedUrlTransform: UrlTransform = (url, key) => {
  if (
    url.startsWith('xdt-image://') ||
    url.startsWith('cindy-media://') ||
    url.startsWith('xdt-file://') ||
    url.startsWith('xdt-audio://') ||
    // device-link 入方向远程媒体:远程会话里的媒体 URL 被改写成此 scheme,经 OSS 中转取字节。
    url.startsWith('cindy-remote-media://') ||
    isDeepLinkUrl(url) ||
    url.startsWith('file://') ||
    WINDOWS_ABSOLUTE_HREF_RE.test(url) ||
    (key === 'src' && url.startsWith('data:'))
  ) {
    return url;
  }
  return defaultUrlTransform(url);
};

const previewSafeUrlTransform: UrlTransform = (url, key) => {
  if (key === 'src') return /^https?:\/\//i.test(url) ? url : '';
  return defaultUrlTransform(url);
};

interface MarkdownRendererProps {
  /** F1: session cwd used to resolve relative paths in markdown links.
   *  Stable per-session — only changes on session switch (parent remount). */
  workingDir: string;
  content: string;
  /** When true, react-markdown re-parse + rehype-highlight runs at most
   *  ~10fps via useStreamingThrottle. The final value is always flushed
   *  synchronously when this flag flips back to false, so the completed
   *  message never misses its last token. Default false (static content
   *  paths like TextLightbox bypass the throttle entirely). */
  isStreaming?: boolean;
  /** Files uploaded in the session. Used to resolve model-authored links like
   *  `[doc.docx](doc.docx)` back to the original attachment path. */
  localFileRefs?: readonly KnownLocalFileRef[];
  /** Current chat session, used by session-handoff cards to build a return link. */
  currentSessionId?: string;
  currentSessionTitle?: string | null;
  /** 受信任内容可解析本地路径和 xdt-* 内部协议；外部 Market 内容必须关闭。 */
  allowPrivilegedLinks?: boolean;
  /**
   * doc 模式专用 opt-in: 在每个 block 元素根上写入 `data-source-line="<N>"`,
   * N = 该节点在源码里的 1-based 起始行号 (取自 mdast `node.position.start.line`)。
   * 用于 doc 模式下 preview ↔ edit 切换时锚定 viewport 位置 —— FileBodyView 在切
   * mode 前从 preview viewport 顶找一个带此属性的元素拿 line, 切到对面后让
   * CodeMirror scrollToLine 对齐 (反向同理)。
   *
   * chat 端调用方 **不传** 此 prop → 默认 false → wrap 分支不进入 → components
   * 对象与改造前 byte-for-byte 一致, chat DOM 输出 / 行为完全不变 (这是 doc 锚点
   * 方案 A 的安全前提)。
   */
  emitSourceLines?: boolean;
}

function parseSessionCardHref(href: string): {
  sessionId: string;
  title: string | null;
  wake: 'resumed' | 'already-active' | 'created';
  lastActive: string | null;
} | null {
  try {
    const url = new URL(href);
    // 双 scheme:cindy: 主 + 历史 xdt-maker: 都认(存量消息里的老卡片链接不死)。
    if (!isDeepLinkProtocol(url.protocol) || url.hostname !== 'session-card') return null;
    const sessionId = decodeURIComponent(url.pathname.replace(/^\/+/, '')).trim();
    if (!sessionId) return null;
    const wake = url.searchParams.get('wake');
    if (wake !== 'resumed' && wake !== 'already-active' && wake !== 'created') return null;
    const title = url.searchParams.get('title');
    const rawLastActive = url.searchParams.get('last_active');
    if (title === null || rawLastActive === null) return null;
    return {
      sessionId,
      title: title.trim() ? title : null,
      wake,
      lastActive: rawLastActive === 'null' ? null : rawLastActive,
    };
  } catch {
    return null;
  }
}

/**
 * Throttle a rapidly-changing string to at most one render per
 * `intervalMs`. Caps react-markdown re-parse + rehype-highlight CPU
 * during SDK streaming, where text deltas can land 30-60 times/s even
 * after the main-process IPC batcher.
 *
 * - `enabled=false`  → returns `value` directly each call (no setState
 *   loop, no timer overhead, identical behavior to passing through).
 * - `enabled=true`   → rate-limits via setTimeout; the trailing edge is
 *   guaranteed (no-token-lost). Switching back to false flushes the
 *   latest value synchronously.
 */
function useStreamingThrottle(value: string, enabled: boolean, intervalMs = 100): string {
  const [throttled, setThrottled] = useState(value);
  const latestRef = useRef(value);
  const lastEmitRef = useRef(0);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    latestRef.current = value;

    if (!enabled) {
      if (timerRef.current != null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      // Stream just ended — flush whatever the most recent value is so
      // the final frame is never the last throttled snapshot.
      if (throttled !== value) setThrottled(value);
      return;
    }

    const now = performance.now();
    const elapsed = now - lastEmitRef.current;
    if (elapsed >= intervalMs) {
      lastEmitRef.current = now;
      setThrottled(value);
      return;
    }
    if (timerRef.current == null) {
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        lastEmitRef.current = performance.now();
        setThrottled(latestRef.current);
      }, intervalMs - elapsed);
    }
    // No new timer needed — an in-flight one will pick up latestRef
    // when it fires.
  }, [value, enabled, intervalMs, throttled]);

  useEffect(() => {
    return () => {
      if (timerRef.current != null) window.clearTimeout(timerRef.current);
    };
  }, []);

  return throttled;
}

/**
 * CodeBlockPre — fenced code block with a hover-revealed copy button at the
 * top-right corner. The button reads `innerText` from the live <pre>, so it
 * always copies the latest text even mid-stream. We use group-hover to keep
 * the chrome out of the way until the user reaches for it.
 */
function CodeBlockPre({ children, ...props }: HTMLAttributes<HTMLPreElement>) {
  const { t } = useTranslation();
  const preRef = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current != null) window.clearTimeout(timerRef.current);
    };
  }, []);

  async function handleCopy() {
    const text = preRef.current?.innerText ?? '';
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (timerRef.current != null) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => {
        setCopied(false);
        timerRef.current = null;
      }, 1500);
    } catch {
      toast.error(t('chat.media.copyFailed'));
    }
  }

  return (
    <div className="group relative my-3">
      <pre
        ref={preRef}
        className={cn(
          'rounded-[12px]',
          'border border-[var(--msg-code-block-border)]',
          'bg-[var(--msg-code-block-bg)]',
          'p-4 font-mono text-[length:var(--app-code-font-size)] leading-[1.5]',
          'select-text',
          // 取消横向滚动:长行/长 token 自动折行,避免出现横滚条
          'whitespace-pre-wrap break-all',
        )}
        {...props}
      >
        {children}
      </pre>
      <button
        type="button"
        onClick={handleCopy}
        aria-label={copied ? t('chat.markdownRenderer.codeCopied') : t('chat.markdownRenderer.copyCode')}
        title={copied ? t('chat.markdownRenderer.codeCopied') : t('chat.markdownRenderer.copy')}
        className={cn(
          'absolute right-2 top-2 inline-flex h-7 w-7 items-center justify-center',
          'rounded-md border border-[var(--msg-code-block-border)]',
          'bg-[var(--msg-code-block-bg)] text-[var(--msg-tool-text)]',
          'opacity-0 transition-opacity duration-150',
          'group-hover:opacity-100 focus-visible:opacity-100',
          'hover:bg-[var(--cmd-palette-item-hover)] hover:text-[var(--msg-assistant-text)]',
        )}
      >
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
    </div>
  );
}

const baseComponents: Components = {
  // NOTE: the `code` renderer is NOT defined here at module level anymore.
  // Inline-code path detection (text-lightbox-trigger-extension v2) needs
  // workingDir + setLightboxSrc + setTextLightboxFile to make detected
  // paths clickable, so it lives inside the instance-level `useMemo` below
  // alongside `a` and `img`. Fenced code blocks still pass through to the
  // simpler renderer there. See line ~310 for the implementation.

  pre({ children, ...props }) {
    // Intercept ```diff fenced blocks before they fall through to highlight.js
    // — we render them with our own row/gutter/symbol layout (MarkdownDiffBlock)
    // so the visual matches the Edit-tool DiffView card and the GitHub red/green
    // tokens (`--diff-add-fg` / `--diff-del-fg`) get applied predictably.
    // Other languages (js/ts/python/...) still go through the default pre+code
    // path with rehype-highlight.
    const firstChild = Array.isArray(children) ? children[0] : children;
    if (isDiffCodeChild(firstChild)) {
      const codeChildren = (firstChild as { props: { children?: ReactNode } })
        .props.children;
      const raw = nodeToText(codeChildren);
      return <MarkdownDiffBlock raw={raw} />;
    }
    if (isMermaidCodeChild(firstChild)) {
      const codeChildren = (firstChild as { props: { children?: ReactNode } })
        .props.children;
      const raw = nodeToText(codeChildren);
      return <MarkdownMermaidBlock raw={raw} />;
    }

    return <CodeBlockPre {...props}>{children}</CodeBlockPre>;
  },

  // Tables (GFM)。外层 CopyAsImageBlock 承载「复制为图片 / 标注」hover 工具栏,
  // overflow 容器下沉为内层(工具栏挂 overflow 容器内会被裁剪并随横滚漂移)。
  table({ children, ...props }) {
    return (
      <CopyAsImageBlock
        className="my-3"
        contentClassName="overflow-x-auto"
        extractPlainText={tableToTsv}
      >
        <table
          className={cn(
            'w-full border-collapse',
            'text-14',
          )}
          {...props}
        >
          {children}
        </table>
      </CopyAsImageBlock>
    );
  },

  // 块级 KaTeX 公式(rehypeMathBlockMarker 包装出的 div[data-math-block])。
  // 其余 div 原样透传——markdown 输出里 div 极少见,不影响其它内容。
  div({ children, node, ...props }) {
    if (node?.properties && 'dataMathBlock' in node.properties) {
      return (
        <CopyAsImageBlock extractPlainText={mathBlockToLatex}>{children}</CopyAsImageBlock>
      );
    }
    return <div {...props}>{children}</div>;
  },

  th({ children, ...props }) {
    return (
      <th
        className={cn(
          'border border-[var(--msg-table-border)] px-3 py-2 text-left',
          'bg-[var(--msg-table-header-bg)] font-medium',
          // 长 token (文件路径、逗号分隔列表等) 没有词边界,
          // 不强制断行会撑爆 td 宽度 → 表格超过消息流容器 → 触发
          // overflow-x-auto 横滚 + .is-scrolling 自动隐藏滚动条,
          // 视觉上像被右边截断。anywhere 让浏览器在任意位置可断行。
          'break-words [overflow-wrap:anywhere]',
        )}
        {...props}
      >
        {children}
      </th>
    );
  },

  td({ children, ...props }) {
    return (
      <td
        className={cn(
          'border border-[var(--msg-table-border)] px-3 py-2',
          'break-words [overflow-wrap:anywhere]',
        )}
        {...props}
      >
        {children}
      </td>
    );
  },

  // Lists
  ul({ children, ...props }) {
    return (
      <ul className="my-2 ml-6 list-disc space-y-1" {...props}>
        {children}
      </ul>
    );
  },

  ol({ children, ...props }) {
    return (
      <ol className="my-2 ml-6 list-decimal space-y-1" {...props}>
        {children}
      </ol>
    );
  },

  // Paragraphs
  p({ children, ...props }) {
    return (
      <p className="my-2 first:mt-0 last:mb-0" {...props}>
        {children}
      </p>
    );
  },

  // NOTE: the `a` renderer is NOT defined here at module level anymore.
  // It needs to capture `workingDir` + setLightboxSrc + setTextLightboxFile
  // (text-lightbox-trigger-extension F1), so it lives inside the instance-
  // level `useMemo` below. The other 13 renderers stay module-level for the
  // existing performance protection (no inline arrays / no per-render
  // components object).

  // Headings
  //
  // 颜色走 --md-hN-fg token(默认值 `inherit`,见 themes/colors.ts):默认主题下与
  // 引入 token 前逐像素一致,外部导入的主题(Obsidian --hN-color / VSCode
  // markup.heading)才会把它染成分级色。字号字重不受 token 影响。
  h1({ children, ...props }) {
    return <h1 className="my-3 text-20 leading-[1.4] font-medium text-[var(--md-h1-fg)]" {...props}>{children}</h1>;
  },
  h2({ children, ...props }) {
    return <h2 className="my-3 text-18 leading-[1.556] font-medium text-[var(--md-h2-fg)]" {...props}>{children}</h2>;
  },
  h3({ children, ...props }) {
    return <h3 className="my-2 text-16 leading-[1.5] font-medium text-[var(--md-h3-fg)]" {...props}>{children}</h3>;
  },
  // h4-h6 此前没有 renderer(走 react-markdown 默认的裸 tag,字号字重由 Tailwind
  // preflight 归一成继承)。这里只补颜色 class,刻意不加字号/字重/间距 —— 保持
  // 原有观感不变。
  h4({ children, ...props }) {
    return <h4 className="text-[var(--md-h4-fg)]" {...props}>{children}</h4>;
  },
  h5({ children, ...props }) {
    return <h5 className="text-[var(--md-h5-fg)]" {...props}>{children}</h5>;
  },
  h6({ children, ...props }) {
    return <h6 className="text-[var(--md-h6-fg)]" {...props}>{children}</h6>;
  },

  // 加粗:同上,只接颜色 token。font-weight 仍由 Tailwind preflight 的
  // `b, strong { font-weight: bolder }` 提供,这里不覆盖。
  strong({ children, ...props }) {
    return <strong className="text-[var(--md-strong-fg)]" {...props}>{children}</strong>;
  },

  // Blockquote
  blockquote({ children, ...props }) {
    return (
      <blockquote
        className={cn(
          // border-l-2 + --msg-blockquote-border(= --agent-actions-rail):与
          // WorkGroupBlock / ThinkingCard / AgentActionsBlock 的 left rail 完全
          // 统一,宽度和颜色都不在引用块这里另搞一套。
          // 不用斜体:中文没有真斜体,机械倾斜反而降低可读性;引用语义由 rail +
          // 内缩表达已经足够。
          'my-2 border-l-2 border-[var(--msg-blockquote-border)] pl-4',
          'text-[var(--msg-blockquote-text)]',
        )}
        {...props}
      >
        {children}
      </blockquote>
    );
  },

  // Horizontal rule
  hr(props) {
    return <hr className="my-4 border-[var(--msg-hr-border)]" {...props} />;
  },
};

/**
 * doc-mode anchor: 给 baseComponents 里的 block renderer 套一层, 把 mdast
 * `node.position.start.line` 注入成根元素上的 `data-source-line="<N>"` 属性。
 * 仅在 emitSourceLines=true 时才会被合并进 components 对象 (见下面的 useMemo);
 * chat 调用方不传 prop, 这里整个函数永远不会运行 → chat 路径零开销零行为变化。
 *
 * 实现:
 *   - 已有 base renderer (h1-h6 / p / pre / table / ul / ol / blockquote / hr):
 *     把 lineAttr merge 进 props 后透传给 base 函数。base 内部 spread props 时
 *     data-source-line 自然落到对应 DOM 节点上。
 *   - base 没有的 (li): 直接 createElement 渲染原生 tag。
 */
type BlockTag = 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' | 'p' | 'pre' | 'table' | 'ul' | 'ol' | 'li' | 'blockquote' | 'hr';

interface MdastPositionedNode {
  position?: { start?: { line?: number } };
}

function lineAttrFor(node: unknown): { 'data-source-line'?: number } {
  const line = (node as MdastPositionedNode | undefined)?.position?.start?.line;
  return typeof line === 'number' ? { 'data-source-line': line } : {};
}

function wrapWithSourceLine<T extends BlockTag>(
  tag: T,
  base: Components[T] | undefined,
): Components[T] {
  // 类型上 react-markdown 的每个 tag 接收的 props 形态略有差异, 这里走 unknown
  // 通用桥接: 拿到 node 注入 lineAttr, 再透传给 base 或原生 tag。
  const wrapped = (props: Record<string, unknown>) => {
    const { node, children, ...rest } = props as { node?: unknown; children?: ReactNode } & Record<string, unknown>;
    const lineAttr = lineAttrFor(node);
    if (base) {
      // 把 lineAttr 加进 props 一起传给 base — base 内部 ...props spread 时
      // data-source-line 会落到根元素上, 不会污染 base 自己的 className/handler。
      return (base as unknown as (p: Record<string, unknown>) => ReactNode)({
        node,
        children,
        ...rest,
        ...lineAttr,
      });
    }
    // base 缺省时直接生成原生 tag。children 单独取出避免被 spread 进 attrs。
    return createElement(tag, { ...rest, ...lineAttr }, children);
  };
  return wrapped as unknown as Components[T];
}

function makeSourceLineWrappers(): Partial<Components> {
  return {
    h1: wrapWithSourceLine('h1', baseComponents.h1),
    h2: wrapWithSourceLine('h2', baseComponents.h2),
    h3: wrapWithSourceLine('h3', baseComponents.h3),
    h4: wrapWithSourceLine('h4', baseComponents.h4),
    h5: wrapWithSourceLine('h5', baseComponents.h5),
    h6: wrapWithSourceLine('h6', baseComponents.h6),
    p: wrapWithSourceLine('p', baseComponents.p),
    pre: wrapWithSourceLine('pre', baseComponents.pre),
    table: wrapWithSourceLine('table', baseComponents.table),
    ul: wrapWithSourceLine('ul', baseComponents.ul),
    ol: wrapWithSourceLine('ol', baseComponents.ol),
    li: wrapWithSourceLine('li', baseComponents.li),
    blockquote: wrapWithSourceLine('blockquote', baseComponents.blockquote),
    hr: wrapWithSourceLine('hr', baseComponents.hr),
  };
}

function stripPrivilegedMarkdownTarget(target: MarkdownTarget): MarkdownTarget {
  if (target.kind === 'external' || target.kind === 'anchor' || target.kind === 'plain-text') {
    return target;
  }
  return { kind: 'plain-text', href: target.href, reason: 'not-a-target' };
}

/**
 * InlineXdtAudioPlayer — markdown 里 `xdt-audio://` 链接的内联播放器。
 * 抽成组件是为了能持 ref 并接入 `mediaPlaybackBus`,保证一次只播一个媒体
 * (新播放会自动 pause 其它 audio/video,切 session 时也会被显式停掉)。
 */
function InlineXdtAudioPlayer({ src }: { src: string }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    return registerMedia(el);
  }, []);
  return (
    // biome-ignore lint/a11y/useMediaCaption: Markdown 链接里的任意音频没有可用字幕源，不能伪造空 track。
    <audio
      ref={audioRef}
      controls
      preload="metadata"
      controlsList="nodownload"
      src={src}
    />
  );
}

/**
 * LightboxImage — module-level component for react-markdown img renderer.
 * Tracks per-image load errors; broken images get no zoom-in cursor or click.
 */
function LightboxImage({
  src,
  alt,
  onZoom,
  ...props
}: {
  src?: string;
  alt?: string;
  onZoom: (src: string) => void;
  [key: string]: unknown;
}) {
  const { t } = useTranslation();
  const [hasError, setHasError] = useState(false);
  // Right-click → custom popover menu. We track cursor pos so a 0×0 virtual
  // trigger can anchor the Radix DropdownMenu wherever the user clicked.
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);

  // image-local-cache F4: when the underlying file is missing (cache cleared,
  // xdt-image:// 404, etc.), swap to the friendly placeholder card. The
  // filename is best-effort: derive it from the URL's last segment.
  if (hasError) {
    const fallbackName = src
      ? decodeURIComponent(src.split(/[\\/]/).pop() ?? 'image')
      : 'image';
    return <ImageMissingPlaceholder filename={alt || fallbackName} />;
  }

  // Only locally-managed images (xdt-image:// / cindy-media://) have a
  // meaningful "open folder" target. Remote https:// images skip the menu.
  const canRevealInFolder =
    !!src && (src.startsWith('xdt-image://') || src.startsWith('cindy-media://'));
  const zoomLabel = alt || t('chat.media.clickToZoom');

  async function handleRevealInFolder(): Promise<void> {
    if (!src) return;
    const res = await window.electronAPI.showItemInFolder({ url: src });
    if (!res.success) {
      toast.error(res.error ?? t('chat.media.openFolderFailed'));
    }
    setMenuPos(null);
  }

  async function handleCopyImage(): Promise<void> {
    if (!src) return;
    const res = await window.electronAPI.copyMediaToClipboard({ url: src });
    if (res.success) {
      toast.success(t('chat.media.imageCopied'));
    } else {
      toast.error(res.error ?? t('chat.media.copyFailed'));
    }
    setMenuPos(null);
  }

  return (
    <>
      <button
        type="button"
        aria-label={zoomLabel}
        title={t('chat.media.clickToZoom')}
        disabled={!src}
        style={{ cursor: src ? 'pointer' : undefined, marginTop: 18, marginBottom: 18, padding: 0, border: 0, background: 'transparent', lineHeight: 0 }}
        onClick={() => {
          if (src) onZoom(src);
        }}
        onContextMenu={(e) => {
          if (!canRevealInFolder) return;
          e.preventDefault();
          e.stopPropagation();
          setMenuPos({ x: e.clientX, y: e.clientY });
        }}
      >
        <img
          src={src}
          alt={alt ?? ''}
          style={{ maxWidth: 'min(100%, 50vw, 480px)', maxHeight: 'min(40vh, 420px)', height: 'auto' }}
          onError={() => setHasError(true)}
          {...props}
        />
      </button>
      {canRevealInFolder ? (
        <DropdownMenu
          open={menuPos !== null}
          onOpenChange={(open) => {
            if (!open) setMenuPos(null);
          }}
        >
          <DropdownMenuTrigger asChild>
            <span
              aria-hidden
              style={{
                position: 'fixed',
                left: menuPos?.x ?? 0,
                top: menuPos?.y ?? 0,
                width: 0,
                height: 0,
                pointerEvents: 'none',
              }}
            />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" sideOffset={2}>
            <DropdownMenuItem onClick={handleCopyImage}>
              <Copy className="mr-2 h-4 w-4" />
              {t('chat.media.copyImage')}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={handleRevealInFolder}>
              <FolderOpen className="mr-2 h-4 w-4" />
              {t('chat.media.revealImage')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </>
  );
}

function localKindFromAbsPath(absPath: string, fallback: MarkdownLocalKind): MarkdownLocalKind {
  if (/\.(png|jpe?g|gif|webp|svg|bmp|ico)(\?.*)?$/i.test(absPath)) return 'image';
  if (MODEL_EXT_RE.test(absPath)) return 'model';
  return fallback;
}

/**
 * FileTargetChip — clickable chip for a uniquely-resolved local file target.
 *
 * Only rendered when classification produced `resolved-local` (path resolved
 * to exactly one existing file/directory in workingDir). Everything else —
 * unresolved / ambiguous / unsupported scheme — renders as plain text by the
 * call sites, not as a chip. So this component is always interactive: click
 * to open, hover to highlight, right-click for the file menu.
 *
 * 标签是 `<code role="button">` 而不是 `<button>`,这条不能回退:这个 chip 是
 * 行内代码升级来的,复制消息时 Chromium 会把选区原样序列化进 `text/html`,而
 * `<button>` 不在外部富文本编辑器(Slack / 飞书 / Notion / Word)的粘贴白名单
 * 里——整个节点连同路径文字会被丢弃,只在原位留下一个断行。`<code>` 既是语义
 * 正解,粘出去还会落成对方的行内代码。详见 InlineReferenceChip 的同款说明。
 */
function FileTargetChip({
  resolvedAbsPath,
  localKind,
  onOpen,
  title,
  children,
  sessionId,
}: {
  resolvedAbsPath: string;
  localKind: MarkdownLocalKind;
  onOpen: () => void | Promise<void>;
  title?: string;
  children: ReactNode;
  /** 当前会话 id;就位时 html 文件左键弹"打开方式"菜单(侧边栏浏览器项需要它)。 */
  sessionId?: string;
}) {
  const { t } = useTranslation();
  const chipRef = useRef<HTMLElement>(null);
  const [imagePreviewOpen, setImagePreviewOpen] = useState(false);
  // html + 有会话上下文:左键按用户偏好直开(内置侧边栏 / 系统浏览器,见设置 →
  // 个性化 → 链接打开方式);右键菜单额外提供「在侧边栏浏览器中打开」和
  // 「查看源文件」(TextLightbox 的入口从左键挪到这里)。
  // 其余文件保持原有单击直开 TextLightbox、右键四项菜单。
  // remote 会话:file:// / 系统浏览器都读本机 fs,先取回缓存副本再按偏好打开。
  const fileCtx = useChatSessionFile();
  const chipRemoteOrigin = isRemoteFileOrigin(fileCtx.origin) ? fileCtx.origin : null;
  const imagePreviewSrc = useMemo(() => {
    if (localKind !== 'image') return null;
    const localUrl = toLocalFileUrl(resolvedAbsPath);
    if (!chipRemoteOrigin) return localUrl;

    // 远程图片只有在现有媒体协议能直接取件时才挂 hover 预览。SSH workdir 外
    // 的路径需要点击后先下载缓存，不能让 xdt-file:// 误读本机同名路径。
    const rewritten = rewriteToRemoteMediaOrigin(
      localUrl,
      toRemoteMediaOrigin(fileCtx.origin, fileCtx.workingDir),
    );
    return rewritten === localUrl ? null : rewritten;
  }, [chipRemoteOrigin, fileCtx.origin, fileCtx.workingDir, localKind, resolvedAbsPath]);
  const htmlWithSession =
    localKind !== 'directory' && isHtmlFilePath(resolvedAbsPath) && sessionId ? sessionId : undefined;
  const sidebarTargetSessionId = useSidebarTargetSessionId(htmlWithSession);
  const ctxMenu = useFileChipContextMenu({
    getAbsPath: async () => resolvedAbsPath,
    canOpenInBrowser: localKind !== 'directory' && isBrowserOpenablePath(resolvedAbsPath),
    sidebarFileBrowserKind: localKind === 'directory' ? 'directory' : 'file',
    sidebarOpenSessionId: htmlWithSession,
    onViewSource: htmlWithSession ? onOpen : undefined,
  });

  const activate = () => {
    // 与输入附件一致：点击打开 lightbox 前先撤掉 hover 层，避免关闭大图后残留。
    setImagePreviewOpen(false);
    if (htmlWithSession) {
      if (chipRemoteOrigin) {
        void (async () => {
          const cachePath = await fetchChatFileWithToasts(chipRemoteOrigin, fileCtx.workingDir, resolvedAbsPath);
          if (cachePath && sidebarTargetSessionId) {
            await openHtmlFileByPreference(sidebarTargetSessionId, cachePath, t);
          }
        })();
        return;
      }
      if (sidebarTargetSessionId) {
        void openHtmlFileByPreference(sidebarTargetSessionId, resolvedAbsPath, t);
      }
      return;
    }
    void onOpen();
  };

  return (
    <>
      <code
        ref={chipRef}
        role="button"
        tabIndex={0}
        title={title}
        onClick={activate}
        onContextMenu={ctxMenu.onContextMenu}
        onPointerEnter={() => {
          if (imagePreviewSrc) setImagePreviewOpen(true);
        }}
        onPointerLeave={() => setImagePreviewOpen(false)}
        onKeyDown={(e) => {
          // 换掉原生按钮元素后,键盘激活要自己补回来。
          if (e.key !== 'Enter' && e.key !== ' ') return;
          e.preventDefault();
          activate();
        }}
        className={cn(
          'inline rounded-[6px] border-0 px-1 py-0.5',
          'font-mono text-14 align-baseline',
          'bg-[var(--msg-code-inline-bg)]',
          'text-[var(--msg-assistant-text)]',
          'text-left break-all',
          'transition-colors',
          'cursor-pointer hover:bg-[var(--cmd-palette-item-hover)]',
        )}
      >
        {children}
      </code>
      {imagePreviewSrc ? (
        <ImageHoverPreview
          open={imagePreviewOpen}
          anchorRef={chipRef}
          src={imagePreviewSrc}
          alt={basename(resolvedAbsPath)}
        />
      ) : null}
      {ctxMenu.menu}
    </>
  );
}

/**
 * ResolvedLocalLink — underlined `<a>` for a uniquely-resolved local file whose
 * label is freeform prose (e.g. `[查看实现](src/App.tsx)`), so it renders as a
 * link rather than a FileTargetChip. Same left-click (open) behavior as before;
 * adds the right-click file menu (复制 / 复制路径 / 打开文件所在目录) so prose-label
 * links match the chip's discoverability. Mirrors FileTargetChip's hook pattern —
 * the menu hook must live in a component (not inside MarkdownTargetLink's
 * conditional branches) to satisfy rules-of-hooks.
 */
function ResolvedLocalLink({
  resolvedAbsPath,
  localKind,
  href,
  onOpen,
  anchorProps,
  children,
  sessionId,
}: {
  resolvedAbsPath: string;
  localKind: MarkdownLocalKind;
  href: string;
  onOpen: () => void | Promise<void>;
  anchorProps: Record<string, unknown>;
  children: ReactNode;
  /** 当前会话 id;就位时 html 文件左键弹"打开方式"菜单(同 FileTargetChip)。 */
  sessionId?: string;
}) {
  const { t } = useTranslation();
  // 同 FileTargetChip:html + 有会话上下文时左键按偏好直开,「查看源文件」
  // 与「在侧边栏浏览器中打开」并入右键菜单;其余文件左键直开预览。
  const fileCtx = useChatSessionFile();
  const linkRemoteOrigin = isRemoteFileOrigin(fileCtx.origin) ? fileCtx.origin : null;
  const htmlWithSession =
    localKind !== 'directory' && isHtmlFilePath(resolvedAbsPath) && sessionId ? sessionId : undefined;
  const sidebarTargetSessionId = useSidebarTargetSessionId(htmlWithSession);
  const ctxMenu = useFileChipContextMenu({
    getAbsPath: () => resolvedAbsPath,
    canOpenInBrowser: localKind !== 'directory' && isBrowserOpenablePath(resolvedAbsPath),
    sidebarFileBrowserKind: localKind === 'directory' ? 'directory' : 'file',
    sidebarOpenSessionId: htmlWithSession,
    onViewSource: htmlWithSession ? onOpen : undefined,
  });

  return (
    <>
      <a
        href={href}
        className={MARKDOWN_LINK_CLASS}
        onClick={async (e) => {
          e.preventDefault();
          if (htmlWithSession) {
            if (linkRemoteOrigin) {
              const cachePath = await fetchChatFileWithToasts(linkRemoteOrigin, fileCtx.workingDir, resolvedAbsPath);
              if (cachePath && sidebarTargetSessionId) {
                await openHtmlFileByPreference(sidebarTargetSessionId, cachePath, t);
              }
              return;
            }
            if (sidebarTargetSessionId) {
              await openHtmlFileByPreference(sidebarTargetSessionId, resolvedAbsPath, t);
            }
            return;
          }
          await onOpen();
        }}
        onContextMenu={ctxMenu.onContextMenu}
        {...anchorProps}
      >
        {children}
      </a>
      {ctxMenu.menu}
    </>
  );
}

/**
 * Decide whether a clickable local-file target should render as a file chip
 * (rounded monospace box) vs. an underlined hyperlink.
 *
 * Chip = the visible label reads as a file reference. Two ways to qualify:
 *   1. Exact match against the target's own forms — full href / originalHref,
 *      basename, or basename + line[:column] suffix. (Cheap, exact.)
 *   2. The label is *shaped* like a file path on its own — a partial path
 *      (`claude-code/index.ts`), a bare filename (`events.ts`), with an
 *      optional `:line[:column]` suffix. This catches labels that name the
 *      file but don't equal the basename or the full href, which would
 *      otherwise fall through to the hyperlink style and look inconsistent
 *      next to a sibling chip.
 * Otherwise (freeform prose label like `查看实现`, which has spaces / no
 * extension) → underlined hyperlink, so a sentence isn't crammed into a
 * monospace box.
 *
 * Works for both local-candidate (pre-resolution) and resolved-local targets:
 * line/column live on whichever kind we're handed, so we read them off the
 * target directly instead of gating on kind.
 */
function shouldRenderCodeReferenceLabel(target: MarkdownTarget, children: ReactNode): boolean {
  const label = nodeToText(children).trim();
  if (!label || label.includes('\n')) return false;
  if (label === target.href) return true;
  if (target.kind === 'local-candidate' && label === target.originalHref) return true;

  const line = 'line' in target ? target.line : undefined;
  const column = 'column' in target ? target.column : undefined;
  const baseName = basename(target.href);
  if (label === baseName) return true;
  if (line !== undefined) {
    if (label === `${baseName}:${line}`) return true;
    if (column !== undefined && label === `${baseName}:${line}:${column}`) return true;
  }

  // Shape-based fallback: the label itself looks like a file path / reference.
  // Strip an optional :line[:column] suffix first so `claude-code/index.ts:42`
  // is judged on its path part. Reuses the same heuristics the classifier uses
  // so "what counts as a file" stays consistent across the codebase.
  const labelPath = splitLocalLineSuffix(label).href;
  if (looksLikeFilePath(labelPath) || looksLikeBareFileReference(labelPath)) return true;

  return false;
}

function isResolvedForTarget(
  resolved: MarkdownTarget | null,
  target: MarkdownTarget,
): resolved is Extract<MarkdownTarget, { kind: 'resolved-local' }> {
  if (target.kind !== 'local-candidate' || resolved?.kind !== 'resolved-local') return false;
  return (
    resolved.href === target.href &&
    resolved.line === target.line &&
    resolved.column === target.column
  );
}

/**
 * Build a `resolved-local` target from a smart-resolve result. Returns null
 * unless the path resolved to a unique file — every other status keeps the
 * caller on the original (plain-text-rendering) candidate. Line/column are
 * carried from the live target so the chip jumps to the right line regardless
 * of which cached resolution it reuses.
 */
function resolvedLocalFromResult(
  target: Extract<MarkdownTarget, { kind: 'local-candidate' }>,
  result: SmartResolveResult,
): Extract<MarkdownTarget, { kind: 'resolved-local' }> | null {
  if (result.status !== 'unique') return null;
  return {
    kind: 'resolved-local',
    href: target.href,
    absPath: result.absPath,
    // 解析端明确说是目录(本机 stat / 远端 chat-file:stat)→ directory chip
    //(点击定位进侧边栏文件浏览器);否则按扩展名分派(原行为)。
    localKind:
      result.kind === 'directory'
        ? 'directory'
        : localKindFromAbsPath(result.absPath, target.localKind),
    ...(target.line !== undefined ? { line: target.line } : {}),
    ...(target.column !== undefined ? { column: target.column } : {}),
  };
}

function useResolvedMarkdownTarget(
  target: MarkdownTarget,
  workingDir: string,
  isStreaming: boolean,
): MarkdownTarget {
  // remote 会话:`fs:resolve-path`(存在性 + 本地 BFS)打的是**本机**文件系统,
  // 对远程 workingDir 结果不可靠(远端文件本机必然不存在 → 永远 none → chip
  // 永不点亮)。改为:按 workdir 分隔符风格 join 出远端绝对路径,再经
  // chat-file:stat **远端精确 stat 验证后**才点亮——目录 / 不存在 / SSH workdir
  // 外保持纯文本(与本机"存在且唯一才点亮"的语义对齐);链路断等无法判定时
  // 乐观点亮,点击链路自带 NOT_FOUND / stale 兜底。不做远程 BFS(monorepo 裸
  // 文件名自动搜子包是本机专属能力,远程按 join 结果判定)。
  const { origin: fileOrigin } = useChatSessionFile();
  const remoteOrigin = isRemoteFileOrigin(fileOrigin) ? fileOrigin : null;

  // Synchronous resolution from the renderer cache. A reference that resolved
  // on a previous mount (e.g. before the user switched away and back) repaints
  // its chip on the very first render — no plain-text → chip flash, no repeat
  // IPC. Recomputed on dep change so an in-place href/line change is covered.
  const syncResolved = useMemo<MarkdownTarget | null>(() => {
    if (isStreaming || target.kind !== 'local-candidate') return null;
    const candidate = target;
    if (remoteOrigin) {
      const absPath = resolveLocalPath(candidate.href, workingDir);
      if (!absPath) return null;
      const verdict = peekRemotePathVerdict(remoteOrigin, workingDir, absPath);
      if (verdict === 'file' || verdict === 'unknown' || verdict === 'directory') {
        return resolvedLocalFromResult(candidate, {
          status: 'unique',
          absPath,
          kind: verdict === 'directory' ? 'directory' : 'file',
        });
      }
      return null; // nonfile → 纯文本;未验证 → 异步 effect 验证后点亮
    }
    const cached = peekResolveLocalPathSmart(candidate.href, workingDir);
    return cached ? resolvedLocalFromResult(candidate, cached) : null;
  }, [isStreaming, target, workingDir, remoteOrigin]);

  // Async resolution for cache misses only. The synchronous path above shadows
  // this whenever it has an answer, so a first-view (cold) ref flashes once,
  // then the result is cached and every later mount hits the sync path.
  const [asyncResolved, setAsyncResolved] = useState<MarkdownTarget | null>(null);

  useEffect(() => {
    setAsyncResolved(null);
    if (isStreaming || target.kind !== 'local-candidate') return;
    const candidate = target;
    if (remoteOrigin) {
      const absPath = resolveLocalPath(candidate.href, workingDir);
      if (!absPath || peekRemotePathVerdict(remoteOrigin, workingDir, absPath)) return;
      let cancelled = false;
      void verifyRemotePathCached(remoteOrigin, workingDir, absPath).then((verdict) => {
        if (cancelled || verdict === 'nonfile') return;
        setAsyncResolved(
          resolvedLocalFromResult(candidate, {
            status: 'unique',
            absPath,
            kind: verdict === 'directory' ? 'directory' : 'file',
          }),
        );
      });
      return () => {
        cancelled = true;
      };
    }
    if (peekResolveLocalPathSmart(candidate.href, workingDir)) return;

    let cancelled = false;
    void resolveLocalPathSmartCached(candidate.href, workingDir).then((result) => {
      if (cancelled) return;
      setAsyncResolved(resolvedLocalFromResult(candidate, result));
    });

    return () => {
      cancelled = true;
    };
  }, [isStreaming, remoteOrigin, target, workingDir]);

  const resolved = syncResolved ?? asyncResolved;
  return isResolvedForTarget(resolved, target) ? resolved : target;
}

async function activateResolvedLocalTarget(
  target: Extract<MarkdownTarget, { kind: 'resolved-local' }>,
  ctx: {
    origin: SessionFileOrigin;
    workingDir: string;
    sessionId?: string;
    sidebarTargetSessionId?: string;
  },
  setLightboxSrc: (src: string) => void,
  setTextLightboxFile: (file: { path: string; name: string; line?: number } | null) => void,
  setModelLightboxPath: (absPath: string | null) => void,
): Promise<void> {
  const remoteOrigin = isRemoteFileOrigin(ctx.origin) ? ctx.origin : null;
  // 目录 chip:定位进侧边栏文件浏览器(远程零特判——file-browser plugin 自身
  // 已按会话路由远端)。workdir 外目录进不了树:本地退回 Finder 定位,远程给
  // 明确提示;无会话上下文(理论不可达,防御)同样走本地定位兜底。
  if (target.localKind === 'directory') {
    const rel = toWorkdirRel(ctx.workingDir, target.absPath);
    const sidebarTargetSessionId = ctx.sidebarTargetSessionId ?? ctx.sessionId;
    if (rel && sidebarTargetSessionId) {
      await openDirInSidebarFileBrowser(sidebarTargetSessionId, rel);
      return;
    }
    if (!remoteOrigin) {
      void window.electronAPI.showItemInFolder({ filePath: target.absPath });
      return;
    }
    toast.error(i18n.t('chat.remoteFile.outsideWorkdir'));
    return;
  }
  if (target.localKind === 'image') {
    const localUrl = toLocalFileUrl(target.absPath);
    if (!remoteOrigin) {
      setLightboxSrc(localUrl);
      return;
    }
    // 远程:xdt-file://?path= 经 origin 改写(device 全量 / ssh 限 workdir 内)
    // 后由 cindy-remote-media 管线取字节;改写不了(ssh workdir 外)→ 取回缓存
    // 副本后按本机文件预览。
    const rewritten = rewriteToRemoteMediaOrigin(
      localUrl,
      toRemoteMediaOrigin(ctx.origin, ctx.workingDir),
    );
    if (rewritten !== localUrl) {
      setLightboxSrc(rewritten);
      return;
    }
    const cachePath = await fetchChatFileWithToasts(remoteOrigin, ctx.workingDir, target.absPath);
    if (cachePath) setLightboxSrc(toLocalFileUrl(cachePath));
    return;
  }
  // 3D 模型:.glb/.gltf → 应用内 ModelLightbox;.fbx → Finder 定位。
  // FBX 不做应用内预览(model-viewer 只认 glTF;three.js 自渲的 Phong 观感
  // 与 GLB 差异大反而误导),也不能丢给 openPath——macOS「预览」不认 FBX
  // 会弹"文件已损坏"的误导弹窗,定位到文件让用户拖进 DCC 才是本意。
  if (target.localKind === 'model') {
    if (remoteOrigin) {
      // 3D 远程本期不做(xdt-model:// 无远程管线):下载缓存副本并在文件管理
      // 器定位,不误开本机同路径文件。
      await revealRemoteChatFile(remoteOrigin, ctx.workingDir, target.absPath);
      return;
    }
    if (/\.fbx(\?.*)?$/i.test(target.absPath)) {
      void window.electronAPI.showItemInFolder({ filePath: target.absPath });
      return;
    }
    setModelLightboxPath(target.absPath);
    return;
  }
  if (!(await shouldOpenTextLightboxForOrigin(ctx, target.absPath))) return;
  setTextLightboxFile({
    path: target.absPath,
    name: basename(target.absPath),
    ...(target.line !== undefined ? { line: target.line } : {}),
  });
}

function MarkdownTargetLink({
  href,
  children,
  workingDir,
  isStreaming,
  localFileRefs,
  setLightboxSrc,
  setTextLightboxFile,
  setModelLightboxPath,
  anchorProps,
  allowPrivilegedLinks,
  remoteMediaOrigin,
  sessionId,
}: {
  href?: string;
  children: ReactNode;
  workingDir: string;
  isStreaming: boolean;
  localFileRefs?: readonly KnownLocalFileRef[];
  setLightboxSrc: (src: string) => void;
  setTextLightboxFile: (file: { path: string; name: string; line?: number } | null) => void;
  setModelLightboxPath: (absPath: string | null) => void;
  anchorProps: Record<string, unknown>;
  allowPrivilegedLinks: boolean;
  /** 远程会话媒体来源:把 xdt-audio:// 等链接改写到 cindy-remote-media://;本地 undefined。 */
  remoteMediaOrigin?: RemoteMediaOrigin;
  /** 当前会话 id;就位时外链 / html 文件左键弹"打开方式"菜单。 */
  sessionId?: string;
}) {
  const { t } = useTranslation();
  const openWith = useOpenWithMenu({ sessionId });
  // 文件点击激活的来源上下文:remote 时激活动作(lightbox / 文本预览 / 打开)
  // 走远程分流(取回缓存副本 / URL 改写),与 remoteMediaOrigin 的媒体改写同源。
  const fileCtx = useChatSessionFile();
  const sidebarTargetSessionId = useSidebarTargetSessionId(sessionId ?? fileCtx.sessionId);
  const initialTarget = useMemo(() => {
    const target = classifyMarkdownLinkTarget(href, localFileRefs);
    return allowPrivilegedLinks ? target : stripPrivilegedMarkdownTarget(target);
  }, [href, localFileRefs, allowPrivilegedLinks]);
  const target = useResolvedMarkdownTarget(initialTarget, workingDir, isStreaming);

  if (target.kind === 'audio') {
    return <InlineXdtAudioPlayer src={rewriteToRemoteMediaOrigin(target.href, remoteMediaOrigin)} />;
  }

  if (target.kind === 'plain-text') {
    return <span>{children}</span>;
  }

  // Local-file targets:
  //   - resolved-local (path uniquely resolves to an existing file) → chip if
  //     the label reads as a file reference, underlined link if the label is
  //     freeform prose.
  //   - local-candidate (not yet resolved, OR resolved to multiple, OR not
  //     found) and code-reference (directory / unsupported scheme) → plain
  //     <span>. We don't reserve a chip slot for paths that may never become
  //     clickable; instead the chip only appears as a one-shot "lit up"
  //     upgrade once unique resolution lands after streaming.
  if (target.kind === 'resolved-local') {
    const openResolvedTarget = () =>
      activateResolvedLocalTarget(
        target,
        { ...fileCtx, sidebarTargetSessionId },
        setLightboxSrc,
        setTextLightboxFile,
        setModelLightboxPath,
      );
    if (!shouldRenderCodeReferenceLabel(target, children)) {
      return (
        <ResolvedLocalLink
          resolvedAbsPath={target.absPath}
          localKind={target.localKind}
          href={target.href}
          onOpen={openResolvedTarget}
          anchorProps={anchorProps}
          sessionId={sessionId}
        >
          {children}
        </ResolvedLocalLink>
      );
    }
    return (
      <FileTargetChip
        resolvedAbsPath={target.absPath}
        localKind={target.localKind}
        title={target.href}
        onOpen={openResolvedTarget}
        sessionId={sessionId}
      >
        {children}
      </FileTargetChip>
    );
  }

  if (target.kind === 'code-reference' || target.kind === 'local-candidate') {
    return <span>{children}</span>;
  }

  // Remaining: external / anchor / local-image-url — none of these flow
  // through the streaming → resolution transition, so the underlined-link
  // visual is stable from first paint. No jitter risk here.
  return (
    <>
    <a
      href={target.href}
      className={MARKDOWN_LINK_CLASS}
      onClick={async (e) => {
        e.preventDefault();

        if (target.kind === 'anchor') {
          if (!target.id) return;
          const el = document.getElementById(target.id);
          if (el) {
            el.scrollIntoView({ behavior: 'smooth', block: 'start' });
          } else {
            toast.error(t('chat.markdownRenderer.anchorNotFound'));
          }
          return;
        }

        if (target.kind === 'external') {
          // 有会话上下文:左键按用户偏好直开(内置侧边栏 / 系统浏览器,设置 →
          // 个性化 → 链接打开方式);右键弹"打开方式"菜单临时选另一种。
          // 修饰键点击(macOS ⌘ / Windows Ctrl)临时强制走系统浏览器,不改偏好。
          // 无会话上下文(Market 预览等)保持原有直开默认浏览器。
          if (openWith.isEnabled && sidebarTargetSessionId && !(e.metaKey || e.ctrlKey)) {
            await openUrlByPreference(sidebarTargetSessionId, target.href, t);
            return;
          }
          const res = await window.electronAPI.openExternal(target.href);
          if (!res.success) toast.error(t('chat.markdownRenderer.openLinkFailed'));
          return;
        }

        if (target.kind === 'local-image-url') {
          // 远程会话:本机媒体 scheme 链接改写到 cindy-remote-media://(同内嵌图);本地原样。
          setLightboxSrc(rewriteToRemoteMediaOrigin(target.href, remoteMediaOrigin));
          return;
        }
      }}
      onContextMenu={(e) => {
        // 仅外链有右键"打开方式"菜单;anchor / local-image-url 保持浏览器默认右键。
        if (target.kind !== 'external' || !openWith.isEnabled) return;
        e.preventDefault();
        e.stopPropagation();
        openWith.openAt(e.clientX, e.clientY, target.href);
      }}
      {...anchorProps}
    >
      {children}
    </a>
    {openWith.menu}
    </>
  );
}

function InlineCodeWithTarget({
  text,
  children,
  workingDir,
  isStreaming,
  props,
  setLightboxSrc,
  setTextLightboxFile,
  setModelLightboxPath,
  sessionId,
}: {
  text: string;
  children: ReactNode;
  workingDir: string;
  isStreaming: boolean;
  props: Record<string, unknown>;
  setLightboxSrc: (src: string) => void;
  setTextLightboxFile: (file: { path: string; name: string; line?: number } | null) => void;
  setModelLightboxPath: (absPath: string | null) => void;
  /** 当前会话 id;透传给 FileTargetChip 的"打开方式"菜单。 */
  sessionId?: string;
}) {
  // remote 时激活动作走远程分流(同 MarkdownTargetLink)。
  const fileCtx = useChatSessionFile();
  const sidebarTargetSessionId = useSidebarTargetSessionId(sessionId ?? fileCtx.sessionId);
  const initialTarget = useMemo(() => classifyInlineCodeTarget(text), [text]);
  const target = useResolvedMarkdownTarget(
    initialTarget ?? { kind: 'plain-text', href: text, reason: 'not-a-target' },
    workingDir,
    isStreaming,
  );

  // Only uniquely-resolved local files/directories get the chip upgrade.
  // Everything else (regular inline code, unresolved file-looking text,
  // ambiguous / not-found paths, unsupported schemes) renders as a vanilla
  // inline <code> — same as before the markdown-target system existed.
  if (target.kind !== 'resolved-local') {
    return (
      <code className={cn(INLINE_CODE_CLASS)} {...props}>
        {children}
      </code>
    );
  }

  return (
    <FileTargetChip
      resolvedAbsPath={target.absPath}
      localKind={target.localKind}
      title={target.absPath}
      onOpen={() =>
        activateResolvedLocalTarget(
          target,
          { ...fileCtx, sidebarTargetSessionId },
          setLightboxSrc,
          setTextLightboxFile,
          setModelLightboxPath,
        )
      }
      sessionId={sessionId}
    >
      {children}
    </FileTargetChip>
  );
}

export const MarkdownRenderer = memo(function MarkdownRenderer({
  workingDir,
  content,
  isStreaming = false,
  localFileRefs,
  currentSessionId,
  currentSessionTitle,
  allowPrivilegedLinks = true,
  emitSourceLines = false,
}: MarkdownRendererProps) {
  // Cap markdown re-parse + syntax highlight cost during streaming.
  // Static callers (TextLightbox) leave isStreaming undefined → false,
  // so the throttle is fully bypassed — same behavior as before.
  const throttledContent = useStreamingThrottle(content, isStreaming);
  // LaTeX 定界符归一化(`\(...\)` / `\[...\]` → `$...$` / `$$...$$`)。
  // emitSourceLines(TextLightbox 行锚点 doc 模式,依赖 data-source-line 与
  // 源文件行号一致)时走保行数模式:单行 inline 照常转换(同行替换不改行
  // 号),会插行的 display 保持源码展示。无定界符时函数原样返回原引用,
  // useMemo + react-markdown 缓存不失效。
  const renderedContent = useMemo(
    () => normalizeMathDelimiters(throttledContent, { preserveLineCount: emitSourceLines }),
    [throttledContent, emitSourceLines],
  );
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  // 远程入方向:远程会话里 markdown 的图片/音频 URL 指向远端机器,按来源改写到
  // cindy-remote-media://(device 经 OSS 中转、ssh 经 file-service 落盘缓存)。本地
  // 会话 → undefined,改写为 no-op。origin 从 ChatSessionFileContext 取(provider
  // 在 MessageStream 顶层统一订阅 remoteProjectsStore,origin-injection race 在那里
  // 处理;context 更新穿透 MessageItem/AssistantMessage 的 memo,deviceId 一就位本
  // 气泡即重渲)。门控 currentSessionId:TextLightbox 等挂在聊天树内、但渲染的是
  // "文件内容"而非会话消息的调用方不传 currentSessionId,此时不做远程改写,与引入
  // context 前行为一致。ssh 的 workdir 取 context 的 workingDir(与 props 的
  // workingDir 同源,聊天调用方都由 session 传入)。
  const sessionFileCtx = useChatSessionFile();
  const remoteMediaOrigin = useMemo(
    () =>
      currentSessionId
        ? toRemoteMediaOrigin(sessionFileCtx.origin, sessionFileCtx.workingDir)
        : undefined,
    [currentSessionId, sessionFileCtx],
  );
  // F1: text-local <a> click → open TextLightbox with the resolved abs path.
  const [textLightboxFile, setTextLightboxFile] = useState<{
    path: string;
    name: string;
    line?: number;
  } | null>(null);
  // model-local chip/link click → in-app 3D preview (ModelLightbox, local mode).
  const [modelLightboxPath, setModelLightboxPath] = useState<string | null>(null);

  // workingDir and localFileRefs are stable within a session lifecycle — they
  // only change on session switch or when the message list gains a new user
  // attachment. So in steady-state streaming, the components object is still
  // recreated rarely.
  const components = useMemo<Components>(
    () => ({
      ...baseComponents,
      // doc-mode anchor: emitSourceLines=true 时把 baseComponents 里的 block
      // renderer 整体替换成带 data-source-line 注入的版本。chat 调用方不传 prop
      // → 默认 false → 整段是 falsy 短路, components 对象与之前完全一致。
      ...(emitSourceLines ? makeSourceLineWrappers() : {}),
      img: ({ src, alt, node, ...props }) => {
        const rawLocalSrc = node?.properties?.[RAW_LOCAL_IMAGE_SRC_PROP];
        const normalized = normalizeMarkdownImageSrc(
          typeof rawLocalSrc === 'string' ? rawLocalSrc : src,
          workingDir,
          allowPrivilegedLinks,
        );
        const imageProps = { ...props };
        delete (imageProps as Record<string, unknown>)[RAW_LOCAL_IMAGE_SRC_PROP];
        return (
          <LightboxImage
            src={normalized ? rewriteToRemoteMediaOrigin(normalized, remoteMediaOrigin) : normalized}
            alt={alt}
            onZoom={setLightboxSrc}
            {...imageProps}
          />
        );
      },
      // text-lightbox-trigger-extension v2: inline `<code>` whose content
      // looks like a file path becomes a clickable preview entry. 代码块
      // (`pre > code`)一律绕开路径检测与行内底色。
      //
      // 判据是 rehypeFencedCodeMarker 打的结构标记,不是「有没有 className」:
      // className 由 rehype-highlight 按语言标注下发,```(无语言)围栏和 4 空格
      // 缩进代码块都没有,曾因此被整块套上行内底色 + 内距(inline 元素逐行画底,
      // 一行一个灰条),内容还被拿去做路径检测。这与 GitHub 用 `pre code` 祖先
      // 选择器复位底色是同一条判据。
      code: ({ className, children, node, ...props }) => {
        const isFencedCode = node?.properties?.[FENCED_CODE_PROP] !== undefined;
        const isInline = !isFencedCode && !className;
        if (!isInline) {
          return (
            <code className={cn(className, 'font-mono text-[length:var(--app-code-font-size)]')} {...props}>
              {children}
            </code>
          );
        }
        // Inline code — flatten children to text to test the path predicate.
        // react-markdown gives us a node tree; nodeToText collapses it safely.
        const text = nodeToText(children);
        const safeProps = omitMarkdownInternalProps(props as Record<string, unknown>);
        if (!allowPrivilegedLinks) {
          return (
            <code className={cn(INLINE_CODE_CLASS)} {...safeProps}>
              {children}
            </code>
          );
        }
        return (
          <InlineCodeWithTarget
            text={text}
            workingDir={workingDir}
            isStreaming={isStreaming}
            props={safeProps}
            setLightboxSrc={setLightboxSrc}
            setTextLightboxFile={setTextLightboxFile}
            setModelLightboxPath={setModelLightboxPath}
            sessionId={currentSessionId}
          >
            {children}
          </InlineCodeWithTarget>
        );
      },
      // F1: route the link by classification.
      //   external    → window.electronAPI.openExternal (existing behavior)
      //   image-local → ImageLightbox via file:// URL
      //   text-local  → TextLightbox with the absolute filesystem path
      a: ({ children, href, ...props }) => {
        // Strip className/node before spreading: react-markdown v10 doesn't
        // currently inject className on <a>, but relying on that is fragile.
        // Explicit drop guarantees our link styling is never overridden by an
        // upstream change. `node` is the mdast node — not a valid DOM prop.
        const safeProps = omitMarkdownInternalProps(props as Record<string, unknown>);
        if (allowPrivilegedLinks && href != null && hasDeepLinkPathPrefix(href, 'session-card/')) {
          const parsed = parseSessionCardHref(href);
          if (parsed) {
            return (
              <SessionHandoffCard
                {...parsed}
                dispatcherSessionId={currentSessionId}
                dispatcherTitle={currentSessionTitle}
              />
            );
          }
        }
        if (allowPrivilegedLinks && href != null && hasDeepLinkPathPrefix(href, 'session/')) {
          // 深链 → 会话 chip:显示会话标题(查不到降级短 ID),点击跳转;
          // 带 ?message= 锚点时进一步定位并高亮目标消息。作者显式写的
          // `[label](…)` 文案(≠ href 本身)作为 chip 文本,不查标题。
          const childrenText = nodeToText(children).trim();
          return (
            <SessionLinkChip
              href={href}
              label={childrenText && childrenText !== href ? childrenText : undefined}
            />
          );
        }
        if (allowPrivilegedLinks && href != null && hasDeepLinkPathPrefix(href, 'project/')) {
          // 项目深链 → 项目 chip(目录名 / 显式 label),点击聚焦侧边栏节点。
          const childrenText = nodeToText(children).trim();
          return (
            <ProjectLinkChip
              href={href}
              label={childrenText && childrenText !== href ? childrenText : undefined}
            />
          );
        }
        return (
          <MarkdownTargetLink
            href={href}
            workingDir={workingDir}
            isStreaming={isStreaming}
            localFileRefs={localFileRefs}
            setLightboxSrc={setLightboxSrc}
            setTextLightboxFile={setTextLightboxFile}
            setModelLightboxPath={setModelLightboxPath}
            anchorProps={safeProps}
            allowPrivilegedLinks={allowPrivilegedLinks}
            remoteMediaOrigin={remoteMediaOrigin}
            sessionId={currentSessionId}
          >
            {children}
          </MarkdownTargetLink>
        );
      },
    }),
    [
      workingDir,
      localFileRefs,
      isStreaming,
      emitSourceLines,
      currentSessionId,
      currentSessionTitle,
      allowPrivilegedLinks,
      remoteMediaOrigin,
    ],
  );

  return (
    <div className="msg-markdown select-text">
      <ReactMarkdown
        remarkPlugins={allowPrivilegedLinks ? REMARK_PLUGINS_PRIVILEGED : REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS}
        components={components}
        urlTransform={allowPrivilegedLinks ? trustedUrlTransform : previewSafeUrlTransform}
        skipHtml
      >
        {renderedContent}
      </ReactMarkdown>
      {lightboxSrc && (
        <ImageLightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />
      )}
      {/* ADR-4: triggerRef intentionally omitted — markdown links rendered by
          react-markdown have no stable button ref; TextLightbox falls back
          to document.body focus on close, which matches F1 spec (focus
          return is only required by F2, not F1). */}
      {textLightboxFile && (
        <TextLightbox
          filePath={textLightboxFile.path}
          fileName={textLightboxFile.name}
          initialLine={textLightboxFile.line}
          onClose={() => setTextLightboxFile(null)}
        />
      )}
      {modelLightboxPath && (
        <ModelLightbox
          source={{ kind: 'local', absPath: modelLightboxPath }}
          onClose={() => setModelLightboxPath(null)}
        />
      )}
    </div>
  );
});
