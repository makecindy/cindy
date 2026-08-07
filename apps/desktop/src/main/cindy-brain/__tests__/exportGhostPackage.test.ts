import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { InstalledGhost } from '../../../shared/ghost';
import { exportGhostPackage, sanitizeExportFileNamePart } from '../exportGhostPackage';
import { MAX_BASIC_ZIP_ENTRIES } from '../GhostManager';
import { signGhostPackage } from '../ghostSignature';

/** 测试用发布者密钥对(每次进程一对,签名/验签都走真实 ed25519)。 */
const { privateKey: publisherKey } = crypto.generateKeyPairSync('ed25519');

// Windows 未开启开发者模式且进程无特权时创建 symlink 会 EPERM。精确探测本用例
// 需要的目录/文件两种链接能力,不可用时只跳过 symlink 专属覆盖。
const canSymlink = (() => {
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-ghost-export-symlink-probe-'));
  try {
    const targetDir = path.join(probeDir, 'target-dir');
    const targetFile = path.join(targetDir, 'target.txt');
    fs.mkdirSync(targetDir);
    fs.writeFileSync(targetFile, 'probe');
    fs.symlinkSync(targetDir, path.join(probeDir, 'linked-dir'));
    fs.symlinkSync(targetFile, path.join(probeDir, 'linked-file'));
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(probeDir, { recursive: true, force: true });
  }
})();

/** 每个用例独立的临时安装目录(规则 23:测试路径一律 os.tmpdir)。 */
let workDir: string;
let ghostDir: string;

const FILE_WRITE_BATCH_SIZE = 16;

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
  await fs.promises.rm(workDir, {
    recursive: true,
    force: true,
    maxRetries: process.platform === 'win32' ? 5 : 0,
    retryDelay: 20,
  });
});

async function writeCacheFiles(count: number): Promise<void> {
  for (let start = 0; start < count; start += FILE_WRITE_BATCH_SIZE) {
    const batchSize = Math.min(FILE_WRITE_BATCH_SIZE, count - start);
    const results = await Promise.allSettled(
      Array.from({ length: batchSize }, (_, offset) =>
        fs.promises.writeFile(path.join(ghostDir, `cache-${start + offset}.dat`), 'x'),
      ),
    );
    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }
}

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

/**
 * 给夹具目录写一份真实签名的 cindy-signatures.json:用 signGhostPackage
 * 对 paths 指定的文件(相对 ghostDir,posix 风格)打包签名,取签名文件
 * 落盘。导出会对签名包做装入级验签,假签名必然 verify_failed。
 */
async function writeStatement(paths: string[]): Promise<void> {
  const zip = new JSZip();
  for (const p of paths) {
    zip.file(p, await fs.promises.readFile(path.join(ghostDir, ...p.split('/'))));
  }
  const pkg = await zip.generateAsync({ type: 'nodebuffer' });
  const signed = await signGhostPackage(pkg, {
    publisherName: 'test',
    privateKey: publisherKey,
  });
  const signedZip = await JSZip.loadAsync(signed);
  const sigText = await signedZip.file('cindy-signatures.json')!.async('string');
  await fs.promises.writeFile(path.join(ghostDir, 'cindy-signatures.json'), sigText);
}

