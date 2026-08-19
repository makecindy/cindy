import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { WebviewTag } from 'electron';

import { createLogger } from '@/lib/logger';
import { useIsDarkMode } from '@/components/markdown/useIsDarkMode';

import {
  LOGIN_CAPTCHA_CANCEL_RESULT_CODE,
  LOGIN_CAPTCHA_PARTITION,
} from '../../../shared/webviewPartition';
import { LOGIN_COLORS } from './loginDesignTokens';

const log = createLogger('LoginCaptchaOverlay');

/**
 * 托管挑战页 → 宿主的回传通道(wire 契约,与 auth-server 挑战页内联脚本对齐):
 * 页面把结果写进 location.hash —— fragment 变更不产生网络请求(token 不进任何
 * 访问日志),桌面侧经 <webview> 的 did-navigate-in-page 事件读取。
 *   成功:#cindy-captcha=ok.<encodeURIComponent(token)>
 *   失败:#cindy-captcha=err.<code>
 */
const CAPTCHA_RESULT_HASH_PREFIX = '#cindy-captcha=';
/** Turnstile token 官方上限(与 shared/authIpc 的 IPC 界校验同值)。 */
const MAX_CAPTCHA_TOKEN_LENGTH = 2048;
/** 挑战总时限:超时视为加载失败,转重试态(token 本身 300s 有效,120s 足够)。 */
const CHALLENGE_TIMEOUT_MS = 120_000;

/** 解析挑战页回传结果;非本契约的 URL 返回 null(导出供单测直接断言)。 */
export function parseLoginCaptchaResult(
  rawUrl: string,
  challengeBaseUrl: string,
): { status: 'ok'; token: string } | { status: 'err'; code: string } | null {
  let parsed: URL;
  let expected: URL;
  try {
    parsed = new URL(rawUrl);
    expected = new URL(challengeBaseUrl);
  } catch {
    return null;
  }
  // hash 结果只信任 main 已批准的托管挑战页 origin + path；query 用于主题/语言。
  if (parsed.origin !== expected.origin || parsed.pathname !== expected.pathname) return null;
  const hash = parsed.hash;
  if (!hash.startsWith(CAPTCHA_RESULT_HASH_PREFIX)) return null;
  const payload = hash.slice(CAPTCHA_RESULT_HASH_PREFIX.length);
  if (payload.startsWith('ok.')) {
    let token: string;
    try {
      token = decodeURIComponent(payload.slice('ok.'.length));
    } catch {
      return null;
    }
    if (!token || token.length > MAX_CAPTCHA_TOKEN_LENGTH) return null;
    return { status: 'ok', token };
  }
  if (payload.startsWith('err.')) {
    const code = payload.slice('err.'.length);
    return { status: 'err', code: /^[a-z0-9_-]{1,64}$/i.test(code) ? code : 'unknown' };
  }
  return null;
}

/**
 * LoginCaptchaOverlay — 登录页人机验证模态层。
 *
 * 独立内存分区的 <webview> 装载 auth-server 托管的 Turnstile 挑战页(主窗 CSP
 * 禁止远程脚本/iframe,故挑战跑在隔离 guest 里;分区与地址白名单由 main 的
 * webview hardener 验明正身,这里传什么都以 main 覆盖为准)。模态交互对齐
 * LoginConsentDialog(遮罩不可点穿、Esc = 取消、背景 inert)。
 *
 * 结果经 onResult 一次性回传:token 字符串 = 挑战通过;null = 用户取消。
 * 加载失败/挑战页报错/超时/guest 崩溃 → 卡片内重试态,不自动关闭。
 */
