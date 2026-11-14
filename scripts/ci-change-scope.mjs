#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DOCUMENTS = new Set(['AGENTS.md', 'REVIEW.md', 'README.md', 'README.en.md',
  'CONTRIBUTING.md', 'CONTRIBUTING.en.md', '.greptile/files.json', '.greptile/rules.md']);
const GENERATED_DESIGN_DOCUMENTS = new Set([
  'docs/design-rules/DESIGN.md', 'docs/design-rules/login-flow.md',
]);

function isDocument(file) {
  // Packaged prompts, legal notices, generated previews and arbitrary JSON are
  // executable inputs elsewhere in the repository, not a docs-only shortcut.
  return DOCUMENTS.has(file) || /^docs\/(?:dev-rules|product-rules|design-rules)\/[^\n]+\.md$/.test(file);
}

function isLocale(file) {
  return /^apps\/(?:desktop\/src\/renderer|mobile\/src)\/i18n\/locales\/[^/]+\/[^/]+\.json$/.test(file);
}

export function classifyChanges(files) {
  const changed = files.filter(file => !isDocument(file));
  const mode = files.length === 0 ? 'full'
    : changed.length === 0 ? 'docs'
      : changed.every(isLocale) ? 'locales'
        : changed.every(file => /^apps\/mobile\/(?:app|src)\//.test(file)) ? 'mobile'
          : changed.every(file => file.startsWith('apps/desktop/src/')) ? 'desktop' : 'full';
  const runtime = !['docs', 'locales'].includes(mode);
  return {
    mode,
    linux_unit: mode !== 'docs',
    windows_unit: runtime,
    desktop: runtime && mode !== 'mobile',
    runtime,
    // Runtime changes retain the unit tier's DS-8 production regression. The
    // lightweight route must separately validate generated tables and markers.
    design_generated: !runtime && files.some(file => GENERATED_DESIGN_DOCUMENTS.has(file)),
  };
}

export function detectChanges({ eventName, event, head, root = ROOT, git = execFileSync }) {
  const base = eventName === 'pull_request' ? event.pull_request?.base?.sha
    : eventName === 'merge_group' ? event.merge_group?.base_sha
      : eventName === 'push' ? event.before : undefined;
  if (!base || /^0+$/.test(base)) return { ...classifyChanges([]), reason: 'No event base; full checks' };
  if (!/^[a-f0-9]{40}$/i.test(base) || !/^[a-f0-9]{40}$/i.test(head ?? '')) {
    throw new Error('CI scope requires complete event base/head commit SHAs');
  }
  try {
    // Include both sides of moves and preserve unusual filenames. Never use a
    // paginated API file list or the contributor's PR title to skip a check.
    const output = git('git', ['diff', '--name-only', '--no-renames', '-z', base, head, '--'], {
      cwd: root, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024,
    });
    const files = output.split('\0').filter(Boolean);
    return { ...classifyChanges(files), reason: `${files.length} changed paths`, files };
  } catch {
    return { ...classifyChanges([]), reason: 'Diff unavailable; full checks' };
  }
}

function main() {
  const event = process.env.GITHUB_EVENT_PATH
    ? JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')) : {};
  const plan = detectChanges({ eventName: process.env.GITHUB_EVENT_NAME, event, head: process.env.GITHUB_SHA });
  console.log(JSON.stringify(plan, null, 2));
  if (process.env.GITHUB_OUTPUT) {
    const outputs = Object.entries(plan).filter(([key]) => !['files', 'reason'].includes(key));
    fs.appendFileSync(process.env.GITHUB_OUTPUT, outputs.map(([key, value]) => `${key}=${value}\n`).join(''));
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      `## CI scope: ${plan.mode}\n\n${plan.reason}. Linux unit: ${plan.linux_unit}; Windows unit: ${plan.windows_unit}; Desktop checks: ${plan.desktop}; Runtime typechecks: ${plan.runtime}.\n`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
