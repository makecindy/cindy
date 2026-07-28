import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { invalidateInFlightAuth } from '@/auth/authGeneration';
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
    const body = authSource.slice(start, authSource.indexOf('const clearLocalSession = useCallback', start));
    expect(body).toContain('applyLocalMode(true)');
    expect(body).not.toContain('acceptPrivacyConsent');
    expect(body).not.toContain('updateLoginState');
  });
});

/**
 * 进入无账号态必须作废在途认证结果(2026-07-28 review P1)。
 *
 * 事故形态:启动 refresh 超过 AUTH_STARTUP_GATE_TIMEOUT_MS 后 initialized 已翻 true、
 * 界面放行,但那条 refresh 仍在飞。此时点「跳过登录」若只写标记、不 bump auth
 * generation,迟到的成功仍能通过 `authGenerationRef.current !== generation` 校验并
 * applyUser() —— 用户明确选了「不登录」,却被自动登录、标记还被 applyUser 清掉。
 *
 * 机制不新造:与 clearLocalSession(登出 / 会话终止)共用 authGeneration.ts 的
 * invalidateInFlightAuth。下面前三条是该机制的**行为级**断言(消费端判据按
 * AuthContext 里的 `captured !== current` 原样建模),末两条锁两个调用点确实接上了。
 */
