import { describe, expect, it } from 'vitest';

import {
  createAuthBrowserAuthorizationSlot,
  createAuthLoopbackDevBridgeSlot,
  parseAuthLoopbackCallback,
  raceAuthBrowserCancellation,
  renderAuthLoopbackPage,
  type AuthLoopbackResult,
} from '../authLoopbackCallback';

describe('auth loopback callback', () => {
  it('accepts an authorization code only for the expected state', () => {
    expect(
      parseAuthLoopbackCallback('/auth/callback?code=auth-code&state=expected', 'expected'),
    ).toEqual({ code: 'auth-code' });

    expect(
      parseAuthLoopbackCallback('/auth/callback?code=auth-code&state=unexpected', 'expected'),
    ).toEqual({ error: 'STATE_MISMATCH' });
  });

  it('propagates provider errors after state validation', () => {
    expect(
      parseAuthLoopbackCallback('/auth/callback?error=access_denied&state=expected', 'expected'),
    ).toEqual({ error: 'access_denied' });
  });

  it('rejects incomplete callbacks and ignores unrelated paths', () => {
    expect(parseAuthLoopbackCallback('/auth/callback?state=expected', 'expected')).toEqual({
      error: 'INVALID_AUTH_CODE',
    });
    expect(parseAuthLoopbackCallback('/health', 'expected')).toBeNull();
    expect(parseAuthLoopbackCallback(undefined, 'expected')).toBeNull();
  });
});

describe('auth loopback callback page', () => {
  it('renders the localized copy and lang attribute', () => {
    const html = renderAuthLoopbackPage({
      htmlLang: 'zh-CN',
      variant: 'success',
      title: '登录成功',
      body: '登录已成功，现在可以关闭此页面了。',
      closeCountdown: '{{count}}秒后自动关闭',
    });
    expect(html).toContain('<html lang="zh-CN">');
    expect(html).toContain('<h1>登录成功</h1>');
    expect(html).toContain('登录已成功，现在可以关闭此页面了。');
    expect(html).toContain('3秒后自动关闭');
    expect(html).toContain('id="close-countdown"');
    expect(html).not.toContain('class="detail"');
    expect(html).not.toContain('class="cta"');
  });

  it('renders the return-to-app CTA on an error page when an action is provided', () => {
    const html = renderAuthLoopbackPage({
      htmlLang: 'zh-CN',
      variant: 'error',
      title: '登录未完成',
      body: '请回到 Cindy 重新登录。',
      action: { href: 'cindy://focus/desktop-login', label: '回到 Cindy' },
    });
    expect(html).toContain('<a class="cta" href="cindy://focus/desktop-login">回到 Cindy</a>');
  });

  it('shows the raw error code on the error page and escapes injected markup', () => {
    const html = renderAuthLoopbackPage({
      htmlLang: 'en',
      variant: 'error',
      title: 'Sign-in not completed',
      body: 'Please return to Cindy and sign in again.',
      detail: '<script>alert(1)</script>',
    });
    expect(html).toContain('class="detail"');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    // 新品牌卡带合法的 U-10 内联缩放脚本,断言收敛为「注入载荷绝不以原文出现」
    expect(html).not.toContain('<script>alert(1)</script>');
  });
});

describe('auth browser authorization cancellation slot', () => {
  it('cancels the active attempt once', () => {
    const slot = createAuthBrowserAuthorizationSlot();
    let cancellations = 0;
    slot.activate(() => {
      cancellations += 1;
    });

    expect(slot.cancelActive()).toBe(true);
    expect(slot.cancelActive()).toBe(false);
    expect(cancellations).toBe(1);
  });

  it('does not let an older cleanup clear a newer attempt', () => {
    const slot = createAuthBrowserAuthorizationSlot();
    const deactivateOlder = slot.activate(() => undefined);
    let newerCancelled = false;
    slot.activate(() => {
      newerCancelled = true;
    });

    deactivateOlder();
    expect(slot.cancelActive()).toBe(true);
    expect(newerCancelled).toBe(true);
  });

  it('cancels post-callback work and ignores its late result', async () => {
    const slot = createAuthBrowserAuthorizationSlot();
    const controller = new AbortController();
    slot.activate(() => controller.abort());
    let completeExchange!: (value: string) => void;
    const exchange = new Promise<string>((resolve) => {
      completeExchange = resolve;
    });

    const raced = raceAuthBrowserCancellation(exchange, controller.signal);
    expect(slot.cancelActive()).toBe(true);
    await expect(raced).resolves.toEqual({ cancelled: true });

    completeExchange('late-token');
    await Promise.resolve();
    expect(controller.signal.aborted).toBe(true);
  });
});

