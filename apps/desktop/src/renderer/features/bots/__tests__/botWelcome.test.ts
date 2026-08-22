// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  botWelcomeClientId,
  clearPendingBotWelcome,
  deliverPendingBotWelcome,
  peekPendingBotWelcome,
  rememberPendingBotWelcome,
  resetPendingBotWelcomeForTests,
} from '../botWelcome';

function deps(overrides: {
  rows?: unknown;
  listMessages?: () => Promise<unknown>;
  createMessage?: ReturnType<typeof vi.fn>;
  translate?: (key: string) => string;
} = {}) {
  const createMessage = overrides.createMessage ?? vi.fn(async () => ({ id: 'm1' }));
  return {
    createMessage,
    listMessages: overrides.listMessages ?? (async () => overrides.rows ?? []),
    translate: overrides.translate ?? ((key: string) => `hello from ${key}`),
  };
}

beforeEach(() => {
  resetPendingBotWelcomeForTests();
});

describe('入伙即打招呼', () => {
  it('把创建时的欢迎语寄存下来,重开客户端也还在', () => {
    rememberPendingBotWelcome('bot-1', 'bots.createWizard.templates.shiba.welcome');
    expect(peekPendingBotWelcome('bot-1')).toBe('bots.createWizard.templates.shiba.welcome');
    // 寄存点是 localStorage:退出到再打开之间不能把这句话弄丢。
    expect(window.localStorage.getItem('cindy.bots.pendingWelcome.v1')).toContain('bot-1');

    clearPendingBotWelcome('bot-1');
    expect(peekPendingBotWelcome('bot-1')).toBeNull();
  });

  it('第一次打开主任务时落一条 assistant 消息,并清掉寄存', async () => {
    rememberPendingBotWelcome('bot-1', 'welcome.key');
    const d = deps();

    await expect(deliverPendingBotWelcome('bot-1', 'session-1', d)).resolves.toBe(true);

    expect(d.createMessage).toHaveBeenCalledWith('session-1', {
      clientId: botWelcomeClientId('bot-1'),
      role: 'assistant',
      content: 'hello from welcome.key',
    });
    expect(peekPendingBotWelcome('bot-1')).toBeNull();
  });

  it('第二次打开什么也不做', async () => {
    rememberPendingBotWelcome('bot-1', 'welcome.key');
    const first = deps();
    await deliverPendingBotWelcome('bot-1', 'session-1', first);

    const second = deps();
    await expect(deliverPendingBotWelcome('bot-1', 'session-1', second)).resolves.toBe(false);
    expect(second.createMessage).not.toHaveBeenCalled();
  });

  it('对话已经开始了就不再插话,并丢掉寄存', async () => {
    rememberPendingBotWelcome('bot-1', 'welcome.key');
    const d = deps({ rows: [{ clientId: 'existing' }] });

    await expect(deliverPendingBotWelcome('bot-1', 'session-1', d)).resolves.toBe(false);
    expect(d.createMessage).not.toHaveBeenCalled();
    expect(peekPendingBotWelcome('bot-1')).toBeNull();
  });

  it('读不到消息列表时保留寄存,下次打开再试', async () => {
    rememberPendingBotWelcome('bot-1', 'welcome.key');
    const d = deps({
      listMessages: async () => {
        throw new Error('offline');
      },
    });

    await expect(deliverPendingBotWelcome('bot-1', 'session-1', d)).resolves.toBe(false);
    expect(d.createMessage).not.toHaveBeenCalled();
    // 没能证明任务是空的 —— 宁可不说话,也不能贸然插进正在进行的对话。
    expect(peekPendingBotWelcome('bot-1')).toBe('welcome.key');
  });

  it('写入失败时保留寄存', async () => {
    rememberPendingBotWelcome('bot-1', 'welcome.key');
    const createMessage = vi.fn(async () => {
      throw new Error('db down');
    });
    const d = deps({ createMessage });

    await expect(deliverPendingBotWelcome('bot-1', 'session-1', d)).resolves.toBe(false);
    expect(peekPendingBotWelcome('bot-1')).toBe('welcome.key');
  });

  it('目录里没有这条文案时,绝不把 i18n key 当成台词发出去', async () => {
    rememberPendingBotWelcome('bot-1', 'missing.key');
    const d = deps({ translate: (key: string) => key });

    await expect(deliverPendingBotWelcome('bot-1', 'session-1', d)).resolves.toBe(false);
    expect(d.createMessage).not.toHaveBeenCalled();
    expect(peekPendingBotWelcome('bot-1')).toBeNull();
  });

  it('没有寄存就什么都不做(稳态)', async () => {
    const d = deps();
    await expect(deliverPendingBotWelcome('bot-1', 'session-1', d)).resolves.toBe(false);
    expect(d.createMessage).not.toHaveBeenCalled();
  });

  it('每个伙伴一个固定 clientId,两个窗口同时打开也只会有一条', () => {
    expect(botWelcomeClientId('bot-1')).toBe('bot-welcome:bot-1');
    expect(botWelcomeClientId('bot-2')).not.toBe(botWelcomeClientId('bot-1'));
  });

  it('多个伙伴各自排队,交付一个不影响另一个', async () => {
    rememberPendingBotWelcome('bot-1', 'welcome.one');
    rememberPendingBotWelcome('bot-2', 'welcome.two');

    await deliverPendingBotWelcome('bot-1', 'session-1', deps());

    expect(peekPendingBotWelcome('bot-1')).toBeNull();
    expect(peekPendingBotWelcome('bot-2')).toBe('welcome.two');
  });
});

