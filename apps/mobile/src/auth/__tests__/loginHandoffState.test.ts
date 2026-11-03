import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  INITIAL_LOGIN_HANDOFF_STATE,
  LOGIN_HANDOFF_EASING,
  LOGIN_HANDOFF_TIMING,
  loginHandoffMoveMs,
  loginHandoffPanelDelayMs,
  loginHandoffReadiness,
  loginHandoffSloganDelayMs,
  loginHandoffTotalMs,
  reduceLoginHandoff,
  type LoginHandoffAction,
  type LoginHandoffState,
} from '../loginHandoff';

/**
 * PR4b 移动 handoff 状态表逐条测试(Step 5b WHAT2「状态表冻结并逐条测试」;
 * SC-7 slice pr4b handoff 行)。状态机核 = 纯 reducer 直测;Provider/reporter/
 * 动画接线与 unmount 清理走读源码断言(mobile 为 node-env vitest,无 RN renderer,
 * v6.3 预设降级双门禁,PR Description 声明)。
 */

function apply(actions: LoginHandoffAction[], from?: LoginHandoffState): LoginHandoffState {
  return actions.reduce(reduceLoginHandoff, from ?? INITIAL_LOGIN_HANDOFF_STATE);
}

function readSource(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), 'utf8').replace(/\r\n/g, '\n');
}

describe('loginHandoff 状态表(冻结逐条)', () => {
  it('endpoint pending→error→retry(pending)→ready:全程可上报,readiness 随闸推进', () => {
    let state = INITIAL_LOGIN_HANDOFF_STATE;
    expect(state.endpoint).toBe('pending');
    state = reduceLoginHandoff(state, { type: 'endpoint', status: 'error' });
    expect(state.endpoint).toBe('error');
    expect(loginHandoffReadiness(state)).toBe(false);
    // retry:gate 重跑上报 pending → ready
    state = reduceLoginHandoff(state, { type: 'endpoint', status: 'pending' });
    expect(state.endpoint).toBe('pending');
    state = reduceLoginHandoff(state, { type: 'endpoint', status: 'ready' });
    expect(state.endpoint).toBe('ready');
    // 其余闸未就绪,readiness 仍不推进
    expect(loginHandoffReadiness(state)).toBe(false);
  });

  it('endpoint ready 后单向锁定:晚到 error/pending 不回退', () => {
    const ready = apply([{ type: 'endpoint', status: 'ready' }]);
    expect(reduceLoginHandoff(ready, { type: 'endpoint', status: 'error' }).endpoint).toBe('ready');
    expect(reduceLoginHandoff(ready, { type: 'endpoint', status: 'pending' }).endpoint).toBe('ready');
  });

  it('OTA reload 期间 ota 保持 pending:readiness 不推进;ota-ready 后随链放行', () => {
    const withoutOta = apply([
      { type: 'endpoint', status: 'ready' },
      { type: 'auth-init', authenticated: false },
      { type: 'assets-ready' },
      { type: 'panel-mounted' },
    ]);
    expect(loginHandoffReadiness(withoutOta)).toBe(false);
    const withOta = reduceLoginHandoff(withoutOta, { type: 'ota-ready' });
    expect(loginHandoffReadiness(withOta)).toBe(true);
  });

  it('auth-init 完成(含异常归一未登录):authInit ready + authenticated 记录', () => {
    const state = apply([{ type: 'auth-init', authenticated: false }]);
    expect(state.authInit).toBe('ready');
    expect(state.authenticated).toBe(false);
  });

  it('未登录完整播放:readiness 锚含 login-panel-mounted(面板未挂载不推进)', () => {
    const gatesOnly = apply([
      { type: 'endpoint', status: 'ready' },
      { type: 'ota-ready' },
      { type: 'auth-init', authenticated: false },
      { type: 'assets-ready' },
    ]);
    expect(loginHandoffReadiness(gatesOnly)).toBe(false);
    const withPanel = reduceLoginHandoff(gatesOnly, { type: 'panel-mounted' });
    expect(loginHandoffReadiness(withPanel)).toBe(true);
    // 播放链:splash → handoff → done
    const playing = reduceLoginHandoff(withPanel, { type: 'handoff-start' });
    expect(playing.phase).toBe('handoff');
    expect(reduceLoginHandoff(playing, { type: 'handoff-done' }).phase).toBe('done');
  });

  it('已登录直入:不等 panel 信号,splash 可直达 done(品牌屏直入首页不闪登录)', () => {
    const authed = apply([
      { type: 'endpoint', status: 'ready' },
      { type: 'ota-ready' },
      { type: 'auth-init', authenticated: true },
      { type: 'assets-ready' },
    ]);
    expect(authed.panelMounted).toBe(false);
    expect(loginHandoffReadiness(authed)).toBe(true);
    expect(reduceLoginHandoff(authed, { type: 'handoff-done' }).phase).toBe('done');
  });

  it('reduced-motion:标志入库;splash 直落 done 合法(不经 handoff 播放)', () => {
    const rm = apply([{ type: 'reduced-motion', value: true }]);
    expect(rm.reducedMotion).toBe(true);
    expect(reduceLoginHandoff(rm, { type: 'handoff-done' }).phase).toBe('done');
  });

  it('config-missing(login 面板闸门态):panel-mounted 照常上报,readiness 语义不变', () => {
    // config 面板与登录面板同宿主同挂载链(login.tsx renderConfigIssues),
    // 状态机不特判——面板挂载即满足 panel 锚
    const state = apply([
      { type: 'endpoint', status: 'ready' },
      { type: 'ota-ready' },
      { type: 'auth-init', authenticated: false },
      { type: 'assets-ready' },
      { type: 'panel-mounted' },
    ]);
    expect(loginHandoffReadiness(state)).toBe(true);
  });

  it('handoff-start 仅从 splash 合法;handoff-done 幂等', () => {
    const done = apply([{ type: 'handoff-done' }]);
    expect(done.phase).toBe('done');
    expect(reduceLoginHandoff(done, { type: 'handoff-start' }).phase).toBe('done');
    expect(reduceLoginHandoff(done, { type: 'handoff-done' })).toBe(done);
  });
});

