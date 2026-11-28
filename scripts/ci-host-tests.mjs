#!/usr/bin/env node
// Keep the workflow and its stable verify check unconditional. Only the costly
// three-OS matrix is selected by paths; unknown ranges must never silently skip.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const INFRASTRUCTURE = new Set([
  '.github/workflows/ci.yml', '.gitattributes', '.npmrc', '.nvmrc', '.node-version',
  'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.json',
]);

export function needsHostTests(files) {
  // Host imports desktop modules, serves its renderer and uses workspace packages
  // transitively. Keep those trees broad rather than maintaining a fragile import
  // allowlist. Build/install/test scripts and dependency patches are inputs too.
  return files.some(file => INFRASTRUCTURE.has(file)
    || /^(?:apps\/(?:host|web|desktop|[^/]+-bin)\/|packages\/|scripts\/|patches\/)/.test(file));
}

export function detectHostChanges({ eventName, event = {}, head, root = ROOT, git = execFileSync }) {
  const base = eventName === 'pull_request' ? event.pull_request?.base?.sha
    : eventName === 'merge_group' ? event.merge_group?.base_sha
      : eventName === 'push' ? event.before : undefined;
  if (!base || /^0+$/.test(base)) return { required: true, reason: 'No event base; run Host regressions' };
  if (!/^[a-f0-9]{40}$/i.test(base) || !/^[a-f0-9]{40}$/i.test(head ?? '')) {
    throw new Error('Host CI requires complete event base/head commit SHAs');
  }
  // Include both paths of a rename, including a deletion out of a relevant tree.
  const output = git('git', ['diff', '--name-only', '--no-renames', '-z', base, head, '--'], {
    cwd: root, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024,
  });
  const files = output.split('\0').filter(Boolean);
  return { required: needsHostTests(files), reason: `${files.length} changed paths`, files };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const event = process.env.GITHUB_EVENT_PATH
      ? JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')) : {};
    const result = detectHostChanges({ eventName: process.env.GITHUB_EVENT_NAME, event, head: process.env.GITHUB_SHA });
    console.log(`Host CI required=${result.required}: ${result.reason}`);
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `required=${result.required}\n`);
  } catch (error) { console.error(error); process.exitCode = 1; }
}
