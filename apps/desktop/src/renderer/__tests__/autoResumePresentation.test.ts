import { describe, expect, it } from 'vitest';
import { findActiveReconnect } from '@/lib/autoResumePresentation';
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
