import type { Maker, Session } from '@cindy/maker-core';
import { describe, expect, it, vi } from 'vitest';

import { invalidateLocalPiPackageRuntimes } from '../pi-package-runtime-invalidation.js';

type InvalidationMaker = Pick<Maker, 'listActiveSessions' | 'getSessionMeta' | 'closeSession'>;

function session(id: string, agentKind: Session['agentKind']): Session {
  return { id, agentKind } as Session;
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
    const closeSession = vi.fn(async () => undefined);
    const maker: InvalidationMaker = {
      listActiveSessions: () => sessions,
      getSessionMeta,
      closeSession,
    };

    await expect(invalidateLocalPiPackageRuntimes(maker)).resolves.toEqual({
      requestedSessionIds: ['local-pi'],
      failedSessionIds: [],
    });
    expect(getSessionMeta).toHaveBeenCalledTimes(3);
    expect(closeSession).toHaveBeenCalledWith('local-pi', 'requested');
  });

  it('still closes known-local siblings when one metadata lookup fails', async () => {
    const closeSession = vi.fn(async () => undefined);
    const maker: InvalidationMaker = {
      listActiveSessions: () => [session('unknown-pi', 'pi'), session('local-pi', 'pi')],
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
      closeSession,
    };

    await expect(invalidateLocalPiPackageRuntimes(maker)).resolves.toEqual({
      requestedSessionIds: ['local-pi'],
      failedSessionIds: ['unknown-pi'],
    });
    expect(closeSession).toHaveBeenCalledWith('local-pi', 'requested');
  });

  it('reports close failures without rewriting an already committed package mutation', async () => {
    const maker: InvalidationMaker = {
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
      closeSession: vi.fn(async () => {
        throw new Error('close failed');
      }),
    };

    await expect(invalidateLocalPiPackageRuntimes(maker)).resolves.toEqual({
      requestedSessionIds: ['local-pi'],
      failedSessionIds: ['local-pi'],
    });
  });
});
