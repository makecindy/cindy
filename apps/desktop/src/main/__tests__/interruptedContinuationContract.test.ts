import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const registerSource = readFileSync(
  resolve(__dirname, '..', 'maker-ipc', 'register.ts'),
  'utf8',
).replace(/\r\n?/g, '\n');
// Retain local characterization guards at the production stages they describe.
// Cross-stage delivery and recovery timing run in sessionEventPipeline.test.ts.
const eventSource = [
  'sessionEventPreparation',
  'sessionEventStream',
  'sessionEventDelivery',
  'sessionEventTerminal',
]
  .map((name) => readFileSync(resolve(__dirname, '..', 'maker-ipc', name + '.ts'), 'utf8'))
  .join('\n')
  .replace(/\r\n?/g, '\n')
  .replaceAll('deps.', '');
const coordinatorSource = readFileSync(
  resolve(__dirname, '..', 'maker-ipc', 'agent-input-coordinator.ts'),
  'utf8',
).replace(/\r\n?/g, '\n');
const sessionViewSource = readFileSync(
  resolve(__dirname, '..', '..', 'renderer', 'features', 'cc-agent', 'CCAgentSessionView.tsx'),
  'utf8',
).replace(/\r\n?/g, '\n');

function matchIndexes(haystack: string, pattern: RegExp): number[] {
  const indexes: number[] = [];
  const re = new RegExp(
    pattern.source,
    pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`,
  );
  for (const match of haystack.matchAll(re)) {
    if (typeof match.index === 'number') indexes.push(match.index);
  }
  return indexes;
}

describe('interrupted continuation enqueue contract', () => {
  it('does not durable-ack continue prompts at INPUT_ENQUEUE or onAccepted time', () => {
    const enqueueStart = registerSource.search(/ipcMain\.handle\(\s*MAKER_INVOKE\.INPUT_ENQUEUE/);
    const enqueueEndMatch = /ipcMain\.handle\(\s*MAKER_INVOKE\.INPUT_COMPACT/.exec(
      registerSource.slice(enqueueStart + 1),
    );
    const enqueueEnd = enqueueEndMatch ? enqueueStart + 1 + enqueueEndMatch.index : -1;
    expect(enqueueStart).toBeGreaterThan(-1);
    expect(enqueueEnd).toBeGreaterThan(enqueueStart);
    const enqueueHandler = registerSource.slice(enqueueStart, enqueueEnd);
    expect(enqueueHandler).toMatch(/inputCoordinator\.enqueue\(\s*sid\s*,\s*queued\b/);
    expect(matchIndexes(enqueueHandler, /ackSessionTurnEndedDurable\s*\(/)).toHaveLength(0);

    const acceptedStart = registerSource.indexOf('onAcceptedQueuedMessage:');
    const acceptedEnd = registerSource.indexOf('onDispatchedUserTurn:', acceptedStart);
    expect(acceptedStart).toBeGreaterThan(-1);
    expect(acceptedEnd).toBeGreaterThan(acceptedStart);
    const acceptedHook = registerSource.slice(acceptedStart, acceptedEnd);
    expect(matchIndexes(acceptedHook, /ackSessionTurnEndedDurable\s*\(/)).toHaveLength(0);
  });

  it('durable-acks continue prompts only after vendor dispatch is irreversible', () => {
    const start = registerSource.indexOf('onDispatchedUserTurn:');
    expect(start).toBeGreaterThan(-1);
    const end = registerSource.indexOf('noteSessionClearBoundary', start);
    expect(end).toBeGreaterThan(start);
    const hook = registerSource.slice(start, end);

    const classifyIndexes = matchIndexes(
      hook,
      /item\.originalSyntheticTrigger\s*!==\s*['"]continue['"]/,
    );
    const acknowledgeIndexes = matchIndexes(
      hook,
      /ackSessionTurnEndedDurable\(\s*sessionId\s*,\s*preVendorDispatchAt\s*\)/,
    );
    expect(classifyIndexes).toHaveLength(1);
    expect(hook).not.toMatch(/syntheticTriggerKind\(\s*item\.text\s*\)/);
    expect(acknowledgeIndexes).toHaveLength(1);
    expect(acknowledgeIndexes[0]).toBeGreaterThan(classifyIndexes[0]!);

    // coordinator must invoke the hook only after isSendDispatched(result) is true.
    const dispatchedCall = coordinatorSource.indexOf(
      'await this.deps.onDispatchedUserTurn?.(sessionId, head, preVendorDispatchAt)',
    );
    expect(dispatchedCall).toBeGreaterThan(-1);
    const windowStart = Math.max(0, dispatchedCall - 500);
    const window = coordinatorSource.slice(windowStart, dispatchedCall);
    const dispatchedCheck = window.lastIndexOf('if (!isSendDispatched(result))');
    expect(dispatchedCheck).toBeGreaterThan(-1);
  });

  it('keeps a scheduler auto-resume owned until dispatch and fails it when discarded', () => {
    const scheduleStart = registerSource.indexOf('autoResumeBookkeeping.schedule(');
    const scheduleEnd = registerSource.indexOf('steerToAgent:', scheduleStart);
    expect(scheduleStart).toBeGreaterThan(-1);
    expect(scheduleEnd).toBeGreaterThan(scheduleStart);
    const scheduleHook = registerSource.slice(scheduleStart, scheduleEnd);
    expect(scheduleHook).not.toMatch(/clearSchedulerAutoResumePending\s*\(/);
    expect(scheduleHook).toMatch(/\(attempt\)\s*=>\s*\{\s*return\s*\(async/);
    expect(scheduleHook).not.toMatch(/void\s*\(async\s*\(\)\s*=>/);

    expect(eventSource).toMatch(/getAutoResumeDeferredOwner\(session\.id\)/);
    const ownerDiscardedStart = registerSource.indexOf('onResumableTurnErrorDiscarded:');
    const ownerDiscardedEnd = registerSource.indexOf('onResumableTurnError:', ownerDiscardedStart);
    expect(registerSource.slice(ownerDiscardedStart, ownerDiscardedEnd)).toMatch(
      /deferredOwner:\s*options\.owner/,
    );

    const dispatchedStart = registerSource.indexOf('onDispatchedUserTurn:');
    const dispatchedEnd = registerSource.indexOf('noteSessionClearBoundary', dispatchedStart);
    expect(dispatchedStart).toBeGreaterThan(-1);
    expect(dispatchedEnd).toBeGreaterThan(dispatchedStart);
    const dispatchedHook = registerSource.slice(dispatchedStart, dispatchedEnd);
    expect(dispatchedHook).toMatch(/attemptToken !== null/);
    expect(dispatchedHook).toMatch(
      /clearSchedulerAutoResumePending\(sessionId, item\.origin\.runId, attemptToken\)/,
    );

    const discardedStart = registerSource.indexOf('onDiscardedQueuedMessage:');
    const discardedEnd = registerSource.indexOf('hasPendingCredentialSwitch:', discardedStart);
    expect(discardedStart).toBeGreaterThan(-1);
    expect(discardedEnd).toBeGreaterThan(discardedStart);
    const discardedHook = registerSource.slice(discardedStart, discardedEnd);
    expect(discardedHook).toMatch(/settleUndispatchedInterruptedAutoResume\(sessionId, item\)/);
    expect(discardedHook).toMatch(
      /finalizeUndispatchedClaimedRetry\(sessionId, item, ['"]cancelled['"]\)/,
    );
    expect(discardedHook).toMatch(/schedulerQueuedPromptDiscardWatchers/);
    const discardedSettleIndex = discardedHook.indexOf(
      'settleUndispatchedInterruptedAutoResume(sessionId, item)',
    );
    const discardedFinalizeIndex = discardedHook.indexOf(
      "finalizeUndispatchedClaimedRetry(sessionId, item, 'cancelled')",
    );
    expect(discardedSettleIndex).toBeGreaterThan(-1);
    expect(discardedFinalizeIndex).toBeGreaterThan(discardedSettleIndex);

    const settleStart = registerSource.indexOf('function settleUndispatchedAutoResumeOutcome(');
    const settleEnd = registerSource.indexOf('\n}\n', settleStart);
    expect(settleStart).toBeGreaterThan(-1);
    expect(settleEnd).toBeGreaterThan(settleStart);
    const settleHelper = registerSource.slice(settleStart, settleEnd);
    expect(settleHelper).toMatch(/autoResumeBookkeeping\.settleOutcomeForClient\(/);
    expect(settleHelper).toMatch(/item\.clientId/);

    const interruptedSettleStart = registerSource.indexOf(
      'function settleUndispatchedInterruptedAutoResume(',
    );
    const interruptedSettleEnd = registerSource.indexOf('\n}\n', interruptedSettleStart);
    expect(interruptedSettleStart).toBeGreaterThan(-1);
    expect(interruptedSettleEnd).toBeGreaterThan(interruptedSettleStart);
    const interruptedSettleHelper = registerSource.slice(
      interruptedSettleStart,
      interruptedSettleEnd,
    );
    expect(interruptedSettleHelper).toMatch(
      /autoResumeBookkeeping\.hasPendingLifecycleForClient\(/,
    );
    expect(interruptedSettleHelper).toMatch(
      /interruptedTurnAutoResumeGuard\.noteResumeSendFailed\(sessionId, attemptToken\)/,
    );

    const undispatchedStart = registerSource.indexOf('onUndispatchedUserTurn:');
    const undispatchedEnd = registerSource.indexOf('onQueueEmptied:', undispatchedStart);
    expect(undispatchedStart).toBeGreaterThan(-1);
    expect(undispatchedEnd).toBeGreaterThan(undispatchedStart);
    const undispatchedHook = registerSource.slice(undispatchedStart, undispatchedEnd);
    expect(undispatchedHook).toMatch(/settleUndispatchedInterruptedAutoResume\(sessionId, item\)/);
    expect(undispatchedHook).toMatch(
      /finalizeUndispatchedClaimedRetry\(sessionId, item, disposition\)/,
    );
    const undispatchedSettleIndex = undispatchedHook.indexOf(
      'settleUndispatchedInterruptedAutoResume(sessionId, item)',
    );
    const undispatchedFinalizeIndex = undispatchedHook.indexOf(
      'finalizeUndispatchedClaimedRetry(sessionId, item, disposition)',
    );
    expect(undispatchedSettleIndex).toBeGreaterThan(-1);
    expect(undispatchedFinalizeIndex).toBeGreaterThan(undispatchedSettleIndex);

    const finalizeStart = registerSource.indexOf('const finalizeUndispatchedClaimedRetry = (');
    const finalizeEnd = registerSource.indexOf('\n  };', finalizeStart);
    expect(finalizeStart).toBeGreaterThan(-1);
    expect(finalizeEnd).toBeGreaterThan(finalizeStart);
    const finalizeHelper = registerSource.slice(finalizeStart, finalizeEnd);
    expect(finalizeHelper).toMatch(/surfaceSuppressedErrorForRetry\(sessionId, item\.clientId\)/);
    expect(finalizeHelper).toMatch(
      /flushSuppressedErrorForRetry\(\s*sessionId,\s*item\.clientId,?\s*\)/,
    );
    expect(finalizeHelper).toMatch(
      /handleAgentIslandSessionStopped\(getStableSessionForTurnBoundary\(sessionId\) \?\? sessionId\)/,
    );
  });

  it('retires an interrupted attempt owner after both done and terminal error settlement', () => {
    const doneStart = eventSource.indexOf('const doneAttemptToken = event.turnAttemptToken;');
    const doneEnd = eventSource.indexOf('const isSilentStopDone', doneStart);
    expect(doneStart).toBeGreaterThan(-1);
    expect(doneEnd).toBeGreaterThan(doneStart);
    expect(eventSource.slice(doneStart, doneEnd)).toMatch(
      /autoResumeBookkeeping\.settleOutcome\(session\.id, doneAttemptToken, 'failed'\);\s*interruptedTurnAutoResumeGuard\.noteAttemptSettled\(session\.id, doneAttemptToken\);/,
    );

    const errorStart = eventSource.indexOf('const failedAttemptToken = event.turnAttemptToken;');
    const errorEnd = eventSource.indexOf('// 终止型 error 可能没有后续 status/done', errorStart);
    expect(errorStart).toBeGreaterThan(-1);
    expect(errorEnd).toBeGreaterThan(errorStart);
    expect(eventSource.slice(errorStart, errorEnd)).toMatch(
      /autoResumeBookkeeping\.settleOutcome\(session\.id, failedAttemptToken, 'failed'\);\s*interruptedTurnAutoResumeGuard\.noteAttemptSettled\(session\.id, failedAttemptToken\);/,
    );
  });

  // Foreground/background progress ordering runs through the production pipeline
  // in sessionEventPipeline.test.ts.

  it('advertises interval null-clear support for mobile wire compatibility', () => {
    expect(registerSource).toMatch(/supportsScheduleIntervalNullClear:\s*true/);
  });

  it('previews user enqueues to Agent Island before drain/sendToAgent', () => {
    expect(registerSource).toContain('previewQueuedUserTurn: (sessionId, item) => {');
    expect(registerSource).toContain("source: 'enqueue'");
    expect(registerSource).toContain('item.text || item.persistedContent');
    expect(registerSource).toContain('extractAgentIslandPromptText(content)');
    const drainableHead = coordinatorSource.indexOf(
      'if (this.getDrainableHead(sessionId, state) === item)',
    );
    const enqueuePreview = coordinatorSource.indexOf(
      'this.deps.previewQueuedUserTurn?.(sessionId, item);',
    );
    const drainImmediate = coordinatorSource.indexOf(
      "void this.drain(sessionId, 'enqueue-immediate');",
    );
    expect(drainableHead).toBeGreaterThan(-1);
    expect(enqueuePreview).toBeGreaterThan(drainableHead);
    expect(drainImmediate).toBeGreaterThan(enqueuePreview);
    expect(coordinatorSource).toContain('!automaticOrigin && !isUiContinuationItem(item)');
  });

  it('rolls back Agent Island enqueue preview when the queued item is discarded, rejected, or blocked', () => {
    expect(registerSource).toContain(
      "rollbackAgentIslandUserPrompt(sessionId, item.clientId, 'discarded')",
    );
    expect(registerSource).toContain(
      "rollbackAgentIslandUserPrompt(sessionId, item.clientId, 'rejected')",
    );
    expect(registerSource).toContain(
      "rollbackAgentIslandUserPrompt(sessionId, item.clientId, 'blocked')",
    );
  });

  it('fails a pending scheduler auto-resume before dispatching unrelated user input', () => {
    const userEnqueueStart = registerSource.indexOf('onUserEnqueue:');
    const userEnqueueEnd = registerSource.indexOf('onDiscardedQueuedMessage:', userEnqueueStart);
    expect(userEnqueueStart).toBeGreaterThan(-1);
    expect(userEnqueueEnd).toBeGreaterThan(userEnqueueStart);
    const userEnqueueHook = registerSource.slice(userEnqueueStart, userEnqueueEnd);
    const failIndex = userEnqueueHook.indexOf('failPendingSchedulerAutoResume(sessionId)');
    const publishIndex = userEnqueueHook.indexOf('publishUiSessionIntervention(sessionId)');
    expect(failIndex).toBeGreaterThan(-1);
    expect(publishIndex).toBeGreaterThan(failIndex);
  });

  it('fails a pending scheduler auto-resume only for a manual UI continuation', () => {
    const uiRetryStart = registerSource.indexOf('onUiRetry:');
    const uiRetryEnd = registerSource.indexOf('onUserEnqueue:', uiRetryStart);
    expect(uiRetryStart).toBeGreaterThan(-1);
    expect(uiRetryEnd).toBeGreaterThan(uiRetryStart);
    const uiRetryHook = registerSource.slice(uiRetryStart, uiRetryEnd);
    const manualCheckIndex = uiRetryHook.indexOf("source === 'manual'");
    const failIndex = uiRetryHook.indexOf('failPendingSchedulerAutoResume(sessionId)');
    const publishIndex = uiRetryHook.indexOf('publishUiContinuation(sessionId, clientId)');
    expect(manualCheckIndex).toBeGreaterThan(-1);
    expect(failIndex).toBeGreaterThan(manualCheckIndex);
    expect(publishIndex).toBeGreaterThan(failIndex);
  });

  it('hands banner suppression to queued or in-flight continuation state so cancellation restores it', () => {
    expect(sessionViewSource).toMatch(
      /syntheticContinuationPending\s*=\s*\n?\s*syntheticContinuationQueued\s*\|\|\s*continuationInFlightClientId\s*!==\s*null/,
    );
    expect(sessionViewSource).toMatch(
      /if \(syntheticContinuationPending && sessionInterruptAcked\) \{\s*setSessionInterruptAcked\(false\);\s*\}/,
    );
    // 恰好三处消费点(error-tail / interrupted / unread-failed-schedule banner
    // 的互斥渲染条件),多一处就要回来审视是否绕过了「抑制交给排队/在飞状态」
    // 这条契约。
    // 注:PR #879 加的「挂起状态落回 false 的边沿 → 重算告警红点」effect 走的是
    // 早退写法(`if (!was || syntheticContinuationPending) return;`),不消费这个
    // 否定形式,故计数不变。
    expect(matchIndexes(sessionViewSource, /!syntheticContinuationPending/)).toHaveLength(3);
  });

  it('defers Orca worker terminal while auto-resume owns the failure, and finalizes on surface', () => {
    const persistStart = eventSource.indexOf('const autoResumeSuppressesPersist =');
    const persistEnd = eventSource.indexOf('const overflowClaim =', persistStart);
    expect(persistStart).toBeGreaterThan(-1);
    expect(persistEnd).toBeGreaterThan(persistStart);
    const persistBlock = eventSource.slice(persistStart, persistEnd);
    expect(persistBlock).toContain('isSessionErrorSuppressed(');
    expect(eventSource).toMatch(/let deferredOrcaWorkerTerminal = false/);

    const stashStart = eventSource.indexOf('if (autoResumeSuppressesPersist) {');
    const stashEnd = eventSource.indexOf(
      "} else if (event.type === 'error' && isTerminalTurnErrorEvent(event)) {",
      stashStart,
    );
    expect(stashStart).toBeGreaterThan(-1);
    expect(stashEnd).toBeGreaterThan(stashStart);
    const stashBlock = eventSource.slice(stashStart, stashEnd);
    expect(stashBlock).toMatch(/autoResumeBookkeeping\.stashSuppressedError\(/);
    expect(stashBlock).toMatch(
      /deferredOrcaWorkerTerminal = autoResumeBookkeeping\.stashOrcaSuppressedTerminal\(/,
    );
    expect(stashBlock).toMatch(/capture:\s*workerTerminalCapture/);

    const terminalStart = eventSource.indexOf(
      '// Worker turn 结束后交给 OrcaTeamService 处理 DB status、广播与 auto-bridge。',
    );
    const terminalEnd = eventSource.indexOf('return { turnAssistantPersistId }', terminalStart);
    expect(terminalStart).toBeGreaterThan(-1);
    expect(terminalEnd).toBeGreaterThan(terminalStart);
    const terminalBlock = eventSource.slice(terminalStart, terminalEnd);
    expect(terminalBlock).toMatch(/shouldSkipOrcaWorkerTerminal\(\{/);
    expect(terminalBlock).toMatch(/stashedThisErrorEvent:\s*deferredOrcaWorkerTerminal/);
    expect(terminalBlock).toMatch(/isPairedFailedTurnDone/);
    expect(terminalBlock).toMatch(/isFailedTurnCompletionTail/);
    expect(terminalBlock).toMatch(
      /consumeFailedTurnCompletionTail\(\s*session\.id,\s*event\.sessionTurnGeneration/,
    );
    expect(terminalBlock).toMatch(
      /hasSuppressedError:\s*autoResumeBookkeeping\.hasSuppressedError/,
    );
    expect(terminalBlock).toMatch(/isAutoResumePending:/);
    expect(terminalBlock).toMatch(/isAutoResumeDeferred:/);
    expect(terminalBlock).toMatch(/handleWorkerTerminalTurn\(/);

    expect(eventSource).toMatch(
      /noteFailedTurnCompletionTail\(\s*session\.id,\s*event\.sessionTurnGeneration/,
    );
    const noteTailStart = eventSource.indexOf(
      'autoResumeBookkeeping.noteFailedTurnCompletionTail(',
    );
    expect(noteTailStart).toBeGreaterThan(-1);
    const persistIdIf = eventSource.lastIndexOf('if (turnAssistantPersistId)', noteTailStart);
    const persistIdIfEnd = eventSource.indexOf('}', persistIdIf);
    expect(persistIdIf).toBeGreaterThan(-1);
    expect(noteTailStart).toBeGreaterThan(persistIdIfEnd);
    expect(eventSource.slice(persistIdIf, persistIdIfEnd)).not.toMatch(
      /noteFailedTurnCompletionTail/,
    );

    const userEnqueueStart = registerSource.indexOf('onUserEnqueue:');
    const userEnqueueEnd = registerSource.indexOf('previewQueuedUserTurn:', userEnqueueStart);
    expect(userEnqueueStart).toBeGreaterThan(-1);
    expect(userEnqueueEnd).toBeGreaterThan(userEnqueueStart);
    const userEnqueueHook = registerSource.slice(userEnqueueStart, userEnqueueEnd);
    expect(userEnqueueHook).toMatch(/supersedeUnclaimedErrorForUserIntervention/);
    expect(userEnqueueHook).not.toMatch(/clearFailedTurnCompletionTail/);
    expect(userEnqueueHook).not.toMatch(/consumeFailedTurnCompletionTail/);
    expect(userEnqueueHook).not.toMatch(/noteFailedTurnCompletionTail/);

    const automaticEnqueueStart = registerSource.indexOf('onAutomaticEnqueue:');
    const automaticEnqueueEnd = registerSource.indexOf(
      'onRejectedUserTurn:',
      automaticEnqueueStart,
    );
    expect(automaticEnqueueStart).toBeGreaterThan(-1);
    expect(automaticEnqueueEnd).toBeGreaterThan(automaticEnqueueStart);
    const automaticEnqueueHook = registerSource.slice(automaticEnqueueStart, automaticEnqueueEnd);
    expect(automaticEnqueueHook).not.toMatch(/clearFailedTurnCompletionTail/);
    expect(automaticEnqueueHook).not.toMatch(/consumeFailedTurnCompletionTail/);

    expect(eventSource).toMatch(
      /if \(typeof event\.turnAttemptToken === 'number'\) \{\s*autoResumeBookkeeping\.clearFailedTurnCompletionTail\(session\.id\);/,
    );

    expect(registerSource).toMatch(/finalizeOrcaSuppressedTerminal:\s*\(sessionId, payload\)\s*=>/);
    expect(registerSource).toMatch(/status: payload\.status,\s*finalText: payload\.finalText/);
  });
});
