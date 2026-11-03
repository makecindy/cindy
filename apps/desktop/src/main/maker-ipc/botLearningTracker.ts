import {
  mergeBotLearningReceipts,
  type BotLearningReceipt,
} from '@cindy/maker-shared/bot-learning';

interface Turn {
  identity: string;
  reply?: string;
  receipts: BotLearningReceipt[];
  publish(reply: string, receipts: BotLearningReceipt[]): void;
}
/** Capture the write's owner before awaiting storage. Late completions retain this object. */
export function createBotLearningTracker() {
  const current = new Map<string, Turn>();
  return {
    observe(sessionId: string, identity: string, publish: Turn['publish']) {
      if (current.get(sessionId)?.identity !== identity)
        current.set(sessionId, { identity, receipts: [], publish });
    },
    capture(sessionId: string) {
      const turn = current.get(sessionId);
      return (receipt: BotLearningReceipt) => {
        if (!turn) return;
        turn.receipts = mergeBotLearningReceipts(turn.receipts, [receipt]);
        if (turn.reply) turn.publish(turn.reply, turn.receipts);
      };
    },
    seal(sessionId: string, identity: string, reply?: string) {
      const turn = current.get(sessionId);
      if (!turn || turn.identity !== identity) return;
      current.delete(sessionId);
      turn.reply = reply;
      if (reply && turn.receipts.length) turn.publish(reply, turn.receipts);
    },
  };
}
export const botLearningTracker = createBotLearningTracker();
