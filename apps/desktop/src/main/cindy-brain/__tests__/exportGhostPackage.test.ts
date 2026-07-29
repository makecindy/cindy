import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { InstalledGhost } from '../../../shared/ghost';
import { exportGhostPackage, sanitizeExportFileNamePart } from '../exportGhostPackage';

/** 每个用例独立的临时安装目录(规则 23:测试路径一律 os.tmpdir)。 */
let workDir: string;
let ghostDir: string;

beforeEach(async () => {
  workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cindy-ghost-export-test-'));
  ghostDir = path.join(workDir, 'hello');
  await fs.promises.mkdir(path.join(ghostDir, 'locales'), { recursive: true });
  await fs.promises.writeFile(path.join(ghostDir, 'ghost.json'), JSON.stringify({
    schemaVersion: 2,
    id: 'hello',
    name: 'Hello 插件',
    version: '1.2.0',
    kind: 'chip',
    entry: 'main.js',
    slots: ['tool'],
    tools: [{ name: 'do_thing', description: '做点事' }],
  }));
  await fs.promises.writeFile(path.join(ghostDir, 'main.js'), 'console.log("hi")');
  await fs.promises.writeFile(path.join(ghostDir, 'locales', 'en.json'), '{}');
  // 主机保留文件 + 系统残渣:导出必须跳过(可过装入校验)。
  await fs.promises.writeFile(path.join(ghostDir, '.disabled'), '');
  await fs.promises.writeFile(path.join(ghostDir, '.cindy-trust.json'), '{}');
  await fs.promises.writeFile(path.join(ghostDir, '.DS_Store'), '');
});

afterEach(async () => {
  await fs.promises.rm(workDir, { recursive: true, force: true });
});

function makeGhost(): InstalledGhost {
  return {
    manifest: {
      schemaVersion: 2,
      id: 'hello',
      name: 'Hello 插件',
      version: '1.2.0',
      kind: 'chip',
      entry: 'main.js',
      slots: ['tool'],
      tools: [{ name: 'do_thing', description: '做点事' }],
    },
    dir: ghostDir,
    enabled: true,
  };
}

function makeDeps(overrides: Partial<Parameters<typeof exportGhostPackage>[1]> = {}) {
  return {
    listInstalled: () => [makeGhost()],
    showSaveDialog: vi.fn(async ({ defaultPath }: { defaultPath: string }) => ({
      canceled: false,
      filePath: path.join(workDir, path.basename(defaultPath)),
    })),
    getDownloadsDir: () => workDir,
    writeFile: (filePath: string, data: Buffer) => fs.promises.writeFile(filePath, data),
    ...overrides,
  };
}

