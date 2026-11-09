import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { assertBundleVersion, checkBuiltInSkills, SKILLS_ROOT, VERSION_FILE } from '../check-built-in-skills.mjs';

// Regression: bundle 89 changed after its version bump, and personal composition
// shipped it. Runtime tests only cover refusal after installation, not the build gate.
// Unit/runner tier: version outcomes in memory plus one small real-Git smoke for
// complete merge history and actual worktree bytes. No user profile or app is loaded.
// Standalone: node --test scripts/__tests__/check-built-in-skills.test.mjs — 1.67s on macOS.
test('unchanged bundles and properly incremented bundles are accepted', () => {
  const history = [{ ref: 'base', version: 89, fingerprint: 'old' }];
  assert.doesNotThrow(() => assertBundleVersion({ version: 89, fingerprint: 'old' }, history));
  assert.doesNotThrow(() => assertBundleVersion({ version: 90, fingerprint: 'new' }, history));
});

test('a changed branch or composition cannot reuse any source version', () => {
  const candidate = { version: 90, fingerprint: 'branch-a' };
  assert.throws(() => assertBundleVersion(candidate, [
    { ref: 'a', ...candidate }, { ref: 'b', version: 90, fingerprint: 'branch-b' },
  ]), /version 90 was reused.*history: b/);
  assert.throws(() => assertBundleVersion(candidate, [
    { ref: 'newer', version: 91, fingerprint: 'branch-a' },
  ]), /older than 91/);
});

test('invalid bundle versions cannot be built', () => {
  for (const version of [null, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => assertBundleVersion({ version, fingerprint: 'bytes' }, []), /positive safe integer/);
  }
});

test('build gate checks real bytes and both parents of a clean synthetic merge', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-skill-build-'));
  // Git for Windows cannot open Node's \\.\nul device path as a config file.
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-skill-build-config-'));
  const globalConfig = path.join(configDir, 'empty.gitconfig');
  fs.writeFileSync(globalConfig, '');
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  });
  const git = (...args) => execFileSync('git', args, {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: globalConfig },
  }).trim();
  const put = (relative, bytes) => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
  };
  const setVersion = version => put(VERSION_FILE, `export const BUILT_IN_SKILLS_BUNDLE_VERSION = ${version};\n`);
  const commit = name => { git('add', '.'); git('-c', 'commit.gpgsign=false', 'commit', '-m', name); return git('rev-parse', 'HEAD'); };
  const check = (baseRefs = []) => checkBuiltInSkills({ repoRoot: root, baseRefs });
  git('init', '-b', 'main');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'core.autocrlf', 'false');
  // Source line endings may differ on Windows; shipped Skill bytes may not.
  put(VERSION_FILE, 'export const BUILT_IN_SKILLS_BUNDLE_VERSION = 1;\r\n');
  put(`${SKILLS_ROOT}/example/SKILL.md`, 'original\n');
  put(`${SKILLS_ROOT}/example/references/a.md`, 'a\n');
  put(`${SKILLS_ROOT}/example/references/b.md`, 'b\n');
  const base = commit('initial');
  assert.equal(check().version, 1);
  put(`${SKILLS_ROOT}/example/SKILL.md`, 'original\r\n');
  assert.throws(check, /version 1 was reused/);
  put(`${SKILLS_ROOT}/example/SKILL.md`, 'original\n');

  // Even ignored/untracked files are shipped by resource-copy: they count as bytes.
  put(`${SKILLS_ROOT}/example/extra.txt`, 'unexpected');
  assert.throws(check, /version 1 was reused/);
  fs.unlinkSync(path.join(root, SKILLS_ROOT, 'example/extra.txt'));
  put(`${SKILLS_ROOT}/example/references/a.md`, 'changed a\n');
  assert.throws(check, /version 1 was reused/);
  setVersion(2);
  assert.equal(check().version, 2);
  const a = commit('branch a');
  assert.equal(check().version, 2);

  git('checkout', '-b', 'b', base);
  put(`${SKILLS_ROOT}/example/references/b.md`, 'changed b\n');
  setVersion(2);
  commit('branch b');
  assert.equal(check().version, 2);
  assert.throws(() => check([a]), /version 2 was reused/);
  git('-c', 'commit.gpgsign=false', 'merge', '--no-ff', a, '-m', 'personal composition');
  assert.throws(check, /version 2 was reused/);
  const status = git('status', '--porcelain');
  setVersion(3);
  assert.equal(check().version, 3);
  assert.equal(status, '');
  assert.equal(git('diff', '--name-only'), VERSION_FILE);
  fs.writeFileSync(path.join(root, '.git', 'shallow'), git('rev-parse', 'HEAD') + '\n');
  assert.throws(check, /complete Git history/);
});
