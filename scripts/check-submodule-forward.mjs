#!/usr/bin/env node

import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SUBMODULE_PATH = 'cindy-protocol';

// 27ef29d was a historical duplicate of e6c95b0. The published-head guard below
// prevents future gitlinks from depending on unpublished commits, so this map
// must not grow. Keep this one verified entry only to move the already-dangling
// main baseline onto the equivalent published history.
const UNREACHABLE_BASE_COMMITS = new Map([
  [
    '27ef29dcb0df1b0f346c82cb7fbb81e9da536a79',
    {
      parents: ['0cb87cb52427fbebd8a3d85a271847d06bfb2ac6'],
      tree: '2b38c6510e36f5c95de9b58b683e0e9c3c896b94',
    },
  ],
]);

function git(cwd, args, { allowFailure = false } = {}) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (!allowFailure && result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    throw new Error(
      `git ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`,
    );
  }
  return result;
}

export function readGitlink(repoRoot, ref, submodulePath = SUBMODULE_PATH) {
  const result = git(repoRoot, ['ls-tree', ref, '--', submodulePath]);
  const match = result.stdout
    .trim()
    .match(/^160000 commit ([0-9a-f]{40})\t(.+)$/i);
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
  throw new Error(
    `无法比较协议历史 ${older.slice(0, 10)}..${newer.slice(0, 10)}${detail ? `: ${detail}` : ''}`,
  );
}

function hasCommit(repoRoot, oid) {
  return (
    git(repoRoot, ['cat-file', '-e', `${oid}^{commit}`], {
      allowFailure: true,
    }).status === 0
  );
}

function hasRef(repoRoot, ref) {
  return (
    git(repoRoot, ['show-ref', '--verify', '--quiet', ref], {
      allowFailure: true,
    }).status === 0
  );
}

function readPublishedBaselineRefs(protocolRepo) {
  const refs = [];
  if (hasRef(protocolRepo, 'refs/remotes/origin/main')) {
    refs.push('refs/remotes/origin/main');
  }
  const tags = git(protocolRepo, [
    'for-each-ref',
    '--format=%(refname)',
    'refs/tags/client-baseline-*',
  ])
    .stdout.trim()
    .split('\n')
    .filter(Boolean);
  return refs.concat(tags);
}

function refreshPublishedBaselines(protocolRepo, { ci, warn }) {
  const mainFetch = git(
    protocolRepo,
    ['fetch', '--no-tags', 'origin', 'main:refs/remotes/origin/main'],
    { allowFailure: true },
  );
  const tagFetch = git(
    protocolRepo,
    [
      'fetch',
      '--no-tags',
      'origin',
      'refs/tags/client-baseline-*:refs/tags/client-baseline-*',
    ],
    { allowFailure: true },
  );
  if (mainFetch.status === 0 && tagFetch.status === 0) return;

  const detail = [mainFetch, tagFetch]
    .filter((result) => result.status !== 0)
    .map((result) => (result.stderr || result.stdout || '').trim())
    .filter(Boolean)
    .join('; ');
  if (ci || !hasRef(protocolRepo, 'refs/remotes/origin/main')) {
    throw new Error(`无法刷新协议仓公开基线${detail ? `: ${detail}` : ''}`);
  }
  warn(
    `无法刷新协议仓公开基线，退用本地 origin/main 与已有 client-baseline tags${detail ? `: ${detail}` : ''}`,
  );
}

export function validatePublishedProtocolHead(
  protocolRepo,
  headOid,
  { ci = Boolean(process.env.CI), warn = console.warn } = {},
) {
  refreshPublishedBaselines(protocolRepo, { ci, warn });
  if (!hasCommit(protocolRepo, headOid)) {
    const headFetch = git(
      protocolRepo,
      ['fetch', '--no-tags', 'origin', headOid],
      { allowFailure: true },
    );
    if (!hasCommit(protocolRepo, headOid)) {
      const detail = (headFetch.stderr || headFetch.stdout || '').trim();
      throw new Error(
        `无法读取协议 head commit ${headOid}${detail ? `: ${detail}` : ''}`,
      );
    }
  }
  const baselineRefs = readPublishedBaselineRefs(protocolRepo);
  if (baselineRefs.some((ref) => isAncestor(protocolRepo, headOid, ref))) {
    return;
  }
  throw new Error(
    `协议提交 ${headOid} 未合入协议仓 main，也未打 client-baseline tag；先完成协议仓发布再更新 gitlink`,
  );
}

function parseCommitMetadata(output) {
  const [oid, tree, parents = ''] = output.split('\0');
  return { oid, tree, parents: parents ? parents.split(' ') : [] };
}

function readCommitMetadata(protocolRepo, oid) {
  const result = git(protocolRepo, [
    'show',
    '-s',
    '--format=%H%x00%T%x00%P%x00',
    oid,
  ]);
  const metadata = parseCommitMetadata(result.stdout.trimEnd());
  return { tree: metadata.tree, parents: metadata.parents };
}

