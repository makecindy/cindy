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

import { MAX_OVERRIDE_ENTRIES_PER_SECTION } from '../model-plane/localCatalogOverrides.js';

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

const {
  MAX_MODEL_CATALOG_OVERRIDE_FILE_BYTES,
  ModelCatalogOverrideLossError,
  modelCatalogOverridePortableSettings,
  readModelCatalogOverrides,
  readModelCatalogImageInput,
  setModelCatalogImageInput,
  readModelCatalogThinkingDivergence,
  readModelImageInputOverride,
  writeModelImageInputOverride,
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

  it('条目限定了 agents 时把目标引擎并进名单，让声明真正生效', async () => {
    // 目录合并按 agents 过滤，读回却不检查 —— 不并进 pi 就会「显示已声明、运行期不生效」。
    owner.current = 'owner-image-agents';
    writeOwnerFile({
      version: 1,
      patches: { [key]: { agents: ['codex'], base: { name: 'Mimo' } } },
    });

    await setModelCatalogImageInput({ ...target, agent: 'pi' }, true);
    expect(readModelCatalogOverrides().patches[key]?.agents).toEqual(['codex', 'pi']);
  });

  it('已有条目无 agents 限制时不加名单', async () => {
    owner.current = 'owner-image-no-agents';
    writeOwnerFile({ version: 1, patches: { [key]: { base: { name: 'Mimo' } } } });

    await setModelCatalogImageInput({ ...target, agent: 'pi' }, true);
    expect(readModelCatalogOverrides().patches[key]?.agents).toBeUndefined();
  });

  it('写入后条目数超上限时拒绝保存，不留下会被下次读取丢弃的条目', async () => {
    owner.current = 'owner-image-limit';
    const full: Record<string, unknown> = {};
    for (let i = 0; i < MAX_OVERRIDE_ENTRIES_PER_SECTION; i++) full[`p:model-${i}`] = { base: {} };
    writeOwnerFile({ version: 1, patches: full });

    await expect(
      setModelCatalogImageInput({ providerId: 'p', modelId: 'one-more' }, true),
    ).rejects.toThrow(/上限/);
    // 文件没被改动：原有 1024 条仍完整
    expect(Object.keys(readModelCatalogOverrides().patches)).toHaveLength(
      MAX_OVERRIDE_ENTRIES_PER_SECTION,
    );
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

  it('一行多个引擎 id 一起写（桥接两端 id 不同，只写一边运行期读不到）', async () => {
    owner.current = 'owner-image-row';
    await setModelCatalogImageInput(
      [
        { providerId: 'openai', modelId: 'gpt-5.6-sol' },
        { providerId: 'openai', modelId: 'chatgpt/gpt-5.6-sol' },
      ],
      true,
    );
    const patches = readModelCatalogOverrides().patches;
    expect(patches['openai:gpt-5.6-sol']?.base?.supportsImageInput).toBe(true);
    expect(patches['openai:chatgpt/gpt-5.6-sol']?.base?.supportsImageInput).toBe(true);
  });

  it('清掉 perAgent 里残留的 supportsImageInput，并让读取按 agent 算有效值', async () => {
    // perAgent 会遮蔽 base：不清的话 UI（读 base）显示已声明、运行期（按合并语义）仍拒收。
    owner.current = 'owner-image-peragent';
    writeOwnerFile({
      version: 1,
      patches: {
        [key]: { agents: ['pi'], perAgent: { pi: { supportsImageInput: false } } },
      },
    });
    // 未写入前：读 pi 的有效值仍是显式声明（不假装「跟随目录」）。
    expect(readModelCatalogImageInput({ ...target, agent: 'pi' })).toEqual({
      value: false,
      isCustomized: true,
    });

    await setModelCatalogImageInput({ ...target, agent: 'pi' }, true);
    expect(readModelCatalogOverrides().patches[key]?.perAgent).toBeUndefined();
    expect(readModelCatalogImageInput({ ...target, agent: 'pi' })).toEqual({
      value: true,
      isCustomized: true,
    });
  });

  it('手改文件里会被 sanitize 丢弃的 patches 条目：拒绝写入而不是静默删掉', async () => {
    owner.current = 'owner-image-lossy';
    writeOwnerFile({
      version: 1,
      patches: {
        // 未知字段 → 整条被 sanitize 隔离；写盘会把 patches 整段换成清洗后的快照。
        'openai:typo-model': { base: { name: 'Typo', unknownField: 1 } },
      },
    });

    await expect(setModelCatalogImageInput(target, true)).rejects.toThrow(/无法保留/);
    // 独立错误类型让 IPC 层能把它映射成可执行的 PRECONDITION_FAILED（而不是笼统的 INTERNAL）。
    await expect(setModelCatalogImageInput(target, true)).rejects.toBeInstanceOf(
      ModelCatalogOverrideLossError,
    );
    // 文件没被动过：那条手改还在（修好后下一次写入自动恢复）。
    const raw = JSON.parse(
      fs.readFileSync(path.join(tmpDir, owner.current, 'model-catalog-overrides.json'), 'utf8'),
    ) as { patches: Record<string, unknown> };
    expect(raw.patches['openai:typo-model']).toEqual({
      base: { name: 'Typo', unknownField: 1 },
    });
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

  it('readModelCatalogThinkingDivergence 把「同集合不同默认档」报成分叉', () => {
    // 手改文件留下的分裂：两侧档位集合相同、默认档不同。diverged 不置位的话，
    // 抽屉的「重选当前项」会被同值 no-op 挡掉，默认档的分叉永远修不掉。
    owner.current = 'owner-thinking-diverged-default';
    writeOwnerFile({
      version: 1,
      patches: {
        'prov:model': {
          agents: ['pi', 'codex'],
          perAgent: {
            pi: { efforts: ['low', 'max'], defaultEffort: 'low' },
            codex: { efforts: ['low', 'max'], defaultEffort: 'max' },
          },
        },
      },
    });
    expect(
      readModelCatalogThinkingDivergence([
        { providerId: 'prov', modelId: 'model', agent: 'pi' },
        { providerId: 'prov', modelId: 'model', agent: 'codex' },
      ]),
    ).toEqual({ diverged: true });

    // 默认档一致时不算分叉（集合相同 + 默认档相同）。
    owner.current = 'owner-thinking-consistent';
    writeOwnerFile({
      version: 1,
      patches: {
        'prov:model': {
          agents: ['pi', 'codex'],
          perAgent: {
            pi: { efforts: ['low', 'max'], defaultEffort: 'low' },
            codex: { efforts: ['low', 'max'], defaultEffort: 'low' },
          },
        },
      },
    });
    expect(
      readModelCatalogThinkingDivergence([
        { providerId: 'prov', modelId: 'model', agent: 'pi' },
        { providerId: 'prov', modelId: 'model', agent: 'codex' },
      ]),
    ).toEqual({ diverged: false });
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

// Unit, new-computer setup (docs/product-rules/new-device-setup-migration.md): this store's own merge
// rule used to keep only `patches`, so a migrated section reported success but was never written.
// Minimal input: one addition from the other computer, one patch already changed here.
describe('new-computer setup', () => {
  it('writes a section this computer has not changed and keeps the ones it has', async () => {
    owner.current = 'setup-migration';
    const file = writeOwnerFile({ version: 1, patches: { 'openai:gpt-6': patchEntry } });
    const additions = { 'xai:xai/local-b': { agents: ['codex'], base: { name: 'B', contextWindow: 1_000, efforts: [], defaultEffort: null } } };
    await expect(modelCatalogOverridePortableSettings.applyPatch(() => ({ additions }))).resolves.toBe(true);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({ additions, patches: { 'openai:gpt-6': patchEntry } });
  });
});
