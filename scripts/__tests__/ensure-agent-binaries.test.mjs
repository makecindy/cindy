// ensure-agent-binaries 纯辅助函数的单测。
//
// 这些 helper 是整个 de-LFS 改动的正确性核心：必须拒绝 LFS pointer / 过小占位，
// 才能保证按需下载逻辑不会把半成品当成"已就位"而跳过。用 node 内置 test runner，
// 不依赖 vitest / 任何 deps，可直接 `node --test scripts/__tests__/`。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  binFileFor,
  isValidBinary,
  isValidDirDist,
  listSiblingWorktreeRoots,
  readInstalledVersion,
  SUPPORTED_BINARY_KINDS,
  supportsCdnFallback,
  tryReuseFromSiblingWorktree,
} from '../ensure-agent-binaries.mjs';
import { verifyDirDistManifest, writeDirDistManifest } from '../../tools/shared/dir-dist-manifest.mjs';

test('directory distributions never use the single-binary CDN fallback', () => {
  assert.equal(supportsCdnFallback('pi'), false);
  assert.equal(supportsCdnFallback('codex'), true);
});

test('dev startup prepares every supported runtime, including Pi', () => {
  assert.deepEqual(SUPPORTED_BINARY_KINDS, ['claude', 'codex', 'ripgrep', 'pi']);

  const devGuard = fs.readFileSync(
    new URL('../ensure-dev-runtime-assets.mjs', import.meta.url),
    'utf8',
  );
  assert.match(devGuard, /const AGENT_KINDS = SUPPORTED_BINARY_KINDS;/);
});

const LFS_POINTER = [
  'version https://git-lfs.github.com/spec/v1',
  'oid sha256:0000000000000000000000000000000000000000000000000000000000000000',
  'size 239438648',
  '',
].join('\n');

function tmpFile(name, contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ensure-bin-test-'));
  const p = path.join(dir, name);
  fs.writeFileSync(p, contents);
  return p;
}

test('binFileFor: win32 gets .exe, other platforms get bare name', () => {
  assert.equal(binFileFor('claude', 'win32-x64'), 'claude.exe');
  assert.equal(binFileFor('rg', 'win32-x64'), 'rg.exe');
  assert.equal(binFileFor('claude', 'darwin-arm64'), 'claude');
  assert.equal(binFileFor('codex', 'linux-x64'), 'codex');
});

test('readInstalledVersion: trims content, null on missing/empty', () => {
  assert.equal(readInstalledVersion(tmpFile('.version', '15.1.0\n')), '15.1.0');
  assert.equal(readInstalledVersion(tmpFile('.version', '  2.1.186  ')), '2.1.186');
  assert.equal(readInstalledVersion(tmpFile('.version', '')), null);
  assert.equal(readInstalledVersion(path.join(os.tmpdir(), 'does-not-exist-xyz', '.version')), null);
});

test('isValidBinary: rejects missing, LFS pointer, and tiny placeholder', () => {
  // missing
  assert.equal(isValidBinary(path.join(os.tmpdir(), 'nope-xyz', 'claude')), false);
  // LFS pointer (starts with the spec header) — must be rejected even though it is a real file
  assert.equal(isValidBinary(tmpFile('claude', LFS_POINTER)), false);
  // tiny placeholder (< 1024 bytes)
  assert.equal(isValidBinary(tmpFile('claude', 'x'.repeat(100))), false);
});

test('isValidBinary: accepts a non-pointer file >= 1024 bytes', () => {
  assert.equal(isValidBinary(tmpFile('claude', Buffer.alloc(2048, 1))), true);
});

// ── dirDist(目录分发)安装清单 ────────────────────────────────────────────────
// codex review 回归:pi 缺 theme/ 等旁侧资产时 RPC 启动即崩,skip 判定只验主执行
// 文件会把残缺目录当"已就位"打进安装包 → 就位判定必须整目录对清单校验。

