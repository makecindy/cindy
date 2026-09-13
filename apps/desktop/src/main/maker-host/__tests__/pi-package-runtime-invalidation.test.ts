import { bindRuntimeRecoveryNotice, advanceRuntimeRecoveryNotice } from '../../im/shared/runtimeRecoveryNotice.js';
import { readFileSync } from 'node:fs';
import { ScriptTarget, transpileModule } from 'typescript';
import { Session, type Maker, type AgentEvent, type AgentSessionHandle } from '@cindy/maker-core';
import { describe, expect, it, vi } from 'vitest';

import {
  captureLocalPiPackageRuntimeInvalidationSnapshot,
  invalidateLocalPiPackageRuntimeSnapshot,
  invalidateLocalPiPackageRuntimes,
  invalidateLocalPiPackageRuntimesForObservedChange,
  settleLocalPiPackageRuntimeSnapshot,
} from '../pi-package-runtime-invalidation.js';

type InvalidationMaker = Pick<
  Maker,
  | 'advanceLocalPiPackageRuntimeGeneration'
  | 'listActiveSessions'
  | 'getSessionMeta'
  | 'closeSessionIfCurrent'
>;

function session(id: string, agentKind: Session['agentKind']): Session {
  return { id, agentKind } as Session;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function live(id: string, closeGate: Promise<void> = Promise.resolve()) {
  const pending: AgentEvent[] = [];
  let wake: (() => void) | undefined;
  let running = false;
  let ended = false;
  const emit = (event: AgentEvent) => { pending.push(event); wake?.(); };
  const close = vi.fn(async () => { await closeGate; ended = true; wake?.(); });
  const handle = {
    id, agentKind: 'pi', model: 'm', close,
    send: vi.fn(async () => { running = true; }),
    isTurnRunning: () => running,
    setInteractionResolver() {},
    async *events() {
      while (!ended || pending.length) {
        if (!pending.length) await new Promise<void>((resolve) => { wake = resolve; });
        const event = pending.shift();
        if (event) yield event;
      }
    },
  } as unknown as AgentSessionHandle;
  const logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return this; } };
  const instance = new Session({ id, agentKind: 'pi', workDir: '/repo', handle,
    capabilities: {} as never, logger, turnStallMs: 0 });
  const seen: AgentEvent[] = [];
  const recovered: AgentEvent[] = [];
  instance.onEvent((event) => seen.push(event));
  instance.onRuntimeRecovery((event) => recovered.push(event));
  const finish = (result: string) => {
    running = false;
    emit({ type: 'text', source: 'pi', data: { text: result } });
    emit({ type: 'done', source: 'pi', data: { status: 'completed', result } });
  };
  return { instance, handle, close, emit, seen, recovered, finish };
}

