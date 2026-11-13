import { describe, expect, it } from 'vitest';
import { createNotificationDismissalLedger, type NotificationDismissalState } from '../notificationDismissal';

// Regression: reading a task must not remove an unanswered question or a later result.
// Existing notification tests only cover sending/deduplication. Unit tier exercises exact
// retirement, restart recovery and a transport acknowledgement racing a new retirement.
describe('notification retirement', () => {
  it('keeps unanswered questions and later results, and resumes unacknowledged retirement', () => {
    let stored: NotificationDismissalState = { pending: [], retired: [] };
    const save = (state: NotificationDismissalState) => { stored = structuredClone(state); };
    let ledger = createNotificationDismissalLedger(stored, save);
    ledger.record({ id: 'old', sessionId: 'task', kind: 'done', requestIds: [] });
    ledger.record({ id: 'question', sessionId: 'task', kind: 'needs-reply', requestIds: ['request'] });
    ledger.read('task');
    expect(ledger.batch()).toEqual(['old']);
    ledger.record({ id: 'new', sessionId: 'task', kind: 'done', requestIds: [] });
    ledger = createNotificationDismissalLedger(stored, save);
    const sending = ledger.batch();
    ledger.resolve('task', 'request');
    ledger.acknowledged(sending);
    expect(ledger.batch()).toEqual(['question']);
    expect(stored.pending.map(item => item.id)).toEqual(['new']);
    ledger.resolve('another-task', 'request');
    expect(stored.pending.map(item => item.id)).toEqual(['new']);
  });
});

it('retires one answered question while preserving a newer pending question', () => {
  const ledger = createNotificationDismissalLedger({ pending: [], retired: [] }, () => {});
  ledger.record({ id: 'first', sessionId: 'task', kind: 'needs-reply', requestIds: ['a'] });
  ledger.record({ id: 'second', sessionId: 'task', kind: 'needs-reply', requestIds: ['a', 'b'] });
  expect(ledger.batch()).toEqual([]);
  ledger.resolve('task', 'a');
  expect(ledger.batch()).toEqual(['first']);
  ledger.read('task');
  expect(ledger.batch()).toEqual(['first']);
  ledger.resolve('task', 'b');
  expect(ledger.batch()).toEqual(['first', 'second']);
  ledger.record({ id: 'cancelled', sessionId: 'task', kind: 'needs-reply', requestIds: ['cancelled-request'] });
  ledger.resolve('task', 'cancelled-request');
  ledger.record({ id: 'replacement', sessionId: 'task', kind: 'needs-reply', requestIds: ['c'] });
  expect(ledger.batch()).toEqual(['first', 'second', 'cancelled']);
});