test('isValidDirDist: requires the manifest and every sidecar asset, not just the main binary', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ensure-dirdist-'));
  const binPath = path.join(dir, 'pi');
  fs.writeFileSync(binPath, Buffer.alloc(4096, 1));
  fs.mkdirSync(path.join(dir, 'theme'));
  fs.writeFileSync(path.join(dir, 'theme', 'default.json'), '{"accent":"pi"}');
  fs.writeFileSync(path.join(dir, '.version'), '0.82.1\n');

  // 主执行文件合法但无清单(旧安装/半成品)→ 不算就位
  assert.equal(isValidDirDist(dir, binPath), false);

  assert.equal(writeDirDistManifest(dir) >= 2, true);
  assert.equal(isValidDirDist(dir, binPath), true);

  // 旁侧资产被删 → 清单校验失败,重新进入下载/promote
  fs.rmSync(path.join(dir, 'theme'), { recursive: true, force: true });
  assert.equal(isValidDirDist(dir, binPath), false);
});

test('verifyDirDistManifest: rejects size drift, empty manifests, and malformed entries', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ensure-dirdist-verify-'));
  fs.writeFileSync(path.join(dir, 'pi'), Buffer.alloc(4096, 1));
  fs.writeFileSync(path.join(dir, 'photon.wasm'), Buffer.alloc(512, 2));
  writeDirDistManifest(dir);
  assert.equal(verifyDirDistManifest(dir), true);

  // 同长度内容被替换/损坏(字节数不变)→ 现按 sha256 拒绝(供应链加固 P1)
  writeDirDistManifest(dir);
  assert.equal(verifyDirDistManifest(dir), true);
  fs.writeFileSync(path.join(dir, 'photon.wasm'), Buffer.alloc(512, 9)); // 同长度、不同内容
  assert.equal(verifyDirDistManifest(dir), false);

  // 旧版本写的 size-only 清单(无 sha256)→ 一律不可信,拒绝(自愈重下)
  fs.writeFileSync(path.join(dir, 'photon.wasm'), Buffer.alloc(512, 2)); // 复原内容
  fs.writeFileSync(
    path.join(dir, '.manifest'),
    JSON.stringify({ files: [{ path: 'photon.wasm', size: 512 }] }),
  );
  assert.equal(verifyDirDistManifest(dir), false);

  // 字节数漂移(截断/损坏)→ 拒绝
  writeDirDistManifest(dir);
  fs.writeFileSync(path.join(dir, 'photon.wasm'), Buffer.alloc(8, 2));
  assert.equal(verifyDirDistManifest(dir), false);

  // 清单之外的多余文件(旧构建残留 / 本地污染)→ 拒绝(不能作为未验证资产打进安装包)
  fs.writeFileSync(path.join(dir, 'photon.wasm'), Buffer.alloc(512, 2)); // 复原
  writeDirDistManifest(dir);
  assert.equal(verifyDirDistManifest(dir), true);
  fs.writeFileSync(path.join(dir, 'stray-residue.bin'), Buffer.alloc(16, 3));
  assert.equal(verifyDirDistManifest(dir), false);
  fs.rmSync(path.join(dir, 'stray-residue.bin'));
  assert.equal(verifyDirDistManifest(dir), true); // 移除多余文件后恢复
  // 嵌套子目录里的多余文件同样拒绝
  fs.mkdirSync(path.join(dir, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'nested', 'extra.json'), '{}');
  assert.equal(verifyDirDistManifest(dir), false);
  fs.rmSync(path.join(dir, 'nested'), { recursive: true, force: true });

  // 空清单 / 非法结构 → 拒绝
  fs.writeFileSync(path.join(dir, '.manifest'), JSON.stringify({ files: [] }));
  assert.equal(verifyDirDistManifest(dir), false);
  fs.writeFileSync(path.join(dir, '.manifest'), '{"files":"nope"}');
  assert.equal(verifyDirDistManifest(dir), false);
  fs.writeFileSync(path.join(dir, '.manifest'), 'not json');
  assert.equal(verifyDirDistManifest(dir), false);
});

