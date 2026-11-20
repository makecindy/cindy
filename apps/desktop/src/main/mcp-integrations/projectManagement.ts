// Desktop notifications wrap the same project operations used by Node Host.
export { renameProject, removeProject } from './projectTools.desktop.js';
export {
  listProjects,
  resolveProjectsRoot,
  inferProjectsRoot,
  resolveSessionProject,
  readCurrentSessionProject,
} from './projectManagementCore.js';
