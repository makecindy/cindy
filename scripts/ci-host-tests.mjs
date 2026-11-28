#!/usr/bin/env node
// Keep the workflow and its stable verify check unconditional. Only the costly
// three-OS matrix is selected by paths; unknown ranges must never silently skip.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const HOST_INFRASTRUCTURE = new Set([
  '.github/workflows/ci.yml', '.gitattributes', '.npmrc', '.nvmrc', '.node-version',
  'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.json',
]);

const HOST_SCAN_EXTS = new Set(['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs', '.json']);
const DESKTOP_TEST_FILE = /^apps\/desktop\/.+\.test\.[cm]?[jt]sx?$/;

function walkHostFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkHostFiles(full, out);
    else if (HOST_SCAN_EXTS.has(path.extname(entry.name))) out.push(full);
  }
  return out;
}

/**
 * Scan apps/host sources and tsconfig for relative references into apps/desktop/src/renderer/.
 * Returns normalized repo-relative paths (including .ts/.tsx candidates when imported via .js)
 * so pure Desktop UI/renderer edits skip the 3-OS Host matrix while any shared type/asset/helper
 * referenced by Host still triggers it.
 */
export function hostRendererEntrypoints(root = ROOT) {
  const hostDir = path.join(root, 'apps', 'host');
  if (!fs.existsSync(hostDir)) return null;
  const entrypoints = new Set();
  const refPattern = /['"]((?:\.\.\/)+desktop\/src\/renderer\/[^'"]+)['"]/g;
  for (const file of walkHostFiles(hostDir)) {
    const source = fs.readFileSync(file, 'utf8');
    const fileDir = path.dirname(file);
    for (const match of source.matchAll(refPattern)) {
      const rel = path.relative(root, path.resolve(fileDir, match[1])).split(path.sep).join('/');
      if (!rel.startsWith('apps/desktop/src/renderer/')) continue;
      entrypoints.add(rel);
      if (/\.[cm]?js$/.test(rel)) {
        const stem = rel.replace(/\.[cm]?js$/, '');
        entrypoints.add(`${stem}.ts`);
        entrypoints.add(`${stem}.tsx`);
        entrypoints.add(`${stem}.mts`);
        entrypoints.add(`${stem}.d.ts`);
      } else if (!path.posix.extname(rel)) {
        entrypoints.add(`${rel}.ts`);
        entrypoints.add(`${rel}.tsx`);
        entrypoints.add(`${rel}.js`);
        entrypoints.add(`${rel}.mjs`);
        entrypoints.add(`${rel}/index.ts`);
      }
    }
  }
  return entrypoints;
}

export function needsHostTests(files, rendererEntrypoints = hostRendererEntrypoints(ROOT)) {
  // Host imports desktop main/shared modules, workspace packages, scripts and a small
  // set of renderer types/assets (discovered dynamically from apps/host/). Pure Desktop
  // renderer UI files, capture-renderer and *.test.* files do not affect Host runtime.
  return files.some((file) => {
    if (HOST_INFRASTRUCTURE.has(file)) return true;
    if (/^(?:apps\/(?:host|web|[^/]+-bin)\/|packages\/|scripts\/|patches\/)/.test(file)) return true;
    if (!file.startsWith('apps/desktop/')) return false;
    if (DESKTOP_TEST_FILE.test(file)) return false;
    if (file.startsWith('apps/desktop/src/capture-renderer/')) return false;
    if (file.startsWith('apps/desktop/src/renderer/')) {
      // Fail-safe when apps/host cannot be scanned (e.g. partial checkout without apps/host).
      if (!rendererEntrypoints) return true;
      return rendererEntrypoints.has(file);
    }
    return true;
  });
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
  const rendererEntrypoints = hostRendererEntrypoints(root);
  return { required: needsHostTests(files, rendererEntrypoints), reason: `${files.length} changed paths`, files };
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