// ── 兄弟 worktree 本地复用 ────────────────────────────────────────────────────

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeBinDir(version, binFile, contents) {
  const dir = tmpDir('reuse-src-');
  if (version !== null) fs.writeFileSync(path.join(dir, '.version'), `${version}\n`);
  if (contents !== null) fs.writeFileSync(path.join(dir, binFile), contents);
  return dir;
}

const REAL_BINARY = Buffer.alloc(4096, 7);

test('tryReuseFromSiblingWorktree: copies matching valid binary and writes marker', () => {
  const src = makeBinDir('1.2.3', 'claude', REAL_BINARY);
  const dest = tmpDir('reuse-dest-');
  const reusedFrom = tryReuseFromSiblingWorktree({
    candidates: [src],
    binFile: 'claude',
    version: '1.2.3',
    destDir: dest,
  });
  assert.equal(reusedFrom, src);
  assert.deepEqual(fs.readFileSync(path.join(dest, 'claude')), REAL_BINARY);
  assert.equal(fs.readFileSync(path.join(dest, '.version'), 'utf8').trim(), '1.2.3');
  if (process.platform !== 'win32') {
    assert.notEqual(fs.statSync(path.join(dest, 'claude')).mode & 0o111, 0);
  }
});

test('tryReuseFromSiblingWorktree: skips version mismatch, LFS pointer, and missing candidates', () => {
  const wrongVersion = makeBinDir('9.9.9', 'claude', REAL_BINARY);
  const lfsPointer = makeBinDir('1.2.3', 'claude', LFS_POINTER);
  const noBinary = makeBinDir('1.2.3', 'claude', null);
  const noMarker = makeBinDir(null, 'claude', REAL_BINARY);
  const missingDir = path.join(os.tmpdir(), 'reuse-does-not-exist-xyz');
  const dest = tmpDir('reuse-dest-');
  const reusedFrom = tryReuseFromSiblingWorktree({
    candidates: [wrongVersion, lfsPointer, noBinary, noMarker, missingDir],
    binFile: 'claude',
    version: '1.2.3',
    destDir: dest,
  });
  assert.equal(reusedFrom, null);
  assert.equal(fs.existsSync(path.join(dest, 'claude')), false);
});

test('tryReuseFromSiblingWorktree: falls through bad candidates to the first good one', () => {
  const bad = makeBinDir('9.9.9', 'rg', REAL_BINARY);
  const good = makeBinDir('15.1.0', 'rg', REAL_BINARY);
  const dest = tmpDir('reuse-dest-');
  const reusedFrom = tryReuseFromSiblingWorktree({
    candidates: [bad, good],
    binFile: 'rg',
    version: '15.1.0',
    destDir: dest,
  });
  assert.equal(reusedFrom, good);
  assert.deepEqual(fs.readFileSync(path.join(dest, 'rg')), REAL_BINARY);
});

test('listSiblingWorktreeRoots: returns [] outside a git repository', () => {
  assert.deepEqual(listSiblingWorktreeRoots(tmpDir('not-a-repo-')), []);
});

test('listSiblingWorktreeRoots: lists other worktrees of the same repo, excluding self', () => {
  const repo = tmpDir('reuse-repo-');
  const git = (...args) =>
    execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '--initial-branch=main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  fs.writeFileSync(path.join(repo, 'README.md'), 'hi');
  git('add', '.');
  git('commit', '-m', 'init', '--no-gpg-sign');
  const wt = path.join(tmpDir('reuse-wt-parent-'), 'wt-a');
  git('worktree', 'add', wt, '-b', 'wt-a');

  const fromMain = listSiblingWorktreeRoots(repo);
  assert.deepEqual(fromMain, [fs.realpathSync.native(wt)]);
  const fromWt = listSiblingWorktreeRoots(wt);
  assert.deepEqual(fromWt, [fs.realpathSync.native(repo)]);
});
