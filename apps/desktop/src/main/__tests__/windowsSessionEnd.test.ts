import type { AgentEvent } from '@cindy/maker-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetWindowsSessionEndForTests,
  beginWindowsSessionEndQuery,
  cancelWindowsSessionEndQuery,
  createWindowsSessionEndEventGate,
  deferRetainedWindowsSessionEndFallback,
  deferWindowsSessionEndEvent,
  deferWindowsSessionEndWiringTeardown,
  finishWindowsSessionEndProductTurn,
  finishWindowsSessionEndSessionClosed,
  isWindowsSessionEndFallbackSession,
  markWindowsSessionEnding,
  noteWindowsSessionEndTurnStarted,
  prepareWindowsSessionEndFallbackBeforeSessionClose,
  prepareWindowsSessionEndFallbackBeforeSessionTeardown,
  rollbackWindowsSessionEndTurnStarted,
  settleWindowsSessionEndRecoveryMarkers,
  shouldRejectWindowsSessionEndTurnStart,
  shouldSuppressWindowsSessionEndClaudeError,
  trackWindowsSessionEndFallbackStorageTask,
} from '../windowsSessionEnd';

const claudeTerminalError: AgentEvent = {
  type: 'error',
  source: 'claude-code',
  data: { message: 'shutdown', isTerminal: true },
  sessionTurnGeneration: 1,
};
const claudeDone: AgentEvent = {
  type: 'done',
  source: 'claude-code',
  data: {},
  sessionTurnGeneration: 1,
};
const claudeContinuationDone: AgentEvent = {
  ...claudeDone,
  turnContinuationId: 7,
};
const claudeSilentStopDone: AgentEvent = {
  ...claudeDone,
  data: { silentStop: true },
};
const claudeText: AgentEvent = {
  type: 'text',
  source: 'claude-code',
  data: { text: 'still running' },
  sessionTurnGeneration: 1,
};
const claudeIdleStatus: AgentEvent = {
  type: 'status',
  source: 'claude-code',
  data: { isRunning: false, status: 'Done' },
  sessionTurnGeneration: 1,
};

const activeTurn = (sessionId: string, turnGeneration = 1, sessionInstanceId = sessionId) => ({
  sessionId,
  sessionInstanceId,
  turnGeneration,
});

