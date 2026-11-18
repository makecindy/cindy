import { prepareNewProject, projectCreationRoot } from './projectCreation.js';
import {
  validateLocalProjectDirectory,
  validateExistingLocalProjectDirectory,
} from './projectDirectoryRoot.js';
import {
  upsertRecentWorkdir,
  hasRecentWorkdir,
  removeRecentWorkdir,
} from './localDb/ipc/recentWorkdirsCore.js';
import { restoreLocalProjectVisibility } from './sidebarSettingsStoreCore.js';
import { readProjectDirectories, setProjectDirectories } from './projectDirectoryStore.js';
import {
  projectAliasComparisonKey,
  parseProjectDirectories,
  resolveProjectDirectories,
} from '@cindy/maker-shared/project-alias-sync';
import {
  requireCanonicalProjectDirectory,
  validateProjectDirectories,
} from './projectDirectoryValidation.js';
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
import {
  authorizeProjectDirectoryChanges,
  newProjectDirectoryAccess,
  type ProjectInfoAuthorization,
} from './projectInfoAuthorization.js';

export async function readProjectInfo(): Promise<HostProjectAliasesSnapshot> {
  const ownerStamp = getActiveDataOwnerPushStamp();
  if (!ownerStamp.dataOwnerId || isAppSessionBoundaryPending())
    throwIpcError('PRECONDITION_FAILED', 'No active account');
  const aliases = await core.listProjectAliases();
  const creationRoot = await projectCreationRoot();
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
    settingsVersion: 7,
    creationRoot,
    directories: readProjectDirectories(),
    platform: process.platform,
    ownerStamp,
  };
}

export async function updateProjectInfo(
  input: unknown,
  authorization?: ProjectInfoAuthorization,
): Promise<HostProjectAliasesSnapshot> {
  return writeProjectInfo(input, authorization);
}