describe('loginHandoff 时序契约(demo splashHandoff 逐值冻结)', () => {
  it('timing/easing 参数逐字冻结', () => {
    expect(LOGIN_HANDOFF_TIMING).toEqual({
      spinnerFadeMs: 200,
      brandMoveDelayMs: 300,
      brandMoveMs: 650,
      panelInMs: 420,
      panelInOffsetPx: 20,
      sloganDelayMs: 100,
      sloganInMs: 500,
      settleMs: 60,
    });
    expect(LOGIN_HANDOFF_EASING.brandMove).toEqual([0.33, 0, 0.18, 1]);
    expect(LOGIN_HANDOFF_EASING.panelIn).toEqual([0.35, 0.1, 0.25, 1]);
    expect(LOGIN_HANDOFF_EASING.sloganIn).toEqual([0.55, 0.06, 0.38, 0.96]);
  });

  it('竖排时序:面板 300+650 起步,Slogan +100,总时长 1610ms', () => {
    expect(loginHandoffMoveMs('phone')).toBe(650);
    expect(loginHandoffPanelDelayMs('phone')).toBe(950);
    expect(loginHandoffSloganDelayMs('phone')).toBe(1050);
    expect(loginHandoffTotalMs('phone')).toBe(300 + 650 + 100 + 500 + 60);
  });

  it('手机横屏回退竖排衔接变体:随竖排规则(mode=phone,同 650ms 位移段)', () => {
    // 手机横屏落 phone 构图(§3.6 条4),衔接时序与竖排完全一致
    expect(loginHandoffMoveMs('phone')).toBe(LOGIN_HANDOFF_TIMING.brandMoveMs);
    expect(loginHandoffTotalMs('phone')).toBe(1610);
  });

  it('iPad 横屏无位移变体(358:833):moveMs=0,loading 完直接面板/Slogan 入场', () => {
    expect(loginHandoffMoveMs('pad-landscape')).toBe(0);
    expect(loginHandoffPanelDelayMs('pad-landscape')).toBe(300);
    expect(loginHandoffSloganDelayMs('pad-landscape')).toBe(400);
    expect(loginHandoffTotalMs('pad-landscape')).toBe(300 + 0 + 100 + 500 + 60);
    // iPad 竖屏仍有位移段
    expect(loginHandoffMoveMs('pad-portrait')).toBe(650);
  });
});

