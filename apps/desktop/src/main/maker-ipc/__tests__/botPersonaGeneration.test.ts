import { describe, expect, it, vi } from 'vitest';

import type { ProviderView } from '@cindy/model-providers';

import { generateBotPersonaDraft, type BotPersonaGenerationDeps } from '../botPersonaGeneration';

const DRAFT_JSON = JSON.stringify({
  name: '阿橘',
  description: '你的设计搭子',
  skill: '视觉设计',
  identity: '你是阿橘，设计搭子。界面、配图、走查都归你。',
  style: 'lively',
  proactivity: 'proactive',
  call: 'name',
  avatarPreset: 'whitecat',
  avatarHue: 'amber',
  memories: [{ title: '先给三版', description: '不一上来就定稿', body: '每次先出三版。' }],
});

const provider = { id: 'anthropic' } as unknown as ProviderView;

function deps(overrides: Partial<BotPersonaGenerationDeps> = {}): BotPersonaGenerationDeps {
  return {
    listConnectedProviders: async () => [provider],
    runOneShot: async () => ({ status: 'ok', title: DRAFT_JSON }),
    readLocale: () => 'zh-CN',
    ...overrides,
  };
}

describe('generateBotPersonaDraft', () => {
  it('turns one line into a draft', async () => {
    const result = await generateBotPersonaDraft('设计师', deps());
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error('unreachable');
    expect(result.draft.name).toBe('阿橘');
    expect(result.draft.memories).toHaveLength(1);
  });

  it('does not send a request for an empty role', async () => {
    const runOneShot = vi.fn();
    expect(await generateBotPersonaDraft('   ', deps({ runOneShot }))).toEqual({
      ok: false,
      code: 'empty-input',
    });
    expect(runOneShot).not.toHaveBeenCalled();
  });

  /*
    「能力在,账号不在」是一类单独的现实,不能和「生成失败」混成一句。用户要做的
    动作完全不同 —— 一个是去登录,一个是重试。
  */
  it('reports provider-not-ready when no agent has a connected source', async () => {
    const runOneShot = vi.fn();
    expect(
      await generateBotPersonaDraft(
        '设计师',
        deps({ listConnectedProviders: async () => [], runOneShot }),
      ),
    ).toEqual({ ok: false, code: 'provider-not-ready' });
    expect(runOneShot).not.toHaveBeenCalled();
  });

  it('falls through to the next agent when the preferred one has nothing connected', async () => {
    const seen: string[] = [];
    const result = await generateBotPersonaDraft(
      '设计师',
      deps({
        listConnectedProviders: async (agentKind) => {
          seen.push(agentKind);
          return agentKind === 'codex' ? [provider] : [];
        },
        runOneShot: async ({ agentKind }) => {
          expect(agentKind).toBe('codex');
          return { status: 'ok', title: DRAFT_JSON };
        },
      }),
    );
    expect(seen).toEqual(['claude-code', 'codex']);
    expect(result.ok).toBe(true);
  });

  it('reports generation-failed when the one-shot channel comes back empty', async () => {
    expect(
      await generateBotPersonaDraft(
        '设计师',
        deps({ runOneShot: async () => ({ status: 'failed' }) }),
      ),
    ).toEqual({ ok: false, code: 'generation-failed' });
    expect(
      await generateBotPersonaDraft(
        '设计师',
        deps({ runOneShot: async () => ({ status: 'unsupported-provider' }) }),
      ),
    ).toEqual({ ok: false, code: 'generation-failed' });
  });

  it('reports invalid-output rather than half-creating a teammate', async () => {
    expect(
      await generateBotPersonaDraft(
        '设计师',
        deps({ runOneShot: async () => ({ status: 'ok', title: '抱歉，我做不到。' }) }),
      ),
    ).toEqual({ ok: false, code: 'invalid-output' });
  });

  it('passes the UI locale through to the prompt', async () => {
    const seen: Array<{ prompt: string; systemPrompt: string }> = [];
    await generateBotPersonaDraft(
      'designer',
      deps({
        readLocale: () => 'ja',
        runOneShot: async ({ prompt, systemPrompt }) => {
          seen.push({ prompt, systemPrompt });
          return { status: 'ok', title: DRAFT_JSON };
        },
      }),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0].systemPrompt).toContain('ja');
    expect(seen[0].prompt).toContain('designer');
  });
});
