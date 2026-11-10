#!/usr/bin/env node
// Build-time counterpart of prepareBuiltInSkills' immutable bundle-version guard.
// Read-only: no index, userData, installed Skills, or synchronization settings are touched.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const SKILLS_ROOT = 'apps/desktop/resources/system-skills';
export const VERSION_FILE = 'apps/desktop/src/main/maker-host/built-in-skills.ts';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION_PATTERN = /^export const BUILT_IN_SKILLS_BUNDLE_VERSION = (\d+);\r?$/m;

function versionOf(source) {
  const match = VERSION_PATTERN.exec(source);
  return match ? Number(match[1]) : null;
}

/** Compare the candidate with *all* reachable versions, including merge side parents. */
export function assertBundleVersion(candidate, history) {
  if (!Number.isSafeInteger(candidate.version) || candidate.version < 1) {
    throw new Error('BUILT_IN_SKILLS_BUNDLE_VERSION must be a positive safe integer');
  }
  for (const previous of history) {
    if (previous.version > candidate.version) {
      throw new Error(`Built-in Skill bundle ${candidate.version} is older than ${previous.version} at ${previous.ref}; increment BUILT_IN_SKILLS_BUNDLE_VERSION above it.`);
    }
    if (previous.version === candidate.version && previous.fingerprint !== candidate.fingerprint) {
      throw new Error(`Built-in Skill bundle version ${candidate.version} was reused for different bytes (history: ${previous.ref}). Increment BUILT_IN_SKILLS_BUNDLE_VERSION above every composed source version before building.`);
    }
  }
}

function filesFingerprint(files) {
  // Git object IDs are only a compact byte comparison here, not the runtime manifest format.
  return JSON.stringify(files.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
}

function workingFingerprint(root, objectFormat) {
  const files = [];
  const visit = (dir, relative = '') => {
    if (!fs.lstatSync(dir).isDirectory()) throw new Error(`Unsupported bundled Skill directory: ${dir}`);
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    if (!entries.length) throw new Error(`Untracked empty bundled Skill directory: ${dir}`);
    for (const entry of entries) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(absolute, name);
      else if (entry.isFile()) {
        const bytes = fs.readFileSync(absolute);
        const oid = createHash(objectFormat).update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
        files.push([name, oid]);
      } else throw new Error(`Unsupported bundled Skill entry: ${name}`);
    }
  };
  visit(root);
  return filesFingerprint(files);
}

function treeFingerprint(tree, git) {
  const files = git(['ls-tree', '-rz', tree]).toString('utf8').split('\0').filter(Boolean).map(entry => {
    const match = /^(100644|100755) blob ([a-f0-9]+)\t(.+)$/s.exec(entry);
    if (!match) throw new Error(`Unsupported bundled Skill tree entry in ${tree}`);
    return [match[3], match[2]];
  });
  return filesFingerprint(files);
}

/** No dependencies or app initialization: safe to run before installation and packaging. */
export function checkBuiltInSkills({ repoRoot = ROOT, baseRefs = [] } = {}) {
  const git = (args, input) => execFileSync('git', args, {
    cwd: repoRoot, input, maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (git(['rev-parse', '--is-shallow-repository']).toString().trim() !== 'false') {
    throw new Error('Built-in Skill version check needs complete Git history; fetch --unshallow before building.');
  }
  const refs = [...new Set(['HEAD', ...baseRefs].map(ref =>
    git(['rev-parse', '--verify', `${ref}^{commit}`]).toString().trim()))];
  const version = versionOf(fs.readFileSync(path.join(repoRoot, VERSION_FILE), 'utf8'));
  const fingerprint = workingFingerprint(path.join(repoRoot, SKILLS_ROOT),
    git(['rev-parse', '--show-object-format']).toString().trim());
  assertBundleVersion({ version, fingerprint }, []);

  // full-history retains side parents: two branches may each bump to the same number.
  // Batch object lookups keep this bounded by history size, not one process per commit.
  const commits = git(['rev-list', '--full-history', ...refs, '--', VERSION_FILE, SKILLS_ROOT])
    .toString().trim().split('\n').filter(Boolean);
  const objects = git(['cat-file', '--batch-check'], commits.flatMap(ref =>
    [`${ref}:${VERSION_FILE}`, `${ref}:${SKILLS_ROOT}`]).join('\n') + '\n')
    .toString().trim().split('\n');
  const snapshots = commits.flatMap((ref, i) => {
    const source = /^([a-f0-9]+) blob \d+$/.exec(objects[i * 2]);
    const tree = /^([a-f0-9]+) tree \d+$/.exec(objects[i * 2 + 1]);
    return source && tree ? [{ ref, source: source[1], tree: tree[1] }] : [];
  });
  const sources = [...new Set(snapshots.map(s => s.source))];
  const versions = new Map();
  if (sources.length) {
    const batch = git(['cat-file', '--batch'], sources.join('\n') + '\n');
    let offset = 0;
    for (const source of sources) {
      const newline = batch.indexOf(10, offset);
      const header = /^([a-f0-9]+) blob (\d+)$/.exec(batch.subarray(offset, newline).toString());
      if (!header || header[1] !== source) throw new Error('Cannot read built-in Skill version history');
      offset = newline + 1;
      const size = Number(header[2]);
      versions.set(source, versionOf(batch.subarray(offset, offset + size).toString('utf8')));
      offset += size + 1;
    }
  }
  const trees = new Map();
  for (const snapshot of snapshots) {
    const previousVersion = versions.get(snapshot.source);
    // Older, already shipped conflicts are not retroactively rejected by a new version.
    if (previousVersion === null || previousVersion < version) continue;
    let previousFingerprint;
    if (previousVersion === version) {
      if (!trees.has(snapshot.tree)) trees.set(snapshot.tree, treeFingerprint(snapshot.tree, git));
      previousFingerprint = trees.get(snapshot.tree);
    }
    assertBundleVersion({ version, fingerprint }, [{
      ref: snapshot.ref, version: previousVersion, fingerprint: previousFingerprint,
    }]);
  }
  return { version, checkedCommits: commits.length, comparedTrees: trees.size };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const baseRefs = [];
    for (let i = 2; i < process.argv.length; i += 2) {
      if (process.argv[i] !== '--base-ref' || !process.argv[i + 1]) throw new Error('Usage: check-built-in-skills.mjs [--base-ref REF]...');
      baseRefs.push(process.argv[i + 1]);
    }
    console.log('Built-in Skill bundle verified:', checkBuiltInSkills({ baseRefs }));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
