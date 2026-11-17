import type { AgentEvent } from '@cindy/maker-core';
import {
  mergeBotLearningReceipts,
  type BotLearningReceipt,
} from '@cindy/maker-shared/bot-learning';

type NativeReceiptReader = (writtenPaths: readonly string[]) => Promise<BotLearningReceipt[]>;

/** Only native file tools identify writes reliably; shell output cannot prove a path. */
function nativeWritePaths(event: AgentEvent, input: Record<string, unknown>, name: unknown): string[] {
  if (event.source === 'codex' && name === 'file_change' && Array.isArray(input.changes)) {
    return input.changes.flatMap(change => {
      if (!change || typeof change !== 'object') return [];
      const { path, kind } = change as { path?: unknown; kind?: { type?: unknown; move_path?: unknown } };
      if (typeof path !== 'string' || !path.trim() || (kind?.type !== 'add' && kind?.type !== 'update')) return [];
      // An update may move the file: only its final destination was written.
      const target = kind.type === 'update' && typeof kind.move_path === 'string' ? kind.move_path : path;
      return target.trim() ? [target] : [];
    });
  }
  const file = event.source === 'pi' && (name === 'write' || name === 'edit') ? input.path
    : event.source === 'claude-code' && (name === 'Write' || name === 'Edit' || name === 'MultiEdit') ? input.file_path
      : undefined;
  return typeof file === 'string' && file.trim() ? [file] : [];
}

interface Turn {
  identity: string;
  reply?: string;
  receipts: BotLearningReceipt[];
  readNative?: NativeReceiptReader;
  pendingWrites: Map<string, { source: AgentEvent['source']; paths: string[] }>;
  writtenPaths: Set<string>;
  publish(reply: string, receipts: BotLearningReceipt[]): void;
}
/** Capture the write's owner before awaiting storage. Late completions retain this object. */
export function createBotLearningTracker() {
  const current = new Map<string, Turn>();
  // V2 teammates write their project's memory (not a `bot:` scope); their writes still count as learning.
  const projectTeammateSessions = new Set<string>();
  const nativeReceipts = new Map<string, NativeReceiptReader>();
  const latestIdentity = new Map<string, string>();
  return {
    async prepareProjectTeammate(sessionId: string, createReader?: () => Promise<NativeReceiptReader>) {
      projectTeammateSessions.add(sessionId);
      if (!createReader) { nativeReceipts.delete(sessionId); return; }
      // Queueing input performs observational resource preflights while the current turn
      // is busy. Keep its pre-write baseline, and avoid another scan in that case.
      if (current.has(sessionId)) return;
      const reader = await createReader();
      if (!current.has(sessionId)) nativeReceipts.set(sessionId, reader);
    },
    markProjectTeammate(sessionId: string, readNativeReceipts?: NativeReceiptReader) {
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
        current.set(sessionId, { identity, receipts: [], publish, readNative: nativeReceipts.get(sessionId), pendingWrites: new Map(), writtenPaths: new Set() });
    },
    noteToolEvent(sessionId: string, identity: string, event: AgentEvent) {
      const turn = current.get(sessionId);
      if (!turn || turn.identity !== identity || event.turnScope === 'background' || event.agentMeta?.parentUuid) return;
      const data = event.data;
      if (!data || typeof data !== 'object' || Array.isArray(data)) return;
      const value = data as Record<string, unknown>;
      if (typeof value.toolUseId !== 'string' || !value.toolUseId) return;
      if (event.type === 'tool_use') {
        const input = value.input;
        if (!input || typeof input !== 'object' || Array.isArray(input)) return;
        const paths = nativeWritePaths(event, input as Record<string, unknown>, value.toolName);
        if (paths.length) turn.pendingWrites.set(value.toolUseId, { source: event.source, paths });
      } else if (event.type === 'tool_result_full') {
        const pending = turn.pendingWrites.get(value.toolUseId);
        if (!pending || pending.source !== event.source) return;
        turn.pendingWrites.delete(value.toolUseId);
        // Unknown/omitted results are not proof that a file tool succeeded.
        if (value.isError === false && !value.outputOmitted)
          for (const file of pending.paths) turn.writtenPaths.add(file);
      }
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
      if (readNative) void readNative([...turn.writtenPaths]).then(receipts => {
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