export function LoginCaptchaOverlay({
  challengeBaseUrl,
  onResult,
}: {
  /** 托管挑战页地址（已含业务 action），源地址来自 main。 */
  challengeBaseUrl: string;
  onResult: (token: string | null) => void;
}) {
  const { t, i18n } = useTranslation();
  const isDark = useIsDarkMode();
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const [generation, setGeneration] = useState(0);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const retryRef = useRef<HTMLButtonElement | null>(null);
  // onResult 进 ref:webview 生命周期 effect 不因回调身份变化重挂载 guest。
  const onResultRef = useRef(onResult);
  onResultRef.current = onResult;
  // 结果只回传一次(ok 与随后的 err/超时互斥)。
  const settledRef = useRef(false);
  const settle = (token: string | null) => {
    if (settledRef.current) return;
    settledRef.current = true;
    onResultRef.current(token);
  };

  const challengeTarget = new URL(challengeBaseUrl);
  challengeTarget.searchParams.set('theme', isDark ? 'dark' : 'light');
  challengeTarget.searchParams.set('lang', i18n.language);
  const challengeUrl = challengeTarget.toString();

  // 模态语义对齐 LoginConsentDialog:背景兄弟节点 inert、关闭归还焦点。
  // 初始焦点由 webview 挂载 effect 交给挑战主交互，绝不默认落在取消动作；
  // guest 内的 Esc 由 Main 转成固定 hash 回传，仍可可靠取消。
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const rootEl = containerRef.current;
    const inerted: HTMLElement[] = [];
    if (rootEl?.parentElement) {
      for (const child of Array.from(rootEl.parentElement.children)) {
        if (child !== rootEl && child instanceof HTMLElement && !child.inert) {
          child.inert = true;
          inerted.push(child);
        }
      }
    }
    return () => {
      for (const el of inerted) el.inert = false;
      opener?.focus();
    };
  }, []);

  // 挑战失败后，WebView 已卸载；此时重试是弹层内的主要动作。
  useEffect(() => {
    if (failed) retryRef.current?.focus();
  }, [failed]);

  useEffect(() => {
    if (failed) return;
    const host = hostRef.current;
    if (!host) return;
    const webview = document.createElement('webview') as WebviewTag;
    webview.setAttribute('partition', LOGIN_CAPTCHA_PARTITION);
    webview.setAttribute('src', challengeUrl);
    webview.setAttribute('tabindex', '0');
    webview.setAttribute(
      'style',
      'display:flex;width:100%;height:100%;opacity:0;transition:opacity 0.12s ease;',
    );
    let disposed = false;
    const timeoutTimer = setTimeout(() => {
      if (!disposed) setFailed(true);
    }, CHALLENGE_TIMEOUT_MS);
    const onDomReady = () => {
      if (disposed) return;
      webview.style.opacity = '1';
      webview.focus();
      setReady(true);
    };
    const onInPageNavigate = (event: Electron.DidNavigateInPageEvent) => {
      if (disposed) return;
      const result = parseLoginCaptchaResult(event.url, challengeBaseUrl);
      if (!result) return;
      if (result.status === 'ok') {
        settle(result.token);
        return;
      }
      if (result.code === LOGIN_CAPTCHA_CANCEL_RESULT_CODE) {
        settle(null);
        return;
      }
      // 挑战页侧 error-callback / expired-callback:转重试态,码只进日志。
      log.warn('captcha challenge reported failure', { code: result.code });
      setFailed(true);
    };
    const onGone = () => {
      if (!disposed) setFailed(true);
    };
    const onFailLoad = (event: Electron.DidFailLoadEvent) => {
      // -3 = ABORTED(导航中断不算失败);子资源失败不判死,交给总时限兜底。
      if (disposed || event.errorCode === -3 || !event.isMainFrame) return;
      setFailed(true);
    };
    webview.addEventListener('dom-ready', onDomReady);
    webview.addEventListener('did-navigate-in-page', onInPageNavigate);
    webview.addEventListener('render-process-gone', onGone);
    webview.addEventListener('did-fail-load', onFailLoad);
    host.appendChild(webview);
    webview.focus();
    return () => {
      disposed = true;
      clearTimeout(timeoutTimer);
      webview.removeEventListener('dom-ready', onDomReady);
      webview.removeEventListener('did-navigate-in-page', onInPageNavigate);
      webview.removeEventListener('render-process-gone', onGone);
      webview.removeEventListener('did-fail-load', onFailLoad);
      webview.remove();
    };
    // challengeUrl 覆盖主题/语言切换;generation 驱动重试重挂载。
  }, [failed, generation, challengeUrl]);

  const retry = () => {
    setReady(false);
    setFailed(false);
    setGeneration((value) => value + 1);
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') settle(null);
  };

  return (
    <div
      data-testid="login-captcha-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="login-captcha-title"
      ref={containerRef}
      tabIndex={-1}
      onMouseDown={(event) => {
        // 点遮罩空白把焦点拉回容器,Esc 恒有效(与 LoginConsentDialog 同口径);
        // 遮罩不可点穿:挑战必须显式完成或取消。
        if (event.target === event.currentTarget) event.currentTarget.focus();
      }}
      onKeyDown={handleKeyDown}
      className="fixed inset-0 z-50 grid place-items-center outline-none"
      style={{ background: LOGIN_COLORS.consentOverlay }}
    >
      <div
        className="relative flex flex-col items-center"
        style={{
          width: 400,
          borderRadius: 18,
          background: LOGIN_COLORS.panelBg,
          boxShadow: `inset 0 0 0 1px ${LOGIN_COLORS.panelBorder}`,
          padding: '20px 24px 16px',
        }}
      >
        <p
          id="login-captcha-title"
          className="font-semibold"
          style={{ fontSize: 16, lineHeight: '24px', color: LOGIN_COLORS.titleText }}
        >
          {t('login.captcha.title')}
        </p>
        {failed ? (
          <div
            className="flex flex-col items-center justify-center gap-3"
            style={{ width: 352, height: 240 }}
          >
            <p style={{ fontSize: 13, color: LOGIN_COLORS.errorFg }}>
              {t('login.captcha.failed')}
            </p>
            <button
              type="button"
              ref={retryRef}
              data-testid="login-captcha-retry"
              onClick={retry}
              className="font-medium transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)]"
              style={{ fontSize: 13, color: LOGIN_COLORS.linkText }}
            >
              {t('login.captcha.retry')}
            </button>
          </div>
        ) : (
          <div className="relative" style={{ width: 352, height: 240, marginTop: 8 }}>
            {!ready && (
              <p
                className="absolute inset-0 grid place-items-center"
                style={{ fontSize: 13, color: LOGIN_COLORS.secondaryText }}
              >
                {t('login.captcha.loading')}
              </p>
            )}
            {/* webview 由 effect 手动 appendChild 进本容器(GhostSettingsWebview
                同款生命周期管理),React 只管理占位与提示文案。 */}
            <div ref={hostRef} className="absolute inset-0" />
          </div>
        )}
        <button
          type="button"
          data-testid="login-captcha-cancel"
          onClick={() => settle(null)}
          className="font-medium transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)]"
          style={{ fontSize: 13, marginTop: 12, color: LOGIN_COLORS.secondaryText }}
        >
          {t('login.captcha.cancel')}
        </button>
      </div>
    </div>
  );
}
