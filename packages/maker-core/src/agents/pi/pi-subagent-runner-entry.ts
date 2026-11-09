import { hy4ContentBlocks } from './hy4-inline-thinking.js';

/** The fixed host entry supplies the shared projection; older snapshots self-start. */
export function startPiSubagentRunner(runner: unknown): void {
  if (typeof runner === 'function') runner(hy4ContentBlocks);
}
