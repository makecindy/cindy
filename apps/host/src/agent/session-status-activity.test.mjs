import test from 'node:test';
import assert from 'node:assert/strict';
import { createHostSessionActivityTracker } from './session-status-activity.ts';

test('Host session activity tracker emits running, interaction, completed, and read-clear transitions', async () => {
  const emitted = [];
  let now = 1_000;
  let fgChanges = 0;
  const tracker = createHostSessionActivityTracker({
    emit: payload => emitted.push(payload),
    onForegroundActivityChanged: () => { fgChanges += 1; },
    sessionExists: async id => id === 'existing-cold',
    minIntervalMs: 0,
    now: () => now,
  });

  try {
    tracker.handleEvent({ type: 'session_changed', sessionId: 's1', patch: { title: 'Build feature', workingDir: '/repo', agentKind: 'cc' } });
    tracker.handleEvent({ sessionId: 's1', event: { type: 'status', data: { isRunning: true } } });
    assert.equal(emitted.at(-1)?.sessionId, 's1');
    assert.equal(emitted.at(-1)?.phase, 'running');
    assert.equal(emitted.at(-1)?.attention, false);

    now += 100;
    tracker.handleEvent({
      type: 'interaction_request',
      sessionId: 's1',
      request: { kind: 'permission', requestId: 'req-1', toolName: 'Bash', input: { command: 'ls' } },
    });
    assert.equal(emitted.at(-1)?.phase, 'needs-interaction');
    assert.equal(emitted.at(-1)?.interactionKind, 'permission');
    assert.equal(emitted.at(-1)?.attention, true);

    const waitingFg = tracker.getForegroundTaskActivity();
    assert.equal(waitingFg.waitingCount, 1);
    assert.equal(waitingFg.selected?.sessionId, 's1');
    assert.equal(waitingFg.selected?.status, 'attention');
    assert.notEqual(tracker.getForegroundTaskActivity(true), null);
    assert.equal(tracker.getForegroundTaskActivity(true), null);

    now += 100;
    tracker.handleEvent({ type: 'interaction_dismissed', sessionId: 's1', requestId: 'req-1', reason: 'resolved' });
    assert.equal(emitted.at(-1)?.phase, 'running');

    now += 100;
    tracker.handleEvent({ sessionId: 's1', event: { type: 'done', data: {} } });
    assert.equal(emitted.at(-1)?.phase, 'completed');
    assert.equal(emitted.at(-1)?.attention, true);

    const replayed = [];
    tracker.replay(payload => replayed.push(payload));
    assert.equal(replayed.length, 1);
    assert.equal(replayed[0].sessionId, 's1');
    assert.equal(replayed[0].phase, 'completed');
    assert.equal(replayed[0].attention, true);

    await tracker.acknowledgeRead('s1', 'explicit');
    assert.equal(emitted.at(-1)?.sessionId, 's1');
    assert.equal(emitted.at(-1)?.attention, false);

    const beforeCold = emitted.length;
    await tracker.acknowledgeRead('missing-cold', 'explicit');
    assert.equal(emitted.length, beforeCold);
    await tracker.acknowledgeRead('existing-cold', 'explicit');
    assert.equal(emitted.at(-1)?.sessionId, 'existing-cold');
    assert.equal(emitted.at(-1)?.attention, false);

    await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(fgChanges >= 1);
  } finally {
    tracker.dispose();
  }
});

test('Host session activity tracker clears interrupted runs without unread completion and removes deleted sessions', async () => {
  const emitted = [];
  let now = 2_000;
  const tracker = createHostSessionActivityTracker({
    emit: payload => emitted.push(payload),
    minIntervalMs: 0,
    now: () => now,
  });

  try {
    tracker.handleEvent({ sessionId: 's-stop', event: { type: 'status', data: { isRunning: true } } });
    assert.equal(emitted.at(-1)?.phase, 'running');

    now += 50;
    tracker.handleEvent({ type: 'input_receipt', sessionId: 's-stop', status: 'interrupted' });
    assert.equal(emitted.at(-1)?.sessionId, 's-stop');
    assert.equal(emitted.at(-1)?.phase, 'completed');
    assert.equal(emitted.at(-1)?.attention, false);

    const countAfterStop = emitted.length;
    tracker.handleEvent({ sessionId: 's-stop', event: { type: 'done', data: {} } });
    assert.equal(emitted.length, countAfterStop);

    now += 50;
    tracker.handleEvent({ sessionId: 's-stop', event: { type: 'status', data: { isRunning: true } } });
    assert.equal(emitted.at(-1)?.phase, 'running');

    now += 50;
    tracker.handleEvent({ sessionId: 's-stop', event: { type: 'error', data: { message: 'boom', isTerminal: true } } });
    assert.equal(emitted.at(-1)?.phase, 'error');
    assert.equal(emitted.at(-1)?.attention, true);

    const countAfterError = emitted.length;
    await tracker.acknowledgeRead('s-stop', 'passive');
    assert.equal(emitted.length, countAfterError);

    await tracker.acknowledgeRead('s-stop', 'explicit');
    assert.equal(emitted.at(-1)?.attention, false);

    now += 50;
    tracker.handleEvent({ sessionId: 's-del', event: { type: 'status', data: { isRunning: true } } });
    assert.equal(emitted.at(-1)?.phase, 'running');
    tracker.handleEvent({ type: 'session_changed', sessionId: 's-del', action: 'delete', status: 'deleted' });
    assert.equal(emitted.at(-1)?.sessionId, 's-del');
    assert.equal(emitted.at(-1)?.attention, false);
    const replayAfterDelete = [];
    tracker.replay(payload => replayAfterDelete.push(payload), 's-del');
    assert.equal(replayAfterDelete.every(p => p.attention === false), true);
  } finally {
    tracker.dispose();
  }
});

