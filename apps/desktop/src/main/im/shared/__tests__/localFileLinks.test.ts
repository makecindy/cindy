/**
 * 回答里的本机文件链接 → 受控附件。
 *
 * 测试价值
 * - 生产入口与可观察结果: resolveLocalFileAttachments(由 runner 在终稿前调用)。
 *   用户可观察的是"回答里链接到的任务文件真的作为附件发出去", 越界文件不会发。
 * - Bug／规则依据: 真机 2026-11-12 企微任务里 `[下载 imbot-live.txt](imbot-live.txt)`
 *   被投影成纯文本, 对方什么也没收到; 要求不靠模型改用 xdt-file。
 * - 现有覆盖缺口: unlinkLocalFileLinks 只覆盖"去掉本机链接", 没有收集/校验附件。
 * - 最小失败输入: 相对链接 + 工作目录 + 允许根 → 解析成绝对路径; `../` 越界 → 不收集。
 * - tier: unit(临时目录, 无网络)。
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { collectLocalFileLinks, resolveLocalFileAttachments } from '../localFileLinks';

let root = '';
let workDir = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cindy-file-links-'));
  workDir = join(root, 'work');
  mkdirSync(workDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('local file link attachments', () => {
  it('resolves a relative link against the task working directory', async () => {
    writeFileSync(join(workDir, 'imbot-live.txt'), 'IMBOT-FILE-OK');
    const attachments = await resolveLocalFileAttachments({
      text: '已创建文件。\n[下载 imbot-live.txt](imbot-live.txt)',
      baseDir: workDir,
      allowedRoots: [workDir],
    });
    expect(attachments.map((item) => item.absPath)).toEqual([
      await realpath(join(workDir, 'imbot-live.txt')),
    ]);
    expect(attachments[0]?.displayName).toBe('下载 imbot-live.txt');
  });

  it('ignores escaping paths, missing files, external links and images', async () => {
    const outside = join(root, 'secret.txt');
    writeFileSync(outside, 'secret');
    const attachments = await resolveLocalFileAttachments({
      text: [
        '[越界](../secret.txt)',
        '[不存在](missing.txt)',
        '[外部](https://example.com/report.pdf)',
        '![图片](shot.png)',
      ].join('\n'),
      baseDir: workDir,
      allowedRoots: [workDir],
    });
    expect(attachments).toEqual([]);
  });

  it('rejects a symlink that points outside the approved root', async () => {
    const outside = join(root, 'secret.txt');
    writeFileSync(outside, 'secret');
    symlinkSync(outside, join(workDir, 'link.txt'));
    const attachments = await resolveLocalFileAttachments({
      text: '[链接](link.txt)',
      baseDir: workDir,
      allowedRoots: [workDir],
    });
    expect(attachments).toEqual([]);
  });

  it('keeps absolute paths and file: URLs only inside the root', async () => {
    const inside = join(workDir, 'report.pdf');
    writeFileSync(inside, 'pdf');
    const outside = join(root, 'other.pdf');
    writeFileSync(outside, 'pdf');
    const absolute = await resolveLocalFileAttachments({
      text: `[一](${inside})\n[二](${outside})`,
      baseDir: workDir,
      allowedRoots: [workDir],
    });
    // 根内绝对路径保留; 根外绝对路径丢弃。
    expect(absolute.map((item) => item.absPath)).toEqual([await realpath(inside)]);

    const fileUrl = await resolveLocalFileAttachments({
      text: `[三](file://${inside})`,
      baseDir: workDir,
      allowedRoots: [workDir],
    });
    expect(fileUrl.map((item) => item.absPath)).toEqual([await realpath(inside)]);

    // 同一文件用两种写法只交付一次。
    const deduped = await resolveLocalFileAttachments({
      text: `[一](${inside})\n[三](file://${inside})`,
      baseDir: workDir,
      allowedRoots: [workDir],
    });
    expect(deduped).toHaveLength(1);
  });

  // Bug（2026-11-12 审查）：`file:` 目标先 decode 再当 URL 解析，`%23`/`%3F` 会变成
  // fragment/query，导致同一目录里的“截断同名文件”被误选或直接丢附件。
  // 覆盖缺口：既有用例只测相对/绝对路径，没有测编码后的 file URL。
  // 最小输入：目录里同时有 `报告#1.txt` 与 `报告`，链接用 pathToFileURL 编码后的 URL。
  it('resolves a percent-encoded # in a file: URL to the exact file', async () => {
    const encodedDir = join(workDir, 'hash');
    mkdirSync(encodedDir, { recursive: true });
    const exact = join(encodedDir, '报告#1.txt');
    // 同名的“被截断”文件：旧实现会把 `#` 当锚点，解析到这里。
    writeFileSync(exact, 'exact');
    writeFileSync(join(encodedDir, '报告'), 'truncated');

    const attachments = await resolveLocalFileAttachments({
      text: `[报告](${pathToFileURL(exact).href})`,
      baseDir: workDir,
      allowedRoots: [workDir],
    });
    expect(attachments.map((item) => item.absPath)).toEqual([await realpath(exact)]);
  });

  it('resolves a percent-encoded % in a file: URL to the exact file', async () => {
    const encodedDir = join(workDir, 'percent');
    mkdirSync(encodedDir, { recursive: true });
    const exact = join(encodedDir, '100%完成.txt');
    writeFileSync(exact, 'exact');

    const attachments = await resolveLocalFileAttachments({
      text: `[报告](${pathToFileURL(exact).href})`,
      baseDir: workDir,
      allowedRoots: [workDir],
    });
    expect(attachments.map((item) => item.absPath)).toEqual([await realpath(exact)]);
  });

  it.skipIf(process.platform === 'win32')(
    'resolves a file: URL whose real name contains a question mark',
    async () => {
      const dir = join(workDir, 'question');
      mkdirSync(dir, { recursive: true });
      const exact = join(dir, '报告?终稿.txt');
      writeFileSync(exact, 'exact');

      const attachments = await resolveLocalFileAttachments({
        text: `[报告](${pathToFileURL(exact).href})`,
        baseDir: workDir,
        allowedRoots: [workDir],
      });
      expect(attachments.map((item) => item.absPath)).toEqual([await realpath(exact)]);
    },
  );

  it('collects only plain links, never images or scheme links', () => {
    const links = collectLocalFileLinks(
      [
        '[文件](report.pdf)',
        '[绝对](/tmp/report.pdf)',
        '[xdt](xdt-file:///tmp/report.pdf)',
        '![图片](shot.png)',
        '[网页](https://example.com)',
      ].join('\n'),
    );
    expect(links.map((link) => link.url)).toEqual(['report.pdf', '/tmp/report.pdf']);
  });

  it('resolves nothing when the task has no approved local root (remote session)', async () => {
    writeFileSync(join(workDir, 'imbot-live.txt'), 'x');
    const attachments = await resolveLocalFileAttachments({
      text: '[下载](imbot-live.txt)',
      baseDir: workDir,
      allowedRoots: [],
    });
    expect(attachments).toEqual([]);
  });
});

async function realpath(target: string): Promise<string> {
  const { realpath: resolveReal } = await import('node:fs/promises');
  return resolveReal(target);
}
