import { describe, expect, it } from 'vitest';

import { parseCaptchaWebViewMessage } from '@/auth/loginCaptchaMessage';
import {
  isAllowedLoginCaptchaNavigation,
  isAllowedLoginCaptchaPageUrl,
  withLoginCaptchaTheme,
} from '@/auth/loginCaptchaUrl';

/**
 * 登录人机验证(captcha)移动端测试:
 *  - parseCaptchaWebViewMessage 纯函数(WebView postMessage 回传契约);
 *  - AuthContext 发码前置闸接线(静态源码断言——AuthContext.tsx 整模块依赖
 *    expo/RN 运行时,node vitest 不宜加载,与 loginScenarioHarness 同款模式)。
 */

describe('parseCaptchaWebViewMessage(挑战页 postMessage 回传契约)', () => {
  it('解析 ok/err,拒绝越界与非本契约消息', () => {
    expect(
      parseCaptchaWebViewMessage(
        JSON.stringify({ type: 'cindy-captcha', ok: true, token: 'tok-1' }),
      ),
    ).toEqual({ ok: true, token: 'tok-1' });
    expect(
      parseCaptchaWebViewMessage(
        JSON.stringify({ type: 'cindy-captcha', ok: false, code: 'expired' }),
      ),
    ).toEqual({ ok: false, code: 'expired' });
    // 越界 token(>2048)/ 空 token 拒
    expect(
      parseCaptchaWebViewMessage(
        JSON.stringify({ type: 'cindy-captcha', ok: true, token: 'a'.repeat(2049) }),
      ),
    ).toBeNull();
    expect(
      parseCaptchaWebViewMessage(JSON.stringify({ type: 'cindy-captcha', ok: true, token: '' })),
    ).toBeNull();
    // 非本契约 type / 非 JSON / 缺 ok
    expect(
      parseCaptchaWebViewMessage(JSON.stringify({ type: 'other', ok: true, token: 't' })),
    ).toBeNull();
    expect(parseCaptchaWebViewMessage('not-json')).toBeNull();
    expect(parseCaptchaWebViewMessage(JSON.stringify({ type: 'cindy-captcha' }))).toBeNull();
    // 失败缺 code → 收敛 unknown
    expect(
      parseCaptchaWebViewMessage(JSON.stringify({ type: 'cindy-captcha', ok: false })),
    ).toEqual({ ok: false, code: 'unknown' });
  });
});

describe('withLoginCaptchaTheme(挑战页有效登录主题)', () => {
  it('保留既有参数并写入 light/dark，覆盖陈旧 theme', () => {
    expect(
      withLoginCaptchaTheme('https://auth.example.com/captcha/turnstile?lang=ja', 'light'),
    ).toBe('https://auth.example.com/captcha/turnstile?lang=ja&theme=light');
    expect(
      withLoginCaptchaTheme(
        'https://auth.example.com/captcha/turnstile?theme=light&lang=ko',
        'dark',
      ),
    ).toBe('https://auth.example.com/captcha/turnstile?theme=dark&lang=ko');
  });

  it('非法 URL 保留原值，由 WebView 加载失败路径收敛', () => {
    expect(withLoginCaptchaTheme('not-a-url', 'light')).toBe('not-a-url');
  });
});

describe('mobile captcha WebView 导航与消息契约边界', () => {
  const expected =
    'https://auth.example.com/captcha/turnstile?action=email_request_code&theme=dark';

  it('顶层只允许预期协议、origin 与精确托管路径', () => {
    expect(
      isAllowedLoginCaptchaNavigation({ url: expected, isTopFrame: true }, expected),
    ).toBe(true);
    expect(
      isAllowedLoginCaptchaNavigation(
        { url: 'https://auth.example.com/captcha/other', isTopFrame: true },
        expected,
      ),
    ).toBe(false);
    expect(
      isAllowedLoginCaptchaNavigation(
        { url: 'blob:https://auth.example.com/opaque-id', isTopFrame: true },
        expected,
      ),
    ).toBe(false);
    expect(
      isAllowedLoginCaptchaNavigation(
        { url: 'https://challenges.cloudflare.com/widget', isTopFrame: true },
        expected,
      ),
    ).toBe(false);
  });

  it('Turnstile 子 frame 放行 Cloudflare HTTPS 与其必需的本地空文档', () => {
    expect(
      isAllowedLoginCaptchaNavigation(
        { url: 'https://challenges.cloudflare.com/turnstile/widget', isTopFrame: false },
        expected,
      ),
    ).toBe(true);
    expect(
      isAllowedLoginCaptchaNavigation(
        { url: 'about:blank', isTopFrame: false },
        expected,
      ),
    ).toBe(true);
    expect(
      isAllowedLoginCaptchaNavigation(
        { url: 'about:srcdoc', isTopFrame: false },
        expected,
      ),
    ).toBe(true);
    expect(
      isAllowedLoginCaptchaNavigation(
        { url: 'about:config', isTopFrame: false },
        expected,
      ),
    ).toBe(false);
    expect(
      isAllowedLoginCaptchaNavigation(
        { url: 'blob:https://challenges.cloudflare.com/opaque-id', isTopFrame: false },
        expected,
      ),
    ).toBe(false);
    expect(
      isAllowedLoginCaptchaNavigation(
        { url: 'https://evil.example.com/widget', isTopFrame: false },
        expected,
      ),
    ).toBe(false);
  });

  it('托管顶层页只接受预期地址，并允许 loopback HTTP 本地开发', () => {
    expect(isAllowedLoginCaptchaPageUrl(expected, expected)).toBe(true);
    expect(
      isAllowedLoginCaptchaPageUrl('https://auth.example.com/captcha/other', expected),
    ).toBe(false);
    expect(
      isAllowedLoginCaptchaPageUrl(
        'http://localhost:3344/captcha/turnstile',
        'http://localhost:3344/captcha/turnstile?action=email_request_code',
      ),
    ).toBe(true);
    expect(
      isAllowedLoginCaptchaPageUrl(
        'http://auth.example.com/captcha/turnstile',
        'http://auth.example.com/captcha/turnstile',
      ),
    ).toBe(false);
  });
});
