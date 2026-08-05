/**
 * textOneshotPinOptions.test.ts — 快问快答目录钉的编码、清单构建与声明解析。
 */

import { describe, expect, it } from 'vitest';
import type { Catalog, CatalogModel, Provider } from '@cindy/model-providers';

import {
  buildTextOneshotPinOptions,
  decodeCatalogPin,
  encodeCatalogPin,
  resolveOneshotCatalogModel,
} from '../textOneshotPinOptions';

function chat(id: string, extra: Partial<CatalogModel> = {}): CatalogModel {
  return { id, name: id, contextWindow: 200_000, ...extra } as CatalogModel;
}

function provider(over: Partial<Provider> & { id: string }): Provider {
  return {
    name: over.id,
    source: 'builtin',
    agents: ['codex', 'claude-code'],
    auth: { method: 'api-key' },
    routing: {
      codex: { upstream: 'https://up.example.com', authStrategy: 'api-key-header' },
      'claude-code': { upstream: 'https://up.example.com', authStrategy: 'api-key-header' },
    },
    models: { codex: [], 'claude-code': [] },
    ...over,
  } as Provider;
}

function catalogOf(...providers: Provider[]): Catalog {
  return { providers } as unknown as Catalog;
}

describe('encodeCatalogPin / decodeCatalogPin', () => {
  it('编码解码往返(model 可含 / 与 :)', () => {
    expect(decodeCatalogPin(encodeCatalogPin('xd', 'codex', 'codex/gpt-5.5'))).toEqual({
      providerId: 'xd',
      agentKind: 'codex',
      model: 'codex/gpt-5.5',
    });
    expect(decodeCatalogPin('cat:custom-1:claude-code:qwen3:8b')).toEqual({
      providerId: 'custom-1',
      agentKind: 'claude-code',
      model: 'qwen3:8b',
    });
  });

  it('非目录钉 / 残缺形态 / 不可路由 agent 一律 null', () => {
    for (const bad of [
      '',
      'litellm-kimi-k2.6',
      'cat:',
      'cat:xd',
      'cat:xd:codex',
      'cat::codex:m',
      'cat:xd::m',
      'cat:xd:pi:m',
      'cat:xd:codex:',
    ]) {
      expect(decodeCatalogPin(bad), bad).toBeNull();
    }
  });
});

