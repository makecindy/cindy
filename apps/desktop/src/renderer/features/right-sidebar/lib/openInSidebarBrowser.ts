/**
 * openInSidebarBrowser —— "在侧边栏浏览器中打开"的统一入口。
 *
 * 消息流(MarkdownRenderer 的链接 / html 文件 chip)等远端调用点通过它把一个
 * URL 交给内置 RSB 浏览器:
 *   1. 给目标 session 新建一个 web-browser tab —— **每次都是新页签**,与
 *      Chrome"从外部应用打开链接"的行为一致;侧边栏没开时由第 2 步带出来,
 *      开着时用户直接看到新页签被激活。
 *   2. 请求右侧栏可见("已打开 → no-op"由 MainLayout 订阅端自行判断,
 *      见 sidebarCommands 的设计说明)。
 *
 * 本地文件必须先经 pathToFileUrl 转成 file:// URL:webview guest 跑在独立的
 * BROWSER_PARTITION 里,不认识主 renderer 的 xdt-file:// 自定义协议,file://
 * 是 guest 能直接加载的唯一本地形式。
 */

import { addTab, closeTab, ensureHydrated, getBucket } from '../store';
import { requestRightSidebarVisibility } from './sidebarCommands';
import {
  getPluginPreviewGhostId,
  getPluginPreviewTabIds,
  markPluginPreviewTab,
} from './pluginPreviewTabs';
import { routeSidebarCommand } from './detachedSidebarRouting';
import { isBrowserOpenablePath } from '../../../../shared/browserOpenableExts';

/**
 * 绝对路径 → file:// URL。macOS/Linux POSIX 路径与 Windows 盘符路径都支持:
 *   /Users/a b/x.html  → file:///Users/a%20b/x.html
 *   E:\out\页 面.html  → file:///E:/out/%E9%A1%B5%20%E9%9D%A2.html
 *
 * 逐段 encodeURIComponent 保证空格 / 中文 / `#` / `?` 都不会被 URL 解析器
 * 吃成 fragment / query;盘符的 `:` 被还原(URL path 段里的 `:` 合法)。
 */
export function pathToFileUrl(absPath: string): string {
  const normalized = absPath.replace(/\\/g, '/');
  const withLeadingSlash = normalized.startsWith('/') ? normalized : `/${normalized}`;
  const encoded = withLeadingSlash
    .split('/')
    .map((seg) => encodeURIComponent(seg).replace(/%3A/gi, ':'))
    .join('/');
  return `file://${encoded}`;
}

/**
 * file:// URL → 本机绝对路径。与 pathToFileUrl 互逆:
 *   file:///Users/a%20b/x.html  → /Users/a b/x.html
 *   file:///E:/out/index.html   → E:\out\index.html (win32 风格分隔)
 *
 * 仅接受无凭证、无端口且 authority 为空或 localhost 的本地 file URL；只取
 * pathname(忽略 hash / query)，非 file:、远端 authority 或解析失败 → null。
 */
export function fileUrlToAbsPath(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'file:') return null;
  if (parsed.username || parsed.password) return null;
  if (parsed.hostname && parsed.hostname !== 'localhost') return null;
  if (parsed.port) return null;
  let pathname: string;
  try {
    pathname = decodeURIComponent(parsed.pathname);
  } catch {
    return null;
  }
  // Windows: URL pathname 形如 `/E:/out/x.html`,剥掉前导 `/` 并还原 `\`。
  if (/^\/[A-Za-z]:[\\/]/.test(pathname)) {
    pathname = pathname.slice(1).replace(/\//g, '\\');
  }
  return pathname || null;
}

/** 当前页是否为本地 HTML 文件预览(file:// + html/htm)。 */
export function isLocalHtmlFileUrl(url: string): boolean {
  const abs = fileUrlToAbsPath(url);
  return abs !== null && isBrowserOpenablePath(abs);
}

/** 回环主机:本机插件自己起的预览服务(端口每次重启都可能变)。 */
function isLoopbackHost(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]';
}

