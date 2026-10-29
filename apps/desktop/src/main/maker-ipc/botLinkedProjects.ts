import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { activeOwnerScopeKey, isAppSessionBoundaryPending, ownerScopedUserDataPath } from '../appSessionState.js';
import { getBotRemoteSettingsSource } from '../localDb/ipc/bots.js';
import { listRecentWorkdirs } from '../localDb/ipc/recentWorkdirs.js';
import { listProjectAliases } from '../localDb/ipc/projectAliases.js';
import { loadSidebarSettingsSnapshot } from '../sidebarSettingsStore.js';
import { projectKeyComparisonKey } from '../../shared/projectKeys.js';
import { extractDisplayName } from '../../shared/projectDisplayName.js';
import { normalizeWorkingDirForStorage } from '../../shared/workingDir.js';
import type { BotLinkedProject, BotProjectOption } from '../../shared/botWorkbench.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { linkedProjectDirectoryKey, readBotLinkedProjects, setBotLinkedProject } from './botWorkbenchService.js';
import { broadcastBotRemoteResourceChanged } from './botRemoteResourceInvalidation.js';
import { withBotProfileLocks } from './botProfileLock.js';

const groupKey = (directory: string) => projectKeyComparisonKey(`local:${directory}`, process.platform);
const projectId = (project: Pick<BotLinkedProject, 'path' | 'deviceId'>) => createHash('sha256')
  .update(JSON.stringify([project.deviceId ?? null, project.deviceId ? project.path : linkedProjectDirectoryKey(project.path)])).digest('hex');

/** One account-bound service for local settings, remote settings and the teammate tools. */
export async function botLinkedProjectAccess(botId: string) {
  const owner = activeOwnerScopeKey();
  const root = ownerScopedUserDataPath();
  const assertCurrent = () => {
    if (isAppSessionBoundaryPending() || activeOwnerScopeKey() !== owner)
      throwIpcError('PRECONDITION_FAILED', 'Account changed');
  };
  assertCurrent();
  await getBotRemoteSettingsSource(botId);
  assertCurrent();
  const read = async (): Promise<BotProjectOption[]> => {
    assertCurrent();
    const [linked, registered, aliases] = await Promise.all([
      readBotLinkedProjects(root, botId), listRecentWorkdirs(), listProjectAliases(),
    ]);
    assertCurrent();
    const hidden = new Set(loadSidebarSettingsSnapshot().hiddenProjectKeys.map(key => projectKeyComparisonKey(key, process.platform)));
    const names = new Map(aliases.map(row => [projectKeyComparisonKey(row.projectKey, process.platform), row.alias]));
    const options = new Map<string, Omit<BotProjectOption, 'name'>>();
    for (const project of linked) {
      const local = !project.deviceId;
      const known = local ? registered.find(row => linkedProjectDirectoryKey(row.path) === linkedProjectDirectoryKey(project.path)) : undefined;
      const id = projectId(project);
      const available = local && (known?.exists ?? await stat(project.path).then(value => value.isDirectory(), () => false));
      assertCurrent();
      options.set(id, { id, path: project.path,
        ...(project.deviceId ? { deviceId: project.deviceId } : {}), linked: true, available });
    }
    for (const project of registered) {
      if (!project.exists || hidden.has(groupKey(project.path))) continue;
      const id = projectId(project);
      if (!options.has(id)) options.set(id, { id, path: project.path, linked: false, available: true });
    }
    const result = [...options.values()];
    const displayPaths = result.map(project => normalizeWorkingDirForStorage(project.path) ?? project.path);
    return result.map((project, index) => ({ ...project,
      name: !project.deviceId && names.get(groupKey(project.path))
        || extractDisplayName(displayPaths[index], displayPaths).name,
    }));
  };
  return {
    read,
    async set(id: string, linked: boolean, actionGuard: () => void = () => {}) {
      return withBotProfileLocks([botId], async () => {
        assertCurrent();
        const settings = await getBotRemoteSettingsSource(botId);
        assertCurrent();
        if (settings.source.status !== 'active') throwIpcError('PRECONDITION_FAILED', 'Teammate is not active');
        const project = (await read()).find(item => item.id === id);
        if (!project || linked && !project.linked && !project.available) throwIpcError('NOT_FOUND', 'Project unavailable');
        const guard = () => { assertCurrent(); actionGuard(); };
        guard();
        await setBotLinkedProject(root, botId, { path: project.path, ...(project.deviceId ? { deviceId: project.deviceId } : {}) }, linked, guard);
        broadcastBotRemoteResourceChanged(botId);
        return read();
      });
    },
  };
}
