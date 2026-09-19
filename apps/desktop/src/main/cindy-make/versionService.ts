import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import originalFs from 'original-fs';
import type { CindyVersionsState } from '../../shared/cindyVersions.js';
import { isIpcError } from '../../shared/ipc-errors.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import {
  captureDataOwnerBroadcastScope,
  isDataOwnerBroadcastScopeCurrent,
} from '../device-link/broadcast-tap.js';
import { readRelaunchBlockingActivity } from '../relaunchBusyActivityIpc.js';
import {
  describeOriginalVersion,
  getCurrentCindyVersionId,
  isCindyVersionSwitching,
  startVersionHandoff,
} from './versionStartup.js';
import {
  assertVersionDirectory,
  listPersonalVersions,
  readOriginalVersion,
  readVersionJson,
  selectedVersion,
  versionDirectory,
  versionsRoot,
  VERSION_ID,
  withVersionStore,
} from './versionStore.js';

let makeBusy: () => boolean = () => true;
export function configureCindyVersions(probe: () => boolean): void {
  makeBusy = probe;
}
export async function getCindyVersions(): Promise<CindyVersionsState> {
  const profile = app.getPath('userData');
  const currentId = getCurrentCindyVersionId();
  const original =
    currentId === 'original' ? describeOriginalVersion() : readOriginalVersion(profile);
  let version = original?.version;
  // Old version registries predate this field. Read the original package, not the running personal app.
  if (!version && original) {
    try {
      version = readVersionJson<{ version?: string }>(
        path.join(original.appPath, 'package.json'),
      )?.version;
    } catch {}
  }
  return {
    currentId,
    selectedId: selectedVersion(profile),
    switching: isCindyVersionSwitching(),
    versions: [
      {
        id: 'original',
        kind: 'original',
        development: Boolean(original?.development),
        version: typeof version === 'string' ? version : undefined,
        commit: typeof original?.commit === 'string' ? original.commit : undefined,
        dirty: original?.dirty === true,
        available: !!original && fs.existsSync(original.executable),
        compatible: true,
      },
      ...listPersonalVersions(profile, original),
    ],
  };
}
export async function actCindyVersion(action: unknown, id: unknown): Promise<CindyVersionsState> {
  if (
    (action !== 'switch' && action !== 'remove') ||
    typeof id !== 'string' ||
    (id !== 'original' && !VERSION_ID.test(id))
  )
    throwIpcError('INVALID_PARAMS', 'Invalid version action');
  const scope = captureDataOwnerBroadcastScope();
  const profile = app.getPath('userData');
  const current = () =>
    isDataOwnerBroadcastScopeCurrent(scope) && app.getPath('userData') === profile;
  try {
    if (makeBusy() || isCindyVersionSwitching()) throwIpcError('PRECONDITION_FAILED', 'busy');
    if (action === 'switch') {
      if (getCurrentCindyVersionId() === id) return getCindyVersions();
      if ((await readRelaunchBlockingActivity()).busy || !current())
        throwIpcError('PRECONDITION_FAILED', 'busy');
      await startVersionHandoff(
        id,
        async () => current() && !makeBusy() && !(await readRelaunchBlockingActivity()).busy,
      );
      if (!current()) throwIpcError('PRECONDITION_FAILED', 'busy');
      // Normal quit awaits the existing Maker, plugin, credential and DB disposers.
      setImmediate(() => app.quit());
    } else {
      await withVersionStore(profile, async () => {
        if (
          !current() ||
          id === 'original' ||
          id === getCurrentCindyVersionId() ||
          id === selectedVersion(profile)
        )
          throwIpcError('PRECONDITION_FAILED', 'busy');
        const active = readVersionJson<{ id: string; pid: number }>(
          path.join(versionsRoot(profile), 'active.json'),
        );
        if (active?.id === id) {
          try {
            process.kill(active.pid, 0);
            throwIpcError('PRECONDITION_FAILED', 'busy');
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
          }
        }
        const directory = versionDirectory(profile, id);
        assertVersionDirectory(profile, directory);
        await originalFs.promises.rm(directory, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 200,
        });
      });
    }
    return getCindyVersions();
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'busy' || code === 'incompatible' || code === 'launchFailed')
      throwIpcError('PRECONDITION_FAILED', code);
    if (isIpcError(error)) throw error;
    throwIpcError('PRECONDITION_FAILED', 'unavailable');
  }
}
