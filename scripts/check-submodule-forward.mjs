#!/usr/bin/env node

import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SUBMODULE_PATH = 'cindy-protocol';

function git(cwd, args, { allowFailure = false } = {}) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (!allowFailure && result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    throw new Error(`git ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`);
  }
  return result;
}

export function readGitlink(repoRoot, ref, submodulePath = SUBMODULE_PATH) {
  const result = git(repoRoot, ['ls-tree', ref, '--', submodulePath]);
  const match = result.stdout.trim().match(/^160000 commit ([0-9a-f]{40})\t(.+)$/i);
  if (!match || match[2] !== submodulePath) {
    throw new Error(`${ref} 中缺少合法的 ${submodulePath} gitlink`);
  }
  return match[1].toLowerCase();
}

function isAncestor(repoRoot, older, newer) {
  const result = git(repoRoot, ['merge-base', '--is-ancestor', older, newer], {
    allowFailure: true,
  });
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  const detail = (result.stderr || result.stdout || '').trim();
  throw new Error(`无法比较协议历史 ${older.slice(0, 10)}..${newer.slice(0, 10)}${detail ? `: ${detail}` : ''}`);
}

export function classifyProtocolRelation(protocolRepo, baseOid, headOid) {
  if (baseOid === headOid) return 'unchanged';
  if (isAncestor(protocolRepo, baseOid, headOid)) return 'forward';
  if (isAncestor(protocolRepo, headOid, baseOid)) return 'rollback';
  return 'diverged';
}

function ensureCommit(protocolRepo, oid) {
  if (git(protocolRepo, ['cat-file', '-e', `${oid}^{commit}`], { allowFailure: true }).status === 0) {
    return;
  }
  git(protocolRepo, ['fetch', '--no-tags', 'origin', oid]);
}

export function validateSubmoduleForward(repoRoot, baseRef, headRef = 'HEAD') {
  const baseOid = readGitlink(repoRoot, baseRef);
  const headOid = readGitlink(repoRoot, headRef);
  const protocolRepo = path.join(repoRoot, SUBMODULE_PATH);
  ensureCommit(protocolRepo, baseOid);
  ensureCommit(protocolRepo, headOid);
  const relation = classifyProtocolRelation(protocolRepo, baseOid, headOid);
  return { baseRef, headRef, baseOid, headOid, relation };
}

function main() {
  const repoRoot = process.cwd();
  const baseRef = process.env.CINDY_PROTOCOL_BASE_REF || 'origin/main';
  const result = validateSubmoduleForward(repoRoot, baseRef);
  const summary = `${result.baseOid.slice(0, 10)} -> ${result.headOid.slice(0, 10)}`;
  if (result.relation === 'rollback') {
    console.error(`::error file=cindy-protocol::cindy-protocol gitlink 回退: ${summary}`);
    process.exitCode = 1;
    return;
  }
  if (result.relation === 'diverged') {
    console.error(`::error file=cindy-protocol::cindy-protocol gitlink 与 base 分叉: ${summary}`);
    process.exitCode = 1;
    return;
  }
  console.log(`cindy-protocol gitlink ${result.relation === 'forward' ? '前进' : '未变化'}: ${summary}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
