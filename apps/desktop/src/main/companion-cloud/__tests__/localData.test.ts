import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { companionHasLocalData } from '../localData.js';

describe('companionHasLocalData', () => {
  let root: string;
  beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'companion-local-data-')); });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

  const check = (overrides: Partial<Parameters<typeof companionHasLocalData>[0]> = {}) => companionHasLocalData({
    hasProfile: async () => false,
    hasTaskLink: async () => false,
    directory: path.join(root, 'bot'),
    owner: () => 'owner',
    ...overrides,
  });

  it('is false only when nothing exists', async () => {
    expect(await check()).toBe(false);
  });

  it('counts a profile or a task link, archived or not', async () => {
    expect(await check({ hasProfile: async () => true })).toBe(true);
    expect(await check({ hasTaskLink: async () => true })).toBe(true);
  });

  it('counts an empty directory and a broken symlink', async () => {
    await fs.mkdir(path.join(root, 'bot'));
    expect(await check()).toBe(true);
    await fs.rmdir(path.join(root, 'bot'));
    await fs.symlink(path.join(root, 'missing'), path.join(root, 'bot'));
    expect(await check()).toBe(true);
  });

  it('throws on a read error other than a missing directory', async () => {
    const lstat = async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); };
    await expect(check({ lstat })).rejects.toMatchObject({ code: 'EACCES' });
  });

  it('throws when the owner changes during the check', async () => {
    let calls = 0;
    await expect(check({ owner: () => (calls++ ? 'other' : 'owner') })).rejects.toThrow('OWNER_CHANGED');
  });
});
