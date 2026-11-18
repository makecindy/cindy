import { withCrossProcessLock } from './device-link/crossProcessLock.js';
import { ownerScopedUserDataPath } from './appSessionState.js';
import {
  importProjectIcon,
  releasePreviousProjectImages,
  readProjectIconBytes,
} from './projectIconMedia.js';
import {
  isProjectImage,
  isProjectImageDraft,
  resolveProjectIcon,
} from '@cindy/maker-shared/project-alias-sync';
import { readProjectIcons, setProjectIcon } from './projectIconStore.js';
import { getActiveDataOwnerPushStamp, isAppSessionBoundaryPending } from './appSessionState.js';
import { normalizeProjectKey } from '../shared/projectKeys.js';
import {
  validProjectIcon,
  type HostProjectAliasesSnapshot,
} from '@cindy/maker-shared/project-alias-sync';
import * as core from './localDb/ipc/projectAliasesCore.js';
import { getDbClient } from './localDb/client/current.js';
import { requireObject, throwIpcError } from './utils/ipcValidate.js';

export async function readProjectInfo(): Promise<HostProjectAliasesSnapshot> {
  const ownerStamp = getActiveDataOwnerPushStamp();
  if (!ownerStamp.dataOwnerId || isAppSessionBoundaryPending())
    throwIpcError('PRECONDITION_FAILED', 'No active account');
  const aliases = await core.listProjectAliases();
  const current = getActiveDataOwnerPushStamp();
  if (
    isAppSessionBoundaryPending() ||
    current.dataOwnerId !== ownerStamp.dataOwnerId ||
    current.ownerGeneration !== ownerStamp.ownerGeneration
  )
    throwIpcError('PRECONDITION_FAILED', 'Project account changed');
  return {
    aliases: aliases
      .filter((row) => !row.projectKey.startsWith('device:'))
      .map(({ projectKey, alias }) => ({ projectKey, alias })),
    icons: Object.fromEntries(
      Object.entries(readProjectIcons()).filter(([key]) => !key.startsWith('device:')),
    ),
    settingsSupported: true,
    settingsVersion: 5,
    platform: process.platform,
    ownerStamp,
  };
}

export async function updateProjectInfo(input: unknown): Promise<HostProjectAliasesSnapshot> {
  const body = requireObject(input, 'input');
  const owner = getActiveDataOwnerPushStamp();
  const assertCurrent = () => {
    const current = getActiveDataOwnerPushStamp();
    if (
      isAppSessionBoundaryPending() ||
      !owner.dataOwnerId ||
      current.dataOwnerId !== body.dataOwnerId ||
      current.ownerGeneration !== body.ownerGeneration
    )
      throwIpcError('PRECONDITION_FAILED', 'Project account changed');
  };
  assertCurrent();
  const projectKey =
    typeof body.projectKey === 'string' && body.projectKey.length <= 4096
      ? normalizeProjectKey(body.projectKey)
      : null;
  if (!projectKey || (!projectKey.startsWith('local:') && !projectKey.startsWith('remote:')))
    throwIpcError('INVALID_PARAMS', 'Invalid host project identity');
  const changes =
    body.field === 'profile'
      ? requireObject(body.value, 'value')
      : body.field === 'icon'
        ? { icon: body.value }
        : body.field === 'name'
          ? { name: body.value }
          : null;
  if (!changes || Object.keys(changes).some((key) => key !== 'name' && key !== 'icon'))
    throwIpcError('INVALID_PARAMS', 'Invalid project setting');
  if ('name' in changes && (typeof changes.name !== 'string' || changes.name.trim().length > 80))
    throwIpcError('INVALID_PARAMS', 'Invalid project name');
  if (
    'icon' in changes &&
    changes.icon !== null &&
    !validProjectIcon(changes.icon) &&
    !isProjectImageDraft(changes.icon)
  )
    throwIpcError('INVALID_PARAMS', 'Invalid project icon');
  const lockPath = ownerScopedUserDataPath('project-info-write.lock');
  await withCrossProcessLock(
    lockPath,
    { label: 'project-info', waitMs: 12_000 },
    async (status) => {
      if (!status.held) throwIpcError('INTERNAL', 'Project settings are busy');
      assertCurrent();
      const previousIcon = resolveProjectIcon(
        { aliases: [], icons: readProjectIcons(), platform: process.platform },
        projectKey,
      );
      let icon = changes.icon as string | null;
      if (isProjectImage(icon) && icon !== previousIcon)
        throwIpcError(
          'INVALID_PARAMS',
          'Upload a project image instead of referring to another image',
        );
      if (isProjectImageDraft(icon))
        icon = await importProjectIcon(icon, projectKey, assertCurrent);
      assertCurrent();
      let iconWritten = false;
      try {
        if ('icon' in changes) {
          await setProjectIcon(projectKey, icon, assertCurrent);
          iconWritten = true;
        }
        if ('name' in changes)
          await core.upsertProjectAlias(projectKey, changes.name, process.platform, {
            client: getDbClient(),
            assertCurrent,
          });
        assertCurrent();
      } catch (error) {
        assertCurrent();
        if (iconWritten) await setProjectIcon(projectKey, previousIcon, assertCurrent);
        if ('icon' in changes)
          await releasePreviousProjectImages(projectKey, previousIcon, assertCurrent).catch(
            () => {},
          );
        throw error;
      }
      // Reference cleanup is best effort: a committed profile must not appear to have failed.
      if ('icon' in changes)
        await releasePreviousProjectImages(projectKey, icon, assertCurrent).catch(() => {});
    },
  );
  assertCurrent();
  return readProjectInfo();
}

export async function readProjectIconImage(input: unknown): Promise<string | null> {
  const body = requireObject(input, 'input');
  const snapshot = await readProjectInfo();
  if (typeof body.projectKey !== 'string')
    throwIpcError('INVALID_PARAMS', 'Invalid project identity');
  const icon = resolveProjectIcon(snapshot, body.projectKey);
  if (!isProjectImage(icon)) return null;
  const result = await readProjectIconBytes(icon);
  const current = getActiveDataOwnerPushStamp();
  if (
    isAppSessionBoundaryPending() ||
    current.dataOwnerId !== snapshot.ownerStamp?.dataOwnerId ||
    current.ownerGeneration !== snapshot.ownerStamp?.ownerGeneration
  )
    throwIpcError('PRECONDITION_FAILED', 'Project account changed');
  return result;
}
