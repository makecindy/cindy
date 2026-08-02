/**
 * model-catalog-override-store.test.ts —— 本地目录 override 存储:
 * owner 切换换文件不泄漏、坏条目隔离整文件不失效、手改文件 mtime 生效、typed 写入口。
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

const { readModelCatalogOverrides, writeModelCatalogOverrideEntry } = await import(
  '../model-catalog-override-store.js'
);

const patchEntry = { base: { name: 'Renamed' } };

describe('model-catalog-override-store', () => {
  it('typed 写入口写盘可读回;entry=null 删除', () => {
    writeModelCatalogOverrideEntry('patches', 'openai:gpt-6', patchEntry);
    expect(readModelCatalogOverrides().patches['openai:gpt-6']).toEqual(patchEntry);
    writeModelCatalogOverrideEntry('patches', 'openai:gpt-6', null);
    expect(readModelCatalogOverrides().patches).toEqual({});
  });

  it('owner 切换后读到的是新 owner 的文件,旧 owner 数据不泄漏;切回后原样恢复', () => {
    owner.current = 'owner-a';
    writeModelCatalogOverrideEntry('patches', 'openai:gpt-6', patchEntry);
    owner.current = 'owner-b';
    expect(readModelCatalogOverrides().patches).toEqual({});
    writeModelCatalogOverrideEntry('additions', 'xai:xai/local-b', {
      agents: ['codex'],
      base: { name: 'B Only', contextWindow: 1_000, efforts: [], defaultEffort: null },
    });
    owner.current = 'owner-a';
    const backToA = readModelCatalogOverrides();
    expect(backToA.patches['openai:gpt-6']).toEqual(patchEntry);
    expect(backToA.additions).toEqual({});
  });

  it('手改文件:坏条目隔离、好条目生效;mtime 变化即现读', () => {
    owner.current = 'owner-c';
    const file = path.join(tmpDir, 'owner-c', 'model-catalog-overrides.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        patches: {
          'openai:gpt-6': { base: { name: 'Hand Edited' } },
          'xd:fake': { base: { name: 'Nope' } },
          'openai:bad': { base: { status: 'retired' } },
        },
      }),
      'utf8',
    );
    const read = readModelCatalogOverrides();
    expect(Object.keys(read.patches)).toEqual(['openai:gpt-6']);
    expect(read.patches['openai:gpt-6']).toEqual({ base: { name: 'Hand Edited' } });
  });
});
