/**
 * office_to_pdf 与 soffice 探测的测试。
 *
 * 直接对着 DocsToolRegistry 注册,而不是走 MCP server —— soffice 的探测与执行是
 * 注册期注入点,这样测试才不依赖跑测机器上到底装没装 LibreOffice。
 *
 * 重点钉住「诚实降级」:未安装返回 SOFFICE_NOT_FOUND + retryable:false + 人话指引,
 * 以及「假成功」防线(soffice 退出码 0 但没产出文件时必须报错,不能交坏文件)。
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DocsToolRegistry } from '../cindy_docsToolRegistry.js';
import { registerOfficeToPdfTool } from '../cindy-docs/office_to_pdf.js';
import {
  __resetSofficeCache,
  findSoffice,
  installHintForPlatform,
  OFFICE_INPUT_EXTENSIONS,
} from '../cindy-docs/soffice.js';
import type { DocsMcpSessionCtx } from '../cindy-docs/types.js';

let workdir: string;
const created: string[] = [];

beforeEach(async () => {
  __resetSofficeCache();
  workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-docs-office-'));
  created.push(workdir);
});

afterEach(async () => {
  while (created.length > 0) {
    const dir = created.pop()!;
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

function ctx(): DocsMcpSessionCtx {
  return { agentKind: 'claude-code', workingDir: workdir, sessionId: 's' };
}

function payload(result: unknown): Record<string, unknown> {
  const content = (result as { content: Array<{ text: string }> }).content;
  return JSON.parse(content[0]!.text) as Record<string, unknown>;
}

describe('findSoffice', () => {
  it('命中常见安装位置就直接用', async () => {
    const fake = path.join(workdir, 'soffice');
    await fs.writeFile(fake, '#!/bin/sh\n', { mode: 0o755 });
    await expect(findSoffice({ wellKnownPaths: [fake], noCache: true })).resolves.toBe(fake);
  });

  it('常见位置都不在时回落 PATH', async () => {
    const fake = path.join(workdir, 'from-path');
    await fs.writeFile(fake, '#!/bin/sh\n', { mode: 0o755 });
    await expect(
      findSoffice({ wellKnownPaths: [], lookupOnPath: async () => fake, noCache: true }),
    ).resolves.toBe(fake);
  });

  it('都找不到返回 null(而不是抛错)', async () => {
    await expect(
      findSoffice({
        wellKnownPaths: [path.join(workdir, 'nope')],
        lookupOnPath: async () => null,
        noCache: true,
      }),
    ).resolves.toBeNull();
  });

  it('PATH 给出的路径不可执行时不认', async () => {
    const notExec = path.join(workdir, 'not-exec');
    await fs.writeFile(notExec, 'x', { mode: 0o644 });
    await expect(
      findSoffice({ wellKnownPaths: [], lookupOnPath: async () => notExec, noCache: true }),
    ).resolves.toBeNull();
  });
});

describe('installHintForPlatform', () => {
  it('每个平台都给出可照做的安装方式,且带官网地址', () => {
    for (const platform of ['darwin', 'win32', 'linux', 'freebsd']) {
      const hint = installHintForPlatform(platform);
      expect(hint).toContain('libreoffice.org');
      expect(hint.length).toBeGreaterThan(20);
    }
    expect(installHintForPlatform('darwin')).toContain('brew');
  });
});

describe('office_to_pdf', () => {
  async function register(opts: Parameters<typeof registerOfficeToPdfTool>[2]) {
    const registry = new DocsToolRegistry();
    registerOfficeToPdfTool(registry, ctx(), opts);
    return registry;
  }

  it('没装 LibreOffice 时返回结构化错误 + 安装指引,并标注不可重试', async () => {
    await fs.writeFile(path.join(workdir, 'a.docx'), 'x');
    const registry = await register({
      lookup: { wellKnownPaths: [], lookupOnPath: async () => null, noCache: true },
    });
    const result = payload(
      await registry.call('office_to_pdf', { path: 'a.docx', outPath: 'a.pdf' }),
    );
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('SOFFICE_NOT_FOUND');
    const data = result.data as Record<string, unknown>;
    expect(data.retryable).toBe(false);
    expect(String(data.hint)).toContain('libreoffice.org');
    // 未安装不该产生任何输出文件
    await expect(fs.stat(path.join(workdir, 'a.pdf'))).rejects.toThrow();
  });

  it('装了就真调 soffice,并把产物搬到 outPath', async () => {
    await fs.writeFile(path.join(workdir, 'src.docx'), 'x');
    const bin = path.join(workdir, 'soffice');
    await fs.writeFile(bin, '#!/bin/sh\n', { mode: 0o755 });

    const invocations: Array<{ bin: string; args: string[] }> = [];
    const registry = await register({
      lookup: { wellKnownPaths: [bin], noCache: true },
      run: async (usedBin, args) => {
        invocations.push({ bin: usedBin, args });
        const outDirIndex = args.indexOf('--outdir');
        await fs.writeFile(path.join(args[outDirIndex + 1]!, 'src.pdf'), '%PDF-1.7 fake');
      },
    });

    const result = payload(
      await registry.call('office_to_pdf', { path: 'src.docx', outPath: 'out/src.pdf' }),
    );
    expect(result.ok).toBe(true);
    expect(result.format).toBe('pdf');
    expect(result.converter).toBe(bin);
    expect(await fs.readFile(path.join(workdir, 'out/src.pdf'), 'utf-8')).toBe('%PDF-1.7 fake');

    const args = invocations[0]!.args;
    expect(args).toContain('--headless');
    expect(args).toContain('--convert-to');
    expect(args).toContain('pdf');
    // 专属 profile:不带它时用户开着 LibreOffice 界面会导致假成功。
    expect(args.some((a) => a.startsWith('-env:UserInstallation='))).toBe(true);
  });

  it('soffice 退出码 0 但没产出文件时报 CONVERT_FAILED(不交坏文件)', async () => {
    await fs.writeFile(path.join(workdir, 'src.pptx'), 'x');
    const bin = path.join(workdir, 'soffice');
    await fs.writeFile(bin, '#!/bin/sh\n', { mode: 0o755 });
    const registry = await register({
      lookup: { wellKnownPaths: [bin], noCache: true },
      run: async () => {
        /* 静默什么都不产出 —— LibreOffice 的经典假成功 */
      },
    });
    const result = payload(
      await registry.call('office_to_pdf', { path: 'src.pptx', outPath: 'src.pdf' }),
    );
    expect(result.errorCode).toBe('CONVERT_FAILED');
    await expect(fs.stat(path.join(workdir, 'src.pdf'))).rejects.toThrow();
  });

  it('超时被归成 CONVERT_TIMEOUT', async () => {
    await fs.writeFile(path.join(workdir, 'src.docx'), 'x');
    const bin = path.join(workdir, 'soffice');
    await fs.writeFile(bin, '#!/bin/sh\n', { mode: 0o755 });
    const registry = await register({
      lookup: { wellKnownPaths: [bin], noCache: true },
      run: async () => {
        throw new Error('spawn soffice ETIMEDOUT');
      },
    });
    expect(
      payload(await registry.call('office_to_pdf', { path: 'src.docx', outPath: 'a.pdf' }))
        .errorCode,
    ).toBe('CONVERT_TIMEOUT');
  });

  it('不支持的输入扩展名在探测之前就被拒', async () => {
    await fs.writeFile(path.join(workdir, 'a.txt'), 'x');
    const lookupOnPath = vi.fn(async () => null);
    const registry = await register({
      lookup: { wellKnownPaths: [], lookupOnPath, noCache: true },
    });
    const result = payload(
      await registry.call('office_to_pdf', { path: 'a.txt', outPath: 'a.pdf' }),
    );
    expect(result.errorCode).toBe('UNSUPPORTED_FORMAT');
    expect(lookupOnPath).not.toHaveBeenCalled();
    expect(OFFICE_INPUT_EXTENSIONS.has('.docx')).toBe(true);
    expect(OFFICE_INPUT_EXTENSIONS.has('.txt')).toBe(false);
  });

  it('输入输出路径都受工作目录边界约束', async () => {
    const bin = path.join(workdir, 'soffice');
    await fs.writeFile(bin, '#!/bin/sh\n', { mode: 0o755 });
    const registry = await register({
      lookup: { wellKnownPaths: [bin], noCache: true },
      run: async () => undefined,
    });

    expect(
      payload(await registry.call('office_to_pdf', { path: '/etc/hosts', outPath: 'a.pdf' }))
        .errorCode,
    ).toBe('PATH_NOT_ALLOWED');

    await fs.writeFile(path.join(workdir, 'src.docx'), 'x');
    expect(
      payload(
        await registry.call('office_to_pdf', {
          path: 'src.docx',
          outPath: '../escaped.pdf',
        }),
      ).errorCode,
    ).toBe('PATH_NOT_ALLOWED');
  });

  it('目标已存在时默认不覆盖', async () => {
    await fs.writeFile(path.join(workdir, 'src.docx'), 'x');
    await fs.writeFile(path.join(workdir, 'src.pdf'), 'old');
    const bin = path.join(workdir, 'soffice');
    await fs.writeFile(bin, '#!/bin/sh\n', { mode: 0o755 });
    const registry = await register({
      lookup: { wellKnownPaths: [bin], noCache: true },
      run: async (_bin, args) => {
        const outDirIndex = args.indexOf('--outdir');
        await fs.writeFile(path.join(args[outDirIndex + 1]!, 'src.pdf'), 'new');
      },
    });
    expect(
      payload(await registry.call('office_to_pdf', { path: 'src.docx', outPath: 'src.pdf' }))
        .errorCode,
    ).toBe('FILE_EXISTS');
    expect(await fs.readFile(path.join(workdir, 'src.pdf'), 'utf-8')).toBe('old');

    const forced = payload(
      await registry.call('office_to_pdf', {
        path: 'src.docx',
        outPath: 'src.pdf',
        overwrite: true,
      }),
    );
    expect(forced.ok).toBe(true);
    expect(await fs.readFile(path.join(workdir, 'src.pdf'), 'utf-8')).toBe('new');
  });

  it('转换用的临时目录事后被清理', async () => {
    await fs.writeFile(path.join(workdir, 'src.docx'), 'x');
    const bin = path.join(workdir, 'soffice');
    await fs.writeFile(bin, '#!/bin/sh\n', { mode: 0o755 });
    let usedTempDir = '';
    const registry = await register({
      lookup: { wellKnownPaths: [bin], noCache: true },
      run: async (_bin, args) => {
        usedTempDir = args[args.indexOf('--outdir') + 1]!;
        await fs.writeFile(path.join(usedTempDir, 'src.pdf'), '%PDF');
      },
    });
    expect(payload(await registry.call('office_to_pdf', { path: 'src.docx', outPath: 'o.pdf' })).ok)
      .toBe(true);
    expect(usedTempDir).not.toBe('');
    await expect(fs.stat(usedTempDir)).rejects.toThrow();
  });
});
