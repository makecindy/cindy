import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { isSkipLoginDisabled, requestSkipLogin } from '@/auth/skipLoginGate';

/**
 * 「跳过登录」无账号通路专测(产品拍板 2026-07-27:手机端新增无账号进主界面入口,
 * 取代 2026-07-24「手机/pad 必须有账号」拍板)。
 *
 * AuthProvider / expo-router 需要 RN 运行时,node vitest 下沿用仓内「读源码接线断言」
 * 模式(loginConsent / loginSkinVisual 同款);持久化 store 是纯模块,直接断言键名与
 * 落盘语义(AsyncStorage 由 vitest setup 的 mock 提供时才可跑行为级,这里只锁契约)。
 */
const authSource = readFileSync(
  resolve(process.cwd(), 'src/auth/AuthContext.tsx'),
  'utf8',
);
const storeSource = readFileSync(
  resolve(process.cwd(), 'src/auth/localModeStore.ts'),
  'utf8',
);
const controlsSource = readFileSync(
  resolve(process.cwd(), 'src/components/LoginSkinControls.tsx'),
  'utf8',
);
const loginSource = readFileSync(
  resolve(process.cwd(), 'app/(auth)/login.tsx'),
  'utf8',
);
const layoutSource = readFileSync(
  resolve(process.cwd(), 'app/_layout.tsx'),
  'utf8',
);
const indexSource = readFileSync(
  resolve(process.cwd(), 'app/index.tsx'),
  'utf8',
);