function readAncestorMetadata(protocolRepo, headOid) {
  const result = git(protocolRepo, [
    'log',
    '--format=%H%x00%T%x00%P%x01',
    headOid,
  ]);
  return result.stdout
    .trimEnd()
    .split('\x01')
    .filter(Boolean)
    .map(parseCommitMetadata);
}

function hasEquivalentAncestor(
  protocolRepo,
  baseOid,
  headOid,
  metadata = UNREACHABLE_BASE_COMMITS,
) {
  const expected =
    git(protocolRepo, ['cat-file', '-e', `${baseOid}^{commit}`], {
      allowFailure: true,
    }).status === 0
      ? readCommitMetadata(protocolRepo, baseOid)
      : metadata.get(baseOid);
  if (!expected) return false;

  return readAncestorMetadata(protocolRepo, headOid).some((candidate) => {
    if (candidate.oid === baseOid) return false;
    return (
      candidate.tree === expected.tree &&
      candidate.parents.length === expected.parents.length &&
      candidate.parents.every(
        (parent, index) => parent === expected.parents[index],
      )
    );
  });
}

export function classifyProtocolRelation(
  protocolRepo,
  baseOid,
  headOid,
  { unreachableBaseMetadata = UNREACHABLE_BASE_COMMITS } = {},
) {
  if (baseOid === headOid) return 'unchanged';
  const baseAvailable =
    git(protocolRepo, ['cat-file', '-e', `${baseOid}^{commit}`], {
      allowFailure: true,
    }).status === 0;
  if (
    !baseAvailable &&
    hasEquivalentAncestor(
      protocolRepo,
      baseOid,
      headOid,
      unreachableBaseMetadata,
    )
  )
    return 'forward';
  if (!baseAvailable) throw new Error(`无法读取协议 base commit ${baseOid}`);
  if (isAncestor(protocolRepo, baseOid, headOid)) return 'forward';
  if (isAncestor(protocolRepo, headOid, baseOid)) return 'rollback';
  if (
    hasEquivalentAncestor(
      protocolRepo,
      baseOid,
      headOid,
      unreachableBaseMetadata,
    )
  )
    return 'forward';
  return 'diverged';
}

function ensureCommit(
  protocolRepo,
  oid,
  { allowUnreachableBase = false } = {},
) {
  if (
    git(protocolRepo, ['cat-file', '-e', `${oid}^{commit}`], {
      allowFailure: true,
    }).status === 0
  ) {
    return true;
  }
  if (allowUnreachableBase && UNREACHABLE_BASE_COMMITS.has(oid)) return false;
  return (
    git(protocolRepo, ['fetch', '--no-tags', 'origin', oid], {
      allowFailure: true,
    }).status === 0
  );
}

export function validateSubmoduleForward(
  repoRoot,
  baseRef,
  headRef = 'HEAD',
  options = {},
) {
  const baseOid = readGitlink(repoRoot, baseRef);
  const headOid = readGitlink(repoRoot, headRef);
  const protocolRepo = path.join(repoRoot, SUBMODULE_PATH);
  const unchangedHistoricalBaseline =
    baseOid === headOid && UNREACHABLE_BASE_COMMITS.has(headOid);
  if (unchangedHistoricalBaseline) {
    return { baseRef, headRef, baseOid, headOid, relation: 'unchanged' };
  }
  validatePublishedProtocolHead(protocolRepo, headOid, options);
  ensureCommit(protocolRepo, baseOid, { allowUnreachableBase: true });
  if (!ensureCommit(protocolRepo, headOid)) {
    throw new Error(`无法准备协议 head commit ${headOid}`);
  }
  const relation = classifyProtocolRelation(protocolRepo, baseOid, headOid);
  return { baseRef, headRef, baseOid, headOid, relation };
}

function main() {
  const repoRoot = process.cwd();
  const baseRef = process.env.CINDY_PROTOCOL_BASE_REF || 'origin/main';
  const result = validateSubmoduleForward(repoRoot, baseRef);
  const summary = `${result.baseOid.slice(0, 10)} -> ${result.headOid.slice(0, 10)}`;
  if (result.relation === 'rollback') {
    console.error(
      `::error file=cindy-protocol::cindy-protocol gitlink 回退: ${summary}`,
    );
    process.exitCode = 1;
    return;
  }
  if (result.relation === 'diverged') {
    console.error(
      `::error file=cindy-protocol::cindy-protocol gitlink 与 base 分叉: ${summary}`,
    );
    process.exitCode = 1;
    return;
  }
  console.log(
    `cindy-protocol gitlink ${result.relation === 'forward' ? '前进' : '未变化'}: ${summary}`,
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