function makeDeps(overrides: Partial<Parameters<typeof exportGhostPackage>[1]> = {}) {
  return {
    listInstalled: () => [makeGhost()],
    showSaveDialog: vi.fn(async ({ defaultPath }: { defaultPath: string }) => ({
      canceled: false,
      filePath: path.join(workDir, path.basename(defaultPath)),
    })),
    getDownloadsDir: () => workDir,
    fileTypeLabel: 'Cindy Plugin',
    writeFile: (filePath: string, data: Buffer) => fs.promises.writeFile(filePath, data),
    inspectPackage: async () => true,
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

  it('签名包:导出 statement 闭包,被覆盖的根部 .DS_Store 保留', async () => {
    // 打包时根部已有 .DS_Store 的签名包:statement 覆盖它,导出必须保留,
    // 否则重装校验缺文件失败;主机保留文件(.disabled/.cindy-trust.json)
    // 不在 statement 里,天然不进入导出包。
    await writeStatement(['.DS_Store', 'ghost.json', 'locales/en.json', 'main.js']);
    const result = await exportGhostPackage('hello', makeDeps());
    expect(result.status).toBe('saved');
    if (result.status !== 'saved') return;
    const zip = await JSZip.loadAsync(await fs.promises.readFile(result.savedPath));
    const names = Object.keys(zip.files);
    expect(names).toContain('.DS_Store');
    expect(names).toContain('cindy-signatures.json');
    expect(names).toContain('ghost.json');
    expect(names).not.toContain('.disabled');
    expect(names).not.toContain('.cindy-trust.json');

    // 未签名包:根部 .DS_Store 是装入后 Finder 残渣,跳过。
    await fs.promises.rm(path.join(ghostDir, 'cindy-signatures.json'));
    const unsignedResult = await exportGhostPackage('hello', makeDeps());
    expect(unsignedResult.status).toBe('saved');
    if (unsignedResult.status !== 'saved') return;
    const unsignedZip = await JSZip.loadAsync(await fs.promises.readFile(unsignedResult.savedPath));
    expect(Object.keys(unsignedZip.files)).not.toContain('.DS_Store');
  });

  it('签名包:statement 之外的杂散文件不进入导出包(任意深度 Finder 残渣)', async () => {
    // 用户用 Finder 浏览过子目录:嵌套 .DS_Store 是装入后生成的,
    // statement 不覆盖它,保留会让重装校验多出 statement 外文件。
    await fs.promises.writeFile(path.join(ghostDir, 'locales', '.DS_Store'), '');
    await writeStatement(['ghost.json', 'locales/en.json', 'main.js']);
    const result = await exportGhostPackage('hello', makeDeps());
    expect(result.status).toBe('saved');
    if (result.status !== 'saved') return;
    const zip = await JSZip.loadAsync(await fs.promises.readFile(result.savedPath));
    const names = Object.keys(zip.files);
    expect(names).not.toContain('locales/.DS_Store');
    expect(names).not.toContain('.DS_Store');
    expect(names).toContain('locales/en.json');
  });

  it('签名包内容被篡改(哈希与 statement 不符):如实 read_failed', async () => {
    await writeStatement(['ghost.json', 'locales/en.json', 'main.js']);
    await fs.promises.writeFile(path.join(ghostDir, 'main.js'), 'tampered-content');
    const result = await exportGhostPackage('hello', makeDeps());
    expect(result).toEqual({ status: 'error', code: 'read_failed' });
  });

  it('产物未过装入校验:如实 verify_failed,不碰用户既有目标文件', async () => {
    // 装入目录被改坏(如 statement/review 签名失效、manifest 不合法)
    // 的情形由装入校验本尊拦下——导出不能报成功;用户选择覆盖旧备份
    // 时,既有文件必须原样保留,只清理临时文件。
    const target = path.join(workDir, 'old-backup.cindy');
    await fs.promises.writeFile(target, 'old-bytes');
    const result = await exportGhostPackage('hello', makeDeps({
      showSaveDialog: vi.fn(async () => ({ canceled: false, filePath: target })),
      inspectPackage: async () => false,
    }));
    expect(result).toEqual({ status: 'error', code: 'verify_failed' });
    await expect(fs.promises.readFile(target, 'utf8')).resolves.toBe('old-bytes');
    const leftovers = (await fs.promises.readdir(workDir)).filter((name) =>
      name.startsWith('.cindy-export-'),
    );
    expect(leftovers).toEqual([]);
  });

  it('用户选择覆盖既有文件且校验通过:目标被完整新包替换', async () => {
    const target = path.join(workDir, 'existing.cindy');
    await fs.promises.writeFile(target, 'old-bytes');
    const result = await exportGhostPackage('hello', makeDeps({
      showSaveDialog: vi.fn(async () => ({ canceled: false, filePath: target })),
    }));
    expect(result).toEqual({ status: 'saved', savedPath: target });
    const zip = await JSZip.loadAsync(await fs.promises.readFile(target));
    expect(Object.keys(zip.files)).toContain('ghost.json');
  });

  it('目录内容超过装入侧条目上限:如实 too_large', async () => {
    // 普通(非 Node)插件装入上限 256 条目;运行期写入的杂散文件可能
    // 把目录撑过上限,导出不能成功却装不回。
    await writeCacheFiles(MAX_BASIC_ZIP_ENTRIES + 1);
    const result = await exportGhostPackage('hello', makeDeps());
    expect(result).toEqual({ status: 'error', code: 'too_large' });
  });

  it('签名包读取期间目录被更新:哈希不符触发整体重读', async () => {
    await writeStatement(['ghost.json', 'locales/en.json', 'main.js']);
    // 第一次读 main.js 返回陈旧字节(模拟并发更新读到旧目录):
    // 哈希与 statement 不符,必须整体重读,最终包内容应为真实字节。
    const realReadFile = fs.promises.readFile;
    let staleServed = false;
    const spy = vi.spyOn(fs.promises, 'readFile').mockImplementation(async (p: any, opts: any) => {
      if (String(p).endsWith('main.js') && !staleServed) {
        staleServed = true;
        return Buffer.from('stale-bytes');
      }
      return realReadFile(p, opts) as any;
    });
    try {
      const result = await exportGhostPackage('hello', makeDeps());
      expect(result.status).toBe('saved');
      if (result.status !== 'saved') return;
      expect(staleServed).toBe(true);
      const zip = await JSZip.loadAsync(await fs.promises.readFile(result.savedPath));
      await expect(zip.files['main.js'].async('string')).resolves.toBe('console.log("hi")');
    } finally {
      spy.mockRestore();
    }
  });

  it('遍历期间目录被改写时整体重读,导出与最终状态一致的包', async () => {
    // 第二遍(校验遍)枚举根部前改写 main.js:第一遍的字节与第二遍的
    // 元数据对不上,必须重读;最终包内容应是改写后的版本。
    const realOpendir = fs.promises.opendir;
    let rootReads = 0;
    const spy = vi.spyOn(fs.promises, 'opendir').mockImplementation(async (p: any) => {
      if (String(p) === ghostDir) {
        rootReads += 1;
        if (rootReads === 2) {
          await fs.promises.writeFile(
            path.join(ghostDir, 'main.js'),
            'console.log("version-2-content")',
          );
        }
      }
      return realOpendir(p) as any;
    });
    try {
      const result = await exportGhostPackage('hello', makeDeps());
      expect(result.status).toBe('saved');
      if (result.status !== 'saved') return;
      expect(rootReads).toBeGreaterThan(2);
      const zip = await JSZip.loadAsync(await fs.promises.readFile(result.savedPath));
      await expect(zip.files['main.js'].async('string')).resolves.toBe(
        'console.log("version-2-content")',
      );
    } finally {
      spy.mockRestore();
    }
  });

  it('嵌套点文件与 node_modules 属于包内容,未签名导出必须保留', async () => {
    await fs.promises.mkdir(path.join(ghostDir, 'node_modules', 'dep'), { recursive: true });
    await fs.promises.writeFile(path.join(ghostDir, 'node_modules', 'dep', 'index.js'), 'x');
    await fs.promises.mkdir(path.join(ghostDir, 'data'), { recursive: true });
    await fs.promises.writeFile(path.join(ghostDir, 'data', '.keep'), '');
    // 嵌套 .DS_Store 可能是作者包内容;未签名包只有根部主机残渣才跳过。
    await fs.promises.writeFile(path.join(ghostDir, 'data', '.DS_Store'), '');

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
    expect(names).toContain('data/.DS_Store');
    expect(names).not.toContain('.disabled');
    expect(names).not.toContain('.cindy-trust.json');
  });

  it('空目录作为显式条目保留(随包模板/输出目录,两条路径)', async () => {
    await fs.promises.mkdir(path.join(ghostDir, 'templates', 'empty'), { recursive: true });

    // 未签名:walk 收集空目录。
    const unsigned = await exportGhostPackage('hello', makeDeps());
    expect(unsigned.status).toBe('saved');
    if (unsigned.status !== 'saved') return;
    const unsignedZip = await JSZip.loadAsync(await fs.promises.readFile(unsigned.savedPath));
    expect(unsignedZip.files['templates/empty/']?.dir).toBe(true);

    // 签名:dir 条目不参与 statement 哈希,补回不影响验签。
    await writeStatement(['ghost.json', 'locales/en.json', 'main.js']);
    const signed = await exportGhostPackage('hello', makeDeps());
    expect(signed.status).toBe('saved');
    if (signed.status !== 'saved') return;
    const signedZip = await JSZip.loadAsync(await fs.promises.readFile(signed.savedPath));
    expect(signedZip.files['templates/empty/']?.dir).toBe(true);
  });

  it.skipIf(!canSymlink)('symlink 条目不跟随,不打进导出包', async () => {
    const outside = path.join(workDir, 'outside-secret');
    await fs.promises.mkdir(outside);
    await fs.promises.writeFile(path.join(outside, 'secret.txt'), 'secret');
    await fs.promises.symlink(outside, path.join(ghostDir, 'linked-dir'));
    await fs.promises.symlink(
      path.join(outside, 'secret.txt'),
      path.join(ghostDir, 'linked-file.js'),
    );

    const result = await exportGhostPackage('hello', makeDeps());
    expect(result.status).toBe('saved');
    if (result.status !== 'saved') return;
    const zip = await JSZip.loadAsync(await fs.promises.readFile(result.savedPath));
    const names = Object.values(zip.files)
      .filter((entry) => !entry.dir)
      .map((entry) => entry.name);
    expect(names).not.toContain('linked-dir/secret.txt');
    expect(names).not.toContain('linked-file.js');
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

  it('多字节名称组合后按 UTF-8 字节截断,不超 255 分量上限', async () => {
    // 64 个中文字符的名 + 32 个中文字符的版本:按码元各截 80 也仍有
    // 96 码元 × 3 字节 + '.cindy' > 255 字节,Linux 上会 ENAMETOOLONG。
    const ghost = makeGhost();
    ghost.manifest = {
      ...ghost.manifest,
      name: '插'.repeat(64),
      version: '版'.repeat(32),
    };
    const showSaveDialog = vi.fn(
      async (_opts: { defaultPath: string }) => ({ canceled: true as const }),
    );
    await exportGhostPackage('hello', makeDeps({
      listInstalled: () => [ghost],
      showSaveDialog,
    }));
    const defaultPath = showSaveDialog.mock.calls[0]?.[0].defaultPath ?? '';
    const base = path.basename(defaultPath);
    expect(Buffer.byteLength(base, 'utf8')).toBeLessThanOrEqual(255);
    expect(base.endsWith('.cindy')).toBe(true);
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

  it('剥掉 Windows 禁止的尾随点/空格', () => {
    expect(sanitizeExportFileNamePart('plugin. ')).toBe('plugin');
    expect(sanitizeExportFileNamePart('v1.0.')).toBe('v1.0');
  });

  it('Windows 保留设备名加前缀避让', () => {
    expect(sanitizeExportFileNamePart('aux')).toBe('_aux');
    expect(sanitizeExportFileNamePart('CON')).toBe('_CON');
    expect(sanitizeExportFileNamePart('com1')).toBe('_com1');
    expect(sanitizeExportFileNamePart('auxiliary')).toBe('auxiliary');
  });

  it('带扩展名的 Windows 保留设备名同样避让(按词干判断)', () => {
    expect(sanitizeExportFileNamePart('CON.txt')).toBe('_CON.txt');
    expect(sanitizeExportFileNamePart('nul.backup')).toBe('_nul.backup');
    expect(sanitizeExportFileNamePart('console.log')).toBe('console.log');
  });
});
