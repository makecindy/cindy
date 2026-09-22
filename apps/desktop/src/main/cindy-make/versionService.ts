import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import originalFs from 'original-fs';
import {
  CINDY_PERSONAL_VERSION,
  type CindyVersionInfo,
  type CindyVersionsState,
} from '../../shared/cindyVersions.js';
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
  describePersonalVersion,
  listPersonalVersions,
  personalVersionId,
  readOriginalVersion,
  readVersionJson,
  selectedVersion,
  versionDirectory,
  versionsRoot,
  VERSION_ID,
  withVersionStore,
  writeVersionJson,
} from './versionStore.js';
import { cleanupPersonalVersions } from './personalVersionCleanup.js';

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
  const originalInfo: CindyVersionInfo = {
    id: 'original',
    kind: 'original',
    development: Boolean(original?.development),
    version: typeof version === 'string' ? version : undefined,
    commit: typeof original?.commit === 'string' ? original.commit : undefined,
    dirty: original?.dirty === true,
    available: !!original && fs.existsSync(original.executable),
    compatible: true,
  };
  const personal = listPersonalVersions(profile, original)[0];
  const publicId = (id: string) => (id === 'original' ? id : CINDY_PERSONAL_VERSION);
  return {
    currentId: publicId(currentId),
    selectedId: publicId(selectedVersion(profile)),
    switching: isCindyVersionSwitching(),
    versions: [originalInfo, ...(personal ? [{ ...personal, id: CINDY_PERSONAL_VERSION }] : [])],
    currentVersion:
      currentId === 'original'
        ? originalInfo
        : {
            ...describePersonalVersion(profile, currentId, original),
            id: CINDY_PERSONAL_VERSION,
          },
    personalUpdateAvailable: currentId !== 'original' && !!personal && personal.id !== currentId,
  };
}
export async function actCindyVersion(action: unknown, id: unknown): Promise<CindyVersionsState> {
  if (
    (action !== 'switch' && action !== 'remove') ||
    typeof id !== 'string' ||
    (id !== 'original' && id !== CINDY_PERSONAL_VERSION && !VERSION_ID.test(id))
  )
    throwIpcError('INVALID_PARAMS', 'Invalid version action');
  const scope = captureDataOwnerBroadcastScope();
  const profile = app.getPath('userData');
  const current = () =>
    isDataOwnerBroadcastScopeCurrent(scope) && app.getPath('userData') === profile;
  try {
    if (makeBusy() || isCindyVersionSwitching()) throwIpcError('PRECONDITION_FAILED', 'busy');
    if (action === 'switch') {
      // Old completion cards carry generation UUIDs. They now address the same personal
      // slot instead of resurrecting the application built for that historical task.
      const targetId = id === 'original' ? id : personalVersionId(profile);
      if (!targetId) throwIpcError('PRECONDITION_FAILED', 'unavailable');
      if (getCurrentCindyVersionId() === targetId) return getCindyVersions();
      if ((await readRelaunchBlockingActivity()).busy || !current())
        throwIpcError('PRECONDITION_FAILED', 'busy');
      await startVersionHandoff(
        targetId,
        async () =>
          current() &&
          !makeBusy() &&
          (targetId === 'original' || personalVersionId(profile) === targetId) &&
          !(await readRelaunchBlockingActivity()).busy,
      );
      if (!current()) throwIpcError('PRECONDITION_FAILED', 'busy');
      // Normal quit awaits the existing Maker, plugin, credential and DB disposers.
      setImmediate(() => app.quit());
    } else {
      await withVersionStore(profile, async () => {
        const targetId = personalVersionId(profile);
        if (
          !current() ||
          id === 'original' ||
          getCurrentCindyVersionId() !== 'original' ||
          selectedVersion(profile) !== 'original'
        )
          throwIpcError('PRECONDITION_FAILED', 'busy');
        if (!targetId || (id !== CINDY_PERSONAL_VERSION && id !== targetId))
          throwIpcError('PRECONDITION_FAILED', 'unavailable');
        const active = readVersionJson<{ id: string; pid: number }>(
          path.join(versionsRoot(profile), 'active.json'),
        );
        if (active && active.id !== 'original') {
          try {
            process.kill(active.pid, 0);
            throwIpcError('PRECONDITION_FAILED', 'busy');
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
          }
        }
        const directory = versionDirectory(profile, targetId);
        assertVersionDirectory(profile, directory);
        const runtime = path.join(directory, 'runtime');
        if (fs.existsSync(runtime)) {
          assertVersionDirectory(profile, runtime);
          await originalFs.promises.rm(runtime, {
            recursive: true,
            force: true,
            maxRetries: 3,
            retryDelay: 200,
          });
        }
        // Explicit deletion must not rediscover an older generation from the legacy registry.
        writeVersionJson(path.join(versionsRoot(profile), 'personal.json'), { id: null });
      });
      await cleanupPersonalVersions(profile);
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
