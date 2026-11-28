import { describe, it, expect, vi } from 'vitest';

import {
  createContextClearSessionClose,
  handleCloseSessionRequest,
  parseCloseSessionOptions,
  type CloseSessionRequestDeps,
} from '../closeSessionRequest';

function makeDeps() {
  const order: string[] = [];
  const deps: CloseSessionRequestDeps = {
    closeSession: vi.fn(async () => {
      order.push('close');
    }),
    withRehydrateCloseSuppressed: vi.fn(async (_sessionId, fn) => {
      order.push('suppress-enter');
      const result = await fn();
      order.push('suppress-exit');
      return result;
    }),
    cleanupPendingInteractions: vi.fn(() => {
      order.push('cleanup-interactions');
    }),
  };
  return { deps, order };
}

describe('parseCloseSessionOptions', () => {
  it('only accepts preserveWorkspace === true', () => {
    expect(parseCloseSessionOptions({ preserveWorkspace: true })).toEqual({ preserveWorkspace: true });
    // IPC 边界形状不可信:truthy 非 true 一律不算
    expect(parseCloseSessionOptions({ preserveWorkspace: 1 }).preserveWorkspace).toBe(false);
    expect(parseCloseSessionOptions({ preserveWorkspace: 'true' }).preserveWorkspace).toBe(false);
    expect(parseCloseSessionOptions(undefined).preserveWorkspace).toBeUndefined();
    expect(parseCloseSessionOptions(null).preserveWorkspace).toBeUndefined();
    expect(parseCloseSessionOptions('junk').preserveWorkspace).toBeUndefined();
  });
});

describe('handleCloseSessionRequest', () => {
  it('plain close: no suppression, cleanup runs after close', async () => {
    const { deps, order } = makeDeps();

    await handleCloseSessionRequest(deps, 's1', undefined);

    expect(deps.closeSession).toHaveBeenCalledWith('s1');
    expect(deps.withRehydrateCloseSuppressed).not.toHaveBeenCalled();
    expect(order).toEqual(['close', 'cleanup-interactions']);
  });

  it('preserveWorkspace: close runs inside the suppression window', async () => {
    const { deps, order } = makeDeps();

    await handleCloseSessionRequest(deps, 's1', { preserveWorkspace: true });

    expect(deps.withRehydrateCloseSuppressed).toHaveBeenCalledWith('s1', expect.any(Function));
    // close 必须发生在抑制窗口内,否则 onClose 副作用照跑
    expect(order).toEqual(['suppress-enter', 'close', 'suppress-exit', 'cleanup-interactions']);
  });

  it('malformed opts fall back to plain close', async () => {
    const { deps } = makeDeps();

    await handleCloseSessionRequest(deps, 's1', { preserveWorkspace: 'yes' });

    expect(deps.withRehydrateCloseSuppressed).not.toHaveBeenCalled();
    expect(deps.closeSession).toHaveBeenCalledWith('s1');
  });

  it('close failure propagates and skips interaction cleanup', async () => {
    const { deps } = makeDeps();
    (deps.closeSession as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'));

    await expect(handleCloseSessionRequest(deps, 's1', undefined)).rejects.toThrow('boom');
    expect(deps.cleanupPendingInteractions).not.toHaveBeenCalled();
  });
});


// #12516: exercise the request handlers shared by the two production IPCs.
// Session.close unit coverage alone cannot catch a stale clear taking down a newer runtime.
// The minimal input is one captured clear and one soft-close request with a changed owner or timestamp.
describe('local Pi context clear and close', () => {
  const sessionId = 's1';
  const timestamp = '2026-11-24T09:00:00.000Z';
  const clearOptions = { preserveWorkspace: true, contextClearedAt: timestamp };

  function setup() {
    const { deps, order } = makeDeps();
    let generation = 1;
    let live = {
      instanceId: 'first',
      agentKind: 'pi',
      captureContextClearTurn() {
        const captured = generation;
        return {
          confirmCancellation: () => {},
          resolveGeneration: () => captured === generation ? generation : null,
        };
      },
    };
    const original = live;
    const closeSessionIfCurrent = vi.fn(async () => { order.push('clear-close'); });
    const handlers = createContextClearSessionClose({
      ...deps,
      getSession: () => live,
      closeSessionIfCurrent,
    });
    const sender = {};
    handlers.noteClear(sender, sessionId, timestamp, false);
    return {
      deps, order, original, handlers, closeSessionIfCurrent, sender,
      replaceRuntime: () => { live = { ...live, instanceId: 'replacement' }; },
      advanceTurn: () => { generation++; },
    };
  }

  it('closes the captured runtime and turn inside the workspace suppression window', async () => {
    const test = setup();
    await test.handlers.close(test.sender, sessionId, clearOptions, false);

    expect(test.closeSessionIfCurrent).toHaveBeenCalledExactlyOnceWith(test.original, 1);
    expect(test.deps.closeSession).not.toHaveBeenCalled();
    expect(test.order).toEqual(['suppress-enter', 'clear-close', 'suppress-exit', 'cleanup-interactions']);
  });

  it.each(['timestamp', 'runtime replacement', 'turn advance'] as const)(
    'leaves the runtime and its interactions alone after a mismatch in %s',
    async (mismatch) => {
      const test = setup();
      if (mismatch === 'runtime replacement') test.replaceRuntime();
      if (mismatch === 'turn advance') test.advanceTurn();
      const options = mismatch === 'timestamp'
        ? { ...clearOptions, contextClearedAt: '2026-11-24T08:59:59.000Z' }
        : clearOptions;

      await test.handlers.close(test.sender, sessionId, options, false);
      expect(test.order).toEqual([]);

      if (mismatch === 'timestamp') {
        await test.handlers.close(test.sender, sessionId, clearOptions, false);
        expect(test.closeSessionIfCurrent).toHaveBeenCalledExactlyOnceWith(test.original, 1);
      }
    },
  );

  it.each([
    ['ordinary soft close', { preserveWorkspace: true }, false],
    ['different local window', clearOptions, false],
    ['device-link close', clearOptions, true],
  ] as const)('keeps %s on the existing close path', async (kind, options, remote) => {
    const test = setup();
    const sender = kind === 'different local window' ? {} : test.sender;
    await test.handlers.close(sender, sessionId, options, remote);

    expect(test.closeSessionIfCurrent).not.toHaveBeenCalled();
    expect(test.deps.closeSession).toHaveBeenCalledExactlyOnceWith(sessionId);
    expect(test.order).toEqual(['suppress-enter', 'close', 'suppress-exit', 'cleanup-interactions']);
  });
});