function parseHttpUrl(url: unknown): URL | null {
  if (typeof url !== 'string') return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 旧预览标签是否被「这次新开的预览」取代。
 *
 * - 同一页:origin + path + query 完全相同(忽略 hash,插件常把每次启动的一次性令牌放
 *   在 hash 里)——任何插件、任何主机都适用。
 * - 同一插件的本机预览服务重启:新旧两个 URL 的主机都是回环地址、协议相同、path 与
 *   query 相同,仅端口不同;并且旧标签必须是**同一个插件实例**(ghostId,主机在推送里
 *   填的)在本 renderer 开的。插件重启服务后旧端口已无人监听,旧标签永远打不开,
 *   但它加载过的旧文档不会变成错误页,所以不能靠加载失败来识别。
 *
 * 非回环地址不放宽端口:远程主机上不同端口是不同的服务。
 */
function supersedes(
  next: URL,
  nextGhostId: string | undefined,
  oldTabId: string,
  oldUrl: unknown,
): boolean {
  const old = parseHttpUrl(oldUrl);
  if (!old) return false;
  if (old.origin === next.origin && old.pathname === next.pathname && old.search === next.search) {
    return true;
  }
  return (
    nextGhostId !== undefined &&
    getPluginPreviewGhostId(oldTabId) === nextGhostId &&
    isLoopbackHost(old.hostname) &&
    isLoopbackHost(next.hostname) &&
    old.protocol === next.protocol &&
    old.pathname === next.pathname &&
    old.search === next.search
  );
}

export interface OpenUrlInSidebarBrowserOptions {
  /**
   * false = 不是用户当次手势(插件 preview 槽开页):标签照常开、内容照常加载,
   * 但 detached 形态下不得把子窗口 show + focus 抢走用户前台。缺省 true。
   */
  userInitiated?: boolean;
  /**
   * 插件预览槽签发的凭据(main 的 PreviewTabIndex 用它把这个标签绑定到插件身份)。
   * 随标签状态保存,标签每次 report 时带回;缺省 = 普通网页标签。
   */
  previewRequestId?: string;
  /**
   * 开这个预览的插件实例 id(主机在推送里填)。只用于「同一插件在同一任务里新开预览时,
   * 取代它自己此前开的回环预览标签」,不参与任何授权判断。
   */
  previewGhostId?: string;
}

/** 在指定 session 的侧边栏浏览器里新开一个页签加载 url,并确保侧边栏可见。 */
export async function openUrlInSidebarBrowser(
  sessionId: string,
  url: string,
  options: OpenUrlInSidebarBrowserOptions = {},
): Promise<void> {
  const userInitiated = options.userInitiated !== false;
  const previewRequestId = options.previewRequestId;
  const previewGhostId = previewRequestId ? options.previewGhostId : undefined;
  const routeResult = await routeSidebarCommand(
    {
      type: 'open-web-browser',
      sessionId,
      url,
      ...(previewRequestId ? { previewRequestId } : {}),
      ...(previewGhostId ? { previewGhostId } : {}),
    },
    { userInitiated },
  );
  if (routeResult !== 'attached') {
    if (routeResult !== 'routed') return;
    requestRightSidebarVisibility('open', { sessionId, userInitiated });
    return;
  }
  // store.addTab 的乐观写以 bucket 已 hydrate 为前提(见 store 内
  // addOrFocusSingletonTab 的注释):用户可能在切到 session 后立刻点链接,
  // 此时 Shell 的异步 list 拉取尚未回包,直接 addTab 会与后到的 list 结果
  // 互相覆盖。先 ensureHydrated(已 hydrate 时是同步 no-op)消除该竞态。
  await ensureHydrated(sessionId);
  // 插件对同一预览再次发起(close_viewer / open_viewer、重复调用、服务换端口):旧标签被新
  // 标签取代,而不是再叠一个。只关「本 renderer 里由插件预览槽开的」标签(已登记的 tracked
  // 集合;普通网页标签、用户自己导航走的标签不在其中),判据见 supersedes。
  // 一个预览始终只有一个标签、一个 guest、一个手机列表项。
  if (previewRequestId) {
    const next = parseHttpUrl(url);
    if (next) {
      const tracked = getPluginPreviewTabIds();
      const superseded = getBucket(sessionId).tabs.filter(
        (tab) =>
          tab.kind === 'web-browser' &&
          tracked.has(tab.id) &&
          supersedes(next, previewGhostId, tab.id, (tab.state as { url?: unknown } | null)?.url),
      );
      for (const tab of superseded) await closeTab(sessionId, tab.id);
    }
  }
  // initialState 形状与 RightSidebarShell popup 路径 / rsbBrowserBridge open
  // 路径保持一致,plugin hydrate 不会看到意外字段。
  const tab = await addTab(sessionId, 'web-browser', {
    url,
    title: '',
    favicon: null,
    isAudible: false,
    ...(previewRequestId ? { previewRequestId } : {}),
  });
  // 插件预览标签:人不一定在看它(别的标签/任务/设置页),但 main 要等它 report 才能绑定
  // 插件身份。登记为「待绑定」,Shell 会在隐藏保活层里立即物化一次 webview。
  if (previewRequestId) markPluginPreviewTab(tab.id, previewGhostId);
  requestRightSidebarVisibility('open', { sessionId, userInitiated });
}
