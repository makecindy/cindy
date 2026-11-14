import path from 'node:path';
import { copyFile } from 'node:fs/promises';
import { installTool } from '../managed-tools/installer.js';
import { extractToolArchive } from '../managed-tools/archive.js';

// Preserve existing installation roots and records; no user-data migration.
export const makeToolRoot = (userData: string) => path.join(userData, 'cindy-make');
export { installedTool as installedMakeTool } from '../managed-tools/installer.js';
export type { ToolInstallProgress as InstallProgress } from '../managed-tools/types.js';

/** Intel Mac uses the official Node distribution; retain pnpm's relative imports
 * while exposing its shim under the command name that the existing PATH runner finds. */
export function installMakeTool(
  input: Parameters<typeof installTool>[0],
  deps: Parameters<typeof installTool>[1] = {},
): ReturnType<typeof installTool> {
  const nodePackage = input.artifact.id === 'pnpm' &&
    input.artifact.host === 'darwin-x64' && input.artifact.executable === 'package/bin/pnpm';
  if (!nodePackage) return installTool(input, deps);
  return installTool(input, {
    ...deps,
    extract: async (...args) => {
      await (deps.extract ?? extractToolArchive)(...args);
      await copyFile(path.join(args[1], 'package/bin/pnpm.cjs'), path.join(args[1], 'package/bin/pnpm'));
    },
  });
}
