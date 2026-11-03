#!/usr/bin/env node
/**
 * pr-preflight.mjs — read-only checks right before pushing and opening a pull request, plus the
 * repository context the agent must follow (rule files, PR template).
 *
 * Works in any Git repository: it only checks what the repository itself declares.
 *   - Never open a PR from the default branch or a detached HEAD (BLOCK).
 *   - DCO sign-off, only when the repository has a `DCO` file or `.github/dco.yml`: every non-merge
 *     commit on the branch needs a Signed-off-by matching its author (BLOCK).
 *   - Prettier on the files this branch changed, only when the repository configures Prettier
 *     and has it installed (WARN).
 *   - Uncommitted changes (WARN), behind the upstream branch (WARN), not pushed / base moved (NOTE).
 * It prints the rule files to re-read (AGENTS.md, CLAUDE.md, CONTRIBUTING.md) and the PR template.
 *
 * Usage: node pr-preflight.mjs [worktree] [--json]
 * Exit:  0 continue (handle WARN/NOTE), 1 a BLOCK to fix first, 2 not a usable Git repository.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function git(root, args) {
  try {
    return { ok: true, out: execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd() };
  } catch (err) {
    return { ok: false, out: String(err.stdout ?? '').trimEnd(), err: String(err.stderr ?? err.message ?? '').trim() };
  }
}

const PRETTIER_CONFIGS = ['.prettierrc', '.prettierrc.json', '.prettierrc.yml', '.prettierrc.yaml', '.prettierrc.js',
  '.prettierrc.cjs', '.prettierrc.mjs', 'prettier.config.js', 'prettier.config.cjs', 'prettier.config.mjs'];

function readPackage(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')); } catch { return null; }
}

/** Prettier on this branch's committed changes, with the repository's own Prettier only. */
function checkPrettier(root, base, warns, notes) {
  if (!PRETTIER_CONFIGS.some((name) => fs.existsSync(path.join(root, name))) && !readPackage(root)?.prettier) return;
  const diff = git(root, ['diff', '--name-only', '--diff-filter=ACMR', `origin/${base}...HEAD`]);
  if (!diff.ok) return;
  const files = diff.out.split('\n')
    .filter((f) => f && /\.(mjs|cjs|jsx?|tsx?|json|md|ya?ml|css|scss|less|html)$/i.test(f) && fs.existsSync(path.join(root, f)))
    .slice(0, 200);
  if (!files.length) return;
  const bin = path.join(root, 'node_modules', '.bin', 'prettier');
  if (!fs.existsSync(bin)) {
    notes.push('The repository uses Prettier but its dependencies are not installed, so formatting was not checked.');
    return;
  }
  try {
    execFileSync(bin, ['--check', '--ignore-unknown', ...files], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    const bad = `${err.stdout ?? ''}${err.stderr ?? ''}`.split('\n')
      .map((line) => line.replace(/^\[warn\]\s*/, '').trim()).filter((line) => files.includes(line));
    warns.push(`Prettier fails on ${bad.length || 'some'} changed file(s)${bad.length ? `: ${bad.slice(0, 5).join(', ')}${bad.length > 5 ? ' …' : ''}` : ''}. Format them with the repository's Prettier and commit before pushing.`);
  }
}

export function findTemplate(root) {
  for (const rel of ['.github/pull_request_template.md', '.github/PULL_REQUEST_TEMPLATE.md', 'PULL_REQUEST_TEMPLATE.md',
    'docs/pull_request_template.md', 'docs/PULL_REQUEST_TEMPLATE.md']) {
    const file = path.join(root, rel);
    if (fs.existsSync(file)) return { path: rel, content: fs.readFileSync(file, 'utf8') };
  }
  return null;
}

/** DCO, only when the repository asks for it: each commit signed off by its own author. */
export function checkDco(root, base) {
  if (!fs.existsSync(path.join(root, 'DCO')) && !fs.existsSync(path.join(root, '.github', 'dco.yml'))) return { requires: false, missing: [] };
  // Merge commits are skipped, as the DCO check does.
  const list = git(root, ['log', '--no-merges', `origin/${base}..HEAD`, '--format=%H%x00%ae%x00%(trailers:key=Signed-off-by,valueonly)%x01']);
  if (!list.ok) return { requires: true, missing: [], error: list.err };
  const missing = [];
  for (const record of list.out.split('\x01')) {
    const text = record.trim();
    if (!text) continue;
    const [hash, email, trailers] = text.split('\x00');
    if (!trailers || !trailers.toLowerCase().includes(`<${String(email ?? '').toLowerCase()}>`)) missing.push(hash.slice(0, 8));
  }
  return { requires: true, missing };
}

export function preflight(target) {
  const top = git(target, ['rev-parse', '--show-toplevel']);
  if (!top.ok) return { error: `Not inside a Git repository: ${target}` };
  const root = top.out;
  if (!git(root, ['remote', 'get-url', 'origin']).ok) return { error: 'This repository has no origin remote.' };
  const head = git(root, ['symbolic-ref', 'refs/remotes/origin/HEAD', '--short']);
  const base = head.ok ? head.out.replace(/^origin\//, '')
    : ['main', 'master'].find((name) => git(root, ['rev-parse', '--verify', `origin/${name}`]).ok);
  if (!base) return { error: 'Cannot tell the default branch (origin/HEAD is unset and origin/main|master is missing). Run git fetch origin first.' };

  const blocks = [], warns = [], notes = [];
  const branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).out;
  if (branch === 'HEAD') blocks.push('Detached HEAD: work on a branch made for this change.');
  else if (branch === base) blocks.push(`On the default branch ${base}: move the work to a branch made for this change.`);

  const dco = checkDco(root, base);
  if (dco.error) warns.push(`Could not check DCO sign-offs (${dco.error}); check Signed-off-by by hand before pushing.`);
  else if (dco.missing.length) blocks.push(`The repository requires DCO sign-off; these commits lack a Signed-off-by matching their author: ${dco.missing.join(', ')}. Add it (git rebase --signoff origin/${base}, or git commit --amend -s for the last one).`);

  const upstream = git(root, ['rev-parse', '--abbrev-ref', '@{u}']);
  if (!upstream.ok) notes.push(`Branch ${branch} is not pushed yet.`);
  else {
    const counts = git(root, ['rev-list', '--left-right', '--count', '@{u}...HEAD']);
    if (counts.ok) {
      const [behind, ahead] = counts.out.split(/\s+/).map(Number);
      if (behind > 0) warns.push(`${behind} commit(s) on the remote branch are not here. Someone else may have pushed: merge them before pushing, never force-push.`);
      if (ahead > 0) notes.push(`${ahead} local commit(s) are not pushed yet.`);
    }
  }
  const dirty = git(root, ['status', '--porcelain']).out;
  if (dirty) warns.push(`${dirty.split('\n').length} uncommitted change(s): commit what belongs to this PR; leave the rest alone.`);
  const gap = git(root, ['rev-list', '--count', `HEAD..origin/${base}`]);
  if (gap.ok && Number(gap.out) > 0) notes.push(`origin/${base} is ${gap.out} commit(s) ahead. If the repository wants branches current, merge it in before the final checks.`);
  checkPrettier(root, base, warns, notes);

  const ruleFiles = ['AGENTS.md', 'CLAUDE.md', 'CONTRIBUTING.md', '.github/CONTRIBUTING.md'].filter((f) => fs.existsSync(path.join(root, f)));
  const template = findTemplate(root);
  return { root, branch, base, blocks, warns, notes, ruleFiles, template: template?.path ?? null, templateContent: template?.content ?? null };
}

function main() {
  const argv = process.argv.slice(2);
  const result = preflight(argv.find((arg) => !arg.startsWith('-')) ?? process.cwd());
  if (result.error) {
    process.stderr.write(`[pr-preflight] ${result.error}\n`);
    process.exit(2);
  }
  if (argv.includes('--json')) {
    const { templateContent, ...rest } = result;
    process.stdout.write(`${JSON.stringify(rest, null, 2)}\n`);
    process.exit(result.blocks.length ? 1 : 0);
  }
  const lines = [`[pr-preflight] ${result.root} branch=${result.branch} base=origin/${result.base}`];
  for (const item of result.blocks) lines.push(`BLOCK: ${item}`);
  for (const item of result.warns) lines.push(`WARN: ${item}`);
  for (const item of result.notes) lines.push(`NOTE: ${item}`);
  lines.push('', result.ruleFiles.length
    ? `Re-read the commit, test and PR rules in: ${result.ruleFiles.join(', ')} (your earlier read may have been compacted away).`
    : 'No AGENTS.md, CLAUDE.md or CONTRIBUTING.md at the repository root.');
  lines.push(result.templateContent
    ? `\n── PR template (${result.template}); fill it truthfully ──\n${result.templateContent.trimEnd()}`
    : '\nNo PR template: describe what changed and why, how it was verified, and the risks.');
  process.stdout.write(`${lines.join('\n')}\n`);
  process.exit(result.blocks.length ? 1 : 0);
}

function realpathOrSelf(target) {
  try { return fs.realpathSync(target); } catch { return target; }
}
// Run only when executed directly (tests import the functions). Compare real paths: the Skill
// directory may be reached through a link.
const entry = process.argv[1] ? realpathOrSelf(process.argv[1]) : null;
if (entry && entry === realpathOrSelf(new URL(import.meta.url).pathname)) main();
