#!/usr/bin/env node
// Read-only local cleanup planner for an already-terminal GitHub PR.
//
// This script intentionally does not remove worktrees, delete branches, or
// touch remote refs. It produces a bounded JSON plan so the agent can decide
// whether local cleanup is safe before running any destructive git command.

import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { buildCleanupCommands, planLocalCleanup } from './lib/cleanup-plan.mjs';
import { ensureAuth, ensureBinary, ghJson } from './lib/gh.mjs';
import { resolvePullRequestTarget } from './lib/repo-target.mjs';

const exec = promisify(execFile);
const MAX_BUFFER = 10 * 1024 * 1024;
const LONG_LIVED_BRANCHES = new Set(['main', 'master', 'develop', 'dev', 'staging', 'production']);
const LONG_LIVED_PREFIXES = ['release/', 'hotfix/', 'support/'];

function usage() {
  process.stderr.write(`Usage: node scripts/pr-cleanup-plan.mjs <pr-number-or-url> [--repo owner/name] [--worktree path] [--fetch]\n`);
}

function parseArgs(argv) {
  let repo = null;
  let prArg = null;
  let worktree = process.cwd();
  let fetch = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      usage();
      process.exit(0);
    }
    if (arg === '--repo') {
      repo = argv[++i];
      continue;
    }
    if (arg === '--worktree') {
      worktree = argv[++i];
      continue;
    }
    if (arg === '--fetch') {
      fetch = true;
      continue;
    }
    if (!prArg) {
      prArg = arg;
      continue;
    }
    throw new Error(`Unexpected argument: ${arg}`);
  }
  return {
    ...resolvePullRequestTarget(prArg, { explicitRepo: repo, worktree }),
    worktree,
    fetch,
  };
}

async function ensureGit() {
  try {
    await exec('git', ['--version'], { encoding: 'utf8' });
  } catch {
    process.stderr.write('[git] binary not found on PATH. Install git and re-run.\n');
    process.exit(1);
  }
}

async function git(cwd, args, { allowFailure = false } = {}) {
  try {
    const { stdout, stderr } = await exec('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      maxBuffer: MAX_BUFFER,
    });
    return { ok: true, stdout: stdout.trimEnd(), stderr: stderr.trimEnd(), code: 0 };
  } catch (e) {
    if (!allowFailure) throw e;
    return {
      ok: false,
      stdout: String(e.stdout || '').trimEnd(),
      stderr: String(e.stderr || e.message || '').trimEnd(),
      code: typeof e.code === 'number' ? e.code : 1,
    };
  }
}

function parseWorktrees(text) {
  const entries = [];
  let current = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current) entries.push(current);
      current = { path: line.slice('worktree '.length), head: null, branchRef: null, branch: null, detached: false, bare: false };
      continue;
    }
    if (!current) continue;
    if (line.startsWith('HEAD ')) current.head = line.slice('HEAD '.length);
    else if (line.startsWith('branch ')) {
      current.branchRef = line.slice('branch '.length);
      current.branch = current.branchRef.startsWith('refs/heads/')
        ? current.branchRef.slice('refs/heads/'.length)
        : current.branchRef;
    } else if (line === 'detached') current.detached = true;
    else if (line === 'bare') current.bare = true;
  }
  if (current) entries.push(current);
  return entries;
}

function classifyStatusLine(line) {
  if (line.startsWith('??')) return 'untracked';
  return 'tracked';
}

async function worktreeStatus(path) {
  const res = await git(path, ['status', '--porcelain=v1', '--untracked-files=all'], { allowFailure: true });
  if (!res.ok) {
    return { ok: false, dirty: true, error: res.stderr, tracked: 0, untracked: 0, files: [] };
  }
  const lines = res.stdout ? res.stdout.split('\n') : [];
  const files = lines.slice(0, 50).map(line => ({
    status: line.slice(0, 2),
    kind: classifyStatusLine(line),
    path: line.slice(3),
  }));
  return {
    ok: true,
    dirty: lines.length > 0,
    tracked: lines.filter(line => classifyStatusLine(line) === 'tracked').length,
    untracked: lines.filter(line => classifyStatusLine(line) === 'untracked').length,
    files,
    truncated: lines.length > files.length,
  };
}

/** Worktrees Cindy created for a task; Cindy owns their lifecycle. */
function isCindyManagedWorktree(worktreePath) {
  const parent = path.basename(path.dirname(path.resolve(worktreePath)));
  return parent === '.cindy-worktrees' || parent === '.xdt-worktrees';
}

function isLongLivedBranch(name) {
  return LONG_LIVED_BRANCHES.has(name) || LONG_LIVED_PREFIXES.some(prefix => name.startsWith(prefix));
}

