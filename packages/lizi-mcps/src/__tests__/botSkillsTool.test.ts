import { describe, expect, it, vi } from 'vitest';

import { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import { registerBotSkillTools } from '../xdt-helper/bot_skills.js';

function parse(result: { content: Array<{ type: string; text?: string }> }) {
  const block = result.content[0];
  if (block?.type !== 'text' || typeof block.text !== 'string') throw new Error('text expected');
  return JSON.parse(block.text) as Record<string, unknown>;
}

const SKILL = {
  slug: 'weekly-report',
  name: 'weekly-report',
  description: 'How I put the weekly report together',
  updatedAt: '2026-08-19T00:00:00.000Z',
};

function registry(overrides: Partial<Parameters<typeof registerBotSkillTools>[1]> = {}) {
  const reg = new XdtHelperToolRegistry();
  registerBotSkillTools(reg, {
    getSessionContext: () => ({ sessionId: 'bot-session', agentKind: 'pi', workingDir: '/w' }),
    callbacks: {
      save: vi.fn(async () => ({
        ok: true as const,
        skill: SKILL,
        created: true,
        effective: 'next-session' as const,
      })),
      list: vi.fn(async () => ({ ok: true as const, skills: [SKILL] })),
    },
    ...overrides,
  });
  return reg;
}

describe('Bot skill tools', () => {
  it('saves through the host-owned caller Session and never accepts a botId', async () => {
    const save = vi.fn(async () => ({
      ok: true as const,
      skill: SKILL,
      created: true,
      effective: 'next-session' as const,
    }));
    const reg = registry({
      callbacks: { save, list: vi.fn() },
    });

    const result = await reg.call('save_bot_skill', {
      name: 'weekly-report',
      description: 'How I put the weekly report together',
      body: '1. Pull merged PRs\n2. Group by author',
    });

    expect(parse(result)).toMatchObject({ ok: true, created: true, effective: 'next-session' });
    expect(save).toHaveBeenCalledWith({
      callerSessionId: 'bot-session',
      name: 'weekly-report',
      description: 'How I put the weekly report together',
      body: '1. Pull merged PRs\n2. Group by author',
    });
  });

  it('reports an update rather than a new skill when the host says so', async () => {
    const reg = registry({
      callbacks: {
        save: vi.fn(async () => ({
          ok: true as const,
          skill: SKILL,
          created: false,
          effective: 'next-session' as const,
        })),
        list: vi.fn(),
      },
    });

    const result = await reg.call('save_bot_skill', {
      name: 'weekly-report',
      description: 'sharper now',
      body: 'step 1',
    });
    expect(parse(result)).toMatchObject({ ok: true, created: false });
  });

  it('lists what the Bot already learned so it does not learn it twice', async () => {
    const result = await registry().call('list_bot_skills', {});
    expect(parse(result)).toMatchObject({ ok: true, skills: [SKILL] });
  });

  it('fails closed without a bound Session', async () => {
    const reg = new XdtHelperToolRegistry();
    registerBotSkillTools(reg, {
      getSessionContext: () => ({ agentKind: 'pi', workingDir: '/w' }),
      callbacks: { save: vi.fn(), list: vi.fn() },
    });

    for (const tool of ['save_bot_skill', 'list_bot_skills']) {
      const result = await reg.call(
        tool,
        tool === 'save_bot_skill' ? { name: 'a', description: 'b', body: 'c' } : {},
      );
      expect(result.isError).toBe(true);
      expect(parse(result)).toMatchObject({ ok: false, errorCode: 'NOT_A_BOT_SESSION' });
    }
  });

  it('passes the host error code straight through instead of pretending it worked', async () => {
    const reg = registry({
      callbacks: {
        save: vi.fn(async () => ({
          ok: false as const,
          errorCode: 'SKILL_NAME_UNUSABLE',
          message: 'name could not be turned into a slug',
        })),
        list: vi.fn(),
      },
    });

    const result = await reg.call('save_bot_skill', {
      name: '周报怎么写',
      description: 'b',
      body: 'c',
    });
    expect(result.isError).toBe(true);
    expect(parse(result)).toMatchObject({ ok: false, errorCode: 'SKILL_NAME_UNUSABLE' });
  });

  it('rejects a stray field instead of silently dropping it', async () => {
    // registry 用 strictObject 校验:模型把 botId 塞进来必须被打回,不能静默剥掉后
    // 当成「写进自己名下」成功返回。
    const result = await registry().call('save_bot_skill', {
      name: 'a',
      description: 'b',
      body: 'c',
      botId: 'someone-else',
    });
    expect(result.isError).toBe(true);
    expect(parse(result)).toMatchObject({ ok: false, errorCode: 'INVALID_ARGS' });
  });
});
