/** Refuse to switch a user's dirty checkout, allowing only verified sqlite-vec LFS bytes. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

export function checkCheckout(cwd, restore = false) {
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  const staged = git('diff', '--cached', '--name-only');
  if (staged) throw new Error(`Staged changes in ${cwd}: ${staged}`);
  const files = git('diff', '--name-only', '-z').split('\0').filter(Boolean);
  for (const file of files) {
    if (!file.startsWith('apps/desktop/native/sqlite-vec/')) throw new Error(`Uncommitted change: ${file}`);
    const pointer = git('show', `HEAD:${file}`);
    const oid = /^oid sha256:([a-f0-9]{64})$/m.exec(pointer)?.[1];
    const src = path.join(cwd, file);
    if (!oid || !fs.existsSync(src) || !fs.lstatSync(src).isFile() || createHash('sha256').update(fs.readFileSync(src)).digest('hex') !== oid) throw new Error(`Modified LFS content: ${file}`);
  }
  if (restore && files.length) git('-c', 'filter.lfs.smudge=cat', '-c', 'filter.lfs.process=', '-c', 'filter.lfs.required=false', 'restore', '--worktree', '--', ...files);
  return files;
}
if (process.argv[1] && fs.existsSync(process.argv[1]) && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { checkCheckout(process.argv[2], process.argv[3] === '--restore-lfs'); }
  catch (e) { console.error(e.message); process.exitCode = 1; }
}
