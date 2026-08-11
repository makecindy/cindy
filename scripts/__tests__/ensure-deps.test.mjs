import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolvePnpmInstallInvocation } from '../ensure-deps.mjs';

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
