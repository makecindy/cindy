/**
 * model-catalog-override-store.test.ts —— 本地目录 override 存储:
 * owner 切换换文件不泄漏、坏条目隔离整文件不失效、手改文件 mtime 生效、
 * malformed/超限文件保留供用户修复。
 * userData 经 mock 的 ownerScopedUserDataPath 指向测试专属临时目录,读写走真文件。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-catalog-overrides-test-'));
const owner = { current: 'owner-a', generation: 1 };
afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/never-used-here' } }));
vi.mock('../logger-adapter.js', () => ({
  desktopMakerLogger: { child: () => ({ info: () => {}, warn: () => {}, error: () => {} }) },
}));
vi.mock('../../appSessionState.js', () => ({
  getActiveAppSession: () => ({ generation: owner.generation }),
  ownerScopedUserDataPath: (name: string) => path.join(tmpDir, owner.current, name),
}));

const { MAX_MODEL_CATALOG_OVERRIDE_FILE_BYTES, readModelCatalogOverrides, readModelImageInputOverride, writeModelImageInputOverride } =
  await import('../model-catalog-override-store.js');

const patchEntry = { base: { name: 'Renamed' } };

function writeOwnerFile(value: unknown): string {
  const file = path.join(tmpDir, owner.current, 'model-catalog-overrides.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
  return file;
}

describe('model-catalog-override-store', () => {
  it('读取显式 v1 文件', () => {
    owner.current = 'owner-valid';
    writeOwnerFile({ version: 1, patches: { 'openai:gpt-6': patchEntry } });
    expect(readModelCatalogOverrides().patches['openai:gpt-6']).toEqual(patchEntry);
  });

  it('owner 切换后读到的是新 owner 的文件,旧 owner 数据不泄漏;切回后原样恢复', () => {
    owner.current = 'owner-a';
    writeOwnerFile({ version: 1, patches: { 'openai:gpt-6': patchEntry } });
    owner.current = 'owner-b';
    expect(readModelCatalogOverrides().patches).toEqual({});
    writeOwnerFile({
      version: 1,
      additions: {
        'xai:xai/local-b': {
          agents: ['codex'],
          base: { name: 'B Only', contextWindow: 1_000, efforts: [], defaultEffort: null },
        },
      },
    });
    owner.current = 'owner-a';
    const backToA = readModelCatalogOverrides();
    expect(backToA.patches['openai:gpt-6']).toEqual(patchEntry);
    expect(backToA.additions).toEqual({});
  });

  it('手改文件:坏条目隔离、好条目生效;mtime 变化即现读', () => {
    owner.current = 'owner-c';
    writeOwnerFile({
      version: 1,
      patches: {
        'openai:gpt-6': { base: { name: 'Hand Edited' } },
        'xd:fake': { base: { name: 'Nope' } },
        'openai:bad': { base: { status: 'retired' } },
      },
    });
    const read = readModelCatalogOverrides();
    expect(Object.keys(read.patches)).toEqual(['openai:gpt-6', 'xd:fake']);
    expect(read.patches['openai:gpt-6']).toEqual({ base: { name: 'Hand Edited' } });
  });

  it('不解释未来版本,也不删除用户文件', () => {
    owner.current = 'owner-future';
    const file = writeOwnerFile({
      version: 2,
      patches: { 'openai:gpt-6': { base: { name: 'Future Shape' } } },
    });
    expect(readModelCatalogOverrides().patches).toEqual({});
    expect(fs.existsSync(file)).toBe(true);
  });

  it('malformed/超限文件回落空配置并保留原文', () => {
    owner.current = 'owner-malformed';
    const malformed = writeOwnerFile('{not-json');
    expect(readModelCatalogOverrides().patches).toEqual({});
    expect(fs.readFileSync(malformed, 'utf8')).toBe('{not-json');

    owner.current = 'owner-oversized';
    const oversized = writeOwnerFile(
      JSON.stringify({
        patches: {
          'openai:gpt-6': {
            base: { description: 'x'.repeat(MAX_MODEL_CATALOG_OVERRIDE_FILE_BYTES) },
          },
        },
      }),
    );
    expect(readModelCatalogOverrides().patches).toEqual({});
    expect(fs.statSync(oversized).size).toBeGreaterThan(MAX_MODEL_CATALOG_OVERRIDE_FILE_BYTES);
    expect(fs.existsSync(oversized)).toBe(true);
  });
});

// Unit: the new public writer must preserve sparse user data and false, unlike the former read-only store.
// Minimal inputs: one model, a malformed sibling, a refresh failure, and a changed account.
describe('image input edits', () => {
  const target = { providerId: 'relay', agent: 'pi' as const, modelId: 'model' };
  const refresh = async () => {};
  it('persists true and false, resets by deletion, and keeps unrelated and quarantined fields', async () => {
    owner.current = 'image-edit';
    const bad = { base: { unknownField: true } };
    const file = writeOwnerFile({ version: 1, patches: {
      'relay:model': { base: { name: 'My model' }, perAgent: { codex: { contextWindow: 200_000 } } },
      'relay:broken': bad,
    }, additions: { 'xai:extra': { base: { name: 'Extra', contextWindow: 1000, efforts: [], defaultEffort: null } } } });
    for (const value of [true, false, null]) {
      await writeModelImageInputOverride([target], value, refresh);
      expect(readModelImageInputOverride(target)).toBe(value);
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      expect(raw.patches['relay:broken']).toEqual(bad);
      expect(raw.patches['relay:model'].base.name).toBe('My model');
      expect(raw.patches['relay:model'].perAgent.codex.contextWindow).toBe(200_000);
      expect(raw.additions['xai:extra']).toBeDefined();
    }
    expect(readModelCatalogOverrides().patches['relay:model'].perAgent?.pi).toBeUndefined();
    owner.current = 'image-other-owner';
    expect(readModelImageInputOverride(target)).toBeNull();
    owner.current = 'image-edit';
    expect(readModelCatalogOverrides().patches['relay:model'].base?.name).toBe('My model');
  });
  it('rolls back in the original account if refresh fails after an owner switch', async () => {
    owner.current = 'image-original';
    await writeModelImageInputOverride([target], false, refresh);
    await expect(writeModelImageInputOverride([target], true, async () => {
      owner.current = 'image-switched'; owner.generation++;
      throw new Error('refresh failed');
    })).rejects.toThrow('refresh failed');
    expect(readModelImageInputOverride(target)).toBeNull();
    owner.current = 'image-original';
    expect(readModelImageInputOverride(target)).toBe(false);
  });
  it.each([2, '{broken'])('refuses to overwrite unsupported or unreadable data: %s', async (version) => {
    owner.current = `image-invalid-${version}`;
    const original = typeof version === 'string' ? version : JSON.stringify({ version, patches: {} });
    const file = writeOwnerFile(original);
    await expect(writeModelImageInputOverride([target], true, refresh)).rejects.toThrow();
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
  });
});
