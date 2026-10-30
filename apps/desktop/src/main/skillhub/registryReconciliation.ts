import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createLogger } from '../logger';
import { registryService, type StoredInstall } from './registry';
import { withSkillMutation } from './sharedMutationLease';
import { fileIdentity } from './uninstallJournal';

const log = createLogger('skillhub:registry-reconciliation');

/** Background scan maintenance is a writer too; stale scan snapshots grant no writes. */
export async function reconcileScannedInstall(
  record: { skillName: string; installPath: string; entry: StoredInstall },
  orphan: boolean,
): Promise<void> {
  try {
    const sourceIdentity = fileIdentity(record.installPath, true);
    const source = sourceIdentity ? fs.realpathSync.native(record.installPath) : record.installPath;
    await withSkillMutation([record.skillName, path.basename(record.installPath), path.basename(source)], async () => {
      const current = await registryService.getInstall(record.skillName, record.installPath);
      if (JSON.stringify(current) !== JSON.stringify(record.entry)
        || fileIdentity(record.installPath, true) !== sourceIdentity) return;
      if (sourceIdentity === null) {
        if (orphan) await registryService.removeInstall(record.skillName, record.installPath, {
          expected: record.entry, canMutate: () => true,
          shouldRemove: () => fileIdentity(record.installPath, true) === null,
        });
        return;
      }
      const index = record.installPath.replace(/\\/g, '/').lastIndexOf('/.agents/skills/');
      if (index < 0) return;
      const base = record.installPath.slice(0, index);
      const link = path.join(base || os.homedir(), '.claude', 'skills', record.skillName);
      // Existing entries belong to their current owner, including external links.
      if (fileIdentity(link) !== null) return;
      // Keep final validation and link creation synchronous inside the lease.
      fs.mkdirSync(path.dirname(link), { recursive: true });
      if (fileIdentity(record.installPath, true) !== sourceIdentity) return;
      fs.symlinkSync(record.installPath, link, process.platform === 'win32' ? 'junction' : 'dir');
    });
  } catch (error) {
    log.warn('Skill registry maintenance deferred:', error);
  }
}
