import { expect, it } from 'vitest';
import { withBatchUpdatePlacement } from '../batchUpdatePlacement';

// A single decision can release several inspected packages. The next package
// must not enter final inspection until its predecessor settles, even on error.
it('serializes approved placements and releases the slot when an install fails', async () => {
  const started: string[] = [];
  let failFirst!: () => void;
  const first = withBatchUpdatePlacement(async waitForTurn => {
    await waitForTurn();
    started.push('first');
    await new Promise<void>(resolve => { failFirst = resolve; });
    throw new Error('placement failed');
  });
  const second = withBatchUpdatePlacement(async waitForTurn => {
    await waitForTurn();
    started.push('second');
  });
  await Promise.resolve();
  expect(started).toEqual(['first']);
  failFirst();
  await expect(first).rejects.toThrow('placement failed');
  await second;
  expect(started).toEqual(['first', 'second']);
});
