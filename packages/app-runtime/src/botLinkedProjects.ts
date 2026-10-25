import {createHash} from 'node:crypto';
import {stat} from 'node:fs/promises';
import {projectKeyComparisonKey} from '@cindy/maker-shared/project-keys';
import {extractDisplayName} from '@cindy/maker-shared/project-display-name';
import {isWindowsPathLike,normalizeWorkingDirForStorage} from '@cindy/maker-shared/working-dir';
import type {BotLinkedProject,BotProjectOption} from '@cindy/companion-core/botWorkbench';
import {throwIpcError} from '@cindy/remote-agent/ipcValidate';
import type {createBotWorkbenchStore} from '@cindy/companion-core/workbench';
import type {createBotProfileService} from './botProfileService.js';
import type {createRecentWorkdirs} from './recentWorkdirs.js';
export function linkedProjectDirectoryKey(directory:string):string {
 const normalized=normalizeWorkingDirForStorage(directory)??directory;
 return process.platform==='win32'&&isWindowsPathLike(normalized)?normalized.toLowerCase():normalized;
}
export interface BotLinkedProjectsHost extends Pick<ReturnType<typeof createBotWorkbenchStore>,'readBotLinkedProjects'|'setBotLinkedProject'> {
 activeOwnerScopeKey():string;
 isAppSessionBoundaryPending():boolean;
 ownerScopedUserDataPath():string;
 getBotRemoteSettingsSource:ReturnType<typeof createBotProfileService>['getBotRemoteSettingsSource'];
 listRecentWorkdirs:ReturnType<typeof createRecentWorkdirs>['listRecentWorkdirs'];
 listProjectAliases():Promise<Array<{projectKey:string;alias:string}>>;
 loadSidebarSettingsSnapshot():{hiddenProjectKeys:string[]};
 linkedProjectDirectoryKey(directory:string):string;
 broadcastBotRemoteResourceChanged(botId:string):void;
 withBotProfileLocks<T>(ids:readonly string[],work:()=>Promise<T>):Promise<T>;
}
export function createBotLinkedProjects(host:BotLinkedProjectsHost) {
 const {activeOwnerScopeKey,isAppSessionBoundaryPending,ownerScopedUserDataPath,getBotRemoteSettingsSource,listRecentWorkdirs,listProjectAliases,loadSidebarSettingsSnapshot,linkedProjectDirectoryKey,readBotLinkedProjects,setBotLinkedProject,broadcastBotRemoteResourceChanged,withBotProfileLocks}=host;
const groupKey = (directory: string) => projectKeyComparisonKey(`local:${directory}`, process.platform);
const projectId = (project: Pick<BotLinkedProject, 'path' | 'deviceId'>) => createHash('sha256')
  .update(JSON.stringify([project.deviceId ?? null, project.deviceId ? project.path : linkedProjectDirectoryKey(project.path)])).digest('hex');

/** One account-bound service for local settings, remote settings and the teammate tools. */
async function botLinkedProjectAccess(botId: string) {
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

return {botLinkedProjectAccess};
}
