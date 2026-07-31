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

  it('clears a stale .bak from a previous failed write before writing', () => {
    const file = makeFile();
    fs.writeFileSync(`${file}.bak`, 'stale-backup');
    atomicWriteFileSync(file, 'fresh');
    expect(fs.readFileSync(file, 'utf8')).toBe('fresh');
    expect(fs.existsSync(`${file}.bak`)).toBe(false);
  });
});
