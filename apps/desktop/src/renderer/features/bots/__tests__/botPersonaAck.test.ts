// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PersonaSelection } from '../botPersona';
import {
  botPersonaAckCopy,
  clearPendingBotPersonaAck,
  deliverPendingBotPersonaAck,
  peekPendingBotPersonaAck,
  personaAckClientId,
  personaFingerprint,
  rememberPendingBotPersonaAck,
  resetPendingBotPersonaAckForTests,
} from '../botPersonaAck';

function selection(overrides: Partial<PersonaSelection> = {}): PersonaSelection {
  return { style: 'concise', proactivity: 'reactive', call: 'name', ...overrides };
}

function deps(
  overrides: {
    createMessage?: ReturnType<typeof vi.fn>;
    translate?: (key: string, params?: Record<string, string>) => string;
  } = {},
) {
  const createMessage = overrides.createMessage ?? vi.fn(async () => ({ id: 'm1' }));
  return {
    createMessage,
    translate:
      overrides.translate ??
      ((key: string, params?: Record<string, string>) =>
        params ? `${key}:${JSON.stringify(params)}` : `said ${key}`),
  };
}

beforeEach(() => {
  resetPendingBotPersonaAckForTests();
});

describe('调完性格,TA 回一句', () => {
  it('人格真的变了才寄存 —— 打开向导原样关掉不该冒出一句话', () => {
    const before = selection();
    expect(rememberPendingBotPersonaAck('bot-1', before, selection())).toBe(false);
    expect(peekPendingBotPersonaAck('bot-1')).toBeNull();

    expect(rememberPendingBotPersonaAck('bot-1', before, selection({ style: 'lively' }))).toBe(
      true,
    );
    expect(peekPendingBotPersonaAck('bot-1')?.style).toBe('lively');
    // 寄存点是 localStorage:设置页保存到对话页打开之间隔着一次导航。
    expect(window.localStorage.getItem('cindy.bots.pendingPersonaAck.v1')).toContain('bot-1');

    clearPendingBotPersonaAck('bot-1');
    expect(peekPendingBotPersonaAck('bot-1')).toBeNull();
  });

  it('第一次设置性格(此前没有)也算变了', () => {
    expect(rememberPendingBotPersonaAck('bot-1', null, selection())).toBe(true);
  });

  it('自定义称呼改了字也算变了', () => {
    const a = selection({ call: 'custom', customCall: '头儿' });
    const b = selection({ call: 'custom', customCall: '老大' });
    expect(personaFingerprint(a)).not.toBe(personaFingerprint(b));
    expect(rememberPendingBotPersonaAck('bot-1', a, b)).toBe(true);
  });

  it('clientId 跟着这次选择走 —— 重复投递只写一行,换了性格才会有新的一行', () => {
    const a = selection({ style: 'steady' });
    const b = selection({ style: 'lively' });
    expect(personaAckClientId('bot-1', a)).toBe(personaAckClientId('bot-1', a));
    expect(personaAckClientId('bot-1', a)).not.toBe(personaAckClientId('bot-1', b));
    expect(personaAckClientId('bot-1', a)).not.toBe(personaAckClientId('bot-2', a));
    expect(personaAckClientId('bot-1', a)).toMatch(/^persona-ack:bot-1:/);
  });

  it('说话风格三档各有自己的一句', () => {
    expect(botPersonaAckCopy(selection({ style: 'concise' })).key).toBe('bots.persona.ack.concise');
    expect(botPersonaAckCopy(selection({ style: 'lively' })).key).toBe('bots.persona.ack.lively');
    expect(botPersonaAckCopy(selection({ style: 'steady' })).key).toBe('bots.persona.ack.steady');
  });

  it('称呼选了老板 / 自定义时,这一句里就带上称呼', () => {
    expect(botPersonaAckCopy(selection({ style: 'steady', call: 'boss' })).key).toBe(
      'bots.persona.ack.steadyBoss',
    );
    const custom = botPersonaAckCopy(
      selection({ style: 'lively', call: 'custom', customCall: '头儿' }),
    );
    expect(custom.key).toBe('bots.persona.ack.livelyCalled');
    expect(custom.params).toEqual({ call: '头儿' });
    // 自定义留空时退回不带称呼的那条,不会渲染出一个空称呼。
    expect(botPersonaAckCopy(selection({ call: 'custom', customCall: '  ' })).key).toBe(
      'bots.persona.ack.concise',
    );
  });

  it('投递一次写一行,并把寄存清掉;第二次打开什么都不做', async () => {
    rememberPendingBotPersonaAck('bot-1', null, selection({ style: 'steady', call: 'boss' }));
    const d = deps();

    expect(await deliverPendingBotPersonaAck('bot-1', 'sess-1', d)).toBe(true);
    expect(d.createMessage).toHaveBeenCalledTimes(1);
    expect(d.createMessage).toHaveBeenCalledWith('sess-1', {
      clientId: personaAckClientId('bot-1', selection({ style: 'steady', call: 'boss' })),
      role: 'assistant',
      content: 'said bots.persona.ack.steadyBoss',
    });

    expect(await deliverPendingBotPersonaAck('bot-1', 'sess-1', d)).toBe(false);
    expect(d.createMessage).toHaveBeenCalledTimes(1);
  });

  it('对话已经有内容照样投 —— 它本来就发生在一段已有的对话里', async () => {
    // 与打招呼的唯一区别:不做「任务必须是空的」那道判断,所以这里没有
    // listMessages 依赖可言,投递不受已有消息影响。
    rememberPendingBotPersonaAck('bot-1', null, selection());
    const d = deps();
    expect(await deliverPendingBotPersonaAck('bot-1', 'sess-1', d)).toBe(true);
  });

  it('文案缺条目时不把 raw key 写进对话', async () => {
    rememberPendingBotPersonaAck('bot-1', null, selection());
    const d = deps({ translate: (key: string) => key });

    expect(await deliverPendingBotPersonaAck('bot-1', 'sess-1', d)).toBe(false);
    expect(d.createMessage).not.toHaveBeenCalled();
    expect(peekPendingBotPersonaAck('bot-1')).toBeNull();
  });

  it('写失败时留在寄存处,下次打开再试', async () => {
    rememberPendingBotPersonaAck('bot-1', null, selection());
    const failing = vi.fn(async () => {
      throw new Error('db not ready');
    });

    expect(await deliverPendingBotPersonaAck('bot-1', 'sess-1', deps({ createMessage: failing })))
      .toBe(false);
    expect(peekPendingBotPersonaAck('bot-1')).not.toBeNull();

    const d = deps();
    expect(await deliverPendingBotPersonaAck('bot-1', 'sess-1', d)).toBe(true);
  });

  it('没有寄存时什么都不做', async () => {
    const d = deps();
    expect(await deliverPendingBotPersonaAck('bot-1', 'sess-1', d)).toBe(false);
    expect(d.createMessage).not.toHaveBeenCalled();
  });
});
