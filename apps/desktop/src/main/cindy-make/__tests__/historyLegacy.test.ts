import { expect, it, vi } from 'vitest';
import { readLegacyFeatureReceipts } from '../historyLegacy';
import type { CindyMakeHistoryRecord } from '../../../shared/cindyMakeHistory';

it('reconstructs undo only from a proven legacy integration and rejects a file-only or unrelated build commit', async () => {
  const record: CindyMakeHistoryRecord = {
    schema: 1,
    runId: 'aaaa',
    sessionId: 'session',
    title: 'Feature',
    request: '',
    createdAt: 1,
    updatedAt: 2,
    receipts: [],
    versions: [],
    completions: [
      {
        id: 'completion',
        reportedAt: 2,
        commit: 'a'.repeat(40),
        tree: 'b'.repeat(40),
        personal: { status: 'ready', commit: 'c'.repeat(40), tree: 'd'.repeat(40) },
      },
    ],
  };
  const git = vi.fn(async (args: string[]) => {
    if (args[0] === 'rev-parse') return args[1].startsWith('c') ? 'd'.repeat(40) : 'e'.repeat(40);
    if (args.includes('--format=%P')) return 'f'.repeat(40) + ' ' + 'a'.repeat(40);
    return 'Cindy Make: integrate personal feature';
  });
  const receipts = await readLegacyFeatureReceipts(record, git, 'source');
  expect(receipts).toEqual([
    expect.objectContaining({
      action: 'integrate',
      baselineCommit: 'f'.repeat(40),
      beforeTree: 'e'.repeat(40),
      tree: 'd'.repeat(40),
      taskTree: 'b'.repeat(40),
    }),
  ]);
  expect((await readLegacyFeatureReceipts(record, git, 'source'))[0].id).toBe(receipts[0].id);
  record.completions[0].personal!.tree = '9'.repeat(40);
  expect(await readLegacyFeatureReceipts(record, git, 'source')).toEqual([]);
  expect(await readLegacyFeatureReceipts({ ...record, receipts }, git, 'source')).toEqual([]);
});
