import type { MakeSourceStatus } from '../../shared/cindyMakeDoctor.js';
import type { CindyMakeManager } from './manager.js';

/** Publish the disk summary before tool discovery, Git inspection and network lookup. */
export function refreshCindySourceStatus(
  manager: CindyMakeManager,
  readers: {
    readSummary: () => Promise<MakeSourceStatus>;
    readLocal: () => Promise<MakeSourceStatus>;
    readLatest: (source: MakeSourceStatus) => Promise<MakeSourceStatus>;
  },
): Promise<MakeSourceStatus> {
  const previous = manager.getState().source;
  return manager.refreshSourceStatus(async (publish) => {
    let summary = await readers.readSummary();
    // Reopening Settings keeps the last known details while checking them again.
    if (
      previous?.status === 'ready' &&
      summary.status === 'ready' &&
      previous.path === summary.path &&
      previous.ref === summary.ref &&
      previous.channel === summary.channel &&
      previous.version === summary.version
    )
      summary = { ...previous, ...summary };
    if (!publish(summary) || summary.status !== 'ready') return summary;

    let local = await readers.readLocal();
    // A previous comparison is only meaningful for the same local main commit.
    if (
      local.status === 'ready' &&
      local.path === summary.path &&
      local.mainCommit &&
      local.mainCommit === summary.mainCommit &&
      local.channel === summary.channel &&
      local.ref === summary.ref &&
      local.version === summary.version
    )
      local = { ...local, latestVersion: summary.latestVersion };
    if (!publish(local) || local.status !== 'ready') return local;
    return readers.readLatest(local);
  });
}
