import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const registerSource = readFileSync(
  resolve(__dirname, '..', 'maker-ipc', 'register.ts'),
  'utf8',
).replace(/\r\n?/g, '\n');
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
  const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
  for (const match of haystack.matchAll(re)) {
    if (typeof match.index === 'number') indexes.push(match.index);
  }
  return indexes;
}

describe('interrupted continuation enqueue contract', () => {
  it('does not durable-ack continue prompts at INPUT_ENQUEUE or onAccepted time', () => {
    const enqueueStart = registerSource.indexOf('ipcMain.handle(MAKER_INVOKE.INPUT_ENQUEUE');
    const enqueueEnd = registerSource.indexOf('ipcMain.handle(MAKER_INVOKE.INPUT_COMPACT', enqueueStart);
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

    const dispatchedStart = registerSource.indexOf('onDispatchedUserTurn:');
    const dispatchedEnd = registerSource.indexOf('noteSessionClearBoundary', dispatchedStart);
    expect(dispatchedStart).toBeGreaterThan(-1);
    expect(dispatchedEnd).toBeGreaterThan(dispatchedStart);
    const dispatchedHook = registerSource.slice(dispatchedStart, dispatchedEnd);
    expect(dispatchedHook).toMatch(
      /!inputCoordinator\.isAutoResumePending\(sessionId\)/,
    );
    expect(dispatchedHook).toMatch(
      /clearSchedulerAutoResumePending\(sessionId, item\.origin\.runId\)/,
    );

    const discardedStart = registerSource.indexOf('onDiscardedQueuedMessage:');
    const discardedEnd = registerSource.indexOf('hasPendingCredentialSwitch:', discardedStart);
    expect(discardedStart).toBeGreaterThan(-1);
    expect(discardedEnd).toBeGreaterThan(discardedStart);
    const discardedHook = registerSource.slice(discardedStart, discardedEnd);
    expect(discardedHook).toMatch(
      /settleUndispatchedAutoResumeOutcome\(sessionId, item\)/,
    );
    expect(discardedHook).toMatch(
      /interruptedTurnAutoResumeGuard\.noteResumeSendFailed\(sessionId\)/,
    );
    expect(discardedHook).toMatch(
      /notifySchedulerAutoResumeFailed\(sessionId, item\.origin\.runId\)/,
    );

    const settleStart = registerSource.indexOf('function settleUndispatchedAutoResumeOutcome(');
    const settleEnd = registerSource.indexOf('\n}\n', settleStart);
    expect(settleStart).toBeGreaterThan(-1);
    expect(settleEnd).toBeGreaterThan(settleStart);
    const settleHelper = registerSource.slice(settleStart, settleEnd);
    expect(settleHelper).toMatch(
      /autoResumeBookkeeping\.isPendingOutcomeClientId\(sessionId, item\.clientId\)/,
    );
    expect(settleHelper).toMatch(
      /autoResumeBookkeeping\.settleOutcome\(sessionId, ['"]failed['"]\)/,
    );

    const undispatchedStart = registerSource.indexOf('onUndispatchedUserTurn:');
    const undispatchedEnd = registerSource.indexOf('onQueueEmptied:', undispatchedStart);
    expect(undispatchedStart).toBeGreaterThan(-1);
    expect(undispatchedEnd).toBeGreaterThan(undispatchedStart);
    expect(registerSource.slice(undispatchedStart, undispatchedEnd)).toMatch(
      /settleUndispatchedAutoResumeOutcome\(sessionId, item\)/,
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
    // 恰好两处消费点(error-tail banner 与 interrupted banner 的互斥渲染条件),
    // 多一处就要回来审视是否绕过了「抑制交给排队/在飞状态」这条契约。
    // 注:PR #879 加的「挂起状态落回 false 的边沿 → 重算告警红点」effect 走的是
    // 早退写法(`if (!was || syntheticContinuationPending) return;`),不消费这个
    // 否定形式,故计数不变。
    expect(matchIndexes(sessionViewSource, /!syntheticContinuationPending/)).toHaveLength(2);
  });
});
