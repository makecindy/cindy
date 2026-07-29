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
    expect(names).toEqual(['ghost.json', 'locales/en.json', 'main.js']);
    const manifest = JSON.parse(await zip.files['ghost.json'].async('string')) as { id: string };
    expect(manifest.id).toBe('hello');
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
