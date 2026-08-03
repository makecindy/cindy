/**
 * send_to_session create 的 working_dir 覆盖校验(#811):绝对路径 + 已存在目录,
 * 通过时返回规范化路径(trim + resolve),失败给出可行动错误文案。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { validateHandoffWorkingDir } from '../handoffWorkingDir.js';

const dir = mkdtempSync(path.join(tmpdir(), 'cindy-handoff-wd-'));
const realDir = await (await import('node:fs')).promises.realpath(dir);
const file = path.join(dir, 'plain.txt');
writeFileSync(file, 'x');

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('validateHandoffWorkingDir', () => {
  it('已存在目录(绝对路径)→ ok 且返回规范化路径', async () => {
    expect(await validateHandoffWorkingDir(dir)).toEqual({ ok: true, dir: realDir });
  });

  it('带前后空白的合法路径 → trim 后通过,返回规范化路径(review 反馈)', async () => {
    expect(await validateHandoffWorkingDir(`  ${dir}  `)).toEqual({
      ok: true,
      dir: realDir,
    });
  });

  it('相对路径 → 报绝对路径要求', async () => {
    const r = await validateHandoffWorkingDir('relative/path');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('绝对路径');
  });

  it('不存在的路径 → 报不存在', async () => {
    const r = await validateHandoffWorkingDir(path.join(dir, 'nope'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('不存在');
  });

  it('指向文件 → 报不是目录', async () => {
    const r = await validateHandoffWorkingDir(file);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('不是目录');
  });

  it('软链目录 → 返回真身路径(review 反馈:base repo 解析看真身)', async () => {
    const linkPath = path.join(dir, 'link-to-dir');
    const target = path.join(dir, 'real-target');
    const { mkdirSync, promises, symlinkSync } = await import('node:fs');
    mkdirSync(target);
    try {
      symlinkSync(target, linkPath, 'dir');
    } catch {
      return; // Windows 无特权时目录软链可能 EPERM,建不出夹具就跳过(守卫仍在)。
    }
    expect(await validateHandoffWorkingDir(linkPath)).toEqual({
      ok: true,
      dir: await promises.realpath(target),
    });
  });

  it('空串 / 纯空白 → 报不能为空', async () => {
    for (const input of ['', '   ']) {
      const r = await validateHandoffWorkingDir(input);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message).toContain('不能为空');
    }
  });
});
