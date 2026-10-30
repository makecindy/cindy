import path from 'node:path';

// Preserve existing installation roots and records; no user-data migration.
export const makeToolRoot = (userData: string) => path.join(userData, 'cindy-make');
export {
  installTool as installMakeTool,
  installedTool as installedMakeTool,
} from '../managed-tools/installer.js';
export type { ToolInstallProgress as InstallProgress } from '../managed-tools/types.js';
