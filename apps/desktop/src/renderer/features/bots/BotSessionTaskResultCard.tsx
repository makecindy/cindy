import { readBotCollaborationMeta } from '../../../shared/botCollaboration';
import { BotTaskCard } from './BotCollaborationCard';

/**
 * Frozen execution receipt rendered as the same background-task card in its
 * terminal state. Under the bot's closing reply (`attached`) the result starts
 * open; a standalone fallback receipt starts collapsed. Legacy receipts may read
 * the existing task title only.
 */
export function BotSessionTaskResultCard({
  data,
  sessionId,
  attached = false,
}: {
  data?: Record<string, unknown>;
  sessionId?: string;
  attached?: boolean;
}) {
  const card = readBotCollaborationMeta(data);
  if (card?.role !== 'delegation-result' || !card.result) return null;
  return <BotTaskCard card={card} sessionId={sessionId} attached={attached} />;
}
