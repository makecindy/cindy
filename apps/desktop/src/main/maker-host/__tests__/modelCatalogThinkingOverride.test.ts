/**
 * model-catalog-override-store 的思考档位声明面 —— 与图片输入声明同构：
 * 三态（跟随 / 自定义档位 / 复位）、只动自己那两个字段、perAgent 残留遮蔽要清掉、
 * 非法组合在写入面就拒。
 *
 * 为什么这条面必须存在：目录把「会推理」的模型声明成不支持思考时，Pi 客户端就没有
 * thinking 通道（`piThinkingLevels.mjs`：`reasoning !== true` → 零档位），模型推理只能随
 * content 返回、被 Cindy 当普通 assistant 正文渲染。用户此前没有任何入口能声明这件事。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { Effort } from '@cindy/model-providers';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-catalog-thinking-test-'));
const owner = { current: 'owner-a' };

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/never-used-here' } }));
vi.mock('../logger-adapter.js', () => ({
  desktopMakerLogger: { child: () => ({ info: () => {}, warn: () => {}, error: () => {} }) },
}));
vi.mock('../../appSessionState.js', () => ({
  ownerScopedUserDataPath: (name: string) => path.join(tmpDir, owner.current, name),
}));

const {
  readModelCatalogOverrides,
  readModelCatalogThinking,
  readModelCatalogThinkingDivergence,
  setModelCatalogThinking,
} = await import('../model-catalog-override-store.js');

const target = { providerId: 'opencode-go', modelId: 'space-bunny-free' };
const key = 'opencode-go:space-bunny-free';
/** 厂商模型卡：5 档、默认 max、强制推理。 */
const TIERS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

