import { listRecentWorkdirs } from '../localDb/ipc/recentWorkdirs.js';
import { listProjectAliases, upsertProjectAlias } from '../localDb/ipc/projectAliases.js';
import { loadSidebarSettingsSnapshot, setLocalProjectHidden } from '../sidebarSettingsStore.js';
import { validateLocalProjectDirectory, withLocalProjectContext } from './createProject.js';
import { createProjectManagement } from '@cindy/app-runtime/projectManagement';
export const { listProjects, renameProject, removeProject } = createProjectManagement({
  listRecentWorkdirs,
  listProjectAliases,
  upsertProjectAlias,
  loadSidebarSettingsSnapshot,
  setLocalProjectHidden,
  validateLocalProjectDirectory,
  withLocalProjectContext,
});
