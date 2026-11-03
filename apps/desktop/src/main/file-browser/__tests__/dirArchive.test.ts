/**
 * dirArchive.test.ts — 远程文件夹下载的打包 / 解包往返。
 * 锁:.app 程序包依赖的符号链接与可执行位原样还原;恶意归档里的符号链接不能把
 * 后续条目引到目标目录之外。
 */
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import * as tar from 'tar';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { extractDirectoryArchive, packDirectory } from '../dir-archive';

const posix = process.platform !== 'win32';
let tmp: string;

beforeEach(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'dir-archive-test-'));
});
afterEach(async () => {
  await fsp.rm(tmp, { recursive: true, force: true });
});

describe.runIf(posix)('packDirectory / extractDirectoryArchive', () => {
  it('还原 app 包的符号链接、可执行位与空目录', async () => {
    const app = path.join(tmp, 'src', 'Game.app');
    const fw = path.join(app, 'Contents', 'Frameworks', 'X.framework');
    await fsp.mkdir(path.join(fw, 'Versions', 'A'), { recursive: true });
    await fsp.mkdir(path.join(app, 'Contents', 'MacOS'), { recursive: true });
    await fsp.mkdir(path.join(app, 'Contents', 'Empty'), { recursive: true });
    await fsp.writeFile(path.join(app, 'Contents', 'MacOS', 'Game'), '#!/bin/sh\n', {
      mode: 0o755,
    });
    await fsp.writeFile(path.join(fw, 'Versions', 'A', 'X'), 'lib');
    await fsp.symlink('A', path.join(fw, 'Versions', 'Current'));
    await fsp.symlink('Versions/Current/X', path.join(fw, 'X'));

    const dest = path.join(tmp, 'out');
    await fsp.mkdir(dest);
    let packSkipped = 0;
    const skipped = await extractDirectoryArchive(
      packDirectory(app, () => packSkipped++),
      dest,
    );

    expect(skipped).toBe(0);
    expect(packSkipped).toBe(0);
    const outFw = path.join(dest, 'Contents', 'Frameworks', 'X.framework');
    expect(await fsp.readlink(path.join(outFw, 'Versions', 'Current'))).toBe('A');
    expect(await fsp.readlink(path.join(outFw, 'X'))).toBe('Versions/Current/X');
    expect(await fsp.readFile(path.join(outFw, 'X'), 'utf8')).toBe('lib');
    const mode = (await fsp.stat(path.join(dest, 'Contents', 'MacOS', 'Game'))).mode;
    expect(mode & 0o111).not.toBe(0);
    expect((await fsp.stat(path.join(dest, 'Contents', 'Empty'))).isDirectory()).toBe(true);
  });

  it('符号链接不能把后续条目写到目标目录之外', async () => {
    const outside = path.join(tmp, 'outside');
    await fsp.mkdir(outside);
    const src = path.join(tmp, 'evil');
    await fsp.mkdir(path.join(src, 'esc'), { recursive: true });
    await fsp.writeFile(path.join(src, 'esc', 'pwned'), 'x');
    // 归档里先出现 `esc -> <outside>`,再出现 `esc/pwned`(同名真实目录先打包后改名)。
    const linkSrc = path.join(tmp, 'linksrc');
    await fsp.mkdir(linkSrc);
    await fsp.symlink(outside, path.join(linkSrc, 'esc'));
    const archive = new PassThrough();
    const first = tar.c({ cwd: linkSrc, portable: true }, [
      'esc',
    ]) as unknown as NodeJS.ReadableStream;
    const second = tar.c({ cwd: src, portable: true }, [
      'esc/pwned',
    ]) as unknown as NodeJS.ReadableStream;
    const chunks: Buffer[] = [];
    for await (const c of first) chunks.push(c as Buffer);
    // 去掉第一个归档的结尾零块,把两个归档拼成一个。
    let joined = Buffer.concat(chunks);
    while (joined.length >= 512 && joined.subarray(joined.length - 512).every((b) => b === 0))
      joined = joined.subarray(0, joined.length - 512);
    archive.write(joined);
    for await (const c of second) archive.write(c as Buffer);
    archive.end();

    const dest = path.join(tmp, 'out');
    await fsp.mkdir(dest);
    await extractDirectoryArchive(archive, dest);

    await expect(fsp.stat(path.join(outside, 'pwned'))).rejects.toThrow();
  });

  it('截断的归档 reject', async () => {
    const src = path.join(tmp, 'src');
    await fsp.mkdir(src);
    await fsp.writeFile(path.join(src, 'big'), Buffer.alloc(64 * 1024, 1));
    const chunks: Buffer[] = [];
    for await (const c of packDirectory(src, () => undefined)) chunks.push(c as Buffer);
    const truncated = new PassThrough();
    truncated.end(Buffer.concat(chunks).subarray(0, 4096));
    const dest = path.join(tmp, 'out');
    await fsp.mkdir(dest);
    await expect(extractDirectoryArchive(truncated, dest)).rejects.toThrow();
  });
});
