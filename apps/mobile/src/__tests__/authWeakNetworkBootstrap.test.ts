import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 弱网冷启动不许误踢登录页(回归锚点):
 * refresh() 的瞬时失败(网络/5xx)与 401(凭证真失效)必须区别对待——
 * 历史 bug 是 bootstrap 用 .catch(() => null) 把两者一起坍缩成"未登录",
 * 弱网冷启动直接把持有效 refresh token 的用户踢回登录页。
 */
describe('auth weak-network bootstrap', () => {
  const authSource = readFileSync(
    resolve(process.cwd(), 'src/auth/AuthContext.tsx'),
    'utf8',
  );

  it('bootstrap 只在会话 realm 端点激活后用本地痕迹恢复登录视图', () => {
    // 快照恢复必须双条件:refresh token 还在 + 有缓存资料;二者缺一不得凭空造登录态。
    expect(authSource).toContain('if (storedSession && cachedUser) {');
    expect(authSource).toContain('userRef.current = cachedUser;');
    expect(authSource).toContain('setUser(cachedUser);');
    const restoreStart = authSource.indexOf(
      'if (storedSession && cachedUser) {',
    );
    const restoreEnd = authSource.indexOf(
      '\n        if (!storedSession)',
      restoreStart,
    );
    const restoreBody = authSource.slice(restoreStart, restoreEnd);
    const loadRealmAt = restoreBody.indexOf(
      'await loadMobileEndpointsForRealm(storedSession.realm);',
    );
    const activateRealmAt = restoreBody.indexOf(
      'activateMobileSessionRealm(storedSession.realm);',
    );
    const publishUserAt = restoreBody.indexOf('setUser(cachedUser);');
    const publishOwnerAt = restoreBody.indexOf('setMobileAuthOwner(cachedUser.id);');
    expect(loadRealmAt).toBeGreaterThanOrEqual(0);
    expect(activateRealmAt).toBeGreaterThan(loadRealmAt);
    expect(publishOwnerAt).toBeGreaterThan(activateRealmAt);
    expect(publishUserAt).toBeGreaterThan(publishOwnerAt);
    expect(restoreBody).toContain('setDeferredSessionRecovery(true);');
    // bootstrap 里的 refresh 失败必须是"保留降级会话",不许再出现坍缩式 .catch(() => null)。
    expect(authSource).not.toContain('await refresh(did).catch(() => null)');
    expect(authSource).toMatch(
      /await awaitAuthStartupGate\(\s*refresh\(did\),\s*AUTH_STARTUP_GATE_TIMEOUT_MS,?\s*\)/,
    );
    expect(authSource).toContain(
      'without aborting a rotating refresh-token request',
    );
  });

  it('publishes the auth-owner generation before every user snapshot change', () => {
    const applyUserStart = authSource.indexOf('const applyUser = useCallback');
    const applyUserEnd = authSource.indexOf('\n  );', applyUserStart);
    const applyUserBody = authSource.slice(applyUserStart, applyUserEnd);
    expect(applyUserBody.indexOf('setMobileAuthOwner(next?.id);'))
      .toBeLessThan(applyUserBody.indexOf('setUser(next);'));

    const initializeFailure = authSource.indexOf(
      "console.warn('[auth] initialize failed; normalized to signed-out'",
    );
    const failureOwner = authSource.indexOf('setMobileAuthOwner(null);', initializeFailure);
    const failureUser = authSource.indexOf('setUser(null);', initializeFailure);
    expect(failureOwner).toBeGreaterThan(initializeFailure);
    expect(failureUser).toBeGreaterThan(failureOwner);
  });

  it('isAuthenticated 以 user 为准,token 未刷到时不闪回登录页', () => {
    expect(authSource).toContain('isAuthenticated: user !== null');
    expect(authSource).not.toContain(
      'isAuthenticated: accessToken !== null && user !== null',
    );
  });

  it('已发布或因 realm 清单失败而延迟的降级会话都会自愈', () => {
    expect(authSource).toMatch(
      /const hasRecoverableSession\s*=\s*user !== null \|\| deferredSessionRecovery;/,
    );
    expect(authSource).toMatch(
      /if \(\s*!initialized \|\|\s*accessToken \|\|\s*!hasRecoverableSession \|\|\s*sessionRecoverySuspendedRef\.current\s*\)\s*return;/,
    );
    expect(authSource).toContain(
      'const delay = Math.min(5_000 * 2 ** attempt, 60_000);',
    );
  });

  it('用户开始新登录后立即停止旧会话自愈，迟到 refresh 也不能抢回界面', () => {
    expect(authSource).toContain(
      'const sessionRecoverySuspendedRef = useRef(false);',
    );
    expect(authSource).toContain('authGenerationRef.current += 1;');
    const dispatchStart = authSource.indexOf(
      'const dispatchLoginAction = useCallback',
    );
    const dispatchBody = authSource.slice(
      dispatchStart,
      authSource.indexOf(
        'const clearLocalSession = useCallback',
        dispatchStart,
      ),
    );
    expect(dispatchBody).toMatch(
      /action: MobileLoginAction[\s\S]*suspendSessionRecoveryForLogin\(\);[\s\S]*loginActionInFlightRef/,
    );
    const healStart = authSource.indexOf('// 降级会话自愈');
    const healBody = authSource.slice(
      healStart,
      authSource.indexOf('// 存量同意迁移', healStart),
    );
    expect(healBody).toContain('sessionRecoverySuspendedRef.current');
    expect(healBody).toContain(
      'if (cancelled || sessionRecoverySuspendedRef.current) return;',
    );
  });

  it('旧 refresh 的 realm 清单迟到时，必须先检查 generation 再激活区域', () => {
    const refreshStart = authSource.indexOf('const refresh = useCallback');
    const refreshBody = authSource.slice(
      refreshStart,
      authSource.indexOf('\n  useEffect(() => {', refreshStart),
    );
    const readSessionAt = refreshBody.indexOf(
      'const session = await serializeRefreshTokenMutation(',
    );
    const emptySessionAt = refreshBody.indexOf('if (!session) {');
    const loadRealmAt = refreshBody.indexOf(
      'await loadMobileEndpointsForRealm(session.realm);',
    );
    const activateRealmAt = refreshBody.indexOf(
      'activateMobileSessionRealm(session.realm);',
    );
    const guards = [
      ...refreshBody.matchAll(
        /if \(authGenerationRef\.current !== generation\) return null;/g,
      ),
    ].map((match) => match.index);

    expect(readSessionAt).toBeGreaterThanOrEqual(0);
    expect(
      guards.some((index) => index > readSessionAt && index < emptySessionAt),
    ).toBe(true);
    expect(loadRealmAt).toBeGreaterThan(emptySessionAt);
    expect(
      guards.some((index) => index > loadRealmAt && index < activateRealmAt),
    ).toBe(true);
  });

  it('换账号或区域时先用旧会话撤销旧区域推送，再激活新区域', () => {
    const acceptStart = authSource.indexOf('const acceptOutcome = useCallback');
    const acceptBody = authSource.slice(
      acceptStart,
      authSource.indexOf('const refresh = useCallback', acceptStart),
    );
    const revokeAt = acceptBody.indexOf('await unregisterPushTokenBestEffort(');
    const activateAt = acceptBody.indexOf(
      'activateMobileSessionRealm(committedRealm);',
    );
    expect(acceptBody).toContain(
      'const previousRealm = activeAuthRealmRef.current;',
    );
    expect(acceptBody).toMatch(
      /unregisterPushTokenBestEffort\(\s*previousAccessToken,\s*previousRealm,?\s*\)/,
    );
    expect(revokeAt).toBeGreaterThanOrEqual(0);
    expect(activateAt).toBeGreaterThan(revokeAt);
  });

  it('自愈路径处理 refresh 无异常返回 null:凭证确不在才登出,读取异常只退避(不静默卡死、不误登出)', () => {
    // review P1 两连:refresh() 返回 null 不抛错时若不处理,降级态永远卡死;
    // 而二次读取 getSecureItem 的**异常**不能与「读到空值」折叠——异常时无从
    // 判定凭证是否存在,只能继续退避,绝不能据此 applyUser(null) 误登出。
    const healStart = authSource.indexOf('// 降级会话自愈');
    const healBody = authSource.slice(
      healStart,
      authSource.indexOf('}, [accessToken, applyUser', healStart),
    );
    expect(healBody).toContain(
      'storedSession = await readPersistedAuthSession();',
    );
    // 读取异常分支:只 scheduleNext,不 applyUser(null)
    const catchStart = healBody.indexOf(
      '} catch {',
      healBody.indexOf('storedSession = await'),
    );
    const catchBody = healBody.slice(
      catchStart,
      healBody.indexOf('}', catchStart + 10) + 1,
    );
    expect(catchBody).toContain('scheduleNext();');
    expect(catchBody).not.toContain('applyUser(null)');
    // 成功读到空值才登出收敛
    expect(healBody).toContain('if (!storedSession) {');
    expect(healBody).toContain('applyUser(null);');
  });

  it('登出与凭证失效仍会清掉用户资料快照(applyUser(null))', () => {
    // refresh 401 路径与 logout 都必须走 applyUser(null),连带清持久化快照,
    // 否则下次冷启动会用快照复活已失效的会话。
    const occurrences = authSource.split('applyUser(null)').length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(2);
    expect(authSource).toMatch(
      /const USER_PROFILE_KEY = ["']cindy\.mobile\.auth\.userProfile["'];/,
    );
    expect(authSource).toMatch(/error\.code === ["']MEMBERSHIP_DISABLED["']/);
    expect(authSource).toContain('updateLoginState(null);');
  });

  it('初始化会清理所有旧飞书登录痕迹,不复活旧账号资料', () => {
    const bootstrapStart = authSource.indexOf('useEffect(() => {');
    const bootstrapEnd = authSource.indexOf('// 降级会话自愈', bootstrapStart);
    const bootstrap = authSource.slice(bootstrapStart, bootstrapEnd);
    expect(bootstrap).toContain('deleteSecureItem(LEGACY_REFRESH_TOKEN_KEY)');
    expect(bootstrap).toContain('deleteSecureItem(LEGACY_PENDING_OAUTH_KEY)');
    expect(bootstrap).toContain('deleteSecureItem(LEGACY_USER_PROFILE_KEY)');
  });
});
