import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { parseCaptchaWebViewMessage } from '@/auth/loginCaptchaMessage';
import { withLoginCaptchaTheme } from '@/auth/loginCaptchaUrl';

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

  it('login.tsx 渲染 captcha WebView 模态并接回 resolveCaptchaChallenge', () => {
    expect(loginSource).toContain('auth.captchaChallenge');
    expect(loginSource).toContain('LoginCaptchaWebView');
    expect(loginSource).toContain('auth.resolveCaptchaChallenge');
  });

  it('captcha WebView 不让 originWhitelist 把挑战页交给外部浏览器', () => {
    expect(captchaWebViewSource).toContain("originWhitelist={['*']}");
    expect(captchaWebViewSource).toContain('setSupportMultipleWindows={false}');
    expect(captchaWebViewSource).toContain(
      'target.origin === pageOrigin || target.origin === TURNSTILE_ORIGIN',
    );
    expect(captchaWebViewSource).not.toContain('`${pageOrigin}/*`');
  });

  it('captcha WebView 使用 ThemeOverrideProvider 内的有效登录主题', () => {
    expect(captchaWebViewSource).toContain('const { colors, mode } = useTheme()');
    expect(captchaWebViewSource).toContain('withLoginCaptchaTheme(url, mode)');
    expect(captchaWebViewSource).toContain('source={{ uri: themedUrl }}');
  });
});
