import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { safeArchivePath } from './archive.js';
import type { ToolArtifact } from './types.js';

export const toolInstallKey = (artifact: ToolArtifact) => {
  for (const part of [artifact.id, artifact.version, artifact.host]) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(part)) throw new Error('Invalid tool identity');
  }
  if (!/^[a-f0-9]{64}$/.test(artifact.sha256)) throw new Error('Invalid tool digest');
  safeArchivePath(artifact.executable);
  return `${artifact.id}-${artifact.version}-${artifact.host}-${artifact.sha256.slice(0, 12)}`;
};
export const toolInstallRecordPath = (root: string, artifact: ToolArtifact) =>
  path.join(root, 'tools', toolInstallKey(artifact), 'current.json');

/** A record references only a complete immutable generation, never an in-progress extraction. */
export async function installedTool(
  root: string,
  artifact: ToolArtifact,
): Promise<string | undefined> {
  try {
    const record = JSON.parse(await readFile(toolInstallRecordPath(root, artifact), 'utf8'));
    if (
      record.sha256 !== artifact.sha256 ||
      typeof record.generation !== 'string' ||
      !/^[a-f0-9-]{36}$/.test(record.generation)
    )
      return;
    const executable = path.join(
      root,
      'tools',
      toolInstallKey(artifact),
      record.generation,
      ...artifact.executable.split('/'),
    );
    if ((await stat(executable)).isFile()) return executable;
  } catch {
    /* Missing/corrupt records are not installed tools. */
  }
}
