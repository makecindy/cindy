import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

import { classifyProtocolRelation } from '../check-submodule-forward.mjs';

function git(repo, ...args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf-8' }).trim();
}

function fixture() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-protocol-forward-'));
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