describe('无账号态作废在途认证结果(authGeneration)', () => {
  /** 建模 AuthContext 消费端:异步开始时捕获 generation,落地前比对,不等则整条丢弃。 */
  const makeLateAuthResult = (refs: {
    authGeneration: { current: number };
    refreshInFlight: { current: Promise<string | null> | null };
  }) => {
    const captured = refs.authGeneration.current;
    return {
      /** 迟到结果落地:返回是否真的 apply(false = 被 generation 作废)。 */
      settle(applyUser: (user: { id: string }) => void): boolean {
        if (refs.authGeneration.current !== captured) return false;
        applyUser({ id: 'late-refresh-user' });
        return true;
      },
    };
  };

  it('在途 refresh 迟到返回成功、期间进入无账号态 → 结果被丢弃,不写 user', () => {
    const refs = {
      authGeneration: { current: 3 },
      refreshInFlight: { current: Promise.resolve('stale-token') as Promise<string | null> | null },
    };
    const inFlight = makeLateAuthResult(refs);
    const applyUser = vi.fn();

    // 用户点「跳过登录」:enterLocalMode 同步 bump(await 落盘之前)
    const next = invalidateInFlightAuth(refs);
    expect(next).toBe(4);
    // 落盘还在队列里的同时,迟到的 refresh 成功返回
    expect(inFlight.settle(applyUser)).toBe(false);
    expect(applyUser).not.toHaveBeenCalled();
    // 共享 in-flight promise 一并丢弃(否则下个调用方拿到注定返回 null 的旧 promise)
    expect(refs.refreshInFlight.current).toBeNull();
  });

  it('进入无账号态之后开始的登录不被误杀(先跳过、再主动登录仍成功)', () => {
    const refs = {
      authGeneration: { current: 0 },
      refreshInFlight: { current: null as Promise<string | null> | null },
    };
    invalidateInFlightAuth(refs);
    // 主动登录:acceptOutcome 在自己开始时才捕获 generation(拿到 bump 后的新值)
    const login = makeLateAuthResult(refs);
    const applyUser = vi.fn();
    expect(login.settle(applyUser)).toBe(true);
    expect(applyUser).toHaveBeenCalledTimes(1);
  });

  it('连续两次作废各自递增,后发者胜(跳过后立刻登出/再跳过都不会互相复活)', () => {
    const refs = {
      authGeneration: { current: 7 },
      refreshInFlight: { current: null as Promise<string | null> | null },
    };
    const first = makeLateAuthResult(refs);
    expect(invalidateInFlightAuth(refs)).toBe(8);
    const second = makeLateAuthResult(refs);
    expect(invalidateInFlightAuth(refs)).toBe(9);
    expect(first.settle(vi.fn())).toBe(false);
    expect(second.settle(vi.fn())).toBe(false);
  });

  it('enterLocalMode 在 await 之前调用 invalidateInFlightAuth(接线 + 时序)', () => {
    const start = authSource.indexOf('const enterLocalMode = useCallback');
    const body = authSource.slice(start, authSource.indexOf('const clearLocalSession = useCallback', start));
    expect(body).toContain('invalidateInFlightAuth({');
    expect(body).toContain('authGeneration: authGenerationRef');
    expect(body).toContain('refreshInFlight: refreshInFlightRef');
    // 时序:bump 必须先于落盘 await,否则落盘那段窗口里迟到结果照样能落地
    expect(body.indexOf('invalidateInFlightAuth(')).toBeLessThan(
      body.indexOf('await applyLocalMode(true)'),
    );
  });

  it('OAuth 回调形态(请求前捕获、落地前复核)同样被作废', () => {
    // acceptOutcome 自己 ++generation、只跟自己比,必然相等 —— 所以「跳过」能否作废
    // 一次在飞的 OAuth 回调,取决于调用方是否在**发起 code 兑换之前**捕获 generation
    // 并交给 acceptOutcome 复核。这里按该契约建模:捕获 → 作废 → 落地必须被拒。
    const refs = {
      authGeneration: { current: 12 },
      refreshInFlight: { current: null as Promise<string | null> | null },
    };
    const captured = refs.authGeneration.current; // completeOAuthCallback 第一个 await 之前
    invalidateInFlightAuth(refs); // 用户点「跳过登录」
    const superseded = refs.authGeneration.current !== captured; // acceptOutcome 入口复核
    expect(superseded).toBe(true);
  });

  it('acceptOutcome 接受调用方捕获的 generation 并在入口复核(接线)', () => {
    const start = authSource.indexOf('const acceptOutcome = useCallback');
    expect(start).toBeGreaterThan(0);
    const head = authSource.slice(start, authSource.indexOf('await deleteSecureItem(PENDING_OAUTH_KEY)', start));
    expect(head).toContain('expectedGeneration?: number');
    // 复核在入口(早于任何写入 / 早于自己 ++generation),不等即整条丢弃
    expect(head).toMatch(
      /expectedGeneration !== undefined &&\s*authGenerationRef\.current !== expectedGeneration/,
    );
    expect(head).toContain("throw authCodeError('AUTH_FLOW_SUPERSEDED')");
  });

  it('completeOAuthCallback 在第一个 await 之前捕获 generation 并传给 acceptOutcome', () => {
    const start = authSource.indexOf('const completeOAuthCallback = useCallback');
    expect(start).toBeGreaterThan(0);
    const body = authSource.slice(start, authSource.indexOf('browserCompletionRef.current = run;', start));
    const captureAt = body.indexOf('const expectedGeneration = authGenerationRef.current;');
    expect(captureAt).toBeGreaterThan(0);
    // 时序:捕获必须早于本函数第一个 await 语句(否则捕到的是竞态之后的值,复核形同虚设)。
    // 只认语句级 await(行首;可带 `const x = ` 前缀),不被注释里的 "await" 字样干扰。
    const firstAwait = body.search(/\n\s+(?:const\s+\w+\s*=\s*)?await\s/);
    expect(firstAwait).toBeGreaterThan(0);
    expect(captureAt).toBeLessThan(firstAwait);
    expect(body).toContain(
      'await acceptOutcome(outcome, pending.deviceId, expectedGeneration)',
    );
  });

  it('enterLocalMode 同步清掉存量 refresh token(P1-B 方案 A:接线 + 时序)', () => {
    const start = authSource.indexOf('const enterLocalMode = useCallback');
    const body = authSource.slice(
      start,
      authSource.indexOf('const clearLocalSession = useCallback', start),
    );
    // 删除走 refresh token 的写队列:保证排在任何已入队的写入之后生效
    expect(body).toContain('serializeRefreshTokenMutation(() =>');
    expect(body).toContain('deleteSecureItem(REFRESH_TOKEN_KEY)');
    expect(body).toContain('serializeRefreshTokenMutation');
    // 时序:先作废在途结果(同步)→ 再删凭证 → 最后置标记落盘
    const bumpAt = body.indexOf('invalidateInFlightAuth(');
    const deleteAt = body.indexOf('deleteSecureItem(REFRESH_TOKEN_KEY)');
    const markAt = body.indexOf('await applyLocalMode(true)');
    expect(bumpAt).toBeGreaterThan(-1);
    expect(bumpAt).toBeLessThan(deleteAt);
    expect(deleteAt).toBeLessThan(markAt);
  });

  it('清了凭证的下次冷启动:留在无账号态,且缓存 profile 不会把用户拉回登录态', () => {
    // 建模 initialize 的两道守卫(下面同步用源码断言锁住它们仍是这个形状):
    // ① 降级恢复要求「token 与快照同时存在」;② 无 token 时快照被顺手删掉。
    const coldStart = (storedRefreshToken: string | null, cachedUser: { id: string } | null) => {
      const restoredUser = storedRefreshToken && cachedUser ? cachedUser : null;
      // refresh():读不到 token 直接 return null,不进 catch、不触发 terminateSession
      const refreshRejected = storedRefreshToken !== null;
      return {
        restoredUser,
        // clearLocalSession 只由「refresh 被拒」路径触发,它才会清 localMode
        localModeCleared: refreshRejected,
        profileSnapshotDeleted: storedRefreshToken === null,
      };
    };

    // 方案 A 之后:token 已删,即便 profile 快照还在也不恢复登录态、不清无账号标记
    const after = coldStart(null, { id: 'stale-cached-user' });
    expect(after.restoredUser).toBeNull();
    expect(after.localModeCleared).toBe(false);
    expect(after.profileSnapshotDeleted).toBe(true);
    // 方案 A 之前的怪状(留着已失效 token):refresh 401 → terminateSession → 标记被清
    expect(coldStart('stale-token', null).localModeCleared).toBe(true);

    // 上述两道守卫的真实形状(改了这两行,上面的建模就失效,必须一起改)
    expect(authSource).toContain('if (storedRefreshToken && cachedUser) {');
    expect(authSource).toMatch(
      /if \(!storedRefreshToken\)\s*await deleteSecureItem\(USER_PROFILE_KEY\)/,
    );
  });

  it('clearLocalSession 仍走同一机制(登出 / 会话终止回归,不散写 ++generation)', () => {
    const start = authSource.indexOf('const clearLocalSession = useCallback');
    const body = authSource.slice(start, authSource.indexOf('}, [\n    applyLocalMode,', start));
    expect(body).toContain('invalidateInFlightAuth({');
    // 登出仍是完整清理:清 token/user、删凭证、退无账号态(与 enterLocalMode 的差别只在
    // 后者不 setToken(null)/applyUser(null)、也不清 localMode —— 它就是要置上 localMode)
    expect(body).toContain('setToken(null);');
    expect(body).toContain('applyUser(null);');
    expect(body).toContain('applyLocalMode(false)');
    expect(body).toContain('deleteSecureItem(REFRESH_TOKEN_KEY)');
    // 全文件不再有裸 ++/+= 1 的 generation 写法(唯一例外:acceptOutcome 自己开新会话)
    expect(authSource).not.toContain('authGenerationRef.current += 1');
    expect(authSource.split('const generation = ++authGenerationRef.current').length - 1).toBe(1);
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
  it('登录提交在飞或未 initialized → 禁用;两者都就绪 → 放行', () => {
    expect(
      isSkipLoginDisabled({ loginSubmissionInFlight: true, initialized: true }),
    ).toBe(true);
    expect(
      isSkipLoginDisabled({ loginSubmissionInFlight: false, initialized: false }),
    ).toBe(true);
    expect(
      isSkipLoginDisabled({ loginSubmissionInFlight: true, initialized: false }),
    ).toBe(true);
    expect(
      isSkipLoginDisabled({ loginSubmissionInFlight: false, initialized: true }),
    ).toBe(false);
  });

  it('登录提交在飞时点击 enterLocalMode 调用 0 次,idle 时 1 次', () => {
    const enterLocalMode = vi.fn(async () => undefined);

    expect(
      requestSkipLogin({
        loginSubmissionInFlight: true,
        initialized: true,
        enterLocalMode,
      }),
    ).toBe(false);
    expect(
      requestSkipLogin({
        loginSubmissionInFlight: false,
        initialized: false,
        enterLocalMode,
      }),
    ).toBe(false);
    expect(enterLocalMode).toHaveBeenCalledTimes(0);

    expect(
      requestSkipLogin({
        loginSubmissionInFlight: false,
        initialized: true,
        enterLocalMode,
      }),
    ).toBe(true);
    expect(enterLocalMode).toHaveBeenCalledTimes(1);
  });

  /**
   * provider bootstrap 不该锁死逃生入口(2026-07-28 review P2)。
   *
   * 冷启动 dispatch({reset}) → getProviders() 期间 isBusy=true 而 loginState 仍为 null;
   * 它永不产出身份,离线 / 认证服务挂住时把入口锁死与「门刻意不看 configIssues」的
   * 理由自相矛盾。调用方按「isBusy ∧ loginState 非空」推导,门只吃推导结果。
   */
  it('provider bootstrap 期间(isBusy 但无 loginState)门放行,真实提交期间仍禁用', () => {
    const derive = (isBusy: boolean, loginState: { step: string } | null) => ({
      loginSubmissionInFlight: isBusy && loginState !== null,
      initialized: true,
    });
    const enterLocalMode = vi.fn(async () => undefined);

    // bootstrap:isBusy=true + loginState=null → 可点,派发 1 次
    expect(isSkipLoginDisabled(derive(true, null))).toBe(false);
    expect(requestSkipLogin({ ...derive(true, null), enterLocalMode })).toBe(true);
    expect(enterLocalMode).toHaveBeenCalledTimes(1);

    // 真实登录提交(identifier 上发码等):isBusy=true + loginState 非空 → 仍禁用(回归)
    expect(isSkipLoginDisabled(derive(true, { step: 'identifier' }))).toBe(true);
    expect(
      requestSkipLogin({ ...derive(true, { step: 'verification-code' }), enterLocalMode }),
    ).toBe(false);
    expect(enterLocalMode).toHaveBeenCalledTimes(1);
  });

  it('login.tsx 按「isBusy ∧ 有 loginState」推导,不把 bootstrap 算进门(接线)', () => {
    expect(loginSource).toContain(
      'const loginSubmissionInFlight = auth.isBusy && auth.loginState !== null;',
    );
    const start = loginSource.indexOf('const skipDisabled = isSkipLoginDisabled({');
    const decl = loginSource.slice(start, loginSource.indexOf('});', start));
    expect(decl).toContain('loginSubmissionInFlight');
    // 门只吃推导结果,不再直接读 auth.isBusy(否则 bootstrap 又被算进来)
    expect(decl).not.toContain('auth.isBusy');
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
      requestSkipLogin({
        loginSubmissionInFlight: false,
        initialized: true,
        enterLocalMode,
      }),
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
    // 全文件恰好三处:identifier + config + noLoginState 兜底屏,别处不再散落
    expect(loginSource.split('<LoginSkipLoginLink').length - 1).toBe(3);
  });
});

/**
 * 兜底屏(loginState 为 null 且已 initialized)同样承载入口(2026-07-28 review P2)。
 *
 * 冷启动 provider bootstrap 在飞 / 刚失败时用户看到的正是这一屏,而它一度整屏没渲染
 * 跳过入口——「配置坏 / 网络坏时留逃生入口」的承诺在最常见的坏环境下落空。
 */
describe('无 loginState 兜底屏同样承载跳过入口', () => {
  it('noLoginState 面板内挂同一个 LoginSkipLoginLink(同组件 / 同 handler / 同门)', () => {
    const panelStart = loginSource.indexOf(
      '<LoginPanel testID="login.panel.noLoginState">',
    );
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
    expect(jsx).toContain('disabled={skipDisabled}');
    expect(jsx).toContain('onPress={skipLogin}');
    expect(jsx).toContain("label={loginText('skipLogin')}");
  });

  it('该屏的门确实放行:bootstrap 在飞(无 loginState)也可点', () => {
    const enterLocalMode = vi.fn(async () => undefined);
    expect(
      requestSkipLogin({
        // 该屏渲染条件 = loginState 为 null → 推导出的提交态必然为 false
        loginSubmissionInFlight: false,
        initialized: true,
        enterLocalMode,
      }),
    ).toBe(true);
    expect(enterLocalMode).toHaveBeenCalledTimes(1);
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
