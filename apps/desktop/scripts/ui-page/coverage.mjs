import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { desktop, root, scanPage } from './build.mjs';

const git = (args) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const renderer = path.join(desktop, 'src/renderer');
// Files whose change is visible in the UI; anything else is ignored for coverage.
const UI_FILE = /\.(?:tsx|ts|css|json|png|jpe?g|gif|webp|avif|svg|woff2?|ttf|otf)$/;

/** Merge-base with `requested`, or with the conventional upstream branch. */
export function baseRef(requested) {
  if (typeof requested === 'string') return git(['merge-base', 'HEAD', requested]).trim();
  for (const candidate of ['upstream/main', 'origin/main', 'main']) {
    try {
      return git(['merge-base', 'HEAD', candidate]).trim();
    } catch {
      // Try the next conventional base.
    }
  }
  throw new Error('No base for --changed; pass --changed=<ref>');
}

/** Worktree changes (committed since the base, staged, unstaged and untracked). */
export function changedFiles(requested) {
  const base = baseRef(requested);
  const tracked = git(['diff', '--name-only', base, '--']).split('\n');
  const untracked = git(['ls-files', '--others', '--exclude-standard']).split('\n');
  return {
    base,
    files: [...new Set([...tracked, ...untracked])]
      .filter(Boolean)
      .map((file) => path.join(root, file))
      .filter((file) => existsSync(file)),
  };
}

/**
 * Which pages load each changed file for real. A file a page replaces with a stub is not
 * covered by that page. Renderer UI files no page loads are reported as uncovered.
 */
export async function coverageFor(pages, changed) {
  const covered = {};
  const replacedOnly = {};
  const selected = [];
  for (const definition of Object.values(pages)) {
    const { inputs, replaced } = await scanPage(definition);
    const loaded = new Set(inputs);
    const stubbed = new Set(Object.keys(replaced).map((key) => path.join(desktop, key)));
    const hits = changed.filter((file) => loaded.has(file));
    for (const file of changed) {
      const base = file.replace(/\.(?:[cm]?[jt]sx?)$/, '');
      if (stubbed.has(base)) (replacedOnly[path.relative(root, file)] ??= []).push(definition.name);
    }
    for (const file of hits) (covered[path.relative(root, file)] ??= []).push(definition.name);
    // Fixture-only edits also select the page (its own scenario changed).
    const own = changed.some((file) => file.startsWith(definition.dir + path.sep));
    if (hits.length || own) selected.push(definition.name);
  }
  const uncovered = changed
    .filter((file) => file.startsWith(renderer + path.sep) && UI_FILE.test(file))
    .filter((file) => !file.includes(`${path.sep}__tests__${path.sep}`))
    .map((file) => path.relative(root, file))
    .filter((file) => !covered[file]);
  return { covered, replacedOnly, uncovered, selected };
}
