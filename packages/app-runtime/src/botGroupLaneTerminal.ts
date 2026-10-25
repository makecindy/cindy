import type {BotGroupRuntimeFailureCode} from '@cindy/maker-shared/botGroupChat';
export interface BotGroupLaneSettler {settleLaneTurn(terminal: BotGroupLaneTerminal):Promise<boolean>;}
export interface BotGroupLaneTerminal {
  sessionId: string;
  /** Input that owned the finished turn, captured before the queue drains. */
  activeInputClientId: string | null;
  outcome: 'done' | 'error';
  resultText: string;
  resultMessageClientId?: string | null;
  failureCode?: BotGroupRuntimeFailureCode;
  /** Delivery failed before an Agent turn existed; discard the hidden queued input. */
  undispatched?: boolean;
}

/** Ordinary and recovery-held replies must read their fallback text after queued writes. */
export async function settleBotGroupLaneTerminal(
  service: BotGroupLaneSettler,
  terminal: BotGroupLaneTerminal,
  drainPersistQueue: () => Promise<void>,
): Promise<boolean> {
  if (terminal.outcome === 'done' && !terminal.resultText.trim() && terminal.resultMessageClientId) {
    await drainPersistQueue();
  }
  return service.settleLaneTurn(terminal);
}

