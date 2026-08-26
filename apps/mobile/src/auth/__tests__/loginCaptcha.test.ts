import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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

describe('AuthContext captcha 闸接线(静态源码断言)', () => {
  const authContextSource = readFileSync(
    resolve(process.cwd(), 'src/auth/AuthContext.tsx'),
    'utf8',
  );
  const loginSource = readFileSync(resolve(process.cwd(), 'app/(auth)/login.tsx'), 'utf8');
  const captchaWebViewSource = readFileSync(
    resolve(process.cwd(), 'src/auth/LoginCaptchaWebView.tsx'),
    'utf8',
  );

  it('discover 的 sole email_code 自动串发路径先过 ensureCaptchaGate', () => {
    const soleBranch = authContextSource.slice(
      authContextSource.indexOf("sole?.type === 'email_code'"),
      authContextSource.indexOf("updateLoginState(\n                reduceAuthFlow(currentState, {\n                  type: 'code-requested'"),
    );
    expect(soleBranch).toContain("ensureCaptchaGate('email')");
    expect(soleBranch).toContain('requestCodeWithCaptchaFallback');
  });

  it('request-code 的 email/phone 都按 requiredFor 动作过闸,取消不派发', () => {
    const branch = authContextSource.slice(
      authContextSource.indexOf("if (action.type === 'request-code')"),
      authContextSource.indexOf("if (action.type === 'verify-code')"),
    );
    expect(branch).toContain('ensureCaptchaGate(action.kind)');
    expect(branch).toContain('if (!gate.proceed) return false;');
    expect(branch).toContain('requestCodeWithCaptchaFallback');
    expect(authContextSource).toContain('captchaRequiredActionForVerificationKind(kind)');
    expect(authContextSource).toContain('?action=${encodeURIComponent(action)}&lang=');
  });

  it('挑战页地址由构建区域 authApiBaseUrl + 共享路径常量拼出', () => {
    expect(authContextSource).toContain('CAPTCHA_CHALLENGE_PAGE_PATH');
    expect(authContextSource).toContain(
      "getMobileEndpointForRealm(BUILD_AUTH_REGION, 'authApiBaseUrl')",
    );
  });

  it('显示 captcha WebView 前先收起软键盘', () => {
    const challengeBranch = authContextSource.slice(
      authContextSource.indexOf('const runCaptchaChallenge'),
      authContextSource.indexOf('const ensureCaptchaGate'),
    );
    expect(authContextSource).toMatch(
      /import \{[^}]*\bKeyboard\b[^}]*\} from 'react-native';/,
    );
    expect(challengeBranch.indexOf('Keyboard.dismiss();')).toBeGreaterThan(-1);
    expect(challengeBranch.indexOf('Keyboard.dismiss();')).toBeLessThan(
      challengeBranch.indexOf('setCaptchaChallenge({ url });'),
    );
  });

  it('login.tsx 渲染 captcha WebView 模态并接回 resolveCaptchaChallenge', () => {
    expect(loginSource).toContain('auth.captchaChallenge');
    expect(loginSource).toContain('LoginCaptchaWebView');
    expect(loginSource).toContain('auth.resolveCaptchaChallenge');
  });

  it('captcha WebView 限制导航但不把客户端消息来源当作认证边界', () => {
    expect(captchaWebViewSource).toContain("originWhitelist={['*']}");
    expect(captchaWebViewSource).toContain('setSupportMultipleWindows={false}');
    expect(captchaWebViewSource).toContain('isAllowedLoginCaptchaNavigation(request, themedUrl)');
    expect(captchaWebViewSource).not.toContain('event.nativeEvent.url');
    expect(captchaWebViewSource).not.toMatch(/^\s*incognito(?:\s|=)/m);
    expect(captchaWebViewSource).toContain(
      'parseCaptchaWebViewMessage(event.nativeEvent.data)',
    );
    expect(captchaWebViewSource).not.toContain('`${pageOrigin}/*`');
  });

  it('captcha WebView 使用 ThemeOverrideProvider 内的有效登录主题', () => {
    expect(captchaWebViewSource).toContain('const { colors, mode } = useTheme()');
    expect(captchaWebViewSource).toContain('withLoginCaptchaTheme(url, mode)');
    expect(captchaWebViewSource).toContain('source={{ uri: themedUrl }}');
  });

  it('captcha WebView 的 iOS/Android 渲染进程异常都进入失败重试态', () => {
    expect(captchaWebViewSource).toContain('onContentProcessDidTerminate={() => setFailed(true)}');
    expect(captchaWebViewSource).toContain('onRenderProcessGone={() => setFailed(true)}');
  });

  it('captcha WebView 超时后进入重试态，并在完成、重试或卸载时清理计时器', () => {
    expect(captchaWebViewSource).toContain('const CHALLENGE_TIMEOUT_MS = 120_000;');
    expect(captchaWebViewSource).toContain('const timeoutTimer = setTimeout(() => {');
    expect(captchaWebViewSource).toContain('return () => clearTimeout(timeoutTimer);');
    expect(captchaWebViewSource).toContain('}, [failed, generation, themedUrl]);');
  });

  it('captcha 重试与取消动作都提供至少 44×44 的触控目标', () => {
    for (const testId of ['login.captcha.retry', 'login.captcha.cancel']) {
      const marker = `testID="${testId}"`;
      const markerIndex = captchaWebViewSource.indexOf(marker);
      const actionStart = captchaWebViewSource.lastIndexOf('<Pressable', markerIndex);
      const actionSource = captchaWebViewSource.slice(actionStart, markerIndex);
      expect(markerIndex).toBeGreaterThan(-1);
      expect(actionStart).toBeGreaterThan(-1);
      expect(actionSource).toContain('minHeight: 44');
      expect(actionSource).toContain('minWidth: 44');
    }
  });

  it('captcha 卡片和挑战内容在窄屏内按安全边距收缩', () => {
    expect(captchaWebViewSource).toContain('paddingHorizontal: spacing.lg');
    expect(captchaWebViewSource).toContain('maxWidth: 340');
    expect(captchaWebViewSource).toContain("width: '100%'");
    expect(captchaWebViewSource.match(/alignSelf: 'stretch'/g)).toHaveLength(2);
    expect(captchaWebViewSource).not.toContain('width: 340');
    expect(captchaWebViewSource).not.toContain('width: 308');
  });

  it('captcha 打开时从 Android TalkBack 隐藏背景登录组与注销气泡', () => {
    expect(loginSource).toContain('const captchaChallengeOpen = auth.captchaChallenge !== null');
    expect(loginSource).toContain(
      'consentDialogOpen || realmConsentOpen || captchaChallengeOpen || handoffPhase',
    );
    expect(loginSource).toContain(
      'consentDialogOpen || realmConsentOpen || captchaChallengeOpen',
    );
  });
});
