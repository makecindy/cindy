import { describe, expect, it, vi } from 'vitest';

import type { AgentEvent, Session } from '@cindy/maker-core';
import { backfillSessionMeta, runOneTurn } from '../runners/_shared';

type DbArg = Parameters<typeof backfillSessionMeta>[0];
type LoggerArg = Parameters<typeof backfillSessionMeta>[3];

function createUpdateDb(
  whereImpl: (condition?: unknown) => Promise<unknown> = vi.fn().mockResolvedValue(undefined),
) {
  const where = vi.fn(whereImpl);
  const set = vi.fn((patch: Record<string, unknown>) => ({ where, patch }));
  const update = vi.fn(() => ({ set }));

  return {
    db: { update } as unknown as DbArg,
    update,
    set,
    where,
  };
}

function createLogger() {
  const warn = vi.fn();
  return {
    logger: { warn } as unknown as LoggerArg,
    warn,
  };
}

function createSessionHarness() {
  const listeners: Array<(event: AgentEvent) => void> = [];
  const abort = vi.fn(async () => {});
  const session = {
    onEvent(listener: (event: AgentEvent) => void) {
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      };
    },
    abort,
  } as unknown as Session;
  return {
    session,
    abort,
    emit(event: AgentEvent) {
      for (const listener of [...listeners]) listener(event);
    },
    listenerCount() {
      return listeners.length;
    },
  };
}

describe('backfillSessionMeta', () => {
  it.each([true, false])('persists the resolved Fast state (%s), including clearing a stale true', async (fastMode) => {
    const { db, set } = createUpdateDb();
    const { logger } = createLogger();
    await backfillSessionMeta(db, 'sess-1', { fastMode }, logger);
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ fastMode }));
  });

  it('writes unattended metadata for newly created scheduler sessions', async () => {
    const { db, update, set, where } = createUpdateDb();
    const { logger, warn } = createLogger();

    await backfillSessionMeta(
      db,
      'sess-1',
      {
        effort: 'high',
        workspaceKind: 'dialogue',
        source: 'scheduler',
      },
      logger,
    );

    expect(update).toHaveBeenCalledTimes(1);
    expect(where).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();

    const patch = set.mock.calls[0][0] as Record<string, unknown>;
    expect(patch).toEqual(
      expect.objectContaining({
        permissionMode: 'bypassPermissions',
        effort: 'high',
        workspaceKind: 'dialogue',
        source: 'scheduler',
      }),
    );
    expect(patch.updatedAt).toEqual(expect.any(Number));
  });

  it('learn 会话显式传 permissionMode 时覆盖 unattended 默认(不写回 bypass)', async () => {
    const { db, set } = createUpdateDb();
    const { logger } = createLogger();

    await backfillSessionMeta(
      db,
      'sess-learn',
      {
        workspaceKind: 'dialogue',
        source: 'learn',
        permissionMode: 'acceptEdits',
        providerId: 'provider-x',
      },
      logger,
    );

    const patch = set.mock.calls[0][0] as Record<string, unknown>;
    expect(patch.permissionMode).toBe('acceptEdits');
    expect(patch.providerId).toBe('provider-x');
    expect(patch.source).toBe('learn');
  });

  it('does not mark heartbeat sessions as scheduler-generated when source is omitted', async () => {
    const { db, set } = createUpdateDb();
    const { logger } = createLogger();

    await backfillSessionMeta(db, 'sess-1', {}, logger);

    const patch = set.mock.calls[0][0] as Record<string, unknown>;
    expect(patch).toEqual({
      permissionMode: 'bypassPermissions',
      updatedAt: expect.any(Number),
    });
    expect('source' in patch).toBe(false);
    expect('workspaceKind' in patch).toBe(false);
    expect('effort' in patch).toBe(false);
  });

  it('logs update failures without interrupting the scheduler run', async () => {
    const err = new Error('db failed');
    const { db } = createUpdateDb(async () => {
      throw err;
    });
    const { logger, warn } = createLogger();

    await expect(
      backfillSessionMeta(db, 'sess-1', { source: 'scheduler' }, logger),
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(
      '[runner] backfill sessions metadata failed (non-fatal)',
      err,
    );
  });
});

describe('runOneTurn', () => {
  it('ignores non-terminal recoverable errors and resolves on done', async () => {
    const h = createSessionHarness();
    const { logger } = createLogger();
    const resultPromise = runOneTurn(h.session, 1_000, logger);

    h.emit({ type: 'error', data: { message: 'retrying', isTerminal: false } });
    expect(h.listenerCount()).toBe(1);

    h.emit({ type: 'text', data: { text: 'ok', isFinal: true } });
    h.emit({ type: 'done', data: {} });

    await expect(resultPromise).resolves.toEqual({ assistantText: 'ok' });
    expect(h.abort).not.toHaveBeenCalled();
    expect(h.listenerCount()).toBe(0);
  });
});