/*
  阵容页脚注「加入后 TA 会先跟你打个招呼」是对**所有**创建路径的承诺。模板伙伴
  一直有自己的 welcome 文案,手捏与 AI 生成两条路要用同一条注入通道兑现:插值
  (通用开场句 + 名字)或现成整句(模型现造的开场白)。
*/
describe('入伙即打招呼 — 插值与现成整句', () => {
  it('寄存带插值的通用开场句,交付时把参数交给 t', async () => {
    rememberPendingBotWelcome('bot-1', {
      key: 'bots.welcome.generic',
      params: { name: '阿橘' },
    });
    const translate = vi.fn((key: string, params?: Record<string, string>) =>
      params ? `${key}|${JSON.stringify(params)}` : key,
    );
    const d = deps({ translate });

    await expect(deliverPendingBotWelcome('bot-1', 'session-1', d)).resolves.toBe(true);
    expect(translate).toHaveBeenCalledWith('bots.welcome.generic', { name: '阿橘' });
    expect(d.createMessage.mock.calls[0][1].content).toBe(
      'bots.welcome.generic|{"name":"阿橘"}',
    );
  });

  it('现成整句直接落地,不查目录', async () => {
    rememberPendingBotWelcome('bot-1', {
      key: 'bots.welcome.withRole',
      text: '  嗨，我是阿橘。配图和走查都可以丢给我。  ',
    });
    const translate = vi.fn(() => 'should not be used');
    const d = deps({ translate });

    await expect(deliverPendingBotWelcome('bot-1', 'session-1', d)).resolves.toBe(true);
    expect(translate).not.toHaveBeenCalled();
    expect(d.createMessage.mock.calls[0][1].content).toBe('嗨，我是阿橘。配图和走查都可以丢给我。');
    // 幂等仍靠同一个 clientId,与模板路径完全一致。
    expect(d.createMessage.mock.calls[0][1].clientId).toBe(botWelcomeClientId('bot-1'));
  });

  /*
    升级前建好、升级后才第一次打开的伙伴,寄存的还是旧形状(裸 key 字符串)。
    读不出来就等于那位伙伴永远不打招呼了。
  */
  it('仍然认旧版本寄存的裸 key 字符串', async () => {
    window.localStorage.setItem(
      'cindy.bots.pendingWelcome.v1',
      JSON.stringify({ 'bot-legacy': 'bots.createWizard.templates.shiba.welcome' }),
    );
    expect(peekPendingBotWelcome('bot-legacy')).toBe(
      'bots.createWizard.templates.shiba.welcome',
    );
    const d = deps();
    await expect(deliverPendingBotWelcome('bot-legacy', 'session-1', d)).resolves.toBe(true);
  });

  it('丢掉形状不对的寄存,不把脏数据写进对话', async () => {
    window.localStorage.setItem(
      'cindy.bots.pendingWelcome.v1',
      JSON.stringify({ 'bot-x': { params: { name: 'a' } }, 'bot-y': 42, 'bot-z': '' }),
    );
    for (const id of ['bot-x', 'bot-y', 'bot-z']) {
      const d = deps();
      await expect(deliverPendingBotWelcome(id, 'session-1', d)).resolves.toBe(false);
      expect(d.createMessage).not.toHaveBeenCalled();
    }
  });
});
