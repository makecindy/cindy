import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

// 仓库根的 ESM 工具脚本没有 TS declaration；Vitest 运行时可直接加载。
// @ts-expect-error 见上方说明。
import { findElectronBinaryIssue, getElectronPlatformBinaryRelPath, getElectronRepairMode, resolveSystemTarCommand } from '../../../../../scripts/ensure-deps.mjs';
// @ts-expect-error 见上方说明。
import { commandContainsPath } from '../../../../../scripts/restart-desktop-remote.mjs';

describe('getElectronPlatformBinaryRelPath', () => {
  it.each([
    ['win32', 'electron.exe'],
    ['darwin', 'Electron.app/Contents/MacOS/Electron'],
    ['mas', 'Electron.app/Contents/MacOS/Electron'],
    ['linux', 'electron'],
  ])('%s 平台返回 Electron install.js 语义里的相对 binary 路径', (platform, expected) => {
    expect(getElectronPlatformBinaryRelPath(platform)).toBe(expected);
  });
});

describe('getElectronRepairMode', () => {
  it.each([
    ['win32', '24.0.0', 'system-tar'],
    ['win32', '25.1.0', 'system-tar'],
    ['win32', '22.16.0', 'install-js'],
    ['win32', '23.11.0', 'install-js'],
    ['darwin', '24.0.0', 'install-js'],
    ['darwin', '25.1.0', 'install-js'],
    ['mas', '24.0.0', 'install-js'],
    ['linux', '25.1.0', 'install-js'],
  ])('%s + Node %s 使用 %s 修复模式', (platform, nodeVersion, expected) => {
    expect(getElectronRepairMode(platform, nodeVersion)).toBe(expected);
  });
});

// Bug：Git Bash 里 pnpm install，PATH 先命中 Git 的 GNU tar，把 `C:\...` 当远程主机，Electron 解压失败。
describe('resolveSystemTarCommand', () => {
  it('Windows 用系统目录的 tar.exe，不按 PATH 找', () => {
    const systemTar = 'D:\\Win\\System32\\tar.exe';
    expect(resolveSystemTarCommand('win32', { SystemRoot: 'D:\\Win' }, (file: string) => file === systemTar)).toBe(systemTar);
  });

  it('系统目录里没有 tar.exe 时退回 PATH；其它平台照旧用 PATH', () => {
    expect(resolveSystemTarCommand('win32', { SystemRoot: 'D:\\Win' }, () => false)).toBe('tar');
    expect(resolveSystemTarCommand('darwin', {}, () => true)).toBe('tar');
  });
});

describe('findElectronBinaryIssue', () => {
  it.each(['win32', 'darwin', 'mas', 'linux'])('完整 %s Electron install 返回 null', (platform) => {
    const root = createElectronInstall({ platform });
    try {
      expect(findElectronBinaryIssue(root, platform)).toBeNull();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('容忍 path.txt 末尾换行', () => {
    const root = createElectronInstall({ platform: 'win32', pathText: 'electron.exe\r\n' });
    try {
      expect(findElectronBinaryIssue(root, 'win32')).toBeNull();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('容忍 dist/version 的 v 前缀和末尾换行', () => {
    const root = createElectronInstall({ distVersion: 'v41.2.0\r\n' });
    try {
      expect(findElectronBinaryIssue(root, 'win32')).toBeNull();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('校验 dist/version 与 electron package 版本一致', () => {
    const root = createElectronInstall({ distVersion: '41.1.0' });
    try {
      expect(findElectronBinaryIssue(root, 'win32')).toMatchObject({
        reason: 'version-mismatch',
        expectedVersion: '41.2.0',
        actualVersion: '41.1.0',
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('校验 path.txt 指向的平台 binary 实际存在', () => {
    const root = createElectronInstall({ platform: 'win32', writeBinary: false });
    try {
      expect(findElectronBinaryIssue(root, 'win32')).toMatchObject({
        reason: 'binary-missing',
        expectedRelPath: 'electron.exe',
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('desktop restart runner', () => {
  it('远程启动交给无 shell 链的 runner，确保附加参数控制整条流水线', () => {
    const packageJson = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, '../../../../../package.json'), 'utf8'),
    ) as { scripts: Record<string, string> };
    expect(packageJson.scripts['restart:desktop:remote']).toBe(
      'node scripts/desktop-restart-runner.mjs --wait-ready',
    );
  });

  it('本地模式由同一 runner 显式携带 --local', () => {
    const packageJson = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, '../../../../../package.json'), 'utf8'),
    ) as { scripts: Record<string, string> };
    expect(packageJson.scripts['restart:desktop:local']).toBe(
      'node scripts/desktop-restart-runner.mjs --local --wait-ready',
    );
  });
});

describe('commandContainsPath', () => {
  it('匹配当前 checkout 下的子路径或引号包裹的 root 路径', () => {
    expect(commandContainsPath('node /workspaces/current-checkout/apps/desktop --flag', '/workspaces/current-checkout')).toBe(true);
    expect(commandContainsPath('node "/workspaces/current-checkout" --flag', '/workspaces/current-checkout')).toBe(true);
    expect(commandContainsPath('cmd.exe /c C:\\Workspaces\\CurrentCheckout\\apps\\desktop --flag', 'C:\\Workspaces\\CurrentCheckout')).toBe(true);
    expect(commandContainsPath('cmd.exe /c "C:\\Workspaces\\CurrentCheckout" --flag', 'C:\\Workspaces\\CurrentCheckout')).toBe(true);
  });

  it('不把相似目录名前缀误判为当前 checkout', () => {
    expect(commandContainsPath('node /workspaces/current-checkout-old --flag', '/workspaces/current-checkout')).toBe(false);
    expect(commandContainsPath('node /workspaces/current-checkout old --flag', '/workspaces/current-checkout')).toBe(false);
    expect(commandContainsPath('cmd.exe /c C:\\Workspaces\\CurrentCheckout old --flag', 'C:\\Workspaces\\CurrentCheckout')).toBe(false);
  });
});

function createElectronInstall(options: {
  distVersion?: string;
  packageVersion?: string;
  platform?: string;
  pathText?: string;
  writeBinary?: boolean;
} = {}): string {
  const platform = options.platform ?? 'win32';
  const binaryRelPath = getElectronPlatformBinaryRelPath(platform);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-electron-install-'));
  const electronDir = path.join(root, 'node_modules', 'electron');
  const distDir = path.join(electronDir, 'dist');
  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(
    path.join(electronDir, 'package.json'),
    JSON.stringify({ version: options.packageVersion ?? '41.2.0' }),
  );
  fs.writeFileSync(path.join(electronDir, 'path.txt'), options.pathText ?? binaryRelPath);
  fs.writeFileSync(path.join(distDir, 'version'), options.distVersion ?? '41.2.0');
  const binaryPath = path.join(distDir, ...binaryRelPath.split('/'));
  if (options.writeBinary ?? true) {
    fs.mkdirSync(path.dirname(binaryPath), { recursive: true });
    fs.writeFileSync(binaryPath, '');
  }
  return root;
}
