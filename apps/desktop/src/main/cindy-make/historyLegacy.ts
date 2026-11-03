import { createHash } from 'node:crypto';
import type { CindyMakeHistoryRecord, MakeFeatureReceipt } from '../../shared/cindyMakeHistory.js';
import type { ContentGit } from './sourceContent.js';

const HASH = /^[a-f0-9]{40,64}$/i;
/** Old build records are adopted only when Git proves the exact integration commit and both file trees. */
export async function readLegacyFeatureReceipts(
  record: CindyMakeHistoryRecord,
  git: ContentGit,
  source: string,
): Promise<MakeFeatureReceipt[]> {
  if (record.receipts.length) return [];
  const receipts: MakeFeatureReceipt[] = [];
  for (const completion of record.completions) {
    const built = completion.personal;
    if (
      !built?.commit ||
      !built.tree ||
      !completion.commit ||
      !completion.tree ||
      ![built.commit, built.tree, completion.commit, completion.tree].every((value) =>
        HASH.test(value),
      )
    )
      continue;
    if (receipts.some((receipt) => receipt.commit === built.commit)) continue;
    try {
      const tree = (await git(['rev-parse', built.commit + '^{tree}'], source)).trim();
      if (tree !== built.tree) continue;
      const parents = (await git(['show', '-s', '--format=%P', built.commit], source))
        .trim()
        .split(/\s+/);
      const subject = (await git(['show', '-s', '--format=%s', built.commit], source)).trim();
      if (!HASH.test(parents[0]) || !subject.startsWith('Cindy Make: integrate personal feature'))
        continue;
      if (parents.length > 1 && !parents.slice(1).includes(completion.commit)) continue;
      const beforeTree = (await git(['rev-parse', parents[0] + '^{tree}'], source)).trim();
      if (!HASH.test(beforeTree)) continue;
      receipts.push({
        id: 'legacy-' + createHash('sha256').update(completion.id).digest('hex').slice(0, 32),
        action: 'integrate',
        at: completion.reportedAt,
        baselineCommit: parents[0],
        commit: built.commit,
        beforeTree,
        tree,
        taskTree: completion.tree,
      });
    } catch {
      /* Missing pre-upgrade objects cannot be replaced with guessed undo data. */
    }
  }
  return receipts;
}
