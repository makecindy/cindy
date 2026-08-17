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
    expect(
      source.indexOf(
        'publishDataOwnerGeneration(state.dataOwnerId, state.ownerGeneration);',
        enterLocal,
      ),
    ).toBeLessThan(exitLocal);
    expect(
      source.indexOf(
        'publishDataOwnerGeneration(state.dataOwnerId, state.ownerGeneration);',
        exitLocal,
      ),
    ).toBeGreaterThan(exitLocal);
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
