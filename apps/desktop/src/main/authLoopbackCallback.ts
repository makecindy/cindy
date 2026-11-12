import { renderOAuthResultPage, type OAuthResultPageInput } from './oauthResultPage';

/** Result accepted from the system-browser loopback callback. */
export type AuthLoopbackResult = { code: string } | { error: string };

/** Owns the single cancellable system-browser authorization attempt. */
export interface AuthBrowserAuthorizationSlot {
  activate(cancel: () => void): () => void;
  cancelActive(): boolean;
}

export type AuthBrowserCancellationRace<T> = { cancelled: false; value: T } | { cancelled: true };

/** Creates an identity-safe cancellation slot so an older attempt cannot clear a newer one. */
export function createAuthBrowserAuthorizationSlot(): AuthBrowserAuthorizationSlot {
  let activeCancel: (() => void) | null = null;
  return {
    activate(cancel) {
      activeCancel = cancel;
      return () => {
        if (activeCancel === cancel) activeCancel = null;
      };
    },
    cancelActive() {
      const cancel = activeCancel;
      if (!cancel) return false;
      activeCancel = null;
      cancel();
      return true;
    },
  };
}

/**
 * Races post-callback work (notably the authorization-code exchange) against
 * the same cancellation signal that owns the loopback listener. The wrapped
 * operation may still settle later, but its result can no longer be accepted.
 */
export function raceAuthBrowserCancellation<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<AuthBrowserCancellationRace<T>> {
  if (signal.aborted) return Promise.resolve({ cancelled: true });

  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ cancelled: true });
    };

    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(signal.aborted ? { cancelled: true } : { cancelled: false, value });
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
}

/** Localized copy for the login callback page (resolved by main i18n). */
export type AuthLoopbackPageInput = Omit<OAuthResultPageInput, 'variant'> & {
  variant: 'success' | 'error';
};

/**
 * Renders the standalone HTML page shown in the system browser after the
 * RFC 8252 loopback callback. Pure string builder so it stays unit-testable
 * outside Electron; all copy arrives pre-translated from the caller.
 *
 * PR3(wave4):desktop-login source 固定走新品牌卡(pageKind='desktop-login',
 * 成功 560×500、失败/警告 680×680 + chibi 三表情 + U-10 跨视口缩放;参数权威见 oauthResultPage.ts
 * 的 renderBrandLoginCallbackPage 头注)。visualKind 由 variant 默认映射
 * (success→success / error→failure);文案仍由调用方经 main i18n 预翻译传入
 * (login.browserCallback.* 骨架维持现状,copyKind 仅作验收定位标签)。
 */
export function renderAuthLoopbackPage(input: AuthLoopbackPageInput): string {
  return renderOAuthResultPage({
    pageKind: 'desktop-login',
    copyKind: 'login.browserCallback',
    ...input,
  });
}

// ── Dev-only loopback bridge seam(v6.13,implementation-plan Step 4 WHAT6)─────
//
// 浏览器失败卡验证路径:附录 A 的 browser-callback bridge fixture 无法自行进入
// authManager 的 loopback 闭包(port/state 都是每次尝试的进程内私有值),须由
// authManager 显式注入一条 dev-only 缝。二选一定型结论 = 「可注入纯 helper +
// authManager 静态注入」:slot 在本文件(纯逻辑、可单测),authManager 模块级
// 创建并在 openSystemBrowserAuthorization 内挂接。
// 安全边界:state 与授权码永不经过 bridge 落盘——fixture 只拿得到 ①渲染完成的
// HTML(不含 state)与 ②进程内 error 触发入口;packaged 构建 register 直接拒绝,
// 整条路径不可达(seam 三硬测见 authLoopbackCallback.test.ts)。

/** fixture 可注入的 dev bridge 面(仅 HTML 与进程内触发入口,无 state/凭证)。 */
export interface AuthLoopbackDevBridge {
  /** 拿到进程内回调触发入口(fixture 用于模拟 loopback error 回调到达)。 */
  onCallbackReady?(trigger: (result: AuthLoopbackResult) => void): void;
  /** 收到回调页最终渲染 HTML(仅 HTML,fixture 可落盘 acceptance/evidence 临时文件供截图)。 */
  onCallbackHtml?(html: string): void;
}

export interface AuthLoopbackDevBridgeSlot {
  /** dev 构建注册 bridge;packaged 构建拒绝注册(返回 false),路径不可达。 */
  register(bridge: AuthLoopbackDevBridge): boolean;
  /**
   * loopback 监听就绪后挂接:把「渲染 + 完成回调」组合成进程内触发入口交给
   * bridge。trigger 结果与真实 HTTP 回调走同一 render/finish 路径。
   */
  attach(finish: (result: AuthLoopbackResult) => void, renderHtml: (result: AuthLoopbackResult) => string): void;
  /** 真实 HTTP 回调渲染后同步一份 HTML 给 bridge(仅 HTML)。 */
  notifyHtml(html: string): void;
}

/**
 * 创建 dev-only bridge slot(isPackaged()=true 时全部 no-op,代码路径不可达)。
 * isPackaged 取 getter 而非布尔值:authManager 在模块顶层创建 slot,若此处直接
 * 读 app.isPackaged 会把 electron 依赖提前到 import 期(单测的 electron mock
 * 没有 app 时整条 import 链崩),延迟到调用期取值即无此耦合。
 */
export function createAuthLoopbackDevBridgeSlot(isPackaged: () => boolean): AuthLoopbackDevBridgeSlot {
  let bridge: AuthLoopbackDevBridge | null = null;
  return {
    register(next) {
      if (isPackaged()) return false;
      bridge = next;
      return true;
    },
    attach(finish, renderHtml) {
      if (isPackaged() || !bridge?.onCallbackReady) return;
      const current = bridge;
      current.onCallbackReady?.((result) => {
        const html = renderHtml(result);
        current.onCallbackHtml?.(html);
        finish(result);
      });
    },
    notifyHtml(html) {
      if (isPackaged()) return;
      bridge?.onCallbackHtml?.(html);
    },
  };
}

/**
 * Parses the RFC 8252 loopback request while enforcing the callback path and
 * the per-attempt state value. Unknown paths stay unhandled so the listener
 * can return 404 without completing the login attempt.
 */
export function parseAuthLoopbackCallback(
  requestUrl: string | undefined,
  expectedState: string,
): AuthLoopbackResult | null {
  if (!requestUrl) return null;

  let callback: URL;
  try {
    callback = new URL(requestUrl, 'http://127.0.0.1');
  } catch {
    return null;
  }

  if (callback.pathname !== '/auth/callback') return null;
  if (callback.searchParams.get('state') !== expectedState) {
    return { error: 'STATE_MISMATCH' };
  }

  const providerError = callback.searchParams.get('error');
  if (providerError) return { error: providerError };

  const code = callback.searchParams.get('code');
  return code ? { code } : { error: 'INVALID_AUTH_CODE' };
}
