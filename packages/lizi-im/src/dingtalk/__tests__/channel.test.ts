import { describe, expect, it, vi } from 'vitest';

import type { IMHost, IMMessageEvent, IMStatus } from '../../types.js';
import type { DingTalkDwsIM } from '../../dingtalk-dws/index.js';
import { DingTalkChannelIM } from '../channel.js';
import type { DingTalkIM } from '../index.js';

/** 最小可控的传输桩：记录 init / dispose，并能手动推送入站消息。 */
function fakeTransport(name: string) {
  const messageHandlers = new Set<(event: IMMessageEvent) => void>();
  const statusHandlers = new Set<(status: IMStatus) => void>();
  const transport = {
    name,
    init: vi.fn(async () => undefined),
    dispose: vi.fn(async () => undefined),
    registerIpc: vi.fn(),
    onMessage: (handler: (event: IMMessageEvent) => void) => {
      messageHandlers.add(handler);
      return () => messageHandlers.delete(handler);
    },
    onStatusChange: (handler: (status: IMStatus) => void) => {
      statusHandlers.add(handler);
      return () => statusHandlers.delete(handler);
    },
    onStateChange: () => () => undefined,
    onCardAction: () => () => undefined,
    getStatus: (): IMStatus => ({ kind: 'idle' }),
    getPublicState: () => ({}),
    sendText: vi.fn(async () => ({ messageId: `${name}-out` })),
    sendMarkdownText: vi.fn(async () => ({ messageId: `${name}-out` })),
    sendFile: vi.fn(async () => ({ ok: true })),
    commitFinal: vi.fn(async () => undefined),
    requestTextReply: vi.fn(async () => 'ok'),
    fetchRecentGroupMessages: vi.fn(async () => [{ messageId: 'm1' }]),
    contextId: `${name}-context`,
    emit(event: Partial<IMMessageEvent>) {
      for (const handler of messageHandlers) handler(event as IMMessageEvent);
    },
  };
  return transport;
}

function makeHost(mode?: string) {
  const secrets = new Map<string, string>(mode ? [['dingtalk-transport-mode', mode]] : []);
  const handlers = new Map<string, (payload?: unknown) => unknown>();
  const host: IMHost = {
    secrets: {
      write: (key, value) => {
        secrets.set(key, value);
        return true;
      },
      read: (key) => secrets.get(key) ?? null,
      remove: (key) => void secrets.delete(key),
      isAvailable: () => true,
    },
    ipc: {
      throwIpcError: (code, message) => {
        throw new Error(`[${code}] ${message}`);
      },
      handle: (channel, handler) => void handlers.set(channel, handler),
      broadcast: () => undefined,
    },
    paths: { feishuMediaDir: '/unused' },
    httpPostForm: async () => ({ status: 200, body: {} }),
  };
  return { host, secrets, handlers };
}

function build(mode?: string) {
  const { host, secrets, handlers } = makeHost(mode);
  const robot = fakeTransport('robot');
  const dws = fakeTransport('dws');
  const channel = new DingTalkChannelIM(
    host,
    robot as unknown as DingTalkIM,
    dws as unknown as DingTalkDwsIM,
  );
  return { channel, robot, dws, secrets, handlers };
}

