import { describe, expect, it } from 'vitest';
import {
  CODEX_QUOTA_RESTORED_RESUME_REASON,
  CODEX_RESET_CREDIT_CHECKING_REASON,
  CODEX_RESET_CREDIT_RESUME_REASON,
} from '@cindy/maker-shared/synthetic-trigger';
import {
  autoResumePendingLabel,
  findActiveReconnect,
  hasInterruptionContext,
  readAutoResumeInfo,
  recordedAutoResumeLabelKey,
} from '@/lib/autoResumePresentation';
import type { ChatMessage } from '@/lib/makerChatStore';

const row = (overrides: Partial<ChatMessage> = {}): ChatMessage => ({
  clientId: 'retry',
  role: 'user',
  content: '',
  isStreaming: false,
  systemCardType: 'auto-resume',
  systemCardData: { attempt: 1, maxAttempts: 5 },
  ...overrides,
});
const base = {
  sessionRunning: true,
  continuationTurnClientId: 'retry',
  projectionCapability: 'supported' as const,
};

describe('composer reconnect presentation', () => {
  it('shows pending backoff even without a running turn and uses the latest progress', () => {
    const messages = [
      row(),
      row({
        clientId: 'pending',
        role: 'assistant',
        systemCardType: 'auto-resume-pending',
        systemCardData: { attempt: 2, maxAttempts: 5 },
      }),
    ];
    expect(
      findActiveReconnect({
        ...base,
        messages,
        sessionRunning: false,
        continuationTurnClientId: null,
      }),
    ).toMatchObject({ attempt: 2, maxAttempts: 5 });
  });

  it('keeps the reconnect status when backoff hands over to the running continuation', () => {
    expect(findActiveReconnect({ ...base, messages: [row()] })).toMatchObject({
      attempt: 1,
      maxAttempts: 5,
    });
  });

  it.each(['succeeded', 'failed'])('settled outcome %s stops overriding generation', (outcome) => {
    expect(
      findActiveReconnect({
        ...base,
        messages: [
          row({
            systemCardData: { attempt: 1, maxAttempts: 5, outcome },
          }),
        ],
      }),
    ).toBeNull();
  });

  it('does not revive historical retries or silent-stop continuations', () => {
    expect(
      findActiveReconnect({ ...base, continuationTurnClientId: null, messages: [row()] }),
    ).toBeNull();
    expect(findActiveReconnect({ ...base, messages: [row({ systemCardData: {} })] })).toBeNull();
  });

  it('legacy owners ignore steering but stop after a new user turn or Stop', () => {
    const legacy = {
      ...base,
      continuationTurnClientId: null,
      projectionCapability: 'legacy' as const,
    };
    const messages = [
      row(),
      row({ clientId: 'steer', delivery: 'steer', systemCardType: undefined }),
    ];
    expect(findActiveReconnect({ ...legacy, messages })).not.toBeNull();
    expect(findActiveReconnect({ ...legacy, messages, sessionRunning: false })).toBeNull();
    messages.push(row({ clientId: 'user', systemCardType: undefined }));
    expect(findActiveReconnect({ ...legacy, messages })).toBeNull();
    expect(
      findActiveReconnect({ ...legacy, projectionCapability: 'unknown', messages: [row()] }),
    ).toBeNull();
  });

  it('invalid progress falls back to an unnumbered pending state', () => {
    const active = findActiveReconnect({
      ...base,
      messages: [
        row({
          role: 'assistant',
          systemCardType: 'auto-resume-pending',
          systemCardData: { attempt: NaN, maxAttempts: 'five' },
        }),
      ],
    });
    expect(active).not.toBeNull();
    expect(active?.attempt).toBeUndefined();
    expect(active?.maxAttempts).toBeUndefined();
  });
});

describe('Codex quota continuation presentation', () => {
  it('says it is checking quota, then that it uses a reset or that quota is back', () => {
    const base = { error: 'You have hit your usage limit.', attempt: 1, maxAttempts: 5 };
    const checking = readAutoResumeInfo({ ...base, reason: CODEX_RESET_CREDIT_CHECKING_REASON });
    expect(checking.quotaKind).toBe('checking');
    expect(autoResumePendingLabel(checking)).toEqual({
      key: 'chat.systemCard.autoResumePending.resetCreditChecking',
    });
    expect(autoResumePendingLabel(readAutoResumeInfo({ ...base, reason: CODEX_RESET_CREDIT_RESUME_REASON })))
      .toEqual({ key: 'chat.systemCard.autoResumePending.resetCredit' });
    expect(autoResumePendingLabel(readAutoResumeInfo({ ...base, reason: CODEX_QUOTA_RESTORED_RESUME_REASON })))
      .toEqual({ key: 'chat.systemCard.autoResumePending.quotaRestored' });
    // A quota row is never mistaken for a silent-stop separator, even without an error text.
    expect(hasInterruptionContext(readAutoResumeInfo({ reason: CODEX_RESET_CREDIT_RESUME_REASON }))).toBe(true);
  });

  it('never reads a reset that did not continue the task as continued', () => {
    expect(recordedAutoResumeLabelKey('reset', 'succeeded')).toBe('chat.systemCard.autoResume.resetCreditLabel');
    expect(recordedAutoResumeLabelKey('reset', 'failed')).toBe('chat.systemCard.autoResume.resetCreditLabelFailed');
    expect(recordedAutoResumeLabelKey('reset', undefined)).toBe('chat.systemCard.autoResume.resetCreditLabelNeutral');
    expect(recordedAutoResumeLabelKey('restored', 'failed')).toBe('chat.systemCard.autoResume.quotaRestoredLabelFailed');
    expect(recordedAutoResumeLabelKey(undefined, 'succeeded')).toBe('chat.systemCard.autoResume.label');
  });

  it('keeps reconnect labels for every other reason', () => {
    const info = readAutoResumeInfo({ reason: 'empty-response', attempt: 2, maxAttempts: 5 });
    expect(info.quotaKind).toBeUndefined();
    expect(autoResumePendingLabel(info)).toEqual({
      key: 'chat.systemCard.autoResumePending.labelWithProgress',
      params: { attempt: 2, total: 5 },
    });
    expect(autoResumePendingLabel(readAutoResumeInfo({}))).toEqual({
      key: 'chat.systemCard.autoResumePending.label',
    });
  });
});
