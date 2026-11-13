import type { ChatReplyQuote } from '../../shared/chatReplyQuote.js';

type Turn = { getTurnGeneration(): number };
const selections = new WeakMap<Turn, { generation: number; quote: ChatReplyQuote }>();

export function setSelectedReplyQuote(session: Turn, quote: ChatReplyQuote | null): void {
  if (quote) selections.set(session, { generation: session.getTurnGeneration(), quote });
  else selections.delete(session);
}

/** Selection belongs to the exact runtime instance and turn, never the next input. */
export function selectedReplyQuote(session: Turn, generation: number | undefined): ChatReplyQuote | undefined {
  const selected = selections.get(session);
  return selected && selected.generation === generation ? selected.quote : undefined;
}
