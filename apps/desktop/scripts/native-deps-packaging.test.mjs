import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { preparePackagedNodePty } from '../forge-node-pty';

const windowsFiles = [
  'pty.node',
  'conpty.node',
  'conpty_console_list.node',
  'winpty-agent.exe',
  'winpty.dll',
  path.join('conpty', 'conpty.dll'),
  path.join('conpty', 'OpenConsole.exe'),
];
let root;
let fixtureId = 0;
beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-pty-package-'));
});
afterAll(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(platform = 'win32', arch = 'x64') {
  const buildPath = path.join(root, String(++fixtureId));
  const packageDir = path.join(buildPath, 'node_modules', 'node-pty');
  const prebuildDir = path.join(packageDir, 'prebuilds', `${platform}-${arch}`);
  const files = platform === 'win32' ? windowsFiles : ['pty.node', 'spawn-helper'];
  for (const file of files) {
    const target = path.join(prebuildDir, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'fixture binary');
  }
  return { buildPath, packageDir, prebuildDir, files };
}

describe('native dependency packaging', () => {
  it.each([
    ['win32', 'x64'],
    ['win32', 'arm64'],
    ['darwin', 'x64'],
    ['darwin', 'arm64'],
  ])('uses the complete %s/%s prebuild without requiring compilation', (platform, arch) => {
    const f = fixture(platform, arch);
    expect(preparePackagedNodePty(f.buildPath, platform, arch)).toEqual({
      rebuild: false,
      nativePath: path.join(f.prebuildDir, 'pty.node'),
    });
    for (const file of f.files) {
      expect(fs.readFileSync(path.join(f.prebuildDir, file), 'utf8')).toBe('fixture binary');
    }
  });

  it.each(windowsFiles)('rejects a missing Windows runtime file: %s', (file) => {
    const f = fixture();
    fs.unlinkSync(path.join(f.prebuildDir, file));
    expect(() => preparePackagedNodePty(f.buildPath, 'win32', 'x64')).toThrow(
      /prebuild.*incomplete.*Reinstall workspace dependencies/,
    );
  });

  it.each(['empty', 'directory'])('rejects an %s binding instead of compiling it', (kind) => {
    const f = fixture();
    const file = path.join(f.prebuildDir, 'conpty.node');
    fs.unlinkSync(file);
    if (kind === 'empty') fs.writeFileSync(file, '');
    else fs.mkdirSync(file);
    expect(() => preparePackagedNodePty(f.buildPath, 'win32', 'x64')).toThrow('conpty.node');
  });

  it('does not accept prebuilds for another architecture or a stale local build', () => {
    const f = fixture('win32', 'x64');
    const stale = path.join(f.packageDir, 'build', 'Release', 'pty.node');
    fs.mkdirSync(path.dirname(stale), { recursive: true });
    fs.writeFileSync(stale, 'local binding');
    expect(() => preparePackagedNodePty(f.buildPath, 'win32', 'arm64')).toThrow('win32-arm64');
    expect(fs.readFileSync(stale, 'utf8')).toBe('local binding');
  });

  it('prevents copied Release and Debug bindings from shadowing valid target prebuilds', () => {
    const f = fixture();
    const stale = ['Release', 'Debug'].flatMap((variant) =>
      ['pty.node', 'conpty.node', 'conpty_console_list.node'].map((file) =>
        path.join(f.packageDir, 'build', variant, file),
      ),
    );
    for (const file of stale) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, 'local binding');
    }
    const neighbor = path.join(f.packageDir, 'build', 'Release', 'keep.txt');
    fs.writeFileSync(neighbor, 'keep');
    preparePackagedNodePty(f.buildPath, 'win32', 'x64');
    expect(stale.every((file) => !fs.existsSync(file))).toBe(true);
    expect(fs.readFileSync(neighbor, 'utf8')).toBe('keep');
    expect(fs.readFileSync(path.join(f.prebuildDir, 'conpty.node'), 'utf8')).toBe('fixture binary');
  });

  it('rejects a missing macOS spawn-helper before changing the package', () => {
    const f = fixture('darwin', 'arm64');
    fs.unlinkSync(path.join(f.prebuildDir, 'spawn-helper'));
    expect(() => preparePackagedNodePty(f.buildPath, 'darwin', 'arm64')).toThrow('spawn-helper');
  });

  it.each(['x64', 'arm64'])('keeps the existing Linux/%s source build', (arch) => {
    const f = fixture('linux', arch);
    expect(preparePackagedNodePty(f.buildPath, 'linux', arch)).toEqual({
      rebuild: true,
      nativePath: path.join(f.packageDir, 'build', 'Release', 'pty.node'),
    });
  });
});