describe('Windows session-end terminal error classification', () => {
  beforeEach(() => {
    __resetWindowsSessionEndForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('suppresses only an active Claude terminal after Windows session end is observed', () => {
    const activeClaudeTerminal = {
      sessionId: 'active-session',
      source: 'claude-code',
      isTerminalError: true,
      sessionTurnGeneration: 1,
    };

    expect(shouldSuppressWindowsSessionEndClaudeError(activeClaudeTerminal)).toBe(false);

    expect(markWindowsSessionEnding([activeTurn('active-session')])).toEqual(['active-session']);

    expect(shouldSuppressWindowsSessionEndClaudeError(activeClaudeTerminal)).toBe(true);
    expect(
      shouldSuppressWindowsSessionEndClaudeError({
        ...activeClaudeTerminal,
        source: 'codex',
      }),
    ).toBe(false);
    expect(
      shouldSuppressWindowsSessionEndClaudeError({
        ...activeClaudeTerminal,
        isTerminalError: false,
      }),
    ).toBe(false);
    expect(
      shouldSuppressWindowsSessionEndClaudeError({
        ...activeClaudeTerminal,
        sessionId: 'already-idle-session',
      }),
    ).toBe(false);
    expect(
      shouldSuppressWindowsSessionEndClaudeError({
        ...activeClaudeTerminal,
        sessionInstanceId: 'replacement-instance',
      }),
    ).toBe(false);
  });

  it('drops confirmed shutdown terminal errors at the unified dispatch gate', async () => {
    const replay = vi.fn();
    markWindowsSessionEnding([activeTurn('active-session')]);

    expect(
      deferWindowsSessionEndEvent('active-session', 'claude-code', claudeTerminalError, replay),
    ).toBe(true);
    expect(
      deferWindowsSessionEndEvent('active-session', 'claude-code', claudeIdleStatus, replay),
    ).toBe(true);
    expect(
      deferWindowsSessionEndEvent('active-session', 'claude-code', claudeDone, replay),
    ).toBe(true);
    expect(
      deferWindowsSessionEndEvent(
        'already-idle-session',
        'claude-code',
        claudeTerminalError,
        replay,
      ),
    ).toBe(false);
    expect(
      deferWindowsSessionEndEvent('active-session', 'codex', claudeTerminalError, replay),
    ).toBe(false);
    expect(
      deferWindowsSessionEndEvent('active-session', 'claude-code', claudeText, replay),
    ).toBe(false);
    await settleWindowsSessionEndRecoveryMarkers(['active-session']);
    expect(replay).not.toHaveBeenCalled();
  });

  it('does not drop a newer turn generation behind a confirmed terminal tail', () => {
    markWindowsSessionEnding([activeTurn('active-session')]);

    expect(
      deferWindowsSessionEndEvent('active-session', 'claude-code', claudeTerminalError, vi.fn()),
    ).toBe(true);
    expect(
      deferWindowsSessionEndEvent(
        'active-session',
        'claude-code',
        { ...claudeIdleStatus, sessionTurnGeneration: 2 },
        vi.fn(),
      ),
    ).toBe(false);
    expect(
      deferWindowsSessionEndEvent(
        'active-session',
        'claude-code',
        { ...claudeDone, sessionTurnGeneration: 2 },
        vi.fn(),
      ),
    ).toBe(false);
    expect(
      deferWindowsSessionEndEvent('active-session', 'claude-code', claudeIdleStatus, vi.fn()),
    ).toBe(true);
    expect(deferWindowsSessionEndEvent('active-session', 'claude-code', claudeDone, vi.fn())).toBe(
      true,
    );
  });

  it('does not attribute a confirmed terminal tail to a replacement instance', () => {
    markWindowsSessionEnding([activeTurn('shared-session', 1, 'old-instance')]);

    expect(
      deferWindowsSessionEndEvent(
        'shared-session',
        'claude-code',
        { ...claudeTerminalError, sessionInstanceId: 'old-instance' },
        vi.fn(),
        undefined,
        'old-instance',
      ),
    ).toBe(true);
    expect(
      deferWindowsSessionEndEvent(
        'shared-session',
        'claude-code',
        { ...claudeDone, sessionInstanceId: 'replacement-instance' },
        vi.fn(),
        undefined,
        'replacement-instance',
      ),
    ).toBe(false);
    expect(
      deferWindowsSessionEndEvent(
        'shared-session',
        'claude-code',
        { ...claudeDone, sessionInstanceId: 'old-instance' },
        vi.fn(),
        undefined,
        'old-instance',
      ),
    ).toBe(true);
  });

  it('holds a normal completion for a generation active at confirmation', async () => {
    const replay = vi.fn();
    const discard = vi.fn();
    markWindowsSessionEnding([activeTurn('active-session')]);

    expect(
      deferWindowsSessionEndEvent('active-session', 'claude-code', claudeDone, replay, discard),
    ).toBe(true);
    await settleWindowsSessionEndRecoveryMarkers(['active-session']);
    expect(replay).not.toHaveBeenCalled();
    expect(discard).toHaveBeenCalledTimes(1);
  });

  it('discards query-phase events when Windows confirms the session end', async () => {
    const replay = vi.fn();
    const discard = vi.fn();
    const statusReplay = vi.fn();
    const statusDiscard = vi.fn();

    beginWindowsSessionEndQuery([activeTurn('active-session')]);

    expect(
      deferWindowsSessionEndEvent(
        'active-session',
        'claude-code',
        claudeTerminalError,
        replay,
        discard,
      ),
    ).toBe(true);
    expect(
      deferWindowsSessionEndEvent(
        'active-session',
        'claude-code',
        claudeIdleStatus,
        statusReplay,
        statusDiscard,
      ),
    ).toBe(true);
    expect(
      deferWindowsSessionEndEvent('active-session', 'claude-code', claudeDone, vi.fn()),
    ).toBe(true);
    expect(
      deferWindowsSessionEndEvent(
        'already-idle-session',
        'claude-code',
        claudeTerminalError,
        vi.fn(),
      ),
    ).toBe(false);

    markWindowsSessionEnding([activeTurn('active-session')]);

    expect(discard).not.toHaveBeenCalled();
    await settleWindowsSessionEndRecoveryMarkers(['active-session']);

    expect(replay).not.toHaveBeenCalled();
    expect(discard).toHaveBeenCalledTimes(1);
    expect(statusReplay).not.toHaveBeenCalled();
    expect(statusDiscard).toHaveBeenCalledTimes(1);
  });

  it('keeps replacement wiring alive until a cancelled query replays held events', () => {
    const calls: string[] = [];
    beginWindowsSessionEndQuery([activeTurn('active-session')]);
    expect(
      deferWindowsSessionEndEvent('active-session', 'claude-code', claudeTerminalError, () =>
        calls.push('replay'),
      ),
    ).toBe(true);
    expect(
      deferWindowsSessionEndWiringTeardown('active-session', 'claude-code', () =>
        calls.push('teardown'),
      ),
    ).toBe(true);
    expect(calls).toEqual([]);

    expect(cancelWindowsSessionEndQuery()).toBe(true);
    expect(calls).toEqual(['replay', 'teardown']);
  });

  it('keeps a dispatched query-time turn protected through replacement teardown', () => {
    const calls: string[] = [];
    beginWindowsSessionEndQuery([]);
    expect(noteWindowsSessionEndTurnStarted('late-session', 'claude-code', 1)).toBe(true);
    expect(
      deferWindowsSessionEndEvent('late-session', 'claude-code', claudeTerminalError, () =>
        calls.push('replay'),
      ),
    ).toBe(true);
    expect(
      deferWindowsSessionEndWiringTeardown('late-session', 'claude-code', () =>
        calls.push('teardown'),
      ),
    ).toBe(true);
    expect(calls).toEqual([]);

    expect(cancelWindowsSessionEndQuery()).toBe(true);
    expect(calls).toEqual(['replay', 'teardown']);
  });

  it('does not let a replacement rollback retire the old instance generation', () => {
    const calls: string[] = [];
    const oldTerminal = { ...claudeTerminalError, sessionInstanceId: 'old-instance' };
    beginWindowsSessionEndQuery([activeTurn('shared-session', 1, 'old-instance')]);
    expect(
      deferWindowsSessionEndEvent(
        'shared-session',
        'claude-code',
        oldTerminal,
        () => calls.push('replay'),
        undefined,
        'old-instance',
      ),
    ).toBe(true);
    expect(
      deferWindowsSessionEndWiringTeardown('shared-session', 'claude-code', () =>
        calls.push('teardown'),
      ),
    ).toBe(true);

    expect(
      noteWindowsSessionEndTurnStarted(
        'shared-session',
        'claude-code',
        1,
        undefined,
        'replacement-instance',
      ),
    ).toBe(true);
    rollbackWindowsSessionEndTurnStarted('shared-session', 1, 'replacement-instance');

    expect(cancelWindowsSessionEndQuery()).toBe(true);
    expect(calls).toEqual(['replay', 'teardown']);
  });

  it('does not let a replacement completion remove the old confirmation marker', async () => {
    const oldDiscard = vi.fn();
    beginWindowsSessionEndQuery([activeTurn('shared-session', 1, 'old-instance')]);
    expect(
      deferWindowsSessionEndEvent(
        'shared-session',
        'claude-code',
        { ...claudeTerminalError, sessionInstanceId: 'old-instance' },
        vi.fn(),
        oldDiscard,
        'old-instance',
      ),
    ).toBe(true);
    expect(
      noteWindowsSessionEndTurnStarted(
        'shared-session',
        'claude-code',
        1,
        undefined,
        'replacement-instance',
      ),
    ).toBe(true);
    expect(
      deferWindowsSessionEndEvent(
        'shared-session',
        'claude-code',
        { ...claudeDone, sessionInstanceId: 'replacement-instance' },
        vi.fn(),
        undefined,
        'replacement-instance',
      ),
    ).toBe(false);

    expect(markWindowsSessionEnding([])).toEqual(['shared-session']);
    await settleWindowsSessionEndRecoveryMarkers(['shared-session']);
    expect(oldDiscard).toHaveBeenCalledTimes(1);
  });

  it('settles confirmed held events before replacement wiring teardown', async () => {
    const calls: string[] = [];
    beginWindowsSessionEndQuery([activeTurn('active-session')]);
    expect(
      deferWindowsSessionEndEvent(
        'active-session',
        'claude-code',
        claudeTerminalError,
        () => calls.push('replay'),
        () => calls.push('discard'),
      ),
    ).toBe(true);
    expect(
      deferWindowsSessionEndWiringTeardown('active-session', 'claude-code', () =>
        calls.push('teardown'),
      ),
    ).toBe(true);

    markWindowsSessionEnding([]);
    await settleWindowsSessionEndRecoveryMarkers(['active-session']);
    expect(calls).toEqual(['discard', 'teardown']);
  });

  it('tears down replacement wiring after a normal query-time done fans out', async () => {
    const calls: string[] = [];
    beginWindowsSessionEndQuery([activeTurn('active-session')]);
    expect(
      deferWindowsSessionEndWiringTeardown('active-session', 'claude-code', () =>
        calls.push('teardown'),
      ),
    ).toBe(true);

    expect(
      deferWindowsSessionEndEvent('active-session', 'claude-code', claudeDone, () =>
        calls.push('unexpected-replay'),
      ),
    ).toBe(false);
    calls.push('fan-out');
    expect(calls).toEqual(['fan-out']);
    await Promise.resolve();
    expect(calls).toEqual(['fan-out', 'teardown']);
  });

  it('replays held terminal state when the confirmed recovery marker fails', async () => {
    const calls: string[] = [];
    const discard = vi.fn();
    beginWindowsSessionEndQuery([activeTurn('active-session')]);
    deferWindowsSessionEndEvent(
      'active-session',
      'claude-code',
      claudeTerminalError,
      () => calls.push('terminal'),
      discard,
    );
    deferWindowsSessionEndEvent('active-session', 'claude-code', claudeDone, () =>
      calls.push('done'),
    );
    expect(
      deferWindowsSessionEndWiringTeardown('active-session', 'claude-code', () =>
        calls.push('teardown'),
      ),
    ).toBe(true);

    markWindowsSessionEnding([]);
    await expect(settleWindowsSessionEndRecoveryMarkers([])).resolves.toEqual(['active-session']);

    expect(calls).toEqual(['terminal', 'done', 'teardown']);
    expect(isWindowsSessionEndFallbackSession('active-session')).toBe(true);
    expect(discard).not.toHaveBeenCalled();
    expect(
      deferWindowsSessionEndEvent(
        'active-session',
        'claude-code',
        { ...claudeTerminalError, sessionTurnGeneration: 2 },
        vi.fn(),
      ),
    ).toBe(false);
    expect(
      shouldSuppressWindowsSessionEndClaudeError({
        sessionId: 'active-session',
        source: 'claude-code',
        isTerminalError: true,
        sessionTurnGeneration: 1,
      }),
    ).toBe(false);

    const lateReplay = vi.fn();
    expect(
      deferWindowsSessionEndEvent(
        'active-session',
        'claude-code',
        claudeTerminalError,
        lateReplay,
      ),
    ).toBe(true);
    expect(
      deferWindowsSessionEndEvent(
        'active-session',
        'claude-code',
        claudeIdleStatus,
        lateReplay,
      ),
    ).toBe(true);
    expect(deferWindowsSessionEndEvent('active-session', 'claude-code', claudeDone, lateReplay)).toBe(
      true,
    );
    expect(lateReplay).not.toHaveBeenCalled();
  });

  it('waits for a late terminal before settling a failed recovery marker', async () => {
    const replay = vi.fn();
    markWindowsSessionEnding([activeTurn('active-session')]);

    const settlement = settleWindowsSessionEndRecoveryMarkers([]);
    let settled = false;
    void settlement.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    expect(
      deferWindowsSessionEndEvent('active-session', 'claude-code', claudeTerminalError, replay),
    ).toBe(true);
    await expect(settlement).resolves.toEqual(['active-session']);
    expect(replay).toHaveBeenCalledTimes(1);
    expect(
      shouldSuppressWindowsSessionEndClaudeError({
        sessionId: 'active-session',
        source: 'claude-code',
        isTerminalError: true,
        sessionTurnGeneration: 1,
      }),
    ).toBe(false);
  });

  it('emits a missing fallback terminal before active Session teardown', async () => {
    const replay = vi.fn();
    const emitFallbackTerminal = vi.fn(() =>
      deferWindowsSessionEndEvent(
        'pre-teardown-session',
        'claude-code',
        claudeTerminalError,
        replay,
      ),
    );
    markWindowsSessionEnding([
      {
        ...activeTurn('pre-teardown-session'),
        emitFallbackTerminal,
      },
    ]);

    const settlement = settleWindowsSessionEndRecoveryMarkers([]);
    let settled = false;
    void settlement.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(replay).not.toHaveBeenCalled();

    await expect(prepareWindowsSessionEndFallbackBeforeSessionTeardown()).resolves.toEqual([
      activeTurn('pre-teardown-session'),
    ]);
    await expect(settlement).resolves.toEqual(['pre-teardown-session']);
    expect(emitFallbackTerminal).toHaveBeenCalledOnce();
    expect(replay).toHaveBeenCalledOnce();
  });

  it('replaces a synthetic fallback terminal when the provider emits a real terminal first', async () => {
    const syntheticReplay = vi.fn();
    const realReplay = vi.fn();
    const emitFallbackTerminal = vi.fn(() =>
      deferWindowsSessionEndEvent(
        'replace-synthetic-session',
        'claude-code',
        claudeTerminalError,
        syntheticReplay,
      ),
    );
    markWindowsSessionEnding([
      {
        ...activeTurn('replace-synthetic-session'),
        emitFallbackTerminal,
      },
    ]);

    await expect(
      prepareWindowsSessionEndFallbackBeforeSessionTeardown(),
    ).resolves.toEqual([activeTurn('replace-synthetic-session')]);
    expect(
      deferWindowsSessionEndEvent(
        'replace-synthetic-session',
        'claude-code',
        claudeTerminalError,
        realReplay,
      ),
    ).toBe(true);

    const settlement = settleWindowsSessionEndRecoveryMarkers([]);
    await expect(settlement).resolves.toEqual(['replace-synthetic-session']);
    expect(syntheticReplay).not.toHaveBeenCalled();
    expect(realReplay).toHaveBeenCalledOnce();
  });

  it('emits confirmed fallback for the exact Session before an early close', async () => {
    const closingReplay = vi.fn();
    const replacementReplay = vi.fn();
    const closingTurn = activeTurn('replaced-session', 1, 'closing-instance');
    const replacementTurn = activeTurn('replaced-session', 1, 'replacement-instance');
    const emitClosingFallback = vi.fn(() =>
      deferWindowsSessionEndEvent(
        'replaced-session',
        'claude-code',
        { ...claudeTerminalError, sessionInstanceId: 'closing-instance' },
        closingReplay,
      ),
    );
    const emitReplacementFallback = vi.fn(() =>
      deferWindowsSessionEndEvent(
        'replaced-session',
        'claude-code',
        { ...claudeTerminalError, sessionInstanceId: 'replacement-instance' },
        replacementReplay,
      ),
    );
    markWindowsSessionEnding([
      { ...closingTurn, emitFallbackTerminal: emitClosingFallback },
      { ...replacementTurn, emitFallbackTerminal: emitReplacementFallback },
    ]);

    const settlement = settleWindowsSessionEndRecoveryMarkers([]);
    let settled = false;
    void settlement.then(() => {
      settled = true;
    });
    await Promise.resolve();

    expect(
      prepareWindowsSessionEndFallbackBeforeSessionClose(
        'replaced-session',
        'closing-instance',
      ),
    ).toEqual([closingTurn]);
    await Promise.resolve();
    expect(emitClosingFallback).toHaveBeenCalledOnce();
    expect(emitReplacementFallback).not.toHaveBeenCalled();
    expect(settled).toBe(false);

    expect(
      prepareWindowsSessionEndFallbackBeforeSessionClose(
        'replaced-session',
        'replacement-instance',
      ),
    ).toEqual([replacementTurn]);
    await expect(settlement).resolves.toEqual(['replaced-session']);
    expect(emitReplacementFallback).toHaveBeenCalledOnce();
    expect(closingReplay).toHaveBeenCalledOnce();
    expect(replacementReplay).toHaveBeenCalledOnce();
  });

  it('replays a retained fallback after Session fan-out is unavailable', async () => {
    const turn = activeTurn('closed-failed-session', 3, 'closed-failed-instance');
    const replay = vi.fn();
    markWindowsSessionEnding([turn]);

    const settlement = settleWindowsSessionEndRecoveryMarkers([]);
    let settled = false;
    void settlement.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    expect(
      deferRetainedWindowsSessionEndFallback(
        turn.sessionId,
        'claude-code',
        turn.sessionInstanceId,
        turn.turnGeneration,
        replay,
      ),
    ).toBe(true);
    await expect(settlement).resolves.toEqual([turn.sessionId]);
    expect(replay).toHaveBeenCalledOnce();
    expect(replay).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        source: 'claude-code',
        sessionInstanceId: turn.sessionInstanceId,
        sessionTurnGeneration: turn.turnGeneration,
        sessionEventReplay: { capturedAt: expect.any(Number) },
        data: expect.objectContaining({ isTerminal: true }),
      }),
    );
  });

  it('waits for terminal fallback from every confirmed generation in a session', async () => {
    const calls: string[] = [];
    beginWindowsSessionEndQuery([activeTurn('multi-generation-session', 1)]);
    expect(
      deferWindowsSessionEndEvent(
        'multi-generation-session',
        'claude-code',
        { ...claudeTerminalError, sessionTurnGeneration: 1 },
        () => calls.push('replay:1'),
      ),
    ).toBe(true);
    expect(noteWindowsSessionEndTurnStarted('multi-generation-session', 'claude-code', 2)).toBe(
      true,
    );
    expect(markWindowsSessionEnding([activeTurn('multi-generation-session', 2)])).toEqual([
      'multi-generation-session',
    ]);

    const settlement = settleWindowsSessionEndRecoveryMarkers([], async (sessionId) => {
      calls.push(`settled:${sessionId}`);
    });
    let settled = false;
    void settlement.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(calls).toEqual([]);
    expect(
      shouldSuppressWindowsSessionEndClaudeError({
        sessionId: 'multi-generation-session',
        source: 'claude-code',
        isTerminalError: true,
        sessionTurnGeneration: 2,
      }),
    ).toBe(true);

    expect(
      deferWindowsSessionEndEvent(
        'multi-generation-session',
        'claude-code',
        { ...claudeTerminalError, sessionTurnGeneration: 2 },
        () => calls.push('replay:2'),
      ),
    ).toBe(true);
    await expect(settlement).resolves.toEqual(['multi-generation-session']);
    expect(calls).toEqual([
      'replay:1',
      'replay:2',
      'settled:multi-generation-session',
    ]);
  });

  it('waits for fallback replay storage tasks before settling the marker', async () => {
    const calls: string[] = [];
    let releaseStorageTask!: () => void;
    const storageTask = new Promise<void>((resolve) => {
      releaseStorageTask = resolve;
    });
    markWindowsSessionEnding([activeTurn('orca-worker-session')]);
    expect(
      deferWindowsSessionEndEvent(
        'orca-worker-session',
        'claude-code',
        claudeTerminalError,
        () => {
          calls.push('replay');
          trackWindowsSessionEndFallbackStorageTask(
            'orca-worker-session',
            storageTask.then(() => {
              calls.push('orca-storage');
            }),
          );
        },
      ),
    ).toBe(true);

    const settlement = settleWindowsSessionEndRecoveryMarkers([], async (sessionId) => {
      calls.push(`settled:${sessionId}`);
    });
    let settled = false;
    void settlement.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(calls).toEqual(['replay']);

    releaseStorageTask();
    await expect(settlement).resolves.toEqual(['orca-worker-session']);
    expect(calls).toEqual([
      'replay',
      'orca-storage',
      'settled:orca-worker-session',
    ]);
  });

  it('keeps the recovery marker when a required fallback storage task fails', async () => {
    const persistenceError = new Error('fallback error insert rejected');
    const settleMarker = vi.fn(async () => undefined);
    markWindowsSessionEnding([activeTurn('failed-fallback-persist-session')]);
    expect(
      deferWindowsSessionEndEvent(
        'failed-fallback-persist-session',
        'claude-code',
        claudeTerminalError,
        () => {
          trackWindowsSessionEndFallbackStorageTask(
            'failed-fallback-persist-session',
            Promise.reject(persistenceError),
            { requireSuccess: true },
          );
        },
      ),
    ).toBe(true);

    await expect(
      settleWindowsSessionEndRecoveryMarkers([], settleMarker),
    ).rejects.toBe(persistenceError);
    expect(settleMarker).not.toHaveBeenCalled();
  });

  it('waits for every fallback storage task in one session before propagating a failure', async () => {
    const persistenceError = new Error('first fallback error insert rejected');
    let releaseSecondStorage!: () => void;
    const secondStorage = new Promise<void>((resolve) => {
      releaseSecondStorage = resolve;
    });
    const replay = vi.fn(() => {
      trackWindowsSessionEndFallbackStorageTask(
        'same-failed-marker-session',
        Promise.reject(persistenceError),
        { requireSuccess: true },
      );
      trackWindowsSessionEndFallbackStorageTask('same-failed-marker-session', secondStorage, {
        requireSuccess: true,
      });
    });
    markWindowsSessionEnding([activeTurn('same-failed-marker-session')]);
    expect(
      deferWindowsSessionEndEvent(
        'same-failed-marker-session',
        'claude-code',
        claudeTerminalError,
        replay,
      ),
    ).toBe(true);
    const settleMarker = vi.fn(async () => undefined);

    const settlement = settleWindowsSessionEndRecoveryMarkers([], settleMarker);
    let settlementFinished = false;
    void settlement.then(
      () => {
        settlementFinished = true;
      },
      () => {
        settlementFinished = true;
      },
    );
    await vi.waitFor(() => expect(replay).toHaveBeenCalledOnce());
    expect(settlementFinished).toBe(false);
    expect(settleMarker).not.toHaveBeenCalled();

    releaseSecondStorage();
    await expect(settlement).rejects.toBe(persistenceError);
    expect(settleMarker).not.toHaveBeenCalled();
  });

  it('waits for every failed-marker session before propagating a required task failure', async () => {
    const persistenceError = new Error('first fallback error insert rejected');
    let releaseSecondStorage!: () => void;
    const secondStorage = new Promise<void>((resolve) => {
      releaseSecondStorage = resolve;
    });
    const firstReplay = vi.fn(() => {
      trackWindowsSessionEndFallbackStorageTask(
        'first-failed-marker-session',
        Promise.reject(persistenceError),
        { requireSuccess: true },
      );
    });
    const secondReplay = vi.fn(() => {
      trackWindowsSessionEndFallbackStorageTask(
        'second-failed-marker-session',
        secondStorage,
        { requireSuccess: true },
      );
    });
    markWindowsSessionEnding([
      activeTurn('first-failed-marker-session'),
      activeTurn('second-failed-marker-session'),
    ]);
    expect(
      deferWindowsSessionEndEvent(
        'first-failed-marker-session',
        'claude-code',
        claudeTerminalError,
        firstReplay,
      ),
    ).toBe(true);
    expect(
      deferWindowsSessionEndEvent(
        'second-failed-marker-session',
        'claude-code',
        claudeTerminalError,
        secondReplay,
      ),
    ).toBe(true);
    const settleMarker = vi.fn(async () => undefined);

    const settlement = settleWindowsSessionEndRecoveryMarkers([], settleMarker);
    let settlementFinished = false;
    void settlement.then(
      () => {
        settlementFinished = true;
      },
      () => {
        settlementFinished = true;
      },
    );
    await vi.waitFor(() => {
      expect(firstReplay).toHaveBeenCalledOnce();
      expect(secondReplay).toHaveBeenCalledOnce();
    });
    expect(settlementFinished).toBe(false);
    expect(settleMarker).not.toHaveBeenCalled();

    releaseSecondStorage();
    await expect(settlement).rejects.toBe(persistenceError);
    expect(settleMarker).toHaveBeenCalledOnce();
    expect(settleMarker).toHaveBeenCalledWith('second-failed-marker-session');
  });

  it('does not settle a failed marker from continuation-only done boundaries', async () => {
    const calls: string[] = [];
    markWindowsSessionEnding([activeTurn('active-session')]);

    const settlement = settleWindowsSessionEndRecoveryMarkers([]);
    let settled = false;
    void settlement.then(() => {
      settled = true;
    });
    await Promise.resolve();

    expect(
      deferWindowsSessionEndEvent(
        'active-session',
        'claude-code',
        claudeContinuationDone,
        () => calls.push('continuation'),
      ),
    ).toBe(true);
    expect(
      deferWindowsSessionEndEvent(
        'active-session',
        'claude-code',
        claudeSilentStopDone,
        () => calls.push('silent-stop'),
      ),
    ).toBe(true);
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(calls).toEqual([]);

    expect(
      deferWindowsSessionEndEvent('active-session', 'claude-code', claudeDone, () =>
        calls.push('terminal'),
      ),
    ).toBe(true);
    await expect(settlement).resolves.toEqual(['active-session']);
    expect(calls).toEqual(['continuation', 'silent-stop', 'terminal']);
  });

  it('still waits for a terminal when continuation callbacks precede marker failure', async () => {
    const calls: string[] = [];
    markWindowsSessionEnding([activeTurn('active-session')]);
    expect(
      deferWindowsSessionEndEvent(
        'active-session',
        'claude-code',
        claudeContinuationDone,
        () => calls.push('continuation'),
      ),
    ).toBe(true);
    expect(
      deferWindowsSessionEndEvent(
        'active-session',
        'claude-code',
        claudeSilentStopDone,
        () => calls.push('silent-stop'),
      ),
    ).toBe(true);

    const settlement = settleWindowsSessionEndRecoveryMarkers([]);
    let settled = false;
    void settlement.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(calls).toEqual([]);

    expect(
      deferWindowsSessionEndEvent('active-session', 'claude-code', claudeDone, () =>
        calls.push('terminal'),
      ),
    ).toBe(true);
    await expect(settlement).resolves.toEqual(['active-session']);
    expect(calls).toEqual(['continuation', 'silent-stop', 'terminal']);
  });

  it('settles each late fallback without waiting for another session', async () => {
    const calls: string[] = [];
    markWindowsSessionEnding([activeTurn('first-session'), activeTurn('second-session')]);

    const settlement = settleWindowsSessionEndRecoveryMarkers([], async (sessionId) => {
      calls.push(`settled:${sessionId}`);
    });
    expect(
      deferWindowsSessionEndEvent(
        'first-session',
        'claude-code',
        claudeTerminalError,
        () => calls.push('replayed:first-session'),
      ),
    ).toBe(true);
    await vi.waitFor(() =>
      expect(calls).toEqual(['replayed:first-session', 'settled:first-session']),
    );

    expect(
      deferWindowsSessionEndEvent(
        'second-session',
        'claude-code',
        claudeTerminalError,
        () => calls.push('replayed:second-session'),
      ),
    ).toBe(true);
    await expect(settlement).resolves.toEqual(['first-session', 'second-session']);
    expect(calls).toEqual([
      'replayed:first-session',
      'settled:first-session',
      'replayed:second-session',
      'settled:second-session',
    ]);
  });

  it('settles recovery marker outcomes independently per session', async () => {
    const durableReplay = vi.fn();
    const durableDiscard = vi.fn();
    const failedReplay = vi.fn();
    const failedDiscard = vi.fn();
    beginWindowsSessionEndQuery([activeTurn('durable-session'), activeTurn('failed-session')]);
    deferWindowsSessionEndEvent(
      'durable-session',
      'claude-code',
      claudeTerminalError,
      durableReplay,
      durableDiscard,
    );
    deferWindowsSessionEndEvent(
      'failed-session',
      'claude-code',
      claudeTerminalError,
      failedReplay,
      failedDiscard,
    );

    markWindowsSessionEnding([]);
    await expect(settleWindowsSessionEndRecoveryMarkers(['durable-session'])).resolves.toEqual([
      'failed-session',
    ]);

    expect(durableReplay).not.toHaveBeenCalled();
    expect(durableDiscard).toHaveBeenCalledTimes(1);
    expect(failedReplay).toHaveBeenCalledTimes(1);
    expect(failedDiscard).not.toHaveBeenCalled();
  });

  it('drops a deferred query error paired tail that arrives after confirmation', () => {
    const replay = vi.fn();
    beginWindowsSessionEndQuery([activeTurn('active-session')]);

    expect(
      deferWindowsSessionEndEvent('active-session', 'claude-code', claudeTerminalError, replay),
    ).toBe(true);
    markWindowsSessionEnding([]);
    expect(
      deferWindowsSessionEndEvent('active-session', 'claude-code', claudeIdleStatus, vi.fn()),
    ).toBe(true);
    expect(
      deferWindowsSessionEndEvent('active-session', 'claude-code', claudeDone, vi.fn()),
    ).toBe(true);
    expect(replay).not.toHaveBeenCalled();
  });

  it('replays query-phase events in FIFO order when Windows cancels the request', () => {
    const calls: string[] = [];

    beginWindowsSessionEndQuery([activeTurn('active-session')]);
    deferWindowsSessionEndEvent(
      'active-session',
      'claude-code',
      claudeTerminalError,
      () => calls.push('terminal'),
    );
    deferWindowsSessionEndEvent('active-session', 'claude-code', claudeIdleStatus, () =>
      calls.push('paired-status'),
    );
    deferWindowsSessionEndEvent('active-session', 'claude-code', claudeDone, () =>
      calls.push('paired-done'),
    );

    expect(calls).toEqual([]);
    cancelWindowsSessionEndQuery();
    expect(calls).toEqual(['terminal', 'paired-status', 'paired-done']);
    expect(
      deferWindowsSessionEndEvent(
        'active-session',
        'claude-code',
        claudeTerminalError,
        vi.fn(),
      ),
    ).toBe(false);
  });

  it('commits a normal done and excludes it from the interrupted snapshot', () => {
    const replay = vi.fn();
    beginWindowsSessionEndQuery([activeTurn('active-session')]);

    expect(
      deferWindowsSessionEndEvent('active-session', 'claude-code', claudeDone, replay),
    ).toBe(false);
    expect(markWindowsSessionEnding([])).toEqual([]);
    expect(replay).not.toHaveBeenCalled();
  });

  it('does not let a stale done retire the query-time current generation', () => {
    const replay = vi.fn();
    beginWindowsSessionEndQuery([activeTurn('generation-race', 2)]);

    expect(
      deferWindowsSessionEndEvent(
        'generation-race',
        'claude-code',
        { ...claudeDone, sessionTurnGeneration: 1 },
        vi.fn(),
      ),
    ).toBe(false);
    expect(
      deferWindowsSessionEndEvent(
        'generation-race',
        'claude-code',
        { ...claudeTerminalError, sessionTurnGeneration: 2 },
        replay,
      ),
    ).toBe(true);

    expect(markWindowsSessionEnding([])).toEqual(['generation-race']);
    expect(replay).not.toHaveBeenCalled();
  });

  it('protects a new Claude turn that starts after the query snapshot', () => {
    const replay = vi.fn();
    beginWindowsSessionEndQuery([activeTurn('completed-session')]);
    expect(
      deferWindowsSessionEndEvent('completed-session', 'claude-code', claudeDone, vi.fn()),
    ).toBe(false);

    expect(noteWindowsSessionEndTurnStarted('late-session', 'claude-code', 1)).toBe(true);
    expect(noteWindowsSessionEndTurnStarted('codex-session', 'codex', 1)).toBe(false);
    expect(
      deferWindowsSessionEndEvent('late-session', 'claude-code', claudeTerminalError, replay),
    ).toBe(true);

    expect(markWindowsSessionEnding([])).toEqual(['late-session']);
    expect(replay).not.toHaveBeenCalled();
  });

  it('closes Claude turn admission after Windows confirms session end', () => {
    expect(shouldRejectWindowsSessionEndTurnStart('claude-code')).toBe(false);

    markWindowsSessionEnding([]);

    expect(shouldRejectWindowsSessionEndTurnStart('claude-code')).toBe(true);
    expect(shouldRejectWindowsSessionEndTurnStart('codex')).toBe(false);
  });

  it('rolls back a query-time turn that never dispatches', () => {
    beginWindowsSessionEndQuery([]);

    expect(noteWindowsSessionEndTurnStarted('undispatched-session', 'claude-code', 1)).toBe(true);
    rollbackWindowsSessionEndTurnStarted('undispatched-session', 1);

    expect(markWindowsSessionEnding([])).toEqual([]);
  });

  it('rolls back an undispatched turn already owned by the query snapshot', () => {
    beginWindowsSessionEndQuery([activeTurn('snapshot-owned-session')]);

    expect(noteWindowsSessionEndTurnStarted('snapshot-owned-session', 'claude-code', 1)).toBe(true);
    rollbackWindowsSessionEndTurnStarted('snapshot-owned-session', 1);

    expect(markWindowsSessionEnding([])).toEqual([]);
  });

  it('counts overlapping product turns independently', () => {
    beginWindowsSessionEndQuery([activeTurn('overlap-session')]);
    expect(noteWindowsSessionEndTurnStarted('overlap-session', 'claude-code', 2)).toBe(true);

    expect(
      deferWindowsSessionEndEvent('overlap-session', 'claude-code', claudeDone, vi.fn()),
    ).toBe(false);
    expect(markWindowsSessionEnding([])).toEqual(['overlap-session']);
  });

  it('keeps a silent-stop replacement in the same product-turn slot', () => {
    beginWindowsSessionEndQuery([activeTurn('silent-stop-session')]);
    expect(
      deferWindowsSessionEndEvent(
        'silent-stop-session',
        'claude-code',
        claudeSilentStopDone,
        vi.fn(),
      ),
    ).toBe(false);
    expect(noteWindowsSessionEndTurnStarted('silent-stop-session', 'claude-code', 2)).toBe(true);

    finishWindowsSessionEndProductTurn('silent-stop-session', 2);

    expect(markWindowsSessionEnding([])).toEqual([]);
  });

  it('rolls back an undispatched silent-stop continuation after slot transfer', () => {
    beginWindowsSessionEndQuery([activeTurn('silent-stop-undispatched')]);
    expect(
      deferWindowsSessionEndEvent(
        'silent-stop-undispatched',
        'claude-code',
        claudeSilentStopDone,
        vi.fn(),
      ),
    ).toBe(false);
    expect(
      noteWindowsSessionEndTurnStarted('silent-stop-undispatched', 'claude-code', 2),
    ).toBe(true);

    rollbackWindowsSessionEndTurnStarted('silent-stop-undispatched', 2);
    finishWindowsSessionEndProductTurn('silent-stop-undispatched', 1);

    expect(markWindowsSessionEnding([])).toEqual([]);
  });

  it('does not transfer an old instance silent-stop to a replacement Session', () => {
    beginWindowsSessionEndQuery([activeTurn('shared-session', 1, 'old-instance')]);
    expect(
      deferWindowsSessionEndEvent(
        'shared-session',
        'claude-code',
        { ...claudeSilentStopDone, sessionInstanceId: 'old-instance' },
        vi.fn(),
        undefined,
        'old-instance',
      ),
    ).toBe(false);

    expect(
      noteWindowsSessionEndTurnStarted(
        'shared-session',
        'claude-code',
        1,
        undefined,
        'replacement-instance',
      ),
    ).toBe(true);
    rollbackWindowsSessionEndTurnStarted('shared-session', 1, 'replacement-instance');

    expect(markWindowsSessionEnding([])).toEqual(['shared-session']);
    expect(
      shouldSuppressWindowsSessionEndClaudeError({
        sessionId: 'shared-session',
        source: 'claude-code',
        isTerminalError: true,
        sessionInstanceId: 'old-instance',
        sessionTurnGeneration: 1,
      }),
    ).toBe(true);
    expect(
      shouldSuppressWindowsSessionEndClaudeError({
        sessionId: 'shared-session',
        source: 'claude-code',
        isTerminalError: true,
        sessionInstanceId: 'replacement-instance',
        sessionTurnGeneration: 1,
      }),
    ).toBe(false);
  });

  it('keeps silent-stop continuation slots for both Session instances', async () => {
    const calls: string[] = [];
    beginWindowsSessionEndQuery([
      activeTurn('shared-session', 1, 'instance-a'),
      activeTurn('shared-session', 1, 'instance-b'),
    ]);
    expect(
      deferWindowsSessionEndEvent(
        'shared-session',
        'claude-code',
        { ...claudeSilentStopDone, sessionInstanceId: 'instance-a' },
        vi.fn(),
        undefined,
        'instance-a',
      ),
    ).toBe(false);
    expect(
      deferWindowsSessionEndEvent(
        'shared-session',
        'claude-code',
        { ...claudeSilentStopDone, sessionInstanceId: 'instance-b' },
        vi.fn(),
        undefined,
        'instance-b',
      ),
    ).toBe(false);

    expect(
      noteWindowsSessionEndTurnStarted(
        'shared-session',
        'claude-code',
        2,
        undefined,
        'instance-a',
      ),
    ).toBe(true);
    expect(
      noteWindowsSessionEndTurnStarted(
        'shared-session',
        'claude-code',
        2,
        undefined,
        'instance-b',
      ),
    ).toBe(true);

    expect(markWindowsSessionEnding([])).toEqual(['shared-session']);
    for (const [sessionInstanceId, sessionTurnGeneration, expected] of [
      ['instance-a', 1, false],
      ['instance-a', 2, true],
      ['instance-b', 1, false],
      ['instance-b', 2, true],
    ] as const) {
      expect(
        shouldSuppressWindowsSessionEndClaudeError({
          sessionId: 'shared-session',
          source: 'claude-code',
          isTerminalError: true,
          sessionInstanceId,
          sessionTurnGeneration,
        }),
      ).toBe(expected);
    }

    const settlement = settleWindowsSessionEndRecoveryMarkers([]);
    let settled = false;
    void settlement.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    expect(
      deferWindowsSessionEndEvent(
        'shared-session',
        'claude-code',
        {
          ...claudeTerminalError,
          sessionInstanceId: 'instance-a',
          sessionTurnGeneration: 2,
        },
        () => calls.push('instance-a:2'),
        undefined,
        'instance-a',
      ),
    ).toBe(true);
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(
      deferWindowsSessionEndEvent(
        'shared-session',
        'claude-code',
        {
          ...claudeTerminalError,
          sessionInstanceId: 'instance-b',
          sessionTurnGeneration: 2,
        },
        () => calls.push('instance-b:2'),
        undefined,
        'instance-b',
      ),
    ).toBe(true);

    await expect(settlement).resolves.toEqual(['shared-session']);
    expect(calls).toEqual(['instance-a:2', 'instance-b:2']);
  });

  it('retires only the closed Session instance from the advisory snapshot', () => {
    beginWindowsSessionEndQuery([
      activeTurn('shared-session', 1, 'closing-instance'),
      activeTurn('shared-session', 2, 'closing-instance'),
      activeTurn('shared-session', 1, 'replacement-instance'),
    ]);

    finishWindowsSessionEndSessionClosed('shared-session', 'closing-instance');

    expect(markWindowsSessionEnding([])).toEqual(['shared-session']);
    expect(
      shouldSuppressWindowsSessionEndClaudeError({
        sessionId: 'shared-session',
        source: 'claude-code',
        isTerminalError: true,
        sessionInstanceId: 'closing-instance',
        sessionTurnGeneration: 1,
      }),
    ).toBe(false);
    expect(
      shouldSuppressWindowsSessionEndClaudeError({
        sessionId: 'shared-session',
        source: 'claude-code',
        isTerminalError: true,
        sessionInstanceId: 'replacement-instance',
        sessionTurnGeneration: 1,
      }),
    ).toBe(true);
  });

  it('keeps a continuation boundary in the interrupted snapshot', () => {
    const terminalReplay = vi.fn();
    beginWindowsSessionEndQuery([activeTurn('active-session')]);

    expect(
      deferWindowsSessionEndEvent(
        'active-session',
        'claude-code',
        claudeContinuationDone,
        vi.fn(),
      ),
    ).toBe(false);
    expect(
      deferWindowsSessionEndEvent(
        'active-session',
        'claude-code',
        claudeTerminalError,
        terminalReplay,
      ),
    ).toBe(true);

    expect(markWindowsSessionEnding([])).toEqual(['active-session']);
    expect(terminalReplay).not.toHaveBeenCalled();
  });

  it('keeps a silent-stop boundary in the interrupted snapshot', () => {
    const terminalReplay = vi.fn();
    beginWindowsSessionEndQuery([activeTurn('active-session')]);

    expect(
      deferWindowsSessionEndEvent(
        'active-session',
        'claude-code',
        claudeSilentStopDone,
        vi.fn(),
      ),
    ).toBe(false);
    expect(
      deferWindowsSessionEndEvent(
        'active-session',
        'claude-code',
        claudeTerminalError,
        terminalReplay,
      ),
    ).toBe(true);

    expect(markWindowsSessionEnding([])).toEqual(['active-session']);
    expect(terminalReplay).not.toHaveBeenCalled();
  });

  it('passes high-volume non-terminal events through without dropping query protection', () => {
    const replay = vi.fn();
    const gate = createWindowsSessionEndEventGate('active-session', 'claude-code');

    beginWindowsSessionEndQuery([activeTurn('active-session')]);
    for (let index = 0; index < 128; index += 1) {
      expect(gate.shouldRun?.(claudeText)).toBe(false);
      expect(
        deferWindowsSessionEndEvent('active-session', 'claude-code', claudeText, vi.fn()),
      ).toBe(false);
    }
    expect(gate.shouldRun?.(claudeTerminalError)).toBe(true);
    expect(
      deferWindowsSessionEndEvent('active-session', 'claude-code', claudeTerminalError, replay),
    ).toBe(true);
    expect(gate.shouldRun?.(claudeIdleStatus)).toBe(true);
    expect(
      deferWindowsSessionEndEvent('active-session', 'claude-code', claudeIdleStatus, vi.fn()),
    ).toBe(true);

    markWindowsSessionEnding([]);

    expect(replay).not.toHaveBeenCalled();
  });

  it('retains the query-time active snapshot through confirmation', () => {
    beginWindowsSessionEndQuery([activeTurn('query-time-session')]);

    expect(markWindowsSessionEnding([activeTurn('confirmation-time-session')])).toEqual([
      'query-time-session',
      'confirmation-time-session',
    ]);
    expect(
      shouldSuppressWindowsSessionEndClaudeError({
        sessionId: 'query-time-session',
        source: 'claude-code',
        isTerminalError: true,
        sessionTurnGeneration: 1,
      }),
    ).toBe(true);
  });

  it('contains cancellation replay failures and continues replaying later callbacks', () => {
    const afterFailure = vi.fn();

    beginWindowsSessionEndQuery([activeTurn('active-session')]);
    deferWindowsSessionEndEvent(
      'active-session',
      'claude-code',
      claudeTerminalError,
      () => {
        throw new Error('listener failed');
      },
    );
    deferWindowsSessionEndEvent('active-session', 'claude-code', claudeDone, afterFailure);

    expect(() => cancelWindowsSessionEndQuery()).not.toThrow();
    expect(afterFailure).toHaveBeenCalledTimes(1);
  });

  it('keeps query evidence across an arbitrarily late confirmation', () => {
    vi.useFakeTimers();
    const replay = vi.fn();
    beginWindowsSessionEndQuery([activeTurn('active-session')]);
    deferWindowsSessionEndEvent('active-session', 'claude-code', claudeTerminalError, replay);

    vi.advanceTimersByTime(60_000);

    expect(replay).not.toHaveBeenCalled();
    expect(markWindowsSessionEnding([])).toEqual(['active-session']);
    expect(replay).not.toHaveBeenCalled();
  });
});