// ── PR3:desktop-login 品牌卡接线 + dev-only loopback bridge seam(v6.13)──────

describe('auth loopback page brand wiring (PR3)', () => {
  it('routes the login callback page to the wave4 brand card with acceptance labels', () => {
    const html = renderAuthLoopbackPage({
      htmlLang: 'zh-CN',
      variant: 'success',
      title: '登录成功',
      body: '登录已成功，现在可以关闭此页面了。',
      closeCountdown: '{{count}}秒后自动关闭',
    });
    expect(html).toContain('data-cindy-oauth-visual="success"');
    expect(html).toContain('data-cindy-oauth-copy="login.browserCallback"');
    expect(html).toContain('data-cindy-oauth-layout="compact"');
    expect(html).toContain('data-card-width="560" data-card-height="500"');
    expect(html).toContain('3秒后自动关闭');
  });
});

describe('auth loopback dev bridge seam (v6.13)', () => {
  const renderError = (result: AuthLoopbackResult) =>
    renderAuthLoopbackPage({
      htmlLang: 'en',
      variant: 'error' in result ? 'error' : 'success',
      title: 'Sign-in not completed',
      body: 'Please return to Cindy and sign in again.',
      detail: 'error' in result ? result.error : undefined,
    });

  it('renders the real error page HTML through the shared path when the fixture triggers', () => {
    const slot = createAuthLoopbackDevBridgeSlot(() => false);
    let trigger: ((result: AuthLoopbackResult) => void) | null = null;
    const htmls: string[] = [];
    expect(
      slot.register({
        onCallbackReady: (next) => {
          trigger = next;
        },
        onCallbackHtml: (html) => htmls.push(html),
      }),
    ).toBe(true);
    const finished: AuthLoopbackResult[] = [];
    slot.attach((result) => finished.push(result), renderError);
    expect(trigger).not.toBeNull();
    trigger!({ error: 'SOCIAL_EXCHANGE_FAILED' });
    expect(finished).toEqual([{ error: 'SOCIAL_EXCHANGE_FAILED' }]);
    expect(htmls).toHaveLength(1);
    // ①真实 error 页壳(非 mock 字符串):品牌卡 + error variant + 原始错误码 detail
    expect(htmls[0]).toContain('data-cindy-oauth-result="error"');
    expect(htmls[0]).toContain('data-cindy-oauth-visual="failure"');
    expect(htmls[0]).toContain('SOCIAL_EXCHANGE_FAILED');
  });

  it('never exposes the anti-CSRF state through any bridge surface', () => {
    const secretState = 'anti-csrf-state-9f2c1a';
    const slot = createAuthLoopbackDevBridgeSlot(() => false);
    let trigger: ((result: AuthLoopbackResult) => void) | null = null;
    const fixtureSeen: string[] = [];
    slot.register({
      onCallbackReady: (next) => {
        trigger = next;
      },
      onCallbackHtml: (html) => fixtureSeen.push(html),
    });
    // renderError 闭包持有 state(模拟 authManager 业务段),但渲染输入不含 state,
    // bridge 面上只有 result 与 HTML——state 仅进程内内存传递,不经 fixture 落盘。
    slot.attach(
      () => {
        expect(secretState).toBeTruthy(); // state 停留在宿主闭包
      },
      (result) => renderError(result),
    );
    trigger!({ error: 'PROVIDER_DENIED' });
    slot.notifyHtml(renderError({ error: 'PROVIDER_DENIED' }));
    expect(fixtureSeen.length).toBeGreaterThan(0);
    for (const html of fixtureSeen) {
      expect(html).not.toContain(secretState);
    }
  });

  it('is unreachable in packaged builds (register refused, attach/notify no-op)', () => {
    const slot = createAuthLoopbackDevBridgeSlot(() => true);
    let readyCalls = 0;
    let htmlCalls = 0;
    expect(
      slot.register({
        onCallbackReady: () => {
          readyCalls += 1;
        },
        onCallbackHtml: () => {
          htmlCalls += 1;
        },
      }),
    ).toBe(false);
    let finished = 0;
    slot.attach(
      () => {
        finished += 1;
      },
      () => 'unused',
    );
    slot.notifyHtml('unused');
    expect(readyCalls).toBe(0);
    expect(htmlCalls).toBe(0);
    expect(finished).toBe(0);
  });
});
