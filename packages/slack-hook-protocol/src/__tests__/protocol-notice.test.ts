import { makeInteractionRequest, HOOK_FEATURE_IM_QUESTIONS } from '../index.js';
import { describe, expect, it } from 'vitest';
import { HOOK_FEATURE_TELEGRAM_QUESTION_OPS, makeMessageOp, makeInteractionDecision, parseHookMessage } from '../index';

// Matching client/server wire: durable question cards have no arbitrary placement or approval semantics.
const frame = () => makeMessageOp({ opId: 'notice', requestId: 'request-1',
  purpose: 'turn-notice', questionMode: 'async', interactionId: 'question',
  scope: { externalKey: 'telegram:group:123456789:-100:101:g1' },
  action: { kind: 'send', text: 'Which format?', tier: 'html', buttons: [[{ token: 'pdf', label: 'PDF' }]] } });

describe('durable Telegram question wire', () => {
  it('round trips sends and closed edits under a separate capability', () => {
    expect(HOOK_FEATURE_TELEGRAM_QUESTION_OPS).toBe('telegram-question-ops-v1');
    const value = frame();
    expect(parseHookMessage({ ...value, payload: { ...value.payload, questionMode: 'blocking' } }).ok).toBe(true);
    expect(parseHookMessage(JSON.stringify(value))).toMatchObject({ ok: true, message: value });
    expect(parseHookMessage({ ...value, payload: { ...value.payload, interactionClosed: true,
      action: { kind: 'edit', messageId: '9', text: 'Answered', tier: 'plain', buttons: [] } } }).ok).toBe(true);
  });
  it('accepts explicit question replies and rejects text attached to permission or other buttons', () => {
    const value = makeInteractionDecision({ requestId: 'r', interactionId: 'q', buttonId: 'question:reply', answerText: 'Markdown' });
    expect(parseHookMessage(value).ok).toBe(true);
    for (const override of [{ buttonId: 'allow' }, { answerText: '' }, { answerText: 5 }, { answerText: 'a'.repeat(4097) }]) {
      expect(parseHookMessage({ ...value, payload: { ...value.payload, ...override } }).ok).toBe(false);
    }
  });
  it.each([
    { requestId: undefined }, { questionMode: undefined }, { questionMode: 'other' }, { finalPart: 0 }, { interactionId: undefined }, { interactionClosed: false },
    { action: { kind: 'edit', text: 'x', tier: 'plain', buttons: [] } },
    { action: { kind: 'send', text: 'x', tier: 'rich', buttons: [] } },
    { action: { kind: 'send', text: 'x', tier: 'plain' } },
    { action: { kind: 'send', text: 'x', tier: 'plain', buttons: [], replyToMessageId: '9' } },
    { action: { kind: 'send', text: 'x', tier: 'plain', buttons: [], silent: true } },
    { action: { kind: 'send', text: 'x', tier: 'plain', buttons: [], effectId: '1' } },
    { action: { kind: 'send', text: 'x', tier: 'plain', buttons: [], delivery: { bindingId: 'b', epoch: 'e', expiresAt: 100 } } },
  ])('rejects malformed cards or fields from another delivery purpose: %j', override => {
    const value = frame();
    expect(parseHookMessage({ ...value, payload: { ...value.payload, ...override } }).ok).toBe(false);
  });
});


describe('shared IM question wire', () => {
  it('negotiates structured question updates without changing legacy approvals', () => {
    expect(HOOK_FEATURE_IM_QUESTIONS).toBe('im-question-cards-v1');
    const frame = makeInteractionRequest({ requestId: 'r', interactionId: 'q', kind: 'ask_user_question',
      title: 'Question', body: 'Text answer', buttons: [], questionMode: 'async', questionCode: 'Q0123456789abcdef' });
    expect(parseHookMessage(frame).ok).toBe(true);
    for (const patch of [{ kind: 'permission' }, { questionMode: 'other' }, { questionCode: '' }, { questionMode: undefined }, { questionCode: undefined }]) {
      expect(parseHookMessage({ ...frame, payload: { ...frame.payload, ...patch } }).ok).toBe(false);
    }
    const legacy = { ...frame.payload, questionMode: undefined, questionCode: undefined };
    expect(parseHookMessage({ ...frame, payload: legacy }).ok).toBe(false);
  });
});