describe('Pi package runtime invalidation', () => {
  it.each([false, true])('delivers retirement recovery after Host continuation (refresh=%s)', async (refresh) => {
    const runtime = live('continued');
    const notices = vi.fn(async () => true);
    await runtime.instance.send('IM input', { beforeProviderStart: () => bindRuntimeRecoveryNotice(runtime.instance, notices, { warn() {} }) });
    const firstGeneration = runtime.instance.getTurnGeneration();
    runtime.finish('first segment');
    await vi.waitFor(() => expect(runtime.seen.some(event => event.type === 'done')).toBe(true));
    await runtime.instance.send('Host continuation', {
      onDispatching: () => { if (refresh) advanceRuntimeRecoveryNotice(runtime.instance); },
    });
    expect(runtime.instance.getTurnGeneration()).toBeGreaterThan(firstGeneration);
    runtime.close.mockRejectedValueOnce(new Error('exit unconfirmed'));
    await runtime.instance.closeAfterCurrentTurn({ failureEvent: () => ({
      type: 'text', source: 'pi', data: { isFinal: true, text: 'internal receipt' },
    }) });
    runtime.finish('final result');
    await vi.waitFor(() => expect(runtime.instance.getStatus()).toBe('error'));
    expect(notices).toHaveBeenCalledTimes(refresh ? 1 : 0);
    expect(runtime.handle.send).toHaveBeenCalledTimes(2);
    await runtime.instance.close();
  });

  it.each([
    ['install', undefined, true], ['update', undefined, true],
    ['set-enabled', true, true], ['set-enabled', false, false], ['remove', undefined, false],
  ] as const)('Settings %s enabled=%s retains only positive in-flight work', async (action, enabled, deferredClose) => {
    const busy = live('settings-busy');
    const idle = live('settings-idle');
    const maker: InvalidationMaker = {
      advanceLocalPiPackageRuntimeGeneration: vi.fn(),
      listActiveSessions: () => [busy.instance, idle.instance],
      getSessionMeta: vi.fn(async (id: string) => ({ id, agentKind: 'pi' as const, workDir: '/repo', model: 'm', title: id, createdAt: 1, updatedAt: 1 })),
      closeSessionIfCurrent: async (instance, _reason, opts) => opts?.afterCurrentTurn
        ? instance.closeAfterCurrentTurn(opts) : (await instance.close(), 'closed'),
    };
    const source = readFileSync(new URL('../../maker-ipc/register.ts', import.meta.url), 'utf8');
    const start = source.indexOf('ipcMain.handle(MAKER_INVOKE.PI_PACKAGES_MUTATE');
    const block = source.slice(start, source.indexOf('\n  ipcMain.handle(', start + 1));
    let handler!: (event: unknown, raw: unknown) => Promise<unknown>;
    const dependencies = {
      ipcMain: { handle: (_: unknown, fn: typeof handler) => { handler = fn; } },
      MAKER_INVOKE: { PI_PACKAGES_MUTATE: 'mutate' }, maker,
      assertTrustedAppRendererEvent() {}, requireObject: (value: unknown) => value,
      requireEnum: (value: unknown) => value, throwIpcError: () => { throw new Error('bad input'); },
      runPiPackageMutationIpcBoundary: (run: () => Promise<unknown>) => run(),
      piPackageMutationNeedsGrant: () => false,
      mutatePiPackage: async (_: unknown, __: unknown, hooks: { onRuntimeInvalidationPublished(): Promise<void> }) => {
        await hooks.onRuntimeInvalidationPublished(); return { ok: true };
      },
      invalidateLocalPiPackageRuntimes, t: () => 'Restart Cindy', log: { warn() {} },
    };
    new Function(...Object.keys(dependencies), transpileModule(block, {
      compilerOptions: { target: ScriptTarget.ES2022 },
    }).outputText)(...Object.values(dependencies));
    await busy.instance.send('keep working');
    await handler({}, { action, enabled, source: 'npm:example' });
    expect(idle.close).toHaveBeenCalledOnce();
    expect(busy.close).toHaveBeenCalledTimes(deferredClose ? 0 : 1);
    if (deferredClose) {
      busy.finish('result delivered');
      await vi.waitFor(() => expect(busy.instance.getStatus()).toBe('closed'));
      expect(busy.seen.some(event => event.type === 'done')).toBe(true);
    }
    expect(busy.handle.send).toHaveBeenCalledOnce();
  });

  it.each(['success', 'failure', 'close', 'timeout'] as const)('retains a finished caller through convergence delivery: %s', async (mode) => {
    const fails = mode !== 'success';
    const caller = live('caller');
    const idle = live('idle');
    const closing = deferred<void>();
    const maker: InvalidationMaker = {
      advanceLocalPiPackageRuntimeGeneration: vi.fn(),
      listActiveSessions: () => [caller.instance, idle.instance],
      getSessionMeta: vi.fn(async (id: string) => ({ id, agentKind: 'pi' as const, workDir: '/repo',
        model: 'm', title: id, createdAt: 1, updatedAt: 1 })),
      closeSessionIfCurrent: async (instance, _reason, opts) => {
        if (instance === idle.instance) {
          await closing.promise;
          if (fails) throw new Error('idle process exit unconfirmed');
        }
        return instance.closeAfterCurrentTurn(opts);
      },
    };
    await caller.instance.send('update');
    const snapshot = await captureLocalPiPackageRuntimeInvalidationSnapshot(maker);
    let receipt: AgentEvent | undefined;
    const publish = vi.fn((outcome) => {
      receipt = { type: 'text', source: 'pi', data: { text: JSON.stringify(outcome) } };
      return receipt;
    });
    const settled = settleLocalPiPackageRuntimeSnapshot(maker, snapshot, 'caller', publish);
    caller.finish('done before sibling close');
    await vi.waitFor(() => expect(caller.seen.some(event => event.type === 'done')).toBe(true));
    expect(caller.close).not.toHaveBeenCalled();
    if (mode === 'timeout') vi.useFakeTimers();
    closing.resolve();
    await vi.waitFor(() => expect(publish).toHaveBeenCalledOnce());
    expect(caller.close).not.toHaveBeenCalled(); // Publishing alone is not delivery.
    if (mode === 'timeout') {
      try {
        const rejected = expect(settled).rejects.toThrow('receipt delivery timed out');
        await vi.advanceTimersByTimeAsync(10_000);
        await rejected;
        expect(caller.close).toHaveBeenCalledOnce();
      } finally {
        vi.useRealTimers();
        await idle.instance.close();
      }
      return;
    }
    if (mode === 'close') {
      await caller.instance.close(); // Explicit user close wins over the delivery lease.
      await expect(settled).resolves.toMatchObject({ runtimeConvergence: 'partial' });
      expect(caller.handle.send).toHaveBeenCalledOnce();
      await idle.instance.close();
      return;
    }
    caller.emit(receipt!);
    await expect(settled).resolves.toEqual(fails
      ? { runtimeConvergence: 'partial', recoveryAction: 'restart-cindy-to-refresh-packages' }
      : { runtimeConvergence: 'deferred' });
    await vi.waitFor(() => expect(caller.instance.getStatus()).toBe('closed'));
    expect(caller.seen).toContain(receipt);
    expect(caller.handle.send).toHaveBeenCalledOnce();
    await idle.instance.close();
  });

  it('keeps both busy caller and sibling alive, delivers their results, and retires each independently', async () => {
    const caller = live('caller');
    const sibling = live('sibling');
    const idle = live('idle');
    const instances = [caller, sibling, idle].map((entry) => entry.instance);
    const maker: InvalidationMaker = {
      advanceLocalPiPackageRuntimeGeneration: vi.fn(),
      listActiveSessions: () => instances,
      getSessionMeta: vi.fn(async (id: string) => ({ id, agentKind: 'pi' as const, workDir: '/repo',
        model: 'm', title: id, createdAt: 1, updatedAt: 1 })),
      closeSessionIfCurrent: async (instance, _reason, opts) => opts?.afterCurrentTurn
        ? instance.closeAfterCurrentTurn(opts) : (await instance.close(), 'closed'),
    };
    await caller.instance.send('update and continue');
    await sibling.instance.send('build');
    const snapshot = await captureLocalPiPackageRuntimeInvalidationSnapshot(maker);
    caller.emit({ type: 'tool_result', source: 'pi', data: { toolUseId: 'update', isError: true } });
    expect(await settleLocalPiPackageRuntimeSnapshot(maker, snapshot)).toEqual({ runtimeConvergence: 'deferred' });
    expect(idle.close).toHaveBeenCalledOnce();
    expect(caller.close).not.toHaveBeenCalled();
    expect(sibling.close).not.toHaveBeenCalled();
    caller.finish('update failed; here is the result');
    await vi.waitFor(() => expect(caller.instance.getStatus()).toBe('closed'));
    expect(caller.seen.map((event) => event.type)).toEqual(['tool_result', 'text', 'done']);
    expect(sibling.close).not.toHaveBeenCalled();
    sibling.finish('build finished');
    await vi.waitFor(() => expect(sibling.instance.getStatus()).toBe('closed'));
    expect(sibling.seen.at(-1)?.data).toMatchObject({ result: 'build finished' });
    expect(caller.handle.send).toHaveBeenCalledOnce();
    expect(sibling.handle.send).toHaveBeenCalledOnce();
  });

  it('delivers a deferred sibling failure after the caller has closed, without replay', async () => {
    const caller = live('caller');
    const sibling = live('sibling');
    sibling.close.mockRejectedValueOnce(new Error('exit unconfirmed'));
    const maker: InvalidationMaker = {
      advanceLocalPiPackageRuntimeGeneration: vi.fn(),
      listActiveSessions: () => [caller.instance, sibling.instance],
      getSessionMeta: vi.fn(async (id: string) => ({ id, agentKind: 'pi' as const, workDir: '/repo',
        model: 'm', title: id, createdAt: 1, updatedAt: 1 })),
      closeSessionIfCurrent: async (instance, _reason, opts) => instance.closeAfterCurrentTurn(opts),
    };
    await caller.instance.send('update');
    await sibling.instance.send('build');
    const snapshot = await captureLocalPiPackageRuntimeInvalidationSnapshot(maker);
    expect(await settleLocalPiPackageRuntimeSnapshot(maker, snapshot, undefined, undefined,
      () => ({ type: 'text', source: 'pi', data: { isFinal: true, text: 'partial: restart-cindy-to-refresh-packages' } }))).toEqual({ runtimeConvergence: 'deferred' });
    caller.finish('update completed');
    await vi.waitFor(() => expect(caller.instance.getStatus()).toBe('closed'));
    sibling.finish('build saved');
    await vi.waitFor(() => expect(sibling.instance.getStatus()).toBe('error'));
    expect(sibling.seen.map(event => event.type)).toEqual(['text', 'done']);
    expect(sibling.seen[1].data).toMatchObject({ status: 'completed', result: 'build saved' });
    expect(sibling.recovered).toHaveLength(1);
    expect(sibling.recovered[0].data).toMatchObject({ text: expect.stringContaining('restart-cindy-to-refresh-packages') });
    expect(sibling.recovered[0].data).toMatchObject({ isFinal: true, text: expect.stringContaining('partial') });
    expect(caller.seen.map(event => event.type)).toEqual(['text', 'done']);
    expect(caller.handle.send).toHaveBeenCalledOnce();
    expect(sibling.handle.send).toHaveBeenCalledOnce();
    await sibling.instance.close();
    expect(sibling.close).toHaveBeenCalledTimes(2);
  });

  it('replaces local ordinary Pi runtimes only', async () => {
    const sessions = [
      session('local-pi', 'pi'),
      session('remote-pi', 'pi'),
      session('review-pi', 'pi'),
      session('codex', 'codex'),
    ];
    const getSessionMeta = vi.fn(async (id: string) => ({
      id,
      agentKind: 'pi' as const,
      workDir: '/tmp',
      title: id,
      model: 'test',
      createdAt: 1,
      updatedAt: 1,
      ...(id === 'remote-pi' ? { remoteHostId: 'ssh-host' } : {}),
      ...(id === 'review-pi' ? { reviewMode: true as const } : {}),
    }));
    const closeSessionIfCurrent = vi.fn(async () => undefined);
    const advanceGeneration = vi.fn();
    const listActiveSessions = vi.fn(() => sessions);
    const maker: InvalidationMaker = {
      advanceLocalPiPackageRuntimeGeneration: advanceGeneration,
      listActiveSessions,
      getSessionMeta,
      closeSessionIfCurrent,
    };

    await expect(
      invalidateLocalPiPackageRuntimesForObservedChange(maker, 'external-runtime'),
    ).resolves.toEqual({
      requestedSessionIds: ['local-pi'],
      deferredSessionIds: [],
      failedSessionIds: [],
    });
    expect(getSessionMeta).toHaveBeenCalledTimes(3);
    expect(advanceGeneration.mock.invocationCallOrder[0]).toBeLessThan(
      listActiveSessions.mock.invocationCallOrder[0]!,
    );
    expect(closeSessionIfCurrent).toHaveBeenCalledWith(
      sessions[0],
      'runtime-refresh',
      expect.objectContaining({ afterCurrentTurn: true }),
    );
  });

  it('defers busy local Pi runtimes for cross-process package changes', async () => {
    const busy = live('busy');
    const idle = live('idle');
    const maker: InvalidationMaker = {
      advanceLocalPiPackageRuntimeGeneration: vi.fn(),
      listActiveSessions: () => [busy.instance, idle.instance],
      getSessionMeta: vi.fn(async (id: string) => ({
        id, agentKind: 'pi' as const, workDir: '/repo', model: 'm', title: id, createdAt: 1, updatedAt: 1,
      })),
      closeSessionIfCurrent: async (instance, _reason, opts) => opts?.afterCurrentTurn
        ? instance.closeAfterCurrentTurn(opts) : (await instance.close(), 'closed'),
    };
    await busy.instance.send('keep working');
    await expect(
      invalidateLocalPiPackageRuntimesForObservedChange(maker, 'external-runtime'),
    ).resolves.toEqual({
      requestedSessionIds: ['busy', 'idle'],
      deferredSessionIds: ['busy'],
      failedSessionIds: [],
    });
    expect(idle.close).toHaveBeenCalledOnce();
    expect(busy.close).not.toHaveBeenCalled();
    busy.finish('result delivered');
    await vi.waitFor(() => expect(busy.instance.getStatus()).toBe('closed'));
    expect(busy.seen.some((event) => event.type === 'done')).toBe(true);
    expect(busy.handle.send).toHaveBeenCalledOnce();
  });

  it('does not close a replacement runtime published during metadata lookup', async () => {
    const original = session('local-pi', 'pi');
    const replacement = session('local-pi', 'pi');
    let current = original;
    const metadata = deferred<Awaited<ReturnType<Maker['getSessionMeta']>>>();
    const closed = vi.fn();
    const closeSessionIfCurrent = vi.fn(async (candidate: Session) => {
      if (current === candidate) closed(candidate);
    });
    const getSessionMeta = vi.fn(() => metadata.promise);
    const maker: InvalidationMaker = {
      advanceLocalPiPackageRuntimeGeneration: vi.fn(),
      listActiveSessions: () => [original],
      getSessionMeta,
      closeSessionIfCurrent,
    };

    const invalidation = invalidateLocalPiPackageRuntimes(maker);
    await vi.waitFor(() => expect(getSessionMeta).toHaveBeenCalledWith('local-pi'));
    current = replacement;
    metadata.resolve({
      id: 'local-pi',
      agentKind: 'pi',
      workDir: '/tmp',
      title: 'Pi',
      model: 'test',
      createdAt: 1,
      updatedAt: 1,
    });

    await expect(invalidation).resolves.toEqual({
      requestedSessionIds: ['local-pi'],
      failedSessionIds: [],
    });
    expect(closeSessionIfCurrent).toHaveBeenCalledWith(original, 'requested');
    expect(closed).not.toHaveBeenCalled();
  });

  it('does not retire a new-generation runtime started between commit and settled receipt', async () => {
    const beforeCommit = session('before-commit', 'pi');
    const afterCommit = session('after-commit', 'pi');
    const active = [beforeCommit];
    const closeSessionIfCurrent = vi.fn(async () => undefined);
    const maker: InvalidationMaker = {
      advanceLocalPiPackageRuntimeGeneration: vi.fn(),
      listActiveSessions: vi.fn(() => [...active]),
      getSessionMeta: vi.fn(async (id: string) => ({
        id,
        agentKind: 'pi' as const,
        workDir: '/tmp',
        title: id,
        model: 'test',
        createdAt: 1,
        updatedAt: 1,
      })),
      closeSessionIfCurrent,
    };

    const commitSnapshot = await captureLocalPiPackageRuntimeInvalidationSnapshot(maker);
    active.push(afterCommit);
    await expect(
      invalidateLocalPiPackageRuntimeSnapshot(maker, commitSnapshot),
    ).resolves.toEqual({
      requestedSessionIds: ['before-commit'],
      failedSessionIds: [],
    });

    expect(maker.advanceLocalPiPackageRuntimeGeneration).toHaveBeenCalledOnce();
    expect(closeSessionIfCurrent).toHaveBeenCalledWith(beforeCommit, 'requested');
    expect(closeSessionIfCurrent).not.toHaveBeenCalledWith(afterCommit, 'requested');
  });

  it('does not duplicate convergence for the same-process token publication', async () => {
    const maker: InvalidationMaker = {
      advanceLocalPiPackageRuntimeGeneration: vi.fn(),
      listActiveSessions: vi.fn(() => []),
      getSessionMeta: vi.fn(),
      closeSessionIfCurrent: vi.fn(),
    };

    await expect(
      invalidateLocalPiPackageRuntimesForObservedChange(maker, 'local'),
    ).resolves.toBeNull();
    expect(maker.advanceLocalPiPackageRuntimeGeneration).not.toHaveBeenCalled();
    expect(maker.listActiveSessions).not.toHaveBeenCalled();
  });

  it('still closes known-local siblings when one metadata lookup fails', async () => {
    const closeSessionIfCurrent = vi.fn(async () => undefined);
    const sessions = [session('unknown-pi', 'pi'), session('local-pi', 'pi')];
    const maker: InvalidationMaker = {
      advanceLocalPiPackageRuntimeGeneration: vi.fn(),
      listActiveSessions: () => sessions,
      getSessionMeta: vi.fn(async (id: string) => {
        if (id === 'unknown-pi') throw new Error('metadata unavailable');
        return {
          id,
          agentKind: 'pi' as const,
          workDir: '/tmp',
          title: 'Pi',
          model: 'test',
          createdAt: 1,
          updatedAt: 1,
        };
      }),
      closeSessionIfCurrent,
    };

    await expect(invalidateLocalPiPackageRuntimes(maker)).resolves.toEqual({
      requestedSessionIds: ['local-pi'],
      failedSessionIds: ['unknown-pi'],
    });
    expect(closeSessionIfCurrent).toHaveBeenCalledWith(sessions[1], 'requested');
  });

  it('reports null metadata without preventing known-local siblings from closing', async () => {
    const closeSessionIfCurrent = vi.fn(async () => undefined);
    const sessions = [session('missing-pi', 'pi'), session('local-pi', 'pi')];
    const maker: InvalidationMaker = {
      advanceLocalPiPackageRuntimeGeneration: vi.fn(),
      listActiveSessions: () => sessions,
      getSessionMeta: vi.fn(async (id: string) => (
        id === 'missing-pi'
          ? null
          : {
              id,
              agentKind: 'pi' as const,
              workDir: '/tmp',
              title: 'Pi',
              model: 'test',
              createdAt: 1,
              updatedAt: 1,
            }
      )),
      closeSessionIfCurrent,
    };

    await expect(invalidateLocalPiPackageRuntimes(maker)).resolves.toEqual({
      requestedSessionIds: ['local-pi'],
      failedSessionIds: ['missing-pi'],
    });
    expect(closeSessionIfCurrent).toHaveBeenCalledTimes(1);
    expect(closeSessionIfCurrent).toHaveBeenCalledWith(sessions[1], 'requested');
  });

  it('reports close failures without rewriting an already committed package mutation', async () => {
    const maker: InvalidationMaker = {
      advanceLocalPiPackageRuntimeGeneration: vi.fn(),
      listActiveSessions: () => [session('local-pi', 'pi')],
      getSessionMeta: vi.fn(async () => ({
        id: 'local-pi',
        agentKind: 'pi' as const,
        workDir: '/tmp',
        title: 'Pi',
        model: 'test',
        createdAt: 1,
        updatedAt: 1,
      })),
      closeSessionIfCurrent: vi.fn(async () => {
        throw new Error('close failed');
      }),
    };

    await expect(invalidateLocalPiPackageRuntimes(maker)).resolves.toEqual({
      requestedSessionIds: ['local-pi'],
      failedSessionIds: ['local-pi'],
    });
  });
});
