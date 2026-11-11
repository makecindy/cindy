import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createOrganizationPrefixStore } from '../organizationPrefixStore';

const TEMP_PREFIX = 'cindy-org-prefix-';

let tempDir: string | null = null;

function makeTempDir(): string {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX));
  return tempDir;
}

function storePath(dir: string): string {
  return path.join(dir, 'organization.v1.json');
}

afterEach(() => {
  if (tempDir) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe('createOrganizationPrefixStore', () => {
  it('returns known with the remembered prefix', () => {
    const dir = makeTempDir();
    const store = createOrganizationPrefixStore(storePath(dir));
    store.remember('org-acme', 'acme');
    expect(store.lookup('org-acme')).toEqual({ kind: 'known', pluginPrefix: 'acme' });
  });

  it('merges writes so a previous organization entry is kept', () => {
    const dir = makeTempDir();
    const store = createOrganizationPrefixStore(storePath(dir));
    store.remember('org-a', 'aaa');
    store.remember('org-b', 'bbb');
    expect(store.lookup('org-a')).toEqual({ kind: 'known', pluginPrefix: 'aaa' });
    expect(store.lookup('org-b')).toEqual({ kind: 'known', pluginPrefix: 'bbb' });
  });

  it('returns absent when the file is missing or the orgId key is missing', () => {
    const dir = makeTempDir();
    const store = createOrganizationPrefixStore(storePath(dir));
    expect(store.lookup('org-missing')).toEqual({ kind: 'absent' });

    store.remember('org-a', 'aaa');
    expect(store.lookup('org-b')).toEqual({ kind: 'absent' });
  });

  it('returns unavailable for unparseable JSON, not absent', () => {
    const dir = makeTempDir();
    const file = storePath(dir);
    fs.writeFileSync(file, '{not-json', 'utf8');
    const store = createOrganizationPrefixStore(file);
    expect(store.lookup('org-acme')).toEqual({ kind: 'unavailable' });
  });

  it('returns unavailable for illegal stored pluginPrefix values', () => {
    const dir = makeTempDir();
    const file = storePath(dir);
    const store = createOrganizationPrefixStore(file);
    const illegal = ['A', 'x', 'toolongprefixvalue123', 1] as const;
    for (const pluginPrefix of illegal) {
      fs.writeFileSync(
        file,
        `${JSON.stringify({ version: 1, organizations: { 'org-1': { pluginPrefix } } })}\n`,
        'utf8',
      );
      expect(store.lookup('org-1'), String(pluginPrefix)).toEqual({ kind: 'unavailable' });
    }
  });

  it('treats a remembered null prefix as known, not absent', () => {
    const dir = makeTempDir();
    const store = createOrganizationPrefixStore(storePath(dir));
    store.remember('org-acme', null);
    expect(store.lookup('org-acme')).toEqual({ kind: 'known', pluginPrefix: null });
  });

  it('does not create directories or files when the module is imported', async () => {
    const dir = makeTempDir();
    await import('../organizationPrefixStore');
    expect(fs.readdirSync(dir)).toEqual([]);
    createOrganizationPrefixStore(storePath(dir));
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  // 这个文件是可重建的缓存(下次市场列表成功就能重新填)。若 remember 在内容损坏时
  // 也拒写,一次损坏就会让所有组织插件的特权被永久拒绝,唯一恢复路径是用户手动删文件。
  it('rebuilds over a corrupt file instead of staying permanently unavailable', () => {
    const dir = makeTempDir();
    const file = storePath(dir);
    fs.writeFileSync(file, '{not-json', 'utf8');
    const store = createOrganizationPrefixStore(file);
    expect(store.lookup('org-acme')).toEqual({ kind: 'unavailable' });

    store.remember('org-acme', 'acme');
    expect(store.lookup('org-acme')).toEqual({ kind: 'known', pluginPrefix: 'acme' });
  });

  // 版本不认也算内容损坏:同样要能被重建,不能把用户卡在永久 unavailable。
  it('rebuilds over a document whose version is not recognized', () => {
    const dir = makeTempDir();
    const file = storePath(dir);
    fs.writeFileSync(file, JSON.stringify({ version: 99, organizations: {} }), 'utf8');
    const store = createOrganizationPrefixStore(file);
    expect(store.lookup('org-acme')).toEqual({ kind: 'unavailable' });

    store.remember('org-acme', 'acme');
    expect(store.lookup('org-acme')).toEqual({ kind: 'known', pluginPrefix: 'acme' });
  });

  // 空 orgId 不是一个组织。调用方本该在个人身份下压根不查,但若哪天有人写成
  // `lookup(orgId ?? '')`,不能让它命中一条 `""` 键的条目而得出"有组织"的结论 ——
  // 那是与 installed=false 同类的 fail-open。
  it('never treats an empty orgId as a real organization', () => {
    const dir = makeTempDir();
    const file = storePath(dir);
    const store = createOrganizationPrefixStore(file);
    store.remember('', 'acme');
    expect(fs.existsSync(file)).toBe(false);
    expect(store.lookup('')).toEqual({ kind: 'unavailable' });

    store.remember('org-acme', 'acme');
    expect(store.lookup('  ')).toEqual({ kind: 'unavailable' });
  });

  it('discards illegal non-null prefixes instead of writing them', () => {
    const dir = makeTempDir();
    const file = storePath(dir);
    const store = createOrganizationPrefixStore(file);
    store.remember('org-acme', 'x');
    expect(fs.existsSync(file)).toBe(false);
    expect(store.lookup('org-acme')).toEqual({ kind: 'absent' });
  });
});