describe('localModeStore(「跳过登录」标记持久化)', () => {
  it('键名与取值口径固定:AsyncStorage cindy.mobile.auth.localMode = "1"', () => {
    expect(storeSource).toContain("const STORAGE_KEY = 'cindy.mobile.auth.localMode'");
    expect(storeSource).toContain("const ENABLED_VALUE = '1'");
    // 非凭证走 AsyncStorage(凭证才进 SecureStore),且不引 expo-secure-store
    expect(storeSource).toContain("from '@react-native-async-storage/async-storage'");
    expect(storeSource).not.toContain('expo-secure-store');
    // 读写 best-effort:异常不外抛(读失败按未跳过、写失败不阻断进入)
    expect(storeSource).toMatch(/readLocalMode[\s\S]{0,240}catch \{[\s\S]{0,80}return false;/);
  });
});

describe('AuthContext 无账号态接线', () => {
  it('isLocalMode 与 isAuthenticated 正交:不伪造登录态', () => {
    // 登录态判定仍只看 user(弱网降级恢复契约,authWeakNetworkBootstrap 同锁)
    expect(authSource).toContain('isAuthenticated: user !== null');
    expect(authSource).toContain('isLocalMode: localMode');
    expect(authSource).toContain('enterLocalMode');
  });

  it('冷启动恢复 + 账号优先 + 登出清除三条语义都在', () => {
    // ① 冷启动从盘上恢复(与 refreshToken/profile 同批读)
    expect(authSource).toContain('readLocalMode()');
    expect(authSource).toMatch(/if \(storedLocalMode\) \{[\s\S]{0,160}setLocalMode\(true\)/);
    // ② 账号优先:applyUser 拿到真实身份即清标记(否则登出后被陈旧标记留在主界面)
    expect(authSource).toMatch(
      /if \(next && localModeRef\.current\) void applyLocalMode\(false\)/,
    );
    // ③ 登出 / 会话终止(clearLocalSession)退出无账号态 → 回登录页
    expect(authSource).toMatch(/applyUser\(null\);[\s\S]{0,240}applyLocalMode\(false\)/);
  });

  it('enterLocalMode 不写统计同意、不碰 loginState(跳过登录免协议门)', () => {
    const start = authSource.indexOf('const enterLocalMode = useCallback');
    expect(start).toBeGreaterThan(0);
    const body = authSource.slice(start, authSource.indexOf('}, [applyLocalMode]);', start));
    expect(body).toContain('applyLocalMode(true)');
    expect(body).not.toContain('acceptPrivacyConsent');
    expect(body).not.toContain('updateLoginState');
  });
});

/**
 * 「跳过登录」入口的 in-flight 门(2026-07-27 P1 回归)。
 *
 * 登录动作未决时若还能点跳过,路由先切主界面、迟到的登录结果再写 user 清标记,
 * 最终态取决于异步完成顺序。门是纯函数(skipLoginGate),这里做行为级断言;
 * 组件/调用点的接线仍用源码断言(login.tsx 依赖 expo/RN,node vitest 不加载)。
 */
describe('跳过登录 in-flight 门(skipLoginGate)', () => {
  it('busy 或未 initialized → 禁用;两者都就绪 → 放行', () => {
    expect(isSkipLoginDisabled({ isBusy: true, initialized: true })).toBe(true);
    expect(isSkipLoginDisabled({ isBusy: false, initialized: false })).toBe(true);
    expect(isSkipLoginDisabled({ isBusy: true, initialized: false })).toBe(true);
    expect(isSkipLoginDisabled({ isBusy: false, initialized: true })).toBe(false);
  });

  it('busy 时点击 enterLocalMode 调用 0 次,idle 时 1 次', () => {
    const enterLocalMode = vi.fn(async () => undefined);

    expect(
      requestSkipLogin({ isBusy: true, initialized: true, enterLocalMode }),
    ).toBe(false);
    expect(
      requestSkipLogin({ isBusy: false, initialized: false, enterLocalMode }),
    ).toBe(false);
    expect(enterLocalMode).toHaveBeenCalledTimes(0);

    expect(
      requestSkipLogin({ isBusy: false, initialized: true, enterLocalMode }),
    ).toBe(true);
    expect(enterLocalMode).toHaveBeenCalledTimes(1);
  });

  it('门不看 mobile 配置缺失:配置坏了也要留逃生入口', () => {
    // 登录按钮那条 disabled 含 configIssues,跳过入口刻意不含(不发请求)
    expect(loginSource).toContain('const skipDisabled = isSkipLoginDisabled({');
    const start = loginSource.indexOf('const skipDisabled = isSkipLoginDisabled({');
    const decl = loginSource.slice(start, loginSource.indexOf('});', start));
    expect(decl).not.toContain('configIssues');
  });

  it('双保险接线:handler 走门 + 组件收原生 disabled(视觉不变色)', () => {
    // ① handler 只经 requestSkipLogin(门内判 + 派发),不再裸调 enterLocalMode
    const handlerStart = loginSource.indexOf('const skipLogin = () => {');
    expect(handlerStart).toBeGreaterThan(0);
    const handlerBody = loginSource.slice(
      handlerStart,
      loginSource.indexOf('\n  };', handlerStart),
    );
    expect(handlerBody).toContain('requestSkipLogin({');
    expect(handlerBody).toContain('enterLocalMode: auth.enterLocalMode');
    // ② JSX 传 disabled(与主按钮同一 in-flight 语义,值来自同一个门)
    const jsxStart = loginSource.indexOf('<LoginSkipLoginLink');
    const jsx = loginSource.slice(jsxStart, loginSource.indexOf('/>', jsxStart));
    expect(jsx).toContain('disabled={skipDisabled}');
    // ③ 组件把 disabled 交给 Pressable + 无障碍语义,且不做颜色/透明度回填
    const componentStart = controlsSource.indexOf('export function LoginSkipLoginLink');
    const component = controlsSource.slice(
      componentStart,
      controlsSource.indexOf('\n}\n', componentStart),
    );
    expect(component).toContain('disabled={disabled}');
    expect(component).toContain('accessibilityState={{ disabled }}');
    expect(component).not.toMatch(/opacity|disabledButton/);
  });
});

/**
 * 逃生口落地(Codex review P1):门刻意不看 configIssues,但配置错误屏一度根本没渲染
 * 这个入口——承诺落空。这里同时锁「config 面板内有入口」与「该态下门确实放行」。
 */
describe('配置错误屏同样承载跳过入口', () => {
  it('config 面板内挂同一个 LoginSkipLoginLink(同组件 / 同 handler / 同门)', () => {
    const panelStart = loginSource.indexOf('<LoginPanel testID="login.configPanel">');
    expect(panelStart).toBeGreaterThan(0);
    const panelBlock = loginSource.slice(
      panelStart,
      loginSource.indexOf('</LoginPanel>', panelStart),
    );
    expect(panelBlock).toContain('<LoginSkipLoginLink');
    const jsx = panelBlock.slice(
      panelBlock.indexOf('<LoginSkipLoginLink'),
      panelBlock.indexOf('/>', panelBlock.indexOf('<LoginSkipLoginLink')),
    );
    // 复用 identifier 屏的同一 handler 与同一门,不新造组件、不复制样式
    expect(jsx).toContain('disabled={skipDisabled}');
    expect(jsx).toContain('onPress={skipLogin}');
    expect(jsx).toContain("label={loginText('skipLogin')}");
  });

  it('config 面板的入口可点:configIssues 只禁用登录按钮,不禁用跳过门', () => {
    // 登录按钮那条 disabled 含 configIssues(见上一个 describe 的源码断言),跳过门不含,
    // 所以配置坏掉 + auth 已 initialized 时点击照常派发 enterLocalMode。
    const enterLocalMode = vi.fn(async () => undefined);

    expect(
      requestSkipLogin({ isBusy: false, initialized: true, enterLocalMode }),
    ).toBe(true);
    expect(enterLocalMode).toHaveBeenCalledTimes(1);
  });

  it('identifier 屏入口不受影响(回归):第一处仍在 identifier 面板内', () => {
    const identifierStart = loginSource.indexOf(
      '<LoginPanel testID="login.panel.identifier">',
    );
    const configStart = loginSource.indexOf('<LoginPanel testID="login.configPanel">');
    const firstLink = loginSource.indexOf('<LoginSkipLoginLink');
    expect(identifierStart).toBeGreaterThan(0);
    expect(firstLink).toBeGreaterThan(identifierStart);
    expect(firstLink).toBeLessThan(configStart);
    // 全文件恰好两处:identifier + config,别处不再散落
    expect(loginSource.split('<LoginSkipLoginLink').length - 1).toBe(2);
  });
});

describe('路由门:有账号 ∨ 已跳过', () => {
  it('NavigationGate 与 index 同门放行,且门只在这两处', () => {
    expect(layoutSource).toContain('const canEnterApp = auth.isAuthenticated || auth.isLocalMode');
    expect(layoutSource).toContain('if (!canEnterApp && !inAuthGroup)');
    expect(layoutSource).toContain('if (canEnterApp && inAuthGroup)');
    expect(indexSource).toContain('if (!auth.isAuthenticated && !auth.isLocalMode)');
    expect(indexSource).toContain('<Redirect href="/login" />');
  });
});