describe('exportGhostPackage', () => {
  it('打包安装目录为可重新装入的 .cindy(跳过主机点文件)', async () => {
    const deps = makeDeps();
    const result = await exportGhostPackage('hello', deps);
    expect(result.status).toBe('saved');
    if (result.status !== 'saved') return;

    const zip = await JSZip.loadAsync(await fs.promises.readFile(result.savedPath));
    const names = Object.values(zip.files)
      .filter((entry) => !entry.dir)
      .map((entry) => entry.name)
      .sort();
    // 根部主机保留文件(.disabled/.cindy-trust.json)与 .DS_Store 被跳过;
    // 包本体内容原样保留。
    expect(names).toEqual(['ghost.json', 'locales/en.json', 'main.js']);
    const manifest = JSON.parse(await zip.files['ghost.json'].async('string')) as { id: string };
    expect(manifest.id).toBe('hello');
  });

  it('嵌套点文件与 node_modules 属于包内容,导出必须保留(签名完整性)', async () => {
    await fs.promises.mkdir(path.join(ghostDir, 'node_modules', 'dep'), { recursive: true });
    await fs.promises.writeFile(path.join(ghostDir, 'node_modules', 'dep', 'index.js'), 'x');
    await fs.promises.mkdir(path.join(ghostDir, 'data'), { recursive: true });
    await fs.promises.writeFile(path.join(ghostDir, 'data', '.keep'), '');
    await fs.promises.writeFile(path.join(ghostDir, 'cindy-signatures.json'), '{}');

    const result = await exportGhostPackage('hello', makeDeps());
    expect(result.status).toBe('saved');
    if (result.status !== 'saved') return;
    const zip = await JSZip.loadAsync(await fs.promises.readFile(result.savedPath));
    const names = Object.values(zip.files)
      .filter((entry) => !entry.dir)
      .map((entry) => entry.name)
      .sort();
    expect(names).toContain('node_modules/dep/index.js');
    expect(names).toContain('data/.keep');
    expect(names).toContain('cindy-signatures.json');
    expect(names).not.toContain('.disabled');
    expect(names).not.toContain('.cindy-trust.json');
  });

  it('默认文件名携带插件名与版本号,落在下载目录', async () => {
    const showSaveDialog = vi.fn(async () => ({ canceled: true }));
    await exportGhostPackage('hello', makeDeps({ showSaveDialog }));
    expect(showSaveDialog).toHaveBeenCalledWith({
      defaultPath: path.join(workDir, 'Hello 插件-1.2.0.cindy'),
      filters: [{ name: 'Cindy Plugin', extensions: ['cindy'] }],
    });
  });

  it('未安装返回 not_installed;非法 id 返回 invalid_id', async () => {
    await expect(exportGhostPackage('missing', makeDeps())).resolves.toEqual({
      status: 'not_installed',
    });
    await expect(exportGhostPackage('../escape', makeDeps())).resolves.toEqual({
      status: 'invalid_id',
    });
    await expect(exportGhostPackage(42, makeDeps())).resolves.toEqual({
      status: 'invalid_id',
    });
  });

  it('导出前先把字节快照进内存:对话框期间目录被换掉也不混版本', async () => {
    let resolveDialog: ((value: { canceled: boolean; filePath?: string }) => void) | null = null;
    const showSaveDialog = vi.fn(
      () =>
        new Promise<{ canceled: boolean; filePath?: string }>((resolve) => {
          resolveDialog = resolve;
        }),
    );
    const pending = exportGhostPackage('hello', makeDeps({ showSaveDialog }));
    // 等快照与压缩完成、对话框弹出后再模拟"更新换目录"。
    await vi.waitFor(() => expect(showSaveDialog).toHaveBeenCalled());
    await fs.promises.rm(ghostDir, { recursive: true, force: true });
    await fs.promises.mkdir(ghostDir, { recursive: true });
    await fs.promises.writeFile(path.join(ghostDir, 'ghost.json'), '{"id":"hello","version":"9.9.9"}');
    resolveDialog!({ canceled: false, filePath: path.join(workDir, 'out.cindy') });

    const result = await pending;
    expect(result.status).toBe('saved');
    if (result.status !== 'saved') return;
    const zip = await JSZip.loadAsync(await fs.promises.readFile(result.savedPath));
    // 内容仍是快照时的 1.2.0 完整包,不是换目录后的残缺新版。
    const names = Object.values(zip.files)
      .filter((entry) => !entry.dir)
      .map((entry) => entry.name)
      .sort();
    expect(names).toEqual(['ghost.json', 'locales/en.json', 'main.js']);
  });

  it('版本号含路径分隔符时清洗后再拼默认文件名', async () => {
    const ghost = makeGhost();
    ghost.manifest = { ...ghost.manifest, version: '1/../../etc' };
    const showSaveDialog = vi.fn(
      async (_opts: { defaultPath: string }) => ({ canceled: true as const }),
    );
    await exportGhostPackage('hello', makeDeps({
      listInstalled: () => [ghost],
      showSaveDialog,
    }));
    const defaultPath = showSaveDialog.mock.calls[0]?.[0].defaultPath ?? '';
    expect(path.dirname(defaultPath)).toBe(workDir);
    expect(path.basename(defaultPath)).toBe('Hello 插件-1 .. .. etc.cindy');
  });

  it('取消保存返回 canceled,不写盘', async () => {
    const writeFile = vi.fn();
    const result = await exportGhostPackage('hello', makeDeps({
      showSaveDialog: vi.fn(async () => ({ canceled: true })),
      writeFile,
    }));
    expect(result).toEqual({ status: 'canceled' });
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('写盘失败返回 write_failed', async () => {
    const result = await exportGhostPackage('hello', makeDeps({
      writeFile: () => Promise.reject(new Error('disk full')),
    }));
    expect(result).toEqual({ status: 'error', code: 'write_failed' });
  });

  it('用户选择覆盖既有文件时,写出完整新包内容', async () => {
    const target = path.join(workDir, 'existing.cindy');
    await fs.promises.writeFile(target, 'old-bytes');
    const result = await exportGhostPackage('hello', makeDeps({
      showSaveDialog: vi.fn(async () => ({ canceled: false, filePath: target })),
    }));
    expect(result).toEqual({ status: 'saved', savedPath: target });
    const zip = await JSZip.loadAsync(await fs.promises.readFile(target));
    const names = Object.values(zip.files)
      .filter((entry) => !entry.dir)
      .map((entry) => entry.name)
      .sort();
    expect(names).toEqual(['ghost.json', 'locales/en.json', 'main.js']);
  });

  it('安装目录不可读返回 read_failed', async () => {
    const ghost = makeGhost();
    ghost.dir = path.join(workDir, 'gone');
    const result = await exportGhostPackage('hello', makeDeps({
      listInstalled: () => [ghost],
    }));
    expect(result).toEqual({ status: 'error', code: 'read_failed' });
  });
});

describe('sanitizeExportFileNamePart', () => {
  it('剥掉文件系统非法字符与首尾点,折叠空白', () => {
    expect(sanitizeExportFileNamePart('my <plugin>: "v2"?')).toBe('my plugin v2');
    expect(sanitizeExportFileNamePart('  多空  白  ')).toBe('多空 白');
    expect(sanitizeExportFileNamePart('..hidden')).toBe('hidden');
  });

  it('全非法字符时回落为空(调用方用 id 兜底)', () => {
    expect(sanitizeExportFileNamePart('<>:"/\\|?*')).toBe('');
  });
});
