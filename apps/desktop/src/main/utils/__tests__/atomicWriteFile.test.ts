import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { atomicWriteFileSync } from '../atomicWriteFile';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function makeFile(contents = 'old'): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-atomic-write-'));
  roots.push(root);
  const file = path.join(root, 'state.json');
  fs.writeFileSync(file, contents);
  return file;
}

describe('atomicWriteFileSync', () => {
  it('writes new contents replacing the existing file', () => {
    const file = makeFile();
    atomicWriteFileSync(file, 'new');
    expect(fs.readFileSync(file, 'utf8')).toBe('new');
    const dir = path.dirname(file);
    expect(fs.readdirSync(dir).filter((n) => n !== 'state.json')).toEqual([]);
  });

  it('creates the parent directory when missing', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-atomic-write-'));
    roots.push(root);
    const file = path.join(root, 'nested', 'deep', 'state.json');
    atomicWriteFileSync(file, 'created');
    expect(fs.readFileSync(file, 'utf8')).toBe('created');
  });

  it('restores a missing main file from .bak before writing', () => {
    const file = makeFile();
    // 模拟上次 temp 落位与恢复都失败:主文件缺失,.bak 是唯一快照。
    fs.renameSync(file, `${file}.bak`);
    expect(fs.existsSync(file)).toBe(false);
    atomicWriteFileSync(file, 'next');
    // 先把 .bak 恢复回主文件再写入新内容,唯一快照不被覆盖丢失。
    expect(fs.readFileSync(file, 'utf8')).toBe('next');
    expect(fs.existsSync(`${file}.bak`)).toBe(false);
  });

  it('clears a stale .bak from a previous failed write before writing', () => {
    const file = makeFile();
    fs.writeFileSync(`${file}.bak`, 'stale-backup');
    atomicWriteFileSync(file, 'fresh');
    expect(fs.readFileSync(file, 'utf8')).toBe('fresh');
    expect(fs.existsSync(`${file}.bak`)).toBe(false);
  });
});
