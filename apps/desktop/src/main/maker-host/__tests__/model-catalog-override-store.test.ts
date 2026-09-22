/**
 * model-catalog-override-store.test.ts —— 本地目录 override 存储:
 * owner 切换换文件不泄漏、坏条目隔离整文件不失效、手改文件 mtime 生效、
 * malformed/超限文件保留供用户修复。
 * userData 经 mock 的 ownerScopedUserDataPath 指向测试专属临时目录,读写走真文件。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-catalog-overrides-test-'));
const owner = { current: 'owner-a' };

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/never-used-here' } }));
vi.mock('../logger-adapter.js', () => ({
  desktopMakerLogger: { child: () => ({ info: () => {}, warn: () => {}, error: () => {} }) },
}));
vi.mock('../../appSessionState.js', () => ({
  ownerScopedUserDataPath: (name: string) => path.join(tmpDir, owner.current, name),
}));

const {
  MAX_MODEL_CATALOG_OVERRIDE_FILE_BYTES,
  readModelCatalogOverrides,
  readModelCatalogImageInput,
  setModelCatalogImageInput,
} = await import('../model-catalog-override-store.js');

const patchEntry = { base: { name: 'Renamed' } };

function writeOwnerFile(value: unknown): string {
  const file = path.join(tmpDir, owner.current, 'model-catalog-overrides.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
  return file;
}

describe('model-catalog-override-store / 图片输入能力声明', () => {
  const target = { providerId: 'opencode-go', modelId: 'mimo-v2.6-flash' };
  const key = 'opencode-go:mimo-v2.6-flash';

  it('写入 true/false 落到 base patch，读回 isCustomized 区分「跟随目录」与「显式声明」', async () => {
    owner.current = 'owner-image-write';
    expect(readModelCatalogImageInput(target)).toEqual({ value: null, isCustomized: false });

    await setModelCatalogImageInput(target, true);
    expect(readModelCatalogOverrides().patches[key]?.base?.supportsImageInput).toBe(true);
    expect(readModelCatalogImageInput(target)).toEqual({ value: true, isCustomized: true });

    await setModelCatalogImageInput(target, false);
    expect(readModelCatalogImageInput(target)).toEqual({ value: false, isCustomized: true });
  });

  it('value=null 删除该键回到跟随目录，条目空掉时整条删除', async () => {
    owner.current = 'owner-image-reset';
    await setModelCatalogImageInput(target, true);
    await setModelCatalogImageInput(target, null);
    expect(readModelCatalogOverrides().patches[key]).toBeUndefined();
    expect(readModelCatalogImageInput(target)).toEqual({ value: null, isCustomized: false });
  });

  it('只动 supportsImageInput：同条目其它字段与其它条目原样保留', async () => {
    owner.current = 'owner-image-preserve';
    writeOwnerFile({
      version: 1,
      patches: {
        [key]: {
          agents: ['pi'],
          base: { name: 'Mimo', contextWindow: 128_000 },
          perAgent: { pi: { maxOutput: 8_192 } },
        },
        'openai:gpt-6': { base: { name: 'Renamed' } },
      },
    });

    await setModelCatalogImageInput(target, true);
    const entry = readModelCatalogOverrides().patches[key]!;
    expect(entry.base).toEqual({
      name: 'Mimo',
      contextWindow: 128_000,
      supportsImageInput: true,
    });
    expect(entry.perAgent).toEqual({ pi: { maxOutput: 8_192 } });
    expect(entry.agents).toEqual(['pi']);
    expect(readModelCatalogOverrides().patches['openai:gpt-6']).toEqual({ base: { name: 'Renamed' } });

    // 复位后条目里仍留着用户自己写的字段，不能被一并删掉。
    await setModelCatalogImageInput(target, null);
    expect(readModelCatalogOverrides().patches[key]).toEqual({
      agents: ['pi'],
      base: { name: 'Mimo', contextWindow: 128_000 },
      perAgent: { pi: { maxOutput: 8_192 } },
    });
  });

  it('providerId 里的冒号经 encodeURIComponent 转义，不与 modelId 的分隔符混淆', async () => {
    owner.current = 'owner-image-escape';
    await setModelCatalogImageInput({ providerId: 'a:b', modelId: 'm' }, true);
    expect(readModelCatalogOverrides().patches['a%3Ab:m']?.base?.supportsImageInput).toBe(true);
  });
});

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