describe('DingTalkChannelIM', () => {
  it('defaults to the robot transport so existing users are unaffected', async () => {
    const { channel, robot, dws } = build();
    await channel.init();
    expect(channel.getMode()).toBe('robot');
    expect(robot.init).toHaveBeenCalledTimes(1);
    expect(dws.init).not.toHaveBeenCalled();
    expect(channel.supportsGroupHistory()).toBe(false);
    await expect(channel.fetchRecentGroupMessages('cid', 10)).resolves.toEqual([]);
  });

  it('only forwards inbound messages from the active transport', async () => {
    const { channel, robot, dws } = build('dws');
    await channel.init();
    const received: string[] = [];
    channel.onMessage((event) => received.push(event.messageId));
    robot.emit({ messageId: 'from-robot' });
    dws.emit({ messageId: 'from-dws' });
    expect(received).toEqual(['from-dws']);
  });

  it('delegates outbound calls to the active transport', async () => {
    const { channel, robot, dws } = build('dws');
    await channel.init();
    await channel.sendText('u', 'hi');
    await channel.commitFinal({ userId: 'u', text: 'done', terminal: 'done' });
    expect(dws.sendText).toHaveBeenCalledWith('u', 'hi');
    expect(dws.commitFinal).toHaveBeenCalled();
    expect(robot.sendText).not.toHaveBeenCalled();
  });

  it('switches mode by stopping the old transport before starting the new one', async () => {
    const { channel, robot, dws, secrets, handlers } = build();
    channel.registerIpc();
    await channel.init();
    const order: string[] = [];
    robot.dispose.mockImplementation(async () => void order.push('robot.dispose'));
    dws.init.mockImplementation(async () => void order.push('dws.init'));
    await expect(handlers.get('dingtalkBot:set-mode')?.({ mode: 'dws' })).resolves.toEqual({
      mode: 'dws',
    });
    expect(order).toEqual(['robot.dispose', 'dws.init']);
    expect(secrets.get('dingtalk-transport-mode')).toBe('dws');
    expect(channel.supportsGroupHistory()).toBe(true);
  });

  it('rejects invalid modes', async () => {
    const { channel, handlers } = build();
    channel.registerIpc();
    await expect(handlers.get('dingtalkBot:set-mode')?.({ mode: 'other' })).rejects.toThrow(
      'INVALID_PARAMS',
    );
  });

  it('keeps the robot IPC channels registered', () => {
    const { channel, robot, handlers } = build();
    channel.registerIpc();
    expect(robot.registerIpc).toHaveBeenCalledTimes(1);
    expect([...handlers.keys()]).toEqual(
      expect.arrayContaining([
        'dingtalkBot:get-mode',
        'dingtalkBot:set-mode',
        'dingtalkBot:dws-get-state',
        'dingtalkBot:dws-connect',
        'dingtalkBot:dws-disconnect',
        'dingtalkBot:dws-clear-owner',
      ]),
    );
  });

  it('never sends an in-flight reply through the newly selected transport', async () => {
    const { channel, robot, dws, handlers } = build();
    channel.registerIpc();
    await channel.init();
    channel.onMessage(() => undefined);
    // 机器人方式下进来一条消息，任务进行中用户把连接方式切到钉钉账号。
    robot.emit({ messageId: 'm1', senderId: 'robot-user' });
    await handlers.get('dingtalkBot:set-mode')?.({ mode: 'dws' });
    await expect(
      channel.commitFinal({ userId: 'robot-user', text: 'done', terminal: 'done' }),
    ).rejects.toThrow('DINGTALK_TRANSPORT_SWITCHED');
    await expect(channel.sendText('robot-user', 'hi')).rejects.toThrow('DINGTALK_TRANSPORT_SWITCHED');
    await expect(channel.sendFile('robot-user', '/a.txt')).resolves.toEqual({
      ok: false,
      reason: 'SEND_FAIL',
    });
    expect(dws.commitFinal).not.toHaveBeenCalled();
    expect(dws.sendText).not.toHaveBeenCalled();
    expect(robot.commitFinal).not.toHaveBeenCalled();
  });

  it('routes replies of conversations that arrived on the current transport normally', async () => {
    const { channel, dws } = build('dws');
    await channel.init();
    channel.onMessage(() => undefined);
    dws.emit({ messageId: 'm2', senderId: 'dws-user' });
    await channel.commitFinal({ userId: 'dws-user', text: 'done', terminal: 'done' });
    expect(dws.commitFinal).toHaveBeenCalledTimes(1);
  });
});
