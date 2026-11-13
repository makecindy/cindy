/**
 * One dispatched turn's terminal events and the Git baseline calls they cause, read by two tests:
 * the desktop's event pipeline (sessionEventPipeline.test.ts) and the Host's input queue and turn
 * executor (apps/host/src/agent/input-queue.test.mjs). Each side must produce its column; the two
 * columns differ only in the rows that say why.
 *
 * Steps, in arrival order:
 * - 'done', 'error' (terminal), 'continuation-done' (a done that only closes an SDK segment);
 * - 'stop-with-done': the user stops and the engine reports done while abort() is settling;
 * - 'stop': the user stops and abort() returns with the engine idle and no terminal event yet.
 *   The desktop pipeline sees nothing; the Host settles the stop itself. Later steps arrive after.
 * Calls: 'end' is onTurnEnd (after-edit savepoint), 'abort' is onTurnAbort (baseline cancelled).
 */
export type GitSettlementStep = 'done' | 'error' | 'continuation-done' | 'stop-with-done' | 'stop';
export type GitSettlementCall = 'end' | 'abort';

export interface GitSettlementSequence {
  name: string;
  steps: GitSettlementStep[];
  desktop: GitSettlementCall[];
  host: GitSettlementCall[];
  /** Why the Host column differs from the desktop column. */
  difference?: string;
}

export const GIT_SETTLEMENT_SEQUENCES: GitSettlementSequence[] = [
  { name: 'a completed turn', steps: ['done'], desktop: ['end'], host: ['end'] },
  { name: 'a failed turn that reports its error and then its done', steps: ['error', 'done'], desktop: ['abort', 'end'], host: ['abort', 'end'] },
  { name: 'a failed turn that reports only its error', steps: ['error'], desktop: ['abort'], host: ['abort'] },
  { name: 'a continuation segment, then the turn', steps: ['continuation-done', 'done'], desktop: ['end'], host: ['end'] },
  { name: 'a stop the engine acknowledges with done', steps: ['stop-with-done'], desktop: ['end'], host: ['end'] },
  { name: 'a stop whose done arrives after the Host settled it', steps: ['stop', 'done'], desktop: ['end'], host: ['end'] },
  {
    name: 'a stop the engine never reports', steps: ['stop'], desktop: [], host: ['end'],
    difference: 'The Host settles a stop itself once the engine is idle; it takes the after-edit savepoint, as the engines\' usual done does.',
  },
  {
    name: 'a stop reported with an error and then done, after the Host settled it', steps: ['stop', 'error', 'done'], desktop: ['abort', 'end'], host: ['end'],
    difference: 'The Host settled the stop with the after-edit savepoint; later terminals of that turn settle nothing more.',
  },
];
