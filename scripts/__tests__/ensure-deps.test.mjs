import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';

import { checkWorkspaceDependencies, resolvePnpmInstallInvocation } from '../ensure-deps.mjs';

test('runs a native pnpm binary directly instead of feeding it to node', () => {
  // pnpm 的原生二进制发行版把 npm_execpath 指向可执行文件本身；交给 node 会抛
  // SyntaxError: Invalid or unexpected token，自动修复依赖那一步直接失败。
  const nativePath = '/Users/dev/Library/pnpm/pnpm';
  assert.deepEqual(
    resolvePnpmInstallInvocation(['install'], { npm_execpath: nativePath }, () => true, { platform: 'darwin' }),
    { command: nativePath, args: ['install'], shell: false, displayCommand: 'pnpm install' },
  );
});

test('keeps running a JS pnpm entry through the current node', () => {
  const jsEntry = '/usr/local/lib/node_modules/pnpm/bin/pnpm.cjs';
  assert.deepEqual(
    resolvePnpmInstallInvocation(
      ['install'],
      { npm_execpath: jsEntry },
      () => true,
      { execPath: '/usr/local/bin/node', platform: 'darwin' },
    ),
    {
      command: '/usr/local/bin/node',
      args: [jsEntry, 'install'],
      shell: false,
      displayCommand: 'pnpm install',
    },
  );
});

test('falls back to PATH when npm_execpath is missing or stale', () => {
  assert.deepEqual(
    resolvePnpmInstallInvocation(['install'], {}, () => true, { platform: 'darwin' }),
    { command: 'pnpm', args: ['install'], shell: false, displayCommand: 'pnpm install' },
  );
  // Windows 的 restart 管线新开 cmd.exe：残留路径不可用时必须让 cmd 走 PATH/PATHEXT。
  assert.deepEqual(
    resolvePnpmInstallInvocation(
      ['install'],
      { npm_execpath: 'C:/stale/pnpm.cmd' },
      () => false,
      { platform: 'win32', comSpec: 'C:/Windows/System32/cmd.exe' },
    ),
    {
      command: 'C:/Windows/System32/cmd.exe',
      args: [
        '/d',
        '/s',
        '/v:off',
        '/c',
        '""%CINDY_PNPM_CMD_ARG_0%" "%CINDY_PNPM_CMD_ARG_1%""',
      ],
      env: {
        CINDY_PNPM_CMD_ARG_0: 'pnpm',
        CINDY_PNPM_CMD_ARG_1: 'install',
      },
      shell: false,
      windowsVerbatimArguments: true,
      displayCommand: 'pnpm install',
    },
  );
});

test('does not derive platform from environment variables', () => {
  assert.deepEqual(
    resolvePnpmInstallInvocation(['install'], { platform: 'win32', Platform: 'x64' }, () => true, {
      platform: 'darwin',
    }),
    { command: 'pnpm', args: ['install'], shell: false, displayCommand: 'pnpm install' },
  );
});


test('simulator dependency diagnosis preserves incomplete module directories', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-sim-deps-'));
  try {
    const moduleDir = path.join(root, 'node_modules/expo');
    fs.mkdirSync(moduleDir, { recursive: true });
    fs.writeFileSync(path.join(moduleDir, 'keep.txt'), 'existing installation');
    assert.ok(checkWorkspaceDependencies(root).includes('expo'));
    assert.equal(fs.readFileSync(path.join(moduleDir, 'keep.txt'), 'utf8'), 'existing installation');
    assert.deepEqual(fs.readdirSync(moduleDir), ['keep.txt']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});


test('workspace-only CLI fails without installing or deleting incomplete dependencies', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-sim-deps-cli-')));
  try {
    fs.mkdirSync(path.join(root, 'scripts/shared'), { recursive: true });
    for (const file of ['ensure-deps.mjs', 'shared/pnpm-invocation.mjs']) {
      fs.copyFileSync(new URL(`../${file}`, import.meta.url), path.join(root, 'scripts', file));
    }
    const sentinel = path.join(root, 'node_modules/expo/keep.txt');
    fs.mkdirSync(path.dirname(sentinel), { recursive: true });
    fs.writeFileSync(sentinel, 'preserved');
    const fakePnpm = path.join(root, 'pnpm.cjs');
    fs.writeFileSync(fakePnpm, `require('node:fs').writeFileSync(${JSON.stringify(path.join(root, 'installed'))}, 'unexpected');`);
    const result = spawnSync(process.execPath, [path.join(root, 'scripts/ensure-deps.mjs'), '--workspace-only'], {
      encoding: 'utf8', env: { ...process.env, npm_execpath: fakePnpm },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /pnpm install --frozen-lockfile/);
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'preserved');
    assert.equal(fs.existsSync(path.join(root, 'installed')), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
