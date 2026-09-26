import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readBackgroundTaskOutputTail, readSessionBackgroundTaskOutputTail } from '../reader';

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bg-task-output-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('readBackgroundTaskOutputTail', () => {
  it('returns the whole file with size and mtime when under the cap', async () => {
    const file = path.join(dir, 'b1.output');
    await fs.writeFile(file, 'line 1\nline 2\n');
    const result = await readBackgroundTaskOutputTail(file);
    expect(result).toMatchObject({
      ok: true,
      text: 'line 1\nline 2\n',
      size: 14,
      truncated: false,
    });
    if (result.ok) expect(result.mtimeMs).toBeGreaterThan(0);
  });

  it('reads only the tail and drops the partial first line when over the cap', async () => {
    const file = path.join(dir, 'b2.output');
    await fs.writeFile(file, 'aaaaaaaaaa\nbbbb\ncccc\n');
    const result = await readBackgroundTaskOutputTail(file, 12);
    expect(result).toMatchObject({ ok: true, text: 'bbbb\ncccc\n', size: 21, truncated: true });
  });

  it('keeps the tail of a single long line instead of blanking it', async () => {
    const file = path.join(dir, 'b4.output');
    await fs.writeFile(file, `${'x'.repeat(40)}中文进度 99%`);
    const result = await readBackgroundTaskOutputTail(file, 16);
    expect(result).toMatchObject({ ok: true, truncated: true });
    if (result.ok) {
      expect(result.text.endsWith('中文进度 99%')).toBe(true);
      expect(result.text).not.toContain('\uFFFD');
    }
  });

  it('keeps the partial line when the only newline is the trailing one', async () => {
    const file = path.join(dir, 'b5.output');
    await fs.writeFile(file, `${'y'.repeat(40)}\n`);
    const result = await readBackgroundTaskOutputTail(file, 10);
    expect(result).toMatchObject({ ok: true, text: 'yyyyyyyyy\n', truncated: true });
  });

  it('rejects a link whose real target is not an output file', async () => {
    const target = path.join(dir, 'secret.txt');
    await fs.writeFile(target, 'secret');
    const link = path.join(dir, 'b6.output');
    await fs.symlink(target, link);
    expect(await readBackgroundTaskOutputTail(link)).toEqual({ ok: false, reason: 'forbidden' });
  });

  it('reads through a symlinked parent directory by checking the canonical path', async () => {
    // macOS 的 /tmp → /private/tmp 就是这种形态:上级目录是链接,真实目标仍是 .output 文件。
    const realDir = path.join(dir, 'real');
    await fs.mkdir(realDir);
    await fs.writeFile(path.join(realDir, 'b7.output'), 'via link\n');
    const linkedDir = path.join(dir, 'linked');
    await fs.symlink(realDir, linkedDir, 'dir');
    expect(await readBackgroundTaskOutputTail(path.join(linkedDir, 'b7.output'))).toMatchObject({
      ok: true,
      text: 'via link\n',
    });
  });

  it('returns an empty tail for an empty file', async () => {
    const file = path.join(dir, 'b3.output');
    await fs.writeFile(file, '');
    expect(await readBackgroundTaskOutputTail(file)).toMatchObject({ ok: true, text: '', size: 0 });
  });

  it('rejects non-.output files, relative paths, directories and non-strings', async () => {
    const txt = path.join(dir, 'secret.txt');
    await fs.writeFile(txt, 'x');
    const folder = path.join(dir, 'folder.output');
    await fs.mkdir(folder);
    expect(await readBackgroundTaskOutputTail(txt)).toEqual({ ok: false, reason: 'forbidden' });
    expect(await readBackgroundTaskOutputTail('tasks/b1.output')).toEqual({
      ok: false,
      reason: 'forbidden',
    });
    expect(await readBackgroundTaskOutputTail(123)).toEqual({ ok: false, reason: 'forbidden' });
    expect(await readBackgroundTaskOutputTail(folder)).toEqual({ ok: false, reason: 'forbidden' });
  });

  it('reports a missing file as not_found', async () => {
    expect(await readBackgroundTaskOutputTail(path.join(dir, 'gone.output'))).toEqual({
      ok: false,
      reason: 'not_found',
    });
  });
});

describe('readSessionBackgroundTaskOutputTail', () => {
  it('reads only the output file registered for that running task', async () => {
    const own = path.join(dir, 'own.output');
    const other = path.join(dir, 'other.output');
    await fs.writeFile(own, 'mine\n');
    await fs.writeFile(other, 'someone else\n');
    const source = {
      listBackgroundTasks: () => [
        { taskId: 'own', outputFile: own },
        { taskId: 'other-task', outputFile: other },
      ],
    };
    expect(await readSessionBackgroundTaskOutputTail(source, 'own')).toMatchObject({
      ok: true,
      text: 'mine\n',
    });
    // 传路径而不是任务 id 得不到任何文件。
    expect(await readSessionBackgroundTaskOutputTail(source, other)).toEqual({
      ok: false,
      reason: 'unavailable',
    });
  });

  it('is unavailable for unknown or finished tasks and sessions without a registry', async () => {
    const source = { listBackgroundTasks: () => [{ taskId: 'no-file' }] };
    expect(await readSessionBackgroundTaskOutputTail(source, 'gone')).toEqual({
      ok: false,
      reason: 'unavailable',
    });
    expect(await readSessionBackgroundTaskOutputTail(source, 'no-file')).toEqual({
      ok: false,
      reason: 'unavailable',
    });
    expect(await readSessionBackgroundTaskOutputTail(undefined, 'own')).toEqual({
      ok: false,
      reason: 'unavailable',
    });
    expect(await readSessionBackgroundTaskOutputTail(source, 42)).toEqual({
      ok: false,
      reason: 'forbidden',
    });
  });
});