describe('loginHandoff 接线(Provider/reporter 拓扑 + 清理,读源码断言)', () => {
  const layoutSource = readSource('app/_layout.tsx');
  const providerSource = readSource('src/auth/MobileLoginHandoffContext.tsx');
  const stageSource = readSource('src/components/MobileLoginHandoffStage.tsx');
  const loginSource = readSource('app/(auth)/login.tsx');
  const authSource = readSource('src/auth/AuthContext.tsx');

  it('reporter 拓扑写死:root 挂 Provider,endpoint 在 root 层、OTA 在 RootAfterEndpoints、auth-init 在 AuthProvider 内、面板在登录页上报', () => {
    expect(layoutSource).toContain('<MobileLoginHandoffProvider>');
    expect(layoutSource).toContain('<EndpointHandoffBridge status={endpointGate.status} />');
    expect(layoutSource).toContain("dispatchHandoff({ type: 'ota-ready' })");
    expect(layoutSource).toContain('<AuthHandoffBridge />');
    expect(layoutSource).toContain("dispatch({ type: 'auth-init', authenticated: auth.isAuthenticated })");
    expect(loginSource).toContain("handoffDispatch?.({ type: 'panel-mounted' })");
    expect(stageSource).toContain("handoff?.dispatch({ type: 'assets-ready' })");
    // endpoint→OTA→auth 既有挂载顺序不变:OTA 上报在 RootAfterEndpoints、auth 桥在 AuthProvider 内
    const otaIndex = layoutSource.indexOf('useStartupOtaGate(');
    const authBridgeIndex = layoutSource.indexOf('<AuthHandoffBridge />');
    // 两处都必须真实存在(indexOf >= 0),否则顺序比较会因 -1 而空转;
    // 再断言 OTA 调用先于 auth 桥挂载(与上文注释的既有顺序一致)。
    expect(otaIndex).toBeGreaterThanOrEqual(0);
    expect(authBridgeIndex).toBeGreaterThanOrEqual(0);
    expect(otaIndex).toBeLessThan(authBridgeIndex);
  });

  it('reduced-motion:AccessibilityInfo 拉取 + 订阅,unmount 移除;直落终态由 Provider 收敛', () => {
    expect(providerSource).toContain('AccessibilityInfo.isReduceMotionEnabled()');
    expect(providerSource).toContain("addEventListener(\n      'reduceMotionChanged'");
    expect(providerSource).toContain('subscription.remove()');
    expect(providerSource).toContain("state.authenticated === true || state.reducedMotion");
    expect(providerSource).toContain("dispatch({ type: 'handoff-done' })");
  });

  it('Stage 动画:transform/opacity + useNativeDriver(compositor-only),spinner 限 splash/handoff 挂载', () => {
    expect(stageSource).toContain('useNativeDriver: true');
    expect(stageSource).toContain("phase !== 'done' ? (");
    expect(stageSource).toContain('brandProgress');
    expect(stageSource).toContain('sloganOpacity');
    // 面板入场在登录页(自下而上 20px + 渐显 420ms)
    expect(loginSource).toContain('usePanelEntrance');
    expect(loginSource).toContain('LOGIN_HANDOFF_TIMING.panelInMs');
    expect(loginSource).toContain('LOGIN_HANDOFF_TIMING.panelInOffsetPx');
  });

  it('移动 initialize 链外层 catch(v6.3):void run().catch 归一未登录', () => {
    expect(authSource).toContain('void run().catch((error) => {');
    expect(authSource).toContain('normalized to signed-out');
    expect(authSource).toContain('userRef.current = null;');
  });

  it('gate 屏内容层退化:endpoint error 层可交互 retry(错误层文案 key 化不变)', () => {
    expect(layoutSource).toContain('<MobileLoginHandoffStage>');
    // 内容层的动作 prop 已从 retry 专用改为通用 action(端点重试 / 强更去更新共用同一层),
    // 端点错误屏的接线与文案 key 化契约不变。
    expect(layoutSource).toContain('? endpointGate.resetToDev');
    expect(layoutSource).toContain(': endpointGate.retry');
    expect(layoutSource).toContain("loginText('endpointGateTitle')");
  });

  it('config-missing 面板接线:getMobileConfigIssues → login.configPanel(demo 复用文案口径)', () => {
    expect(loginSource).toContain('getMobileConfigIssues');
    expect(loginSource).toContain('testID="login.configPanel"');
    expect(loginSource).toContain("loginText('configTitle')");
  });
});

// guard: credentials-and-local-storage and engineering-conventions section 3.2.
// Captcha must gate every auth request; scenario credentials must remain excluded from production.
describe("loginScenarioHarness authentication call-site boundary", () => {
const authContextSource = readFileSync(
  resolve(process.cwd(), 'src/auth/AuthContext.tsx'),
  'utf8',
);
const metroConfigSource = readFileSync(resolve(process.cwd(), 'metro.config.js'), 'utf8');
describe('AuthContext 注入点(静态源码断言)', () => {
  it('经静态 import 使用 fixtures', () => {
    expect(authContextSource).toContain(
      "import { resolveLoginScenarioFetch } from '@cindy/auth-client/fixtures'",
    );
  });

  it('guard 写死为 __DEV__ + EXPO_PUBLIC_LOGIN_SCENARIO(附录 A 值域 env)', () => {
    expect(authContextSource).toContain('devModeActive: __DEV__');
    expect(authContextSource).toContain('scenario: process.env.EXPO_PUBLIC_LOGIN_SCENARIO');
  });

  it('注入形态 = 真实 CindyAuthClient + fetch 构造参数(scenarioFetch ?? 真 fetch)', () => {
    expect(authContextSource).toContain(
      'fetch: scenarioFetch ?? (async (input, init) => fetch(input, init))',
    );
    expect(authContextSource.match(/new CindyAuthClient\(/g)).toHaveLength(1);
  });

  it('metro.config 挂了生产 stub resolveRequest(build-time 排除双保险)', () => {
    expect(metroConfigSource).toContain("'@cindy/auth-client/fixtures'");
    expect(metroConfigSource).toContain("process.env.NODE_ENV === 'production'");
    expect(metroConfigSource).toContain('loginScenarios.production-stub.ts');
  });
});
});

// guard: credentials-and-local-storage and engineering-conventions section 3.2.
// Captcha must gate every auth request; scenario credentials must remain excluded from production.
describe("loginCaptcha authentication call-site boundary", () => {
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
});