async function refExists(cwd, ref) {
  const res = await git(cwd, ['rev-parse', '--verify', '--quiet', ref], { allowFailure: true });
  return { exists: res.ok, oid: res.ok ? res.stdout.trim() : null };
}

async function isAncestor(cwd, ancestor, descendant) {
  const res = await git(cwd, ['merge-base', '--is-ancestor', ancestor, descendant], { allowFailure: true });
  if (res.code === 0) return true;
  if (res.code === 1) return false;
  return null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await ensureBinary();
  await ensureAuth();
  await ensureGit();

  const pr = await ghJson(`repos/${args.repo}/pulls/${args.number}`);
  const repoRoot = (await git(args.worktree, ['rev-parse', '--show-toplevel'])).stdout;
  const worktreesText = (await git(repoRoot, ['worktree', 'list', '--porcelain'])).stdout;
  const worktrees = parseWorktrees(worktreesText);
  const primaryWorktree = worktrees[0]?.path || repoRoot;
  const fetched = args.fetch ? (await git(primaryWorktree, ['fetch', '--prune', 'origin'])).ok : false;

  const headRef = pr.head?.ref;
  const baseRef = pr.base?.ref;
  const headSha = pr.head?.sha || null;
  const localHeadRef = `refs/heads/${headRef}`;
  const originBaseRef = `refs/remotes/origin/${baseRef}`;
  const localBranch = await refExists(primaryWorktree, localHeadRef);
  const originBase = await refExists(primaryWorktree, originBaseRef);
  const targetWorktrees = worktrees.filter(w => w.branch === headRef || (headSha && w.head === headSha));
  const primaryStatus = await worktreeStatus(primaryWorktree);
  const targetWorktreeDetails = await Promise.all(targetWorktrees.map(async wt => ({
    ...wt,
    status: await worktreeStatus(wt.path),
  })));
  const cindyManagedWorktree = targetWorktreeDetails.some(worktree => isCindyManagedWorktree(worktree.path));
  const dirtyWorktrees = targetWorktreeDetails.filter(wt => wt.status.dirty);
  const longLivedBranch = isLongLivedBranch(headRef);
  const terminal = pr.state === 'closed';
  const merged = Boolean(pr.merged);
  const hasLocalArtifacts = localBranch.exists || targetWorktreeDetails.length > 0;
  const headShaAncestorOfOriginBase = headSha && originBase.exists
    ? await isAncestor(primaryWorktree, headSha, originBaseRef)
    : null;
  const localBranchAncestorOfOriginBase = localBranch.exists && originBase.exists
    ? await isAncestor(primaryWorktree, localHeadRef, originBaseRef)
    : null;

  const primaryIsHead = targetWorktreeDetails.some(worktree => worktree.path === primaryWorktree);
  const plan = planLocalCleanup({
    terminal,
    merged,
    longLivedBranch,
    primaryStatus,
    primaryIsHead,
    dirtyTargetCount: dirtyWorktrees.length,
    hasLocalArtifacts,
    cindyManagedWorktree,
  });

  const out = {
    fetchedAt: new Date().toISOString(),
    dryRun: true,
    fetched,
    fetchRecommended: !args.fetch,
    repo: args.repo,
    number: args.number,
    url: pr.html_url,
    state: pr.state,
    merged,
    mergedAt: pr.merged_at,
    closedAt: pr.closed_at,
    mergeCommitSha: pr.merge_commit_sha,
    headRef,
    baseRef,
    headSha,
    local: {
      requestedWorktree: args.worktree,
      repoRoot,
      primaryWorktree,
      primaryStatus,
      localBranchExists: localBranch.exists,
      localBranchOid: localBranch.oid,
      originBaseExists: originBase.exists,
      headShaAncestorOfOriginBase,
      localBranchAncestorOfOriginBase,
      targetWorktrees: targetWorktreeDetails,
      cindyManagedWorktree,
    },
    cleanup: {
      recommendation: plan.recommendation,
      canCleanupLocal: plan.canCleanupLocal,
      canSyncPrimary: plan.canSyncPrimary,
      blockers: plan.blockers,
      notes: plan.notes,
      commands: plan.canCleanupLocal
        ? buildCleanupCommands({
            primaryWorktree,
            baseRef,
            headRef,
            localBranchExists: localBranch.exists,
            targetWorktrees: targetWorktreeDetails,
            syncPrimary: plan.canSyncPrimary,
          })
        : [],
    },
  };

  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

main().catch(e => {
  process.stderr.write(`[pr-cleanup-plan] ${e.message}\n`);
  process.exit(2);
});
