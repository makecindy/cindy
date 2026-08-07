import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

import {
  classifyProtocolRelation,
  validatePublishedProtocolHead,
  validateSubmoduleForward,
} from '../check-submodule-forward.mjs';

function git(repo, ...args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf-8' }).trim();
}

function commitTree(repo, tree, parent, message) {
  const args = ['commit-tree', tree];
  if (parent) args.push('-p', parent);
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf-8',
    input: `${message}\n`,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Protocol Guard Test',
      GIT_AUTHOR_EMAIL: 'protocol-guard@example.invalid',
      GIT_COMMITTER_NAME: 'Protocol Guard Test',
      GIT_COMMITTER_EMAIL: 'protocol-guard@example.invalid',
    },
  }).trim();
}

function fixture() {
  const repo = fs.mkdtempSync(
    path.join(os.tmpdir(), 'cindy-protocol-forward-'),
  );
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'Protocol Guard Test');
  git(repo, 'config', 'user.email', 'protocol-guard@example.invalid');
  fs.writeFileSync(path.join(repo, 'protocol.txt'), 'one\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'one');
  const one = git(repo, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(repo, 'protocol.txt'), 'two\n');
  git(repo, 'commit', '-am', 'two');
  const two = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'checkout', '-b', 'fork', one);
  fs.writeFileSync(path.join(repo, 'fork.txt'), 'fork\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'fork');
  const fork = git(repo, 'rev-parse', 'HEAD');
  return { repo, one, two, fork };
}

function setPublishedMain(repo, oid) {
  git(repo, 'update-ref', 'refs/remotes/origin/main', oid);
}

function setPublishedTag(repo, name, oid) {
  git(repo, 'update-ref', `refs/tags/client-baseline-${name}`, oid);
}

test('classifies unchanged, forward, rollback and diverged protocol gitlinks', () => {
  const f = fixture();
  try {
    assert.equal(classifyProtocolRelation(f.repo, f.one, f.one), 'unchanged');
    assert.equal(classifyProtocolRelation(f.repo, f.one, f.two), 'forward');
    assert.equal(classifyProtocolRelation(f.repo, f.two, f.one), 'rollback');
    assert.equal(classifyProtocolRelation(f.repo, f.two, f.fork), 'diverged');
  } finally {
    fs.rmSync(f.repo, { recursive: true, force: true });
  }
});

test('accepts an unreachable base only for a strict equivalent ancestor', () => {
  const f = fixture();
  try {
    const tree = git(f.repo, 'rev-parse', `${f.one}^{tree}`);
    const duplicate = commitTree(f.repo, tree, f.one, 'duplicate');
    const head = commitTree(f.repo, tree, duplicate, 'head');
    const baseOid = 'a'.repeat(40);
    const metadata = new Map([[baseOid, { parents: [f.one], tree }]]);
    assert.equal(
      classifyProtocolRelation(f.repo, baseOid, head, {
        unreachableBaseMetadata: metadata,
      }),
      'forward',
    );
  } finally {
    fs.rmSync(f.repo, { recursive: true, force: true });
  }
});

test('accepts an available base with an equivalent head ancestor', () => {
  const f = fixture();
  try {
    const tree = git(f.repo, 'rev-parse', `${f.one}^{tree}`);
    const duplicate = commitTree(f.repo, tree, null, 'duplicate');
    const head = commitTree(f.repo, tree, duplicate, 'head');
    assert.equal(classifyProtocolRelation(f.repo, f.one, head), 'forward');
  } finally {
    fs.rmSync(f.repo, { recursive: true, force: true });
  }
});

test('rejects matching tree when the parent list differs', () => {
  const f = fixture();
  try {
    const tree = git(f.repo, 'rev-parse', `${f.one}^{tree}`);
    const candidate = commitTree(
      f.repo,
      tree,
      f.one,
      'same tree, different parent',
    );
    const baseOid = 'b'.repeat(40);
    const metadata = new Map([[baseOid, { parents: [f.two], tree }]]);
    assert.throws(
      () =>
        classifyProtocolRelation(f.repo, baseOid, candidate, {
          unreachableBaseMetadata: metadata,
        }),
      /无法读取协议 base commit/,
    );
  } finally {
    fs.rmSync(f.repo, { recursive: true, force: true });
  }
});

test('classifies reachable same-tree different-parent history as diverged', () => {
  const f = fixture();
  try {
    const tree = git(f.repo, 'rev-parse', `${f.two}^{tree}`);
    const duplicate = commitTree(
      f.repo,
      git(f.repo, 'rev-parse', `${f.one}^{tree}`),
      null,
      'duplicate root',
    );
    const candidate = commitTree(
      f.repo,
      tree,
      duplicate,
      'same tree, different parent',
    );
    assert.equal(
      classifyProtocolRelation(f.repo, f.two, candidate),
      'diverged',
    );
  } finally {
    fs.rmSync(f.repo, { recursive: true, force: true });
  }
});

test('rejects a feature-only head before ancestry classification', () => {
  const f = fixture();
  try {
    setPublishedMain(f.repo, f.two);
    assert.throws(
      () => validatePublishedProtocolHead(f.repo, f.fork, { ci: false }),
      /未合入协议仓 main，也未打 client-baseline tag/,
    );
  } finally {
    fs.rmSync(f.repo, { recursive: true, force: true });
  }
});

test('allows a head published on protocol main', () => {
  const f = fixture();
  try {
    setPublishedMain(f.repo, f.two);
    assert.doesNotThrow(() =>
      validatePublishedProtocolHead(f.repo, f.two, { ci: false }),
    );
  } finally {
    fs.rmSync(f.repo, { recursive: true, force: true });
  }
});

