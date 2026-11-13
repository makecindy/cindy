import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { normalizeWorkdirKey } from './ghostWorkdirPrefs.js';
import type { PluginManagementProject } from '../../shared/pluginManagement.js';

export type RemotePluginProject = PluginManagementProject & { workdir: string };

export function projectPluginWorkdir(workdir: string): RemotePluginProject {
  return {
    id: createHash('sha256').update(normalizeWorkdirKey(workdir)).digest('hex'),
    name: path.basename(workdir) || workdir,
    path: workdir,
    workdir,
  };
}

/** Only the selected Host resolves browser output; subsequent writes use its issued ID. */
export async function resolvePluginWorkdir(workdir: string): Promise<RemotePluginProject> {
  if (!path.isAbsolute(workdir) || workdir.includes('\0') || !(await stat(workdir)).isDirectory())
    throw new Error('INVALID_PROJECT_DIRECTORY');
  return projectPluginWorkdir(workdir);
}
