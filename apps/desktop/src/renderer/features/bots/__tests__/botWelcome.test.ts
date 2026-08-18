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