test('Host session activity tracker keeps silent-stop continuation open, suppresses muted/worker summaries, and prunes expired entries', () => {
  const emitted = [];
  let now = 10_000;
  let fgChanges = 0;
  const timers = new Map();
  let nextTimerId = 1;
  const muted = new Set(['s-muted']);
  const workers = new Set(['s-worker']);
  const tracker = createHostSessionActivityTracker({
    emit: payload => emitted.push(payload),
    onForegroundActivityChanged: () => { fgChanges += 1; },
    isSessionMuted: id => muted.has(id),
    isOrcaWorker: id => workers.has(id),
    minIntervalMs: 0,
    now: () => now,
    setTimer: (fn, ms) => {
      const id = nextTimerId++;
      timers.set(id, { fn, at: now + ms });
      return id;
    },
    clearTimer: id => { timers.delete(id); },
  });

  try {
    // Silent-stop continuation must not drop a subsequent exhausted terminal error.
    tracker.handleEvent({ sessionId: 's-cont', event: { type: 'status', data: { isRunning: true } } });
    tracker.handleEvent({ sessionId: 's-cont', event: { type: 'done', data: { silentStop: true } } });
    tracker.handleEvent({ sessionId: 's-cont', event: { type: 'error', data: { message: 'exhausted', isTerminal: true } } });
    assert.equal(emitted.at(-1)?.sessionId, 's-cont');
    assert.equal(emitted.at(-1)?.phase, 'error');
    assert.equal(emitted.at(-1)?.attention, true);

    // Muted task stays on sidebar activity push but is excluded from foreground summary; worker excluded from both.
    tracker.handleEvent({ sessionId: 's-muted', event: { type: 'status', data: { isRunning: true } } });
    assert.equal(emitted.at(-1)?.sessionId, 's-muted');
    assert.equal(emitted.at(-1)?.phase, 'running');

    const beforeWorker = emitted.length;
    tracker.handleEvent({ sessionId: 's-worker', event: { type: 'status', data: { isRunning: true } } });
    assert.equal(emitted.length, beforeWorker);

    const fg = tracker.getForegroundTaskActivity();
    assert.equal(fg.runningCount, 0);
    assert.equal(fg.unreadCount, 1);
    assert.equal(fg.selected?.sessionId, 's-cont');

    // Advancing past retention TTL fires the prune timer and updates foreground summary.
    now += 25 * 60 * 60 * 1_000;
    const due = [...timers.entries()].sort((a, b) => a[1].at - b[1].at);
    for (const [id, entry] of due) {
      if (entry.at <= now) {
        timers.delete(id);
        entry.fn();
      }
    }
    const fgAfterPrune = tracker.getForegroundTaskActivity();
    assert.equal(fgAfterPrune.unreadCount, 0);
    assert.equal(fgAfterPrune.selected, null);
    assert.ok(fgChanges >= 1);
  } finally {
    tracker.dispose();
  }
});