async function writeProjectInfo(
  input: unknown,
  authorization?: ProjectInfoAuthorization,
  authorizedCreation?: string,
): Promise<HostProjectAliasesSnapshot> {
  const body = requireObject(input, 'input');
  const owner = getActiveDataOwnerPushStamp();
  const assertCurrent = () => {
    authorization?.assertCurrent?.();
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
  const automaticCreation =
    body.create === true && (body.projectKey === 'local:' || !!body.repositoryUrl);
  const projectKey =
    typeof body.projectKey === 'string' && body.projectKey.length <= 4096
      ? automaticCreation && body.projectKey === 'local:'
        ? 'local:'
        : normalizeProjectKey(body.projectKey)
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
  if (
    !changes ||
    Object.keys(changes).some((key) => key !== 'name' && key !== 'icon' && key !== 'directories')
  )
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
  if (body.create !== undefined && typeof body.create !== 'boolean')
    throwIpcError('INVALID_PARAMS', 'Invalid create mode');
  if (body.create && !projectKey.startsWith('local:'))
    throwIpcError(
      'UNSUPPORTED_CAPABILITY',
      'New projects require a directory on the selected computer',
    );
  if (
    body.repositoryUrl !== undefined &&
    (typeof body.repositoryUrl !== 'string' || body.repositoryUrl.length > 4096 || !body.create)
  )
    throwIpcError('INVALID_PARAMS', 'Invalid repository URL');
  const requestedDirectories =
    'directories' in changes ? parseProjectDirectories(changes.directories) : undefined;
  if (requestedDirectories === null) throwIpcError('INVALID_PARAMS', 'Invalid project directories');
  if (body.create && !authorization)
    throwIpcError(
      'WRITABLE_DIRECTORY_AUTHORIZATION_REQUIRED',
      'Project creation was not authorized.',
    );
  const remoteRenderer = projectKey.startsWith('remote:') && authorization?.kind === 'renderer';
  const directories =
    requestedDirectories &&
    (await validateProjectDirectories(projectKey, requestedDirectories, remoteRenderer));
  if (body.create && projectKey !== 'local:') {
    const lexical = validateLocalProjectDirectory((body.projectKey as string).slice(6));
    if (!lexical.ok) throwIpcError('INVALID_PARAMS', lexical.message);
    if (projectKey !== `local:${lexical.workingDir}`)
      throwIpcError(
        'INVALID_PARAMS',
        'Use the project main directory, not a managed task worktree',
      );
    const physical = await validateExistingLocalProjectDirectory(lexical.workingDir);
    if (!physical.ok) throwIpcError('INVALID_PARAMS', physical.message);
    requireCanonicalProjectDirectory(lexical.workingDir, physical.workingDir);
  }
  if (automaticCreation) {
    const checkSelection = (checkOnly: boolean) =>
      authorizeProjectDirectoryChanges({
        projectKey,
        authorization,
        previous: [],
        checkOnly,
        requested: [
          ...(projectKey !== 'local:'
            ? [{ path: projectKey.slice(6), access: 'write' as const }]
            : []),
          ...(directories ?? []),
        ],
      });
    // Preserve the selected folders if the user cancels the import and edits the draft.
    const confirmImport =
      authorization?.kind === 'renderer' && body.repositoryUrl
        ? async (url: string, directory: string) => {
            assertCurrent();
            await authorization.check({ kind: 'repository', url, directory });
            assertCurrent();
            await checkSelection(false);
          }
        : undefined;
    await checkSelection(!!confirmImport);
    assertCurrent();
    const prepared = await prepareNewProject(
      {
        directory: projectKey.slice(6),
        confirmImport,
        directories,
        name: changes.name as string | undefined,
        repositoryUrl: body.repositoryUrl as string | undefined,
      },
      assertCurrent,
    );
    try {
      assertCurrent();
      if (directories?.length)
        await validateProjectDirectories(`local:${prepared.directory}`, directories);
    } catch (error) {
      await prepared.cleanup();
      throw error;
    }
    // A metadata failure can have an uncertain commit. Preserve the completed folder for recovery.
    const { repositoryUrl: _url, ...rest } = body;
    return writeProjectInfo(
      { ...rest, projectKey: `local:${prepared.directory}` },
      authorization,
      `local:${prepared.directory}`,
    );
  }
  const currentDirectories = () =>
    resolveProjectDirectories(
      { aliases: [], platform: process.platform, directories: readProjectDirectories() },
      projectKey,
    );
  // The user's native sheet may stay open indefinitely. Do not hold the store lock while waiting.
  let confirmedSsh: typeof directories;
  if (remoteRenderer && directories) {
    confirmedSsh = newProjectDirectoryAccess(directories, currentDirectories() ?? [], true);
    if (confirmedSsh.length) {
      const separator = projectKey.indexOf(':', 7);
      assertCurrent();
      await authorization.check({
        kind: 'ssh',
        host: decodeURIComponent(projectKey.slice(7, separator)),
        project: projectKey.slice(separator + 1),
        directories: confirmedSsh,
      });
    }
  }
  assertCurrent();
  const lockPath = ownerScopedUserDataPath('project-info-write.lock');
  await withCrossProcessLock(
    lockPath,
    { label: 'project-info', waitMs: 12_000 },
    async (status) => {
      if (!status.held) throwIpcError('INTERNAL', 'Project settings are busy');
      assertCurrent();
      const previousDirectories = currentDirectories();
      const previouslyRegistered = body.create ? await hasRecentWorkdir(projectKey.slice(6)) : true;
      if (authorizedCreation !== projectKey) {
        await authorizeProjectDirectoryChanges({
          projectKey,
          authorization,
          requested: [
            ...(body.create && !previouslyRegistered
              ? [{ path: projectKey.slice(6), access: 'write' as const }]
              : []),
            ...(directories ?? []),
          ],
          previous: previousDirectories ?? [],
          confirmedSsh,
        });
      }
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
      const previousAliases = body.create ? await core.listProjectAliases() : [];
      const previousName =
        previousAliases.find(
          (row) =>
            projectAliasComparisonKey(row.projectKey, process.platform) ===
            projectAliasComparisonKey(projectKey, process.platform),
        )?.alias ?? '';
      assertCurrent();
      let nameWritten = false;
      let registered = false;
      let directoriesWritten = false;
      let iconWritten = false;
      try {
        if ('icon' in changes) {
          await setProjectIcon(projectKey, icon, assertCurrent);
          iconWritten = true;
        }
        if (directories) {
          // A directory or ancestor may have changed during a picker, sheet or lock wait.
          const current = await validateProjectDirectories(
            projectKey,
            requestedDirectories!,
            remoteRenderer,
          );
          directories.forEach((item, i) =>
            requireCanonicalProjectDirectory(item.path, current[i]!.path, remoteRenderer),
          );
          assertCurrent();
          await setProjectDirectories(projectKey, directories, assertCurrent);
          directoriesWritten = true;
        }
        if ('name' in changes) {
          await core.upsertProjectAlias(projectKey, changes.name, process.platform, {
            client: getDbClient(),
            assertCurrent,
          });
          nameWritten = true;
        }
        assertCurrent();
        if (body.create) {
          if (
            !(await upsertRecentWorkdir(
              projectKey.slice(6),
              Date.now(),
              process.platform,
              getDbClient(),
            ))
          )
            throwIpcError('INVALID_PARAMS', 'Could not register project directory');
          registered = true;
          assertCurrent();
          await restoreLocalProjectVisibility(projectKey.slice(6), owner);
        }
      } catch (error) {
        assertCurrent();
        if (body.create && nameWritten)
          await core.upsertProjectAlias(projectKey, previousName, process.platform, {
            client: getDbClient(),
            assertCurrent,
          });
        if (registered && !previouslyRegistered) await removeRecentWorkdir(projectKey.slice(6));
        if (directoriesWritten)
          await setProjectDirectories(projectKey, previousDirectories, assertCurrent);
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
  return {
    ...(await readProjectInfo()),
    ...(body.create ? { createdProjectKey: projectKey } : {}),
  };
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
