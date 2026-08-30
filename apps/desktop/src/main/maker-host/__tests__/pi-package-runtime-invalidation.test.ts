import type { Maker, Session } from '@cindy/maker-core';
import { describe, expect, it, vi } from 'vitest';

import {
  captureLocalPiPackageRuntimeInvalidationSnapshot,
  invalidateLocalPiPackageRuntimeSnapshot,
  invalidateLocalPiPackageRuntimes,
  invalidateLocalPiPackageRuntimesForObservedChange,
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

describe('Pi package runtime invalidation', () => {
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
      failedSessionIds: [],
    });
    expect(getSessionMeta).toHaveBeenCalledTimes(3);
    expect(advanceGeneration.mock.invocationCallOrder[0]).toBeLessThan(
      listActiveSessions.mock.invocationCallOrder[0]!,
    );
    expect(closeSessionIfCurrent).toHaveBeenCalledWith(sessions[0], 'requested');
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