test('Host session activity tracker handles silent-stop pending, turn_stopped, post-TTL archive, hydration, and stream coalescing', async () => {
  const emitted = [];
  let now = 20_000;
  const timers = new Map();
  let nextTimerId = 1;
  const runTimers = (maxAt = Infinity) => {
    while (true) {
      const due = [...timers.entries()].filter(([, entry]) => entry.at <= maxAt).sort((a, b) => a[1].at - b[1].at);
      if (!due.length) break;
      const [id, entry] = due[0];
      timers.delete(id);
      entry.fn();
    }
  };
  let resolveMeta;
  const metaReads = [];
  const tracker = createHostSessionActivityTracker({
    emit: payload => emitted.push(payload),
    readSessionMeta: id => {
      metaReads.push(id);
      return new Promise(resolve => { resolveMeta = resolve; });
    },
    minIntervalMs: 0,
    streamCoalesceMs: 250,
    now: () => now,
    setTimer: (fn, ms) => {
      const id = nextTimerId++;
      timers.set(id, { fn, at: now + ms });
      return id;
    },
    clearTimer: id => { timers.delete(id); },
  });

  try {
    // 1. Silent-stop pending holds completion across status:Done + done(silentStopPending), settles on recorded receipt.
    tracker.handleEvent({ sessionId: 's-ss', event: { type: 'status', data: { isRunning: true } } });
    assert.equal(tracker.getSessionActivity('s-ss')?.phase, 'running');
    assert.deepEqual(metaReads, ['s-ss']);
    resolveMeta({ title: 'Hydrated Title', workingDir: '/repo', agentKind: 'cc' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(tracker.getForegroundTaskActivity().selected?.title, 'Hydrated Title');

    tracker.handleEvent({ sessionId: 's-ss', event: { type: 'status', data: { isRunning: false, status: 'Done' } } });
    assert.equal(tracker.getSessionActivity('s-ss')?.phase, 'running');
    tracker.handleEvent({ sessionId: 's-ss', silentStopPending: true, event: { type: 'done', data: { silentStop: true } } });
    assert.equal(tracker.getSessionActivity('s-ss')?.phase, 'running');

    tracker.handleEvent({ type: 'input_receipt', sessionId: 's-ss', status: 'recorded' });
    assert.equal(tracker.getSessionActivity('s-ss')?.phase, 'completed');
    assert.equal(tracker.getSessionActivity('s-ss')?.attention, true);

    // 2. Post-TTL archive clears remoteUnreadTerminals so replay stays empty.
    now += 25 * 60 * 60 * 1_000;
    runTimers(now);
    assert.equal(tracker.getSessionActivity('s-ss')?.attention, true);
    tracker.handleEvent({ type: 'session_changed', sessionId: 's-ss', patch: { status: 'archived' } });
    assert.equal(tracker.getSessionActivity('s-ss'), null);
    const replayedArchived = [];
    tracker.replay(payload => replayedArchived.push(payload), 's-ss');
    assert.equal(replayedArchived.every(item => item.attention === false), true);

    // 3. Explicit Host turn_stopped suppresses trailing status:Done and done{}, and status:cancelled never marks unread.
    tracker.handleEvent({ sessionId: 's-abort', event: { type: 'status', data: { isRunning: true } } });
    tracker.handleEvent({ type: 'turn_stopped', sessionId: 's-abort' });
    const countAfterAbort = emitted.length;
    tracker.handleEvent({ sessionId: 's-abort', event: { type: 'status', data: { isRunning: false, status: 'Done' } } });
    tracker.handleEvent({ sessionId: 's-abort', event: { type: 'done', data: {} } });
    assert.equal(emitted.length, countAfterAbort);
    assert.equal(tracker.getSessionActivity('s-abort'), null);

    tracker.handleEvent({ sessionId: 's-cancel', event: { type: 'status', data: { isRunning: true } } });
    tracker.handleEvent({ sessionId: 's-cancel', event: { type: 'done', data: { status: 'cancelled' } } });
    assert.equal(tracker.getSessionActivity('s-cancel'), null);

    // 4. Streaming text chunks coalesce until the 250ms timer fires.
    tracker.handleEvent({ sessionId: 's-stream', event: { type: 'status', data: { isRunning: true } } });
    const countBeforeChunks = emitted.length;
    tracker.handleEvent({ sessionId: 's-stream', event: { type: 'text', data: { text: 'hello ' } } });
    tracker.handleEvent({ sessionId: 's-stream', event: { type: 'text', data: { text: 'world' } } });
    assert.equal(emitted.length, countBeforeChunks);
    now += 250;
    runTimers(now);
    assert.ok(emitted.length > countBeforeChunks);
  } finally {
    tracker.dispose();
  }
});

test('Host session activity tracker suppresses autoResumePending errors, retains failed aborts, cleans standalone approvals, and defers queued completions', () => {
  const emitted = [];
  let now = 50_000;
  let queued = false;
  const tracker = createHostSessionActivityTracker({
    emit: payload => emitted.push(payload),
    hasPendingQueuedWork: id => id === 's-queue' && queued,
    minIntervalMs: 0,
    streamCoalesceMs: 0,
    now: () => now,
  });

  try {
    tracker.handleEvent({ sessionId: 's-ar', event: { type: 'status', data: { isRunning: true } } });
    tracker.handleEvent({ sessionId: 's-ar', autoResumePending: { reason: 'rate_limit' }, event: { type: 'error', data: { message: 'retry', isTerminal: true } } });
    assert.equal(tracker.getSessionActivity('s-ar')?.phase, 'running');
    assert.equal(tracker.getSessionActivity('s-ar')?.attention, false);
    tracker.handleEvent({ sessionId: 's-ar', event: { type: 'done', data: {} } });
    assert.equal(tracker.getSessionActivity('s-ar')?.phase, 'completed');

    tracker.handleEvent({ sessionId: 's-fa', event: { type: 'status', data: { isRunning: true } } });
    tracker.handleEvent({ type: 'turn_stop_requested', sessionId: 's-fa' });
    assert.equal(tracker.getSessionActivity('s-fa')?.phase, 'running');
    tracker.handleEvent({ type: 'turn_stop_failed', sessionId: 's-fa' });
    assert.equal(tracker.getSessionActivity('s-fa')?.phase, 'running');
    tracker.handleEvent({ sessionId: 's-fa', event: { type: 'done', data: {} } });
    assert.equal(tracker.getSessionActivity('s-fa')?.phase, 'completed');
    assert.equal(tracker.getSessionActivity('s-fa')?.attention, true);

    tracker.handleEvent({
      type: 'interaction_request',
      sessionId: 's-mcp',
      request: { kind: 'permission', requestId: 'mcp-1', toolName: 'Bash', input: {} },
    });
    assert.equal(tracker.getSessionActivity('s-mcp')?.phase, 'needs-interaction');
    tracker.handleEvent({ type: 'interaction_dismissed', sessionId: 's-mcp', requestId: 'mcp-1', reason: 'denied' });
    assert.equal(tracker.getSessionActivity('s-mcp'), null);
    assert.equal(tracker.getForegroundTaskActivity().runningCount, 0);

    queued = true;
    tracker.handleEvent({ sessionId: 's-queue', event: { type: 'status', data: { isRunning: true } } });
    tracker.handleEvent({ sessionId: 's-queue', event: { type: 'done', data: {} } });
    assert.equal(tracker.getSessionActivity('s-queue')?.phase, 'running');
    queued = false;
    tracker.handleEvent({ type: 'input_projection', sessionId: 's-queue', projection: { sessionId: 's-queue', turnInProgress: true, pendingQueue: [] } });
    assert.equal(tracker.getSessionActivity('s-queue')?.phase, 'running');
    queued = true;
    tracker.handleEvent({ sessionId: 's-queue', event: { type: 'done', data: {} } });
    queued = false;
    tracker.handleEvent({ type: 'queue_emptied', sessionId: 's-queue' });
    assert.equal(tracker.getSessionActivity('s-queue')?.phase, 'completed');
    assert.equal(tracker.getSessionActivity('s-queue')?.attention, true);

    tracker.handleEvent({ sessionId: 's-bg', event: { type: 'status', data: { isRunning: true } } });
    tracker.handleEvent({ sessionId: 's-bg', event: { type: 'done', turnScope: 'background', data: {} } });
    tracker.handleEvent({ sessionId: 's-bg', event: { type: 'error', turnScope: 'background', data: { message: 'bg fail', isTerminal: true } } });
    assert.equal(tracker.getSessionActivity('s-bg')?.phase, 'running');

    tracker.handleEvent({ sessionId: 's-ar-fail', event: { type: 'status', data: { isRunning: true } } });
    tracker.handleEvent({ sessionId: 's-ar-fail', autoResumePending: { reason: 'rate_limit' }, event: { type: 'error', data: { message: 'rate limited', isTerminal: true } } });
    tracker.handleEvent({ type: 'auto_resume_error_surfaced', sessionId: 's-ar-fail', detail: { message: 'rate limited' } });
    tracker.handleEvent({ type: 'input_receipt', sessionId: 's-ar-fail', status: 'interrupted', autoResumeErrorSurfaced: true });
    assert.equal(tracker.getSessionActivity('s-ar-fail')?.phase, 'error');
    assert.equal(tracker.getSessionActivity('s-ar-fail')?.attention, true);

    const map = tracker.getSessionActivityMap();
    assert.equal(map.get('s-queue')?.phase, 'completed');
    assert.equal(map.get('s-ar-fail')?.phase, 'error');
    assert.equal(map.get('s-mcp'), undefined);
  } finally {
    tracker.dispose();
  }
});
