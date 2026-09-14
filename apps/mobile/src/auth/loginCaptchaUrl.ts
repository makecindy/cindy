import { CAPTCHA_CHALLENGE_PAGE_PATH } from '@cindy/auth-client';

const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com';
const TURNSTILE_LOCAL_DOCUMENT_URLS = new Set(['about:blank', 'about:srcdoc']);

function isHttpsOrLoopbackHttp(url: URL): boolean {
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  return url.protocol === 'https:' || (url.protocol === 'http:' && loopback);
}

/**
 * 托管挑战页的顶层文档边界：协议必须为 HTTPS（本地开发仅放行 loopback HTTP），
 * origin 与共享挑战路径都必须和预期地址一致。显式检查 protocol，避免 blob URL
 * 继承 auth origin 后绕过只比较 origin 的判定。
 */
export function isAllowedLoginCaptchaPageUrl(rawUrl: string, expectedUrl: string): boolean {
  let target: URL;
  let expected: URL;
  try {
    target = new URL(rawUrl);
    expected = new URL(expectedUrl);
  } catch {
    return false;
  }
  if (!isHttpsOrLoopbackHttp(target) || !isHttpsOrLoopbackHttp(expected)) return false;
  return (
    target.protocol === expected.protocol &&
    target.origin === expected.origin &&
    target.pathname === CAPTCHA_CHALLENGE_PAGE_PATH &&
    expected.pathname === CAPTCHA_CHALLENGE_PAGE_PATH
  );
}

/**
 * Mobile WebView 导航闸：auth 托管页只能是顶层；Turnstile 子 frame 放行其
 * HTTPS origin，以及 Cloudflare WebView 集成明确依赖的 about:blank/srcdoc。
 */
export function isAllowedLoginCaptchaNavigation(
  request: { url: string; isTopFrame: boolean },
  expectedUrl: string,
): boolean {
  if (request.isTopFrame) return isAllowedLoginCaptchaPageUrl(request.url, expectedUrl);
  if (TURNSTILE_LOCAL_DOCUMENT_URLS.has(request.url)) return true;
  try {
    const target = new URL(request.url);
    return target.protocol === 'https:' && target.origin === TURNSTILE_ORIGIN;
  } catch {
    return false;
  }
}

/**
 * 将登录子树最终生效的 light/dark 模式写入托管挑战页 URL。
 *
 * URL 在 AuthContext 中创建，但首次启动的亮色覆盖只存在于
 * MobileLoginHandoffStage 子树内，因此必须由该子树里的 WebView 补入主题。
 */
export function withLoginCaptchaTheme(url: string, theme: 'light' | 'dark'): string {
  try {
    const themedUrl = new URL(url);
    themedUrl.searchParams.set('theme', theme);
    return themedUrl.toString();
  } catch {
    // 保留既有加载失败路径，由 WebView 的 onError 收敛到卡片内重试态。
    return url;
  }
}