function writeOwnerFile(value: unknown): void {
  const file = path.join(tmpDir, owner.current, 'model-catalog-overrides.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
}

describe('model-catalog-override-store / 思考档位声明', () => {
  it('写入落到 base patch，读回 isCustomized 区分「跟随目录」与「显式声明」', async () => {
    owner.current = 'owner-thinking-write';
    // 未声明时读回不带 defaultEffort 键（没有声明就没有默认档可言）。
    expect(readModelCatalogThinking(target)).toEqual({ value: null, isCustomized: false });

    await setModelCatalogThinking(target, [...TIERS], 'max');
    expect(readModelCatalogOverrides().patches[key]?.base).toEqual({
      efforts: [...TIERS],
      defaultEffort: 'max',
    });
    // 读回带上默认档：写入侧靠它沿用既有默认，而不是猜「排序第一档」。
    expect(readModelCatalogThinking(target)).toEqual({
      value: [...TIERS],
      defaultEffort: 'max',
      isCustomized: true,
    });

    // 换一组档位 = 数组整体替换，不与旧值合并。
    await setModelCatalogThinking(target, ['low', 'high'], 'high');
    expect(readModelCatalogOverrides().patches[key]?.base?.efforts).toEqual(['low', 'high']);
  });

  it('tiers=null 删除该键回到跟随目录；条目空掉时整条删除', async () => {
    owner.current = 'owner-thinking-reset';
    await setModelCatalogThinking(target, [...TIERS], 'max');
    await setModelCatalogThinking(target, null);
    expect(readModelCatalogOverrides().patches[key]).toBeUndefined();
    // 未声明时读回不带 defaultEffort 键（没有声明就没有默认档可言）。
    expect(readModelCatalogThinking(target)).toEqual({ value: null, isCustomized: false });
  });

  it('只动 efforts/defaultEffort：同条目其它字段与其它条目原样保留', async () => {
    owner.current = 'owner-thinking-preserve';
    writeOwnerFile({
      version: 1,
      patches: {
        [key]: {
          agents: ['pi'],
          base: { name: 'Space Bunny', contextWindow: 1_000_000 },
          perAgent: { pi: { maxOutput: 8_192 } },
        },
        'openai:gpt-6': { base: { name: 'Renamed' } },
      },
    });

    await setModelCatalogThinking(target, [...TIERS], 'max');
    const entry = readModelCatalogOverrides().patches[key]!;
    expect(entry.base).toEqual({
      name: 'Space Bunny',
      contextWindow: 1_000_000,
      efforts: [...TIERS],
      defaultEffort: 'max',
    });
    expect(entry.perAgent).toEqual({ pi: { maxOutput: 8_192 } });
    expect(entry.agents).toEqual(['pi']);
    expect(readModelCatalogOverrides().patches['openai:gpt-6']).toEqual({ base: { name: 'Renamed' } });

    // 复位后条目里仍留着用户自己写的字段，不能被一并删掉。
    await setModelCatalogThinking(target, null);
    expect(readModelCatalogOverrides().patches[key]).toEqual({
      agents: ['pi'],
      base: { name: 'Space Bunny', contextWindow: 1_000_000 },
      perAgent: { pi: { maxOutput: 8_192 } },
    });
  });

  it('perAgent 里残留的 efforts 会遮蔽 base（UI 显示与运行期不一致），写入时一并清掉', async () => {
    owner.current = 'owner-thinking-peragent';
    writeOwnerFile({
      version: 1,
      patches: {
        [key]: {
          perAgent: { pi: { efforts: ['low'], defaultEffort: 'low' } },
        },
      },
    });

    await setModelCatalogThinking(target, [...TIERS], 'max');
    const entry = readModelCatalogOverrides().patches[key]!;
    // base 有值、perAgent 被清空 → 读回不再被遮蔽。
    expect(entry.base?.efforts).toEqual([...TIERS]);
    expect(entry.perAgent).toBeUndefined();
    expect(readModelCatalogThinking({ ...target, agent: 'pi' }).value).toEqual([...TIERS]);
  });

  it('按 agent 读回时合成 perAgent 引擎例外（base + perAgent[agent]）', async () => {
    owner.current = 'owner-thinking-agent-merge';
    writeOwnerFile({
      version: 1,
      patches: {
        [key]: {
          base: { efforts: [...TIERS], defaultEffort: 'max' },
          perAgent: { codex: { efforts: ['low', 'high'], defaultEffort: 'high' } },
        },
      },
    });

    expect(readModelCatalogThinking({ ...target, agent: 'pi' }).value).toEqual([...TIERS]);
    expect(readModelCatalogThinking({ ...target, agent: 'codex' }).value).toEqual(['low', 'high']);
  });

  it('多引擎 id 分叉可被检出，交给 UI 允许「重选当前项」写回一致', async () => {
    owner.current = 'owner-thinking-diverge';
    const piTarget = { providerId: 'openai', agent: 'pi' as const, modelId: 'chatgpt/gpt-5.6-sol' };
    const codexTarget = { providerId: 'openai', agent: 'codex' as const, modelId: 'gpt-5.6-sol' };

    await setModelCatalogThinking(piTarget, [...TIERS], 'max');
    expect(readModelCatalogThinkingDivergence([piTarget, codexTarget]).diverged).toBe(true);

    await setModelCatalogThinking(codexTarget, [...TIERS], 'max');
    expect(readModelCatalogThinkingDivergence([piTarget, codexTarget]).diverged).toBe(false);
  });

  it('空数组 = 显式「不支持思考」必须能存下来（三态的第三态）', async () => {
    owner.current = 'owner-thinking-explicit-off';
    // sanitize 明确支持 efforts: [] 配 defaultEffort: null；写入面不能把它当非法输入。
    await setModelCatalogThinking(target, [], null);
    // 空集合必须显式带 defaultEffort: null：sanitize 的自洽校验要求「空集合 ⇒ 无默认档」。
    expect(readModelCatalogOverrides().patches[key]?.base).toEqual({ efforts: [], defaultEffort: null });
    expect(readModelCatalogThinking(target)).toMatchObject({ value: [], isCustomized: true });

    // 复位回「跟随目录」后条目整条删除。
    await setModelCatalogThinking(target, null);
    expect(readModelCatalogOverrides().patches[key]).toBeUndefined();
  });

  it('读回带上默认档，写入侧才能不猜（否则会把厂商默认静默改成排序第一档）', async () => {
    owner.current = 'owner-thinking-default-echo';
    await setModelCatalogThinking(target, [...TIERS], 'max');
    // 厂商默认是 max，读回必须原样带回，UI 才能沿用而不是猜 low。
    expect(readModelCatalogThinking(target)).toMatchObject({
      value: [...TIERS],
      defaultEffort: 'max',
    });
  });

  it('含 ultra 的声明不会被后续写入静默删掉', async () => {
    owner.current = 'owner-thinking-ultra';
    const withUltra: Effort[] = [...TIERS, 'ultra'];
    await setModelCatalogThinking(target, withUltra, 'max');
    // 换成不含 ultra 的集合是用户的显式选择，应当照做。
    await setModelCatalogThinking(target, ['low', 'high'], 'low');
    expect(readModelCatalogThinking(target).value).toEqual(['low', 'high']);
    // 但仅声明默认档、集合不变时，ultra 必须原样留着。
    await setModelCatalogThinking(target, withUltra, 'max');
    expect(readModelCatalogThinking(target).value).toContain('ultra');
  });

  it('分叉判定按内容比较：两侧声明完全一致不算分叉', async () => {
    owner.current = 'owner-thinking-div-content';
    const piTarget = { providerId: 'openai', agent: 'pi' as const, modelId: 'chatgpt/gpt-5.6-sol' };
    const codexTarget = { providerId: 'openai', agent: 'codex' as const, modelId: 'gpt-5.6-sol' };
    // 两个不同 key 各写一次、内容相同：每次读盘都是新数组，引用比较会永远误判分叉。
    await setModelCatalogThinking(piTarget, [...TIERS], 'max');
    await setModelCatalogThinking(codexTarget, [...TIERS], 'max');
    expect(readModelCatalogThinkingDivergence([piTarget, codexTarget]).diverged).toBe(false);
  });

  it('写入面就拒掉不自洽的档位组合，不让 sanitize 事后把整条判无效', async () => {
    owner.current = 'owner-thinking-invalid';
    // 默认档不在档位集合里。
    await expect(
      setModelCatalogThinking(target, ['low', 'high'], 'max'),
    ).rejects.toThrow(/not in the declared tiers/);
    // 空档位集合却带默认档。
    await expect(setModelCatalogThinking(target, [], 'max')).rejects.toThrow(/cannot be empty/);
    // 失败的写入不得留下任何痕迹。
    expect(readModelCatalogOverrides().patches[key]).toBeUndefined();
  });
});
