import type { CindyMakeHistoryStore, MakeBuildRollbackEntry } from './historyStore.js';
import { contentRef, snapshotContent, taskContentRef, type ContentGit } from './sourceContent.js';
import { CINDY_PERSONAL_BRANCH } from './sourcePaths.js';

type IsPublishedCommit = (commit: string) => boolean;

/** Shared by failed generation and retrying a confirmed cancellation after restart. */
export async function rollbackUnbuiltHistory(
  store: CindyMakeHistoryStore,
  source: string,
  git: ContentGit,
  isPublishedCommit: IsPublishedCommit,
): Promise<void> {
  const rollback = historyBuildRollback(store, source, isPublishedCommit);
  await rollback.recoverRollback(git);
  const commit = (await git(['rev-parse', 'HEAD'], source)).trim();
  const tree = await snapshotContent(git, source);
  await rollback.prepareRollback({ commit, tree }, git)();
}

/** Restore only an unchanged, unpublished build candidate; never discard user edits. */
export async function restoreBuildSource(
  git: ContentGit,
  source: string,
  before: { commit: string; tree: string },
  after: { commit: string; tree: string },
): Promise<void> {
  const head = (await git(['rev-parse', 'HEAD'], source)).trim();
  const tree = await snapshotContent(git, source);
  if (
    (await git(['rev-parse', '--abbrev-ref', 'HEAD'], source)).trim() !== CINDY_PERSONAL_BRANCH ||
    (await git(['status', '--porcelain'], source)).trim()
  )
    throw new Error('Personal source changed');
  if (head === before.commit && tree === before.tree) return;
  if (head !== after.commit || tree !== after.tree) throw new Error('Personal source changed');
  // Retain the failed candidate independently of the personal branch and task worktree.
  await git(['update-ref', 'refs/cindy-make/failed-builds/' + after.commit, after.commit], source);
  await git(['reset', '--keep', before.commit], source);
  if (
    (await git(['rev-parse', 'HEAD'], source)).trim() !== before.commit ||
    (await snapshotContent(git, source)) !== before.tree
  )
    throw new Error('Personal source recovery incomplete');
}

/** Build cleanup owns only the consecutive integrations not present in a saved version. */
export function historyBuildRollback(
  store: CindyMakeHistoryStore,
  source: string,
  isPublishedCommit: IsPublishedCommit = () => false,
) {
  const recover = async (git: ContentGit) => {
    const entries = store.readBuildRollback();
    while (entries.length) {
      const { runId, receipt, previousTaskTree } = entries[0];
      const record = store.read(runId);
      if (
        !record ||
        record.versions.some((version) => version.operationId === receipt.id) ||
        (record.receipts.some((entry) => entry.id === receipt.id) &&
          record.receipts.at(-1)?.id !== receipt.id)
      )
        throw new Error('Integration changed during build rollback');
      const ref = taskContentRef(runId, 'integrated');
      const taskTree = await contentRef(git, source, ref);
      if (
        taskTree !== previousTaskTree &&
        taskTree !== (receipt.action === 'revert' ? undefined : receipt.taskTree)
      )
        throw new Error('Task integration changed during build rollback');
      await restoreBuildSource(
        git,
        source,
        { commit: receipt.baselineCommit, tree: receipt.beforeTree },
        receipt,
      );
      await git(
        previousTaskTree ? ['update-ref', ref, previousTaskTree] : ['update-ref', '-d', ref],
        source,
      );
      store.rollbackReceipt(runId, receipt.id);
      entries.shift();
      store.saveBuildRollback(entries);
    }
  };
  return {
    recoverRollback: recover,
    prepareRollback: (head: { commit: string; tree: string }, git: ContentGit) => {
      const records = store.list();
      const entries: MakeBuildRollbackEntry[] = [];
      let current = head;
      while (true) {
        if (
          isPublishedCommit(current.commit) ||
          records.some((record) =>
            record.versions.some((version) => version.commit === current.commit),
          )
        )
          break;
        const record = records
          .sort((a, b) => (b.receipts.at(-1)?.at ?? 0) - (a.receipts.at(-1)?.at ?? 0))
          .find((record) => {
            const receipt = record.receipts.at(-1);
            return receipt?.commit === current.commit && receipt.tree === current.tree;
          });
        if (
          !record ||
          record.versions.some((version) => version.operationId === record.receipts.at(-1)?.id)
        )
          break;
        const receipt = record.receipts.pop()!;
        const previous = record.receipts.at(-1);
        entries.push({
          runId: record.runId,
          receipt,
          previousTaskTree: previous?.action !== 'revert' ? previous?.taskTree : undefined,
        });
        current = { commit: receipt.baselineCommit, tree: receipt.beforeTree };
      }
      return async () => {
        if (!entries.length) return;
        store.saveBuildRollback(entries);
        await recover(git);
      };
    },
  };
}
