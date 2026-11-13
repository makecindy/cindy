import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mocks = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('../../logger.js', () => ({ createLogger: () => ({ warn: mocks.warn }) }));

import { codexPackagePathPrepends, ensureCodexCliLauncher } from '../codex-cli-launcher.js';

// 测试价值：ensureCodexCliLauncher 的文件结果与 Windows PATH 选择；防止 shell
// 误用旧 Codex。现有下载测试不覆盖新增入口。最小输入：包已有 bin/codex、无入口。
// tier: unit；唯一临时目录和文件 I/O，不启动真实 CLI/Electron，不访问用户数据。
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  mocks.warn.mockClear();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cli-launcher-'));
  roots.push(userDataPath);
  const packageRoot = path.join(userDataPath, 'codex-package', '0.159.2');
  fs.mkdirSync(path.join(packageRoot, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(packageRoot, 'codex-path'));
  fs.writeFileSync(path.join(packageRoot, 'codex-package.json'), JSON.stringify({ pathDir: 'codex-path' }));
  const binaryPath = path.join(packageRoot, 'bin', 'codex');
  fs.writeFileSync(binaryPath, 'fake binary');
  return {
    packageRoot, binaryPath,
    destination: path.join(packageRoot, 'codex-path', 'codex'),
    options: { userDataPath, isPackaged: true, platform: 'darwin' as NodeJS.Platform },
  };
}

describe('packaged Codex shell launcher', () => {
  it('writes once, updates marked scripts, and preserves an upstream-owned executable', () => {
    const { binaryPath, destination, options } = fixture();
    ensureCodexCliLauncher(binaryPath, options);
    const content = fs.readFileSync(destination, 'utf8');
    expect(content).toContain('../bin/codex');
    if (process.platform !== 'win32') expect(fs.statSync(destination).mode & 0o777).toBe(0o755);
    const oldTime = new Date('2000-01-01T00:00:00Z');
    fs.utimesSync(destination, oldTime, oldTime);
    ensureCodexCliLauncher(binaryPath, options);
    expect(fs.statSync(destination).mtimeMs).toBe(oldTime.getTime());

    fs.writeFileSync(destination, content.replace('exec ', '# old\nexec '));
    ensureCodexCliLauncher(binaryPath, options);
    expect(fs.readFileSync(destination, 'utf8')).toBe(content);
    fs.writeFileSync(destination, 'upstream executable');
    ensureCodexCliLauncher(binaryPath, options);
    expect(fs.readFileSync(destination, 'utf8')).toBe('upstream executable');
  });

  it.each(['development', 'windows', 'outside-userData', 'single-binary', 'missing-manifest', 'wrong-pathDir', 'missing-pathDir'])
  ('does not write for %s', (scenario) => {
    const { binaryPath, destination, packageRoot, options } = fixture();
    let selectedBinary = binaryPath;
    if (scenario === 'development') options.isPackaged = false;
    if (scenario === 'windows') options.platform = 'win32';
    if (scenario === 'outside-userData') options.userDataPath = path.join(options.userDataPath, 'other');
    if (scenario === 'single-binary') selectedBinary = path.join(packageRoot, 'codex');
    if (scenario === 'missing-manifest') fs.rmSync(path.join(packageRoot, 'codex-package.json'));
    if (scenario === 'wrong-pathDir') fs.writeFileSync(path.join(packageRoot, 'codex-package.json'), '{"pathDir":"other"}');
    if (scenario === 'missing-pathDir') fs.rmdirSync(path.dirname(destination));
    expect(() => ensureCodexCliLauncher(selectedBinary, options)).not.toThrow();
    expect(fs.existsSync(destination)).toBe(false);
  });

  it('logs write failure and cleans the temporary file without blocking startup', () => {
    const { binaryPath, destination, options } = fixture();
    vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('write denied'); });
    expect(() => ensureCodexCliLauncher(binaryPath, options)).not.toThrow();
    expect(mocks.warn).toHaveBeenCalledOnce();
    expect(fs.readdirSync(path.dirname(destination))).toEqual([]);
  });
});

it('prepends only a Windows Codex package bin directory, never a system directory', () => {
  const root = path.win32.join('C:\\', 'Cindy Data', 'codex-package', '0.159.2');
  vi.spyOn(fs, 'existsSync').mockImplementation((candidate) => candidate === path.win32.join(root, 'codex-package.json'));
  const binaryPath = path.win32.join(root, 'bin', 'codex.exe');
  expect(codexPackagePathPrepends(binaryPath, 'win32')).toEqual([path.win32.join(root, 'bin')]);
  expect(codexPackagePathPrepends(path.win32.join('C:\\', 'Windows', 'codex.exe'), 'win32')).toEqual([]);
  expect(codexPackagePathPrepends(path.win32.join('C:\\', 'System', 'bin', 'codex.exe'), 'win32')).toEqual([]);
  expect(codexPackagePathPrepends(binaryPath, 'darwin')).toEqual([]);
});
