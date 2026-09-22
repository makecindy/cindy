import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';

/** A release can only use the CLI files bound to its bundle manifest. */
export async function requireBundleDist(bundleDir, manifest) {
  const directory = path.join(bundleDir, 'dist');
  if (!(await lstat(directory)).isDirectory()) throw new Error('bundle dist must be a regular directory; rebuild the bundle');
  for (const [name, field] of [['cli.cjs', 'cliDigest'], ['eval-cli.cjs', 'evalCliDigest']]) {
    const file = path.join(directory, name);
    if (!(await lstat(file)).isFile()) throw new Error(`bundle ${name} must be a regular file`);
    const digest = createHash('sha256').update(await readFile(file)).digest('hex');
    if (typeof manifest[field] !== 'string' || digest !== manifest[field]) throw new Error(`bundle ${name} digest mismatch; rebuild the bundle`);
  }
  return directory;
}
