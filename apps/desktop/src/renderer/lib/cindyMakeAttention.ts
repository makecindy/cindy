import {
  getCindyMakeMessageAttention,
  type CindyMakeAttention,
} from '../../shared/cindyMakeAttention';
import {
  addSessionAttention,
  clearSessionAttention,
  getSessionAttentionKind,
} from './sessionAttentionStore';

interface MakeCard {
  systemCardType?: string;
  systemCardData?: Record<string, unknown>;
}

function attention(card: MakeCard | undefined): CindyMakeAttention | undefined {
  if (!card) return;
  return getCindyMakeMessageAttention({
    role: 'assistant',
    agentMeta:
      card.systemCardType === 'cindy-make-complete'
        ? { cindyMakeCompletion: card.systemCardData }
        : undefined,
    content: { __cindyMakeCard: { type: card.systemCardType, data: card.systemCardData } },
  });
}

/** Called at the shared local/remote message ingress, independently of card mounting. */
export function applyCindyMakeCardAttention(
  sessionId: string,
  previous: MakeCard | undefined,
  next: MakeCard,
  isViewed: boolean,
): void {
  const before = attention(previous);
  const after = attention(next);
  if (!after || (before?.key === after.key && before.kind === after.kind)) return;
  const current = getSessionAttentionKind(sessionId);
  if (after.kind === 'error') {
    addSessionAttention(sessionId, 'error');
    return;
  }
  // Only clear a dot owned by this card. An unrelated pending alert keeps priority.
  if (before && (before.kind === 'error' || before.kind === 'done') && current === before.kind)
    clearSessionAttention(sessionId, { intent: 'explicit' });
  if (
    after.kind === 'done' &&
    !isViewed &&
    getSessionAttentionKind(sessionId) !== 'error' &&
    getSessionAttentionKind(sessionId) !== 'awaiting'
  )
    addSessionAttention(sessionId, 'done');
}