describe('buildTextOneshotPinOptions', () => {
  it('遍历 供应商×agent×聊天模型,带渲染所需的结构化字段', () => {
    const options = buildTextOneshotPinOptions(
      catalogOf(
        provider({
          id: 'xd',
          name: 'Cindy Gateway',
          models: { codex: [chat('codex/gpt-5.5', { name: 'GPT 5.5 折扣' })] },
        }),
        provider({
          id: 'openai',
          name: 'OpenAI',
          agents: ['codex'],
          access: { kind: 'subscription', product: 'chatgpt' },
          routing: { codex: { upstream: 'https://api.example.com', authStrategy: 'oauth-token' } },
          models: { codex: [chat('gpt-5.5', { name: 'GPT 5.5' })] },
        }),
      ),
      undefined,
    );
    expect(options).toEqual([
      {
        id: 'cat:xd:codex:codex/gpt-5.5',
        label: 'GPT 5.5 折扣 · Cindy Gateway',
        group: 'Cindy Gateway',
        providerId: 'xd',
        agentKind: 'codex',
        modelId: 'codex/gpt-5.5',
        modelName: 'GPT 5.5 折扣',
        budget: true,
        subscription: false,
        routing: {
          codex: { upstream: 'https://up.example.com', authStrategy: 'api-key-header' },
          'claude-code': { upstream: 'https://up.example.com', authStrategy: 'api-key-header' },
        },
      },
      {
        id: 'cat:openai:codex:gpt-5.5',
        label: 'GPT 5.5 · OpenAI',
        group: 'OpenAI',
        providerId: 'openai',
        agentKind: 'codex',
        modelId: 'gpt-5.5',
        modelName: 'GPT 5.5',
        budget: false,
        subscription: true,
        routing: { codex: { upstream: 'https://api.example.com', authStrategy: 'oauth-token' } },
      },
    ]);
  });

  it('停用轴:供应商级与逐模型停用都过滤', () => {
    const options = buildTextOneshotPinOptions(
      catalogOf(
        provider({ id: 'xd', models: { codex: [chat('a'), chat('b')] } }),
        provider({ id: 'openai', agents: ['codex'], models: { codex: [chat('c')] } }),
      ),
      { disabledProviders: { openai: true }, disabledModels: { 'xd:a': true } },
    );
    expect(options.map((o) => o.id)).toEqual(['cat:xd:codex:b']);
  });

  it('非聊天模型(mode=embedding 等)过滤;mode 缺省与 responses 按聊天对待', () => {
    const options = buildTextOneshotPinOptions(
      catalogOf(
        provider({
          id: 'xd',
          models: {
            codex: [
              chat('embed-1', { mode: 'embedding' }),
              chat('plain-1'),
              chat('img-1', { mode: 'image_generation' }),
              chat('codex/gpt-5.5', { mode: 'responses' }),
            ],
          },
        }),
      ),
      undefined,
    );
    expect(options.map((o) => o.id)).toEqual(['cat:xd:codex:plain-1', 'cat:xd:codex:codex/gpt-5.5']);
  });

  it('pi-only 供应商与缺 routing 的 agent 不进清单', () => {
    const options = buildTextOneshotPinOptions(
      catalogOf(
        provider({ id: 'pi-prov', agents: ['pi'], models: { pi: [chat('pi-m')] as never } }),
        provider({
          id: 'half',
          agents: ['codex', 'claude-code'],
          routing: { codex: { upstream: 'https://up.example.com', authStrategy: 'api-key-header' } },
          models: { codex: [chat('m-codex')], 'claude-code': [chat('m-cc')] },
        }),
      ),
      undefined,
    );
    expect(options.map((o) => o.id)).toEqual(['cat:half:codex:m-codex']);
  });

  it('自定义供应商:routing 禁用 / 鉴权策略不支持 / 缺上游 → 排除;结构完整 → 收', () => {
    const custom = (id: string, routing: Provider['routing']) =>
      provider({ id, source: 'user', agents: ['codex'], routing, models: { codex: [chat(`${id}-m`)] } });
    const options = buildTextOneshotPinOptions(
      catalogOf(
        custom('ok-key', { codex: { upstream: 'https://up.example.com', authStrategy: 'api-key-header' } }),
        custom('ok-oauth', { codex: { upstream: 'https://up.example.com', authStrategy: 'oauth-token' } }),
        custom('bad-disabled', { codex: { upstream: 'https://up.example.com', authStrategy: 'api-key-header', disabled: true } }),
        custom('bad-auth', { codex: { upstream: 'https://up.example.com', authStrategy: 'bespoke' as never } }),
        custom('bad-upstream', { codex: { upstream: '', authStrategy: 'api-key-header' } }),
      ),
      undefined,
    );
    expect(options.map((o) => o.id)).toEqual(['cat:ok-key:codex:ok-key-m', 'cat:ok-oauth:codex:ok-oauth-m']);
  });

  it('同供应商同模型跨 agent 重复:两边都补 agent 后缀', () => {
    const options = buildTextOneshotPinOptions(
      catalogOf(
        provider({
          id: 'xd',
          name: 'GW',
          models: { codex: [chat('gpt-5.5', { name: 'GPT 5.5' })], 'claude-code': [chat('gpt-5.5', { name: 'GPT 5.5' })] },
        }),
      ),
      undefined,
    );
    expect(options.map((o) => o.label)).toEqual(['GPT 5.5 · GW · Codex', 'GPT 5.5 · GW · Claude Code']);
  });
});

describe('resolveOneshotCatalogModel', () => {
  it('命中即返回,codex 先于 claude-code;停用条目跳过', () => {
    const catalog = catalogOf(
      provider({
        id: 'xd',
        models: { codex: [chat('codex/gpt-5.5')], 'claude-code': [chat('codex/gpt-5.5')] },
      }),
      provider({ id: 'openai', agents: ['codex'], models: { codex: [chat('codex/gpt-5.5')] } }),
    );
    expect(resolveOneshotCatalogModel(catalog, undefined, 'codex/gpt-5.5')).toEqual({
      providerId: 'xd',
      agentKind: 'codex',
      model: 'codex/gpt-5.5',
    });
    // 停用是 (供应商,模型) 粒度:xd 的该模型在两个 agent 下同灭,落到下一供应商。
    expect(
      resolveOneshotCatalogModel(catalog, { disabledModels: { 'xd:codex/gpt-5.5': true } }, 'codex/gpt-5.5'),
    ).toEqual({ providerId: 'openai', agentKind: 'codex', model: 'codex/gpt-5.5' });
  });

  it('目录没有 / 空白声明 / 供应商整体停用 → null(按未声明处理)', () => {
    const catalog = catalogOf(provider({ id: 'xd', models: { codex: [chat('a')] } }));
    expect(resolveOneshotCatalogModel(catalog, undefined, 'no-such-model')).toBeNull();
    expect(resolveOneshotCatalogModel(catalog, undefined, '   ')).toBeNull();
    expect(resolveOneshotCatalogModel(catalog, { disabledProviders: { xd: true } }, 'a')).toBeNull();
  });
});
