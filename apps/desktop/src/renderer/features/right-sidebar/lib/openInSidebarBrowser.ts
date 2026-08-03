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

import { addTab, ensureHydrated } from '../store';
import { requestRightSidebarVisibility } from './sidebarCommands';
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

export interface OpenUrlInSidebarBrowserOptions {
  /**
   * false = 不是用户当次手势(插件 preview 槽开页):标签照常开、内容照常加载,
   * 但 detached 形态下不得把子窗口 show + focus 抢走用户前台。缺省 true。
   */
  userInitiated?: boolean;
}

/** 在指定 session 的侧边栏浏览器里新开一个页签加载 url,并确保侧边栏可见。 */
export async function openUrlInSidebarBrowser(
  sessionId: string,
  url: string,
  options: OpenUrlInSidebarBrowserOptions = {},
): Promise<void> {
  const userInitiated = options.userInitiated !== false;
  const routeResult = await routeSidebarCommand(
    {
      type: 'open-web-browser',
      sessionId,
      url,
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
  // initialState 形状与 RightSidebarShell popup 路径 / rsbBrowserBridge open
  // 路径保持一致,plugin hydrate 不会看到意外字段。
  await addTab(sessionId, 'web-browser', {
    url,
    title: '',
    favicon: null,
    isAudible: false,
  });
  requestRightSidebarVisibility('open', { sessionId, userInitiated });
}
