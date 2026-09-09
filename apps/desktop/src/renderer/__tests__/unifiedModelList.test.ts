// @vitest-environment jsdom

/**
 * UnifiedModelList 纯逻辑单测:并集构建、按 Agent 计数与分歧判定。
 * 可见性 override 走真实 modelVisibilityPrefs(localStorage 由 jsdom 提供,用例间重置)。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildUnionRows,
  hasPaymentRequiredDisabledRow,
  isCapabilityRow,
  isRowDisabled,
  isRowPaymentRequired,
  loadCollapsedMap,
  modelVisibilityTargets,
} from '@/components/settings/UnifiedModelList';
import { __resetForTest, setModelVisibilityOwner } from '@/state/modelVisibilityPrefs';

import type { CatalogModel, ProviderView } from '@cindy/model-providers';

function model(id: string, contextWindow = 100_000): CatalogModel {
  return { id, name: id, contextWindow, efforts: [], defaultEffort: null } as CatalogModel;
}

const provider = {
  id: 'p1',
  name: 'P1',
  source: 'user',
  agents: ['claude-code', 'codex'],
  auth: { method: 'api-key' },
  routing: {},
  models: {
    'claude-code': [model('shared'), model('cc-only')],
    codex: [model('shared', 272_000), model('codex-only')],
  },
  connected: true,
} as unknown as ProviderView;

beforeEach(() => {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      maker: {
        claimLegacyModelVisibilityOwner: () => ({
          dataOwnerId: 'test-owner',
          ownerGeneration: 1,
          canWriteOwnerScoped: true,
          claimed: true,
          claimedByOtherOwner: false,
          canInitialize: true,
        }),
        syncModelVisibility: async () => undefined,
      },
    },
  });
  setModelVisibilityOwner('test-owner', 1, 'cloud');
});

afterEach(() => {
  __resetForTest();
});

describe('buildUnionRows', () => {
  it('同 id 跨 agent 合并;行序 = 首 agent 目录序 + 后续 agent 独占追加', () => {
    const rows = buildUnionRows(provider);
    expect(rows.map((r) => r.id)).toEqual(['shared', 'cc-only', 'codex-only']);
    const shared = rows[0];
    expect(shared.avail).toEqual(['claude-code', 'codex']);
    // 各 agent 目录条目独立保留(同名模型元数据可不同:cc 100K / codex 272K)。
    expect(shared.byAgent['claude-code']?.contextWindow).toBe(100_000);
    expect(shared.byAgent.codex?.contextWindow).toBe(272_000);
    expect(rows[1].avail).toEqual(['claude-code']);
    expect(rows[2].avail).toEqual(['codex']);
  });

  it('三 Agent 同模型合并为一行并保留独立 PI 开关维度', () => {
    const threeAgent = {
      ...provider,
      agents: ['claude-code', 'codex', 'pi'],
      models: {
        ...provider.models,
        pi: [model('shared', 500_000), model('pi-only')],
      },
    } as ProviderView;
    const rows = buildUnionRows(threeAgent);
    expect(rows.find((row) => row.id === 'shared')?.avail).toEqual(['claude-code', 'codex', 'pi']);
    expect(
      modelVisibilityTargets(
        threeAgent,
        rows.find((row) => row.id === 'shared')!,
        false,
      ).map((target) => target.agent),
    ).toEqual(['claude-code', 'codex', 'pi']);
  });
});

describe('buildUnionRows — 桥接命名空间归一', () => {
  it('routing.modelPrefixes 声明的前缀剥掉后合并为一行,byAgent 保留各端真实 id', () => {
    // OpenAI 形态:codex 原生 gpt-5.5,cc 经 responses-bridge 投影为 chatgpt/gpt-5.5。
    const bridged = {
      id: 'openai',
      name: 'OpenAI',
      source: 'builtin',
      agents: ['claude-code', 'codex'],
      auth: { method: 'oauth' },
      routing: { 'claude-code': { upstream: 'https://x', modelPrefixes: ['chatgpt/'] } },
      models: {
        'claude-code': [model('chatgpt/gpt-5.5')],
        codex: [model('gpt-5.5', 272_000)],
      },
      connected: true,
    } as unknown as ProviderView;
    const rows = buildUnionRows(bridged);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('gpt-5.5');
    expect(rows[0].avail).toEqual(['claude-code', 'codex']);
    // 写开关必须用各端真实 id:cc 端仍是带前缀的目录 id。
    expect(rows[0].byAgent['claude-code']?.id).toBe('chatgpt/gpt-5.5');
    expect(rows[0].byAgent.codex?.id).toBe('gpt-5.5');
  });
});

describe('停用轴(isRowDisabled / isCapabilityRow)', () => {
  it('任一端条目带 disabled 标志即视为停用行(单一写入口两端一起写)', () => {
    const withDisabled = {
      ...provider,
      models: {
        'claude-code': [{ ...model('shared'), disabled: true }, model('cc-only')],
        codex: [model('shared', 272_000), model('codex-only')],
      },
    } as ProviderView;
    const rows = buildUnionRows(withDisabled);
    expect(isRowDisabled(rows[0])).toBe(true);
    expect(isRowDisabled(rows[1])).toBe(false);
  });

  it('付费锁定的停用行阻止整组 reset，避免批量入口改写其历史 override', () => {
    const withLockedDisabled = {
      ...provider,
      models: {
        ...provider.models,
        codex: [
          ...(provider.models.codex ?? []),
          { ...model('paid-disabled'), availability: 'requires_payment', disabled: true },
        ],
      },
    } as ProviderView;
    const rows = buildUnionRows(withLockedDisabled);

    expect(hasPaymentRequiredDisabledRow(rows)).toBe(true);
    expect(
      hasPaymentRequiredDisabledRow(rows, (row) =>
        row.id === 'paid-disabled' ? false : isRowDisabled(row),
      ),
    ).toBe(false);
  });

  it('专属媒体清单(imageModels/videoModels)合成能力行:可停用、与 agent 清单同 id 去重', () => {
    const withMedia = {
      ...provider,
      imageModels: [
        {
          id: 'gpt-image-2',
          name: 'GPT Image 2',
          modalities: { input: ['text', 'image'], output: ['image'] },
          disabled: true,
          availability: 'requires_payment',
        },
        { id: 'shared', name: '与 agent 清单撞 id(应被去重)' },
      ],
      videoModels: [{ id: 'seedance-fast', name: 'Seedance 快速' }],
    } as ProviderView;
    const rows = buildUnionRows(withMedia);
    const image = rows.find((r) => r.id === 'gpt-image-2')!;
    expect(isCapabilityRow(image, false)).toBe(true);
    expect(image.byAgent['claude-code']?.mode).toBe('image_generation');
    expect(image.byAgent['claude-code']?.modalities).toEqual({
      input: ['text', 'image'],
      output: ['image'],
    });
    expect(isRowDisabled(image)).toBe(true);
    expect(isRowPaymentRequired(image)).toBe(true);
    expect(rows.find((r) => r.id === 'seedance-fast')).toBeTruthy();
    // 同 id 去重:'shared' 只保留 agent 清单那行(可见性开关照常)。
    expect(rows.filter((r) => r.id === 'shared')).toHaveLength(1);
    expect(
      isCapabilityRow(
        rows.find((r) => r.id === 'shared')!,
        false,
      ),
    ).toBe(false);
  });

  it('向量清单也合成能力行,可停用(否则停用轴有实现无入口)', () => {
    // 派生侧(deriveCindyMediaConfig)一直按 isModelDisabled 过滤向量型号,但设置页
    // 此前只为 image/video 合成行 —— 用户没法单独拦住某个向量型号的付费调用,只能
    // 整家停用 XD(PR #1707 review)。
    const withEmbedding = {
      ...provider,
      embeddingModels: [
        { id: 'voyage/voyage-4', name: 'Voyage 4' },
        { id: 'voyage/voyage-4-large', name: 'Voyage 4 Large', disabled: true },
      ],
    } as ProviderView;
    const rows = buildUnionRows(withEmbedding);
    const v4 = rows.find((r) => r.id === 'voyage/voyage-4')!;
    expect(isCapabilityRow(v4, false)).toBe(true);
    expect(isRowDisabled(v4)).toBe(false);
    const large = rows.find((r) => r.id === 'voyage/voyage-4-large')!;
    expect(isRowDisabled(large)).toBe(true);
  });

  it('能力模型行按分组判定(image → 能力行;对话厂商/兜底分组 → 否)', () => {
    const withImage = {
      ...provider,
      models: {
        ...provider.models,
        codex: [...(provider.models.codex ?? []), model('gpt-image-2')],
      },
    } as ProviderView;
    const rows = buildUnionRows(withImage);
    expect(
      isCapabilityRow(
        rows.find((r) => r.id === 'gpt-image-2')!,
        false,
      ),
    ).toBe(true);
    expect(
      isCapabilityRow(
        rows.find((r) => r.id === 'shared')!,
        false,
      ),
    ).toBe(false);
  });
});

describe('折叠态 v1/v2 → v3 迁移(other 恢复旧语义,新增 ungrouped)', () => {
  const V1 = 'xdt:modelListCollapsedGroups:v1';
  const V2 = 'xdt:modelListCollapsedGroups:v2';
  const V3 = 'xdt:modelListCollapsedGroups:v3';

  afterEach(() => {
    window.localStorage.removeItem(V1);
    window.localStorage.removeItem(V2);
    window.localStorage.removeItem(V3);
  });

  it('v2 的 non-chat 恢复成 other,旧 other 搬到 ungrouped,其余分组原样保留', () => {
    window.localStorage.setItem(
      V2,
      JSON.stringify({ 'non-chat': true, other: false, image: false, china: true }),
    );
    expect(loadCollapsedMap()).toEqual({
      other: true,
      ungrouped: false,
      image: false,
      china: true,
    });
  });

  it('v1 的 other 保留旧语义,不搬到 ungrouped', () => {
    window.localStorage.setItem(V1, JSON.stringify({ other: true, embedding: false }));
    expect(loadCollapsedMap()).toEqual({ other: true, embedding: false });
  });

  it('v2 已存在时优先迁移 v2,不再回读 v1', () => {
    window.localStorage.setItem(V1, JSON.stringify({ other: true }));
    window.localStorage.setItem(V2, JSON.stringify({ image: true }));
    expect(loadCollapsedMap()).toEqual({ image: true });
  });

  it('v3 已存在时直接使用,不再回读旧版本', () => {
    window.localStorage.setItem(V1, JSON.stringify({ other: true }));
    window.localStorage.setItem(V2, JSON.stringify({ other: true }));
    window.localStorage.setItem(V3, JSON.stringify({ ungrouped: true }));
    expect(loadCollapsedMap()).toEqual({ ungrouped: true });
  });

  it('三代都没有 → 空表(全部跟随默认)', () => {
    expect(loadCollapsedMap()).toEqual({});
  });
});

it('ordinary toggles preserve opt-in compatibility and can still enable hidden native models', () => {
  const native = { ...model('gpt-6'), defaultEnabled: true };
  const bridge = { ...model('chatgpt/gpt-6'), defaultEnabled: false };
  const row = {
    id: 'gpt-6',
    name: 'GPT-6',
    avail: ['codex', 'claude-code'] as const,
    byAgent: { codex: native, 'claude-code': bridge },
  };
  const mutableRow = { ...row, avail: [...row.avail] };
  expect(modelVisibilityTargets({ ...provider, id: 'openai' }, mutableRow, true)).toEqual([
    { agent: 'codex', modelId: 'gpt-6' },
  ]);
  expect(modelVisibilityTargets({ ...provider, id: 'openai' }, mutableRow, false)).toHaveLength(2);
  native.defaultEnabled = false;
  expect(modelVisibilityTargets({ ...provider, id: 'openai' }, mutableRow, true)).toEqual([
    { agent: 'codex', modelId: 'gpt-6' },
  ]);
});
