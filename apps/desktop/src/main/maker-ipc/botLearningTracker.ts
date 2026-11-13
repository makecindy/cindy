import {
  mergeBotLearningReceipts,
  type BotLearningReceipt,
} from '@cindy/maker-shared/bot-learning';

interface Turn {
  identity: string;
  reply?: string;
  receipts: BotLearningReceipt[];
  readNative?: () => Promise<BotLearningReceipt[]>;
  publish(reply: string, receipts: BotLearningReceipt[]): void;
}
/** Capture the write's owner before awaiting storage. Late completions retain this object. */
export function createBotLearningTracker() {
  const current = new Map<string, Turn>();
  // V2 teammates write their project's memory (not a `bot:` scope); their writes still count as learning.
  const projectTeammateSessions = new Set<string>();
  const nativeReceipts = new Map<string, () => Promise<BotLearningReceipt[]>>();
  const latestIdentity = new Map<string, string>();
  return {
    async prepareProjectTeammate(sessionId: string, createReader?: () => Promise<() => Promise<BotLearningReceipt[]>>) {
      projectTeammateSessions.add(sessionId);
      if (!createReader) { nativeReceipts.delete(sessionId); return; }
      // Queueing input performs observational resource preflights while the current turn
      // is busy. Keep its pre-write baseline, and avoid another scan in that case.
      if (current.has(sessionId)) return;
      const reader = await createReader();
      if (!current.has(sessionId)) nativeReceipts.set(sessionId, reader);
    },
    markProjectTeammate(sessionId: string, readNativeReceipts?: () => Promise<BotLearningReceipt[]>) {
      projectTeammateSessions.add(sessionId);
      if (readNativeReceipts) nativeReceipts.set(sessionId, readNativeReceipts);
      else nativeReceipts.delete(sessionId);
    },
    learnsFrom(sessionId: string | undefined, memoryScopeKey: string | undefined): string {
      if (!sessionId) return '';
      return memoryScopeKey?.startsWith('bot:') || projectTeammateSessions.has(sessionId) ? sessionId : '';
    },
    observe(sessionId: string, identity: string, publish: Turn['publish']) {
      latestIdentity.set(sessionId, identity);
      if (current.get(sessionId)?.identity !== identity)
        current.set(sessionId, { identity, receipts: [], publish, readNative: nativeReceipts.get(sessionId) });
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
      const readNative = turn.readNative;
      if (readNative) void readNative().then(receipts => {
        // An overlapping next turn makes attribution ambiguous; never attach its files to
        // the previous bubble. Dedicated-tool late receipts retain their existing behavior.
        if (latestIdentity.get(sessionId) !== identity || !reply || !receipts.length) return;
        turn.receipts = mergeBotLearningReceipts(turn.receipts, receipts);
        turn.publish(reply, turn.receipts);
      }).catch(() => { /* Read failure cannot manufacture a successful save. */ });
    },
  };
}
export const botLearningTracker = createBotLearningTracker();
