import { promises as fs } from 'node:fs';
import path from 'node:path';
import { CompanionImportError } from './types.js';

/** One portable asset identity for selection, dependency matching and execution. */
export function importedScriptName(sourceRoot: string, value: string, paths: typeof path = path): string {
  const root = paths.join(sourceRoot, 'scripts');
  const relative = paths.relative(root, paths.resolve(root, value));
  if (!relative || relative === '..' || relative.startsWith(`..${paths.sep}`) || paths.isAbsolute(relative))
    throw new CompanionImportError('AUTOMATION_SCRIPT_MISSING');
  return `scripts/${relative.split(paths.sep).join('/')}`;
}

/** Keep the entry's directory subtree intact: sibling modules and resources are
 * dependencies too. Names are portable snapshot identities, not host paths. */
export function isImportedScriptDependency(name: string, scripts: readonly string[]): boolean {
  return scripts.some(script => name.startsWith(`${path.posix.dirname(script)}/`));
}

export async function importedScriptInterpreter(sourceRoot: string, name: string): Promise<string> {
  if (/\.(sh|bash)$/i.test(name)) return process.platform === 'win32' ? 'bash' : '/bin/bash';
  const python = path.join(sourceRoot, 'hermes-agent', '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  return fs.access(python).then(() => python, () => process.platform === 'win32' ? 'python' : 'python3');
}
