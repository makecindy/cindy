import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  __testing as dataOwnerTesting,
  isDataOwnerPushCurrent,
  setDataOwnerGeneration,
} from '@/contexts/dataOwnerGeneration';

/**
 * Guards renderer auth state transitions. 产品 role 二段式水合已随 /api/me
 * 退役(2026-07):身份即 auth-server membership,不再有"迟到 role 响应"竞态,
 * 这里守住剩余的账号边界语义(切号清会话快照、迟到 initialize 丢弃)。
 */
describe('AuthContext auth-state races', () => {
  const source = readFileSync(
    resolve(process.cwd(), 'src/renderer/contexts/AuthContext.tsx'),
    'utf8',
  );
  const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/App.tsx'), 'utf8');

  it('applies identity synchronously and resets session snapshot on account switch', () => {
    expect(source).toContain('activeDataOwnerIdRef.current !== state.dataOwnerId');
    expect(source).toContain('sessionsStore.reset();');
    expect(source).toContain('setUser(incoming);');
    // 防复活:renderer 不得再对业务 server 发起 role/资料水合请求。
    expect(source).not.toContain('meService');
    expect(source).not.toContain('apiRequest<');
    expect(source).not.toContain('getMe(');
  });

  it('repartitions every owner-scoped renderer store at the same boundary', () => {
    // 统一模型选择器新增的两根轴(引擎 override / 收藏副本)与 newMakerDraft 同待遇:
    // 同一处、同一个 state.dataOwnerId(登出快照里就是 null)。漏接任一个 = 多账号串号 ——
    // 这正是 providerModelMemory 不分账号踩过的坑,不能在新 store 上重演。
    const applyStart = source.indexOf('const applyIncomingState = useCallback');
    expect(applyStart).toBeGreaterThan(-1);
    const applyBlock = source.slice(applyStart, source.indexOf('[applyIncomingUser]', applyStart));
    for (const call of [
      'setNewMakerDraftOwner(state.dataOwnerId);',
      'setModelEnginePrefsOwner(state.dataOwnerId);',
      'setModelFavoritesOwner(state.dataOwnerId);',
    ]) {
      expect(applyBlock).toContain(call);
    }
  });

  it('applies the complete owner transition on local-mode boundaries', () => {
    // 本地模式进出同样是一次 dataOwnerId 切换。自己拼半套 setter 会漏草稿 /
    // prompt / 模型可见性 / 记忆分区(2026-08-21 #3201 Codex P1)。行为断言在
    // authContextSessionBoundary.test.tsx。
    for (const entry of ['const enterLocalMode = useCallback', 'const exitLocalMode = useCallback']) {
      const start = source.indexOf(entry);
      expect(start).toBeGreaterThan(-1);
      const block = source.slice(start, source.indexOf('[applyIncomingState, runDataOwnerBoundary]', start));
      expect(block).toContain('applyIncomingState(state);');
      expect(block).not.toContain('setModelEnginePrefsOwner(state.dataOwnerId);');
    }
  });

  it('ignores initialize results after a newer pushed auth event', () => {
    expect(source).toContain('authStateVersionRef.current += 1;');
    expect(source).toContain('authStateVersionRef.current !== initializeVersion');
  });

  it('clears login progress at auth boundaries', () => {
    expect(source).toContain('setLoginState(null);');
    expect(source).toContain('clearWorkersCache();');
  });

  it('publishes a data-owner generation at every auth boundary', () => {
    expect(source).toContain('cancelRemoteOptimisticSendsForDataOwnerBoundary();');
    expect(source).toContain('setDataOwnerGeneration(dataOwnerId, ownerGeneration);');
    expect(source).toContain('invalidateProvidersSnapshot();');
    expect(source).toContain(
      'publishDataOwnerGeneration(state.dataOwnerId, state.ownerGeneration);',
    );
    expect(source).toContain(
      '// Invalidate in-flight remote sends before the confirmation dialog resolves.',
    );
    expect(source.match(/publishDataOwnerGeneration\(null\);/g)?.length).toBeGreaterThanOrEqual(2);
    expect(source.indexOf('cancelRemoteOptimisticSendsForDataOwnerBoundary();')).toBeLessThan(
      source.indexOf('setDataOwnerGeneration(dataOwnerId, ownerGeneration);'),
    );
    const enterLocal = source.indexOf('const enterLocalMode = useCallback');
    const exitLocal = source.indexOf('const exitLocalMode = useCallback');
    expect(source.indexOf('applyIncomingState(state);', enterLocal)).toBeLessThan(exitLocal);
    expect(source.indexOf('applyIncomingState(state);', exitLocal)).toBeGreaterThan(exitLocal);
    expect(source).toContain('activeDataOwnerGenerationRef.current');
    expect(source).toContain('setDataOwnerRecoveryEpoch((epoch) => epoch + 1);');
    expect(appSource).toContain("`${dataOwnerId ?? 'signed-out'}:${dataOwnerRecoveryEpoch}`");
    expect(appSource).toContain('<RouterProvider key={ownerKey} router={router} />');
  });

  it('projects browser waiting state before the main-process loopback request settles', () => {
    expect(source).toContain("if (action.type === 'start-browser')");
    expect(source).toContain("setLoginState({ step: 'browser-redirect', label: action.label });");
  });

  it('auto-continues a sole method-choice so fake pickers never paint', () => {
    expect(source).toContain('soleLoginMethod(result.state.methods)');
    expect(source).toContain("type: 'start-browser'");
    expect(source).toContain('providerOrConnectionId: sole.connectionId');
    expect(source).toContain("type: 'request-code'");
    expect(source).toContain("kind: 'email'");
    expect(source).toContain('identifier: result.state.email');
    const projectWaiting = source.indexOf(
      "setLoginState({ step: 'browser-redirect', label: action.label });",
    );
    const autoStart = source.indexOf('soleLoginMethod(result.state.methods)');
    expect(projectWaiting).toBeGreaterThan(-1);
    expect(autoStart).toBeGreaterThan(projectWaiting);
  });

  it('gates the sole-email auto request-code behind the login captcha gate', () => {
    // 唯一邮箱自动发码链不经过 LoginPage 的 dispatchRequestCode 闸;这里必须
    // 先问 loginCaptchaGate(global 开启 captcha 后,不过闸会不带 token 发码
    // 直接吃 400),取消(null)则停在 method-choice 不发码。
    expect(source).toContain("from '@/lib/loginCaptchaGate'");
    const gateAt = source.indexOf('getLoginEmailCaptchaGate()');
    const autoRequestAt = source.indexOf("type: 'request-code'");
    expect(gateAt).toBeGreaterThan(-1);
    expect(gateAt).toBeLessThan(autoRequestAt);
    expect(source).toContain('if (captchaToken === null)');
    expect(source).toContain('captchaToken,');
  });
});

describe('data-owner live push fencing', () => {
  afterEach(() => {
    dataOwnerTesting.reset();
  });

  it('accepts legacy unstamped pushes and the exact current owner stamp', () => {
    setDataOwnerGeneration('owner-a', 4);

    expect(isDataOwnerPushCurrent(undefined)).toBe(true);
    expect(
      isDataOwnerPushCurrent({ dataOwnerId: 'owner-a', ownerGeneration: 4 }),
    ).toBe(true);
  });

  it('rejects stale, cross-owner, and malformed stamped pushes', () => {
    setDataOwnerGeneration('owner-b', 7);

    expect(
      isDataOwnerPushCurrent({ dataOwnerId: 'owner-b', ownerGeneration: 6 }),
    ).toBe(false);
    expect(
      isDataOwnerPushCurrent({ dataOwnerId: 'owner-a', ownerGeneration: 7 }),
    ).toBe(false);
    expect(isDataOwnerPushCurrent(null)).toBe(false);
  });
});
