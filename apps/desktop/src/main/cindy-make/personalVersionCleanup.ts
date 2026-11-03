import fs from 'node:fs';
import path from 'node:path';
import originalFs from 'original-fs';
import { createLogger } from '../logger.js';
import {
  assertVersionDirectory,
  personalVersionId,
  readPersonalVersionRecord,
  readVersionJson,
  selectedVersion,
  versionDirectory,
  versionsRoot,
  VERSION_ID,
  withVersionStore,
} from './versionStore.js';

const log = createLogger('cindy-versions');
const alive = (pid: number) => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
};
const validId = (id: unknown) =>
  typeof id === 'string' && (id === 'original' || VERSION_ID.test(id));

/** Retire replaced binaries, retaining publication receipts and every live handoff dependency. */
export async function cleanupPersonalVersions(profile: string): Promise<void> {
  try {
    await withVersionStore(profile, async () => {
      const root = versionsRoot(profile);
      const keep = new Set([personalVersionId(profile), selectedVersion(profile)]);
      const active = readVersionJson<{ id: string; pid: number }>(path.join(root, 'active.json'));
      if (active && (!validId(active.id) || !Number.isSafeInteger(active.pid) || active.pid <= 0))
        return;
      if (active && alive(active.pid)) keep.add(active.id);
      const pending = readVersionJson<{ id: string; pid: number }>(path.join(root, 'pending.json'));
      if (pending && alive(pending.pid)) {
        if (!VERSION_ID.test(pending.id)) return;
        const launch = readVersionJson<{ targetId: string; fallbackId: string }>(
          path.join(root, 'launches', pending.id + '.json'),
        );
        // An incomplete live handoff is not evidence that any generation is disposable.
        if (!launch || !validId(launch.targetId) || !validId(launch.fallbackId)) return;
        keep.add(launch.targetId);
        keep.add(launch.fallbackId);
      }
      // Ready clears pending.json before the helper actually exits. On Windows that
      // helper still runs from the fallback bundle; it must remain intact too.
      const launches = path.join(root, 'launches');
      if (fs.existsSync(launches)) {
        assertVersionDirectory(profile, launches);
        for (const file of fs.readdirSync(launches)) {
          if (!file.endsWith('.json') || !VERSION_ID.test(file.slice(0, -5))) continue;
          const launch = readVersionJson<{
            helperPid?: number;
            targetId: string;
            fallbackId: string;
          }>(path.join(launches, file));
          if (launch?.helperPid && alive(launch.helperPid)) {
            if (!validId(launch.targetId) || !validId(launch.fallbackId)) return;
            keep.add(launch.targetId);
            keep.add(launch.fallbackId);
          }
        }
      }
      const versions = path.join(root, 'versions');
      if (!fs.existsSync(versions)) return;
      assertVersionDirectory(profile, versions);
      for (const id of fs.readdirSync(versions)) {
        if (!VERSION_ID.test(id) || keep.has(id)) continue;
        try {
          // Never touch unpublished builds or unknown directories. The small record stays
          // usable by history rollback after its bulky runtime has been retired.
          readPersonalVersionRecord(profile, id);
          const runtime = path.join(versionDirectory(profile, id), 'runtime');
          if (!fs.existsSync(runtime)) continue;
          assertVersionDirectory(profile, runtime);
          await originalFs.promises.rm(runtime, {
            recursive: true,
            force: true,
            maxRetries: 3,
            retryDelay: 200,
          });
        } catch {
          log.warn('Could not retire a replaced personal application');
        }
      }
    });
  } catch {
    // Publishing/launching has already succeeded. Retry housekeeping on the next build or switch.
    log.warn('Personal application cleanup deferred');
  }
}