test('allows a head published only by a client-baseline tag', () => {
  const f = fixture();
  try {
    setPublishedMain(f.repo, f.one);
    setPublishedTag(f.repo, 'feature', f.fork);
    assert.doesNotThrow(() =>
      validatePublishedProtocolHead(f.repo, f.fork, { ci: false }),
    );
  } finally {
    fs.rmSync(f.repo, { recursive: true, force: true });
  }
});

test('fetches a published head missing from the local protocol clone', () => {
  const publisher = fixture();
  const bare = fs.mkdtempSync(
    path.join(os.tmpdir(), 'cindy-protocol-published-'),
  );
  const local = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-protocol-local-'));
  try {
    git(bare, 'init', '--bare');
    git(publisher.repo, 'remote', 'add', 'origin', bare);
    git(publisher.repo, 'push', 'origin', 'main');
    git(local, 'init', '-b', 'main');
    git(local, 'remote', 'add', 'origin', bare);
    git(local, 'fetch', 'origin', publisher.one);
    assert.throws(() =>
      git(local, 'cat-file', '-e', `${publisher.two}^{commit}`),
    );
    assert.doesNotThrow(() =>
      validatePublishedProtocolHead(local, publisher.two, { ci: true }),
    );
  } finally {
    fs.rmSync(publisher.repo, { recursive: true, force: true });
    fs.rmSync(bare, { recursive: true, force: true });
    fs.rmSync(local, { recursive: true, force: true });
  }
});

test('falls back to local origin/main when baseline fetch is unavailable', () => {
  const f = fixture();
  try {
    setPublishedMain(f.repo, f.two);
    git(f.repo, 'remote', 'add', 'origin', '/definitely/missing/protocol.git');
    const warnings = [];
    assert.doesNotThrow(() =>
      validatePublishedProtocolHead(f.repo, f.two, {
        ci: false,
        warn: (message) => warnings.push(message),
      }),
    );
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /退用本地 origin\/main/);
  } finally {
    fs.rmSync(f.repo, { recursive: true, force: true });
  }
});

test('fails closed when an unavailable base cannot be fetched', () => {
  const f = fixture();
  try {
    const baseOid = 'c'.repeat(40);
    assert.throws(
      () => classifyProtocolRelation(f.repo, baseOid, f.two),
      /无法读取协议 base commit/,
    );
  } finally {
    fs.rmSync(f.repo, { recursive: true, force: true });
  }
});

test('validateSubmoduleForward does not treat a failed base fetch as forward', () => {
  const outer = fs.mkdtempSync(
    path.join(os.tmpdir(), 'cindy-protocol-forward-parent-'),
  );
  const protocol = path.join(outer, 'cindy-protocol');
  fs.mkdirSync(protocol);
  try {
    git(outer, 'init', '-b', 'main');
    git(outer, 'config', 'user.name', 'Protocol Guard Test');
    git(outer, 'config', 'user.email', 'protocol-guard@example.invalid');
    git(protocol, 'init', '-b', 'main');
    git(protocol, 'config', 'user.name', 'Protocol Guard Test');
    git(protocol, 'config', 'user.email', 'protocol-guard@example.invalid');
    fs.writeFileSync(path.join(protocol, 'protocol.txt'), 'head\n');
    git(protocol, 'add', '.');
    git(protocol, 'commit', '-m', 'head');
    const head = git(protocol, 'rev-parse', 'HEAD');
    setPublishedMain(protocol, head);
    const base = 'd'.repeat(40);
    git(
      outer,
      'update-index',
      '--add',
      '--cacheinfo',
      `160000,${base},cindy-protocol`,
    );
    git(outer, 'commit', '-m', 'base');
    git(
      outer,
      'update-index',
      '--add',
      '--cacheinfo',
      `160000,${head},cindy-protocol`,
    );
    git(outer, 'commit', '-m', 'head');
    const warnings = [];
    assert.throws(
      () =>
        validateSubmoduleForward(outer, 'HEAD~1', 'HEAD', {
          ci: false,
          warn: (message) => warnings.push(message),
        }),
      /无法读取协议 base commit/,
    );
    assert.equal(warnings.length, 1);
  } finally {
    fs.rmSync(outer, { recursive: true, force: true });
  }
});

test('allows the unchanged dangling historical baseline without fetching it', () => {
  const outer = fs.mkdtempSync(
    path.join(os.tmpdir(), 'cindy-protocol-unchanged-dangling-'),
  );
  const protocol = path.join(outer, 'cindy-protocol');
  fs.mkdirSync(protocol);
  try {
    git(outer, 'init', '-b', 'main');
    git(outer, 'config', 'user.name', 'Protocol Guard Test');
    git(outer, 'config', 'user.email', 'protocol-guard@example.invalid');
    git(protocol, 'init', '-b', 'main');
    git(
      protocol,
      'remote',
      'add',
      'origin',
      '/definitely/missing/protocol.git',
    );
    const dangling = '27ef29dcb0df1b0f346c82cb7fbb81e9da536a79';
    assert.throws(() =>
      git(protocol, 'cat-file', '-e', `${dangling}^{commit}`),
    );
    git(
      outer,
      'update-index',
      '--add',
      '--cacheinfo',
      `160000,${dangling},cindy-protocol`,
    );
    git(outer, 'commit', '-m', 'dangling baseline');

    assert.deepEqual(validateSubmoduleForward(outer, 'HEAD', 'HEAD'), {
      baseRef: 'HEAD',
      headRef: 'HEAD',
      baseOid: dangling,
      headOid: dangling,
      relation: 'unchanged',
    });
  } finally {
    fs.rmSync(outer, { recursive: true, force: true });
  }
});
