import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { IMHost, IMMessageEvent } from '../../types.js';
import { encodeLaneUserId } from '../../dingtalk/codec.js';
import { DingTalkDwsIM } from '../index.js';
import { DWS_EVENT_DIRECT, DWS_EVENT_MENTION } from '../events.js';
import { DwsCommandError, DWS_NOT_INSTALLED, type DwsRunner, type DwsStreamProcess } from '../runner.js';

class FakeStream implements DwsStreamProcess {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly events = new EventEmitter();
  stdinClosed = false;
  killed = false;
  exited = false;

  closeStdin(): void {
    this.stdinClosed = true;
    this.exit(0);
  }

  forceKill(): void {
    this.killed = true;
    this.exit(null);
  }

  onExit(handler: (code: number | null) => void): void {
    if (this.exited) {
      handler(0);
      return;
    }
    this.events.once('exit', handler);
  }

  onError(handler: (error: Error) => void): void {
    this.events.once('error', handler);
  }

  ready(): void {
    this.stderr.write('[event] ready event_count=2 bus_pid=1\n');
  }

  emit(payload: Record<string, unknown>): void {
    this.stdout.write(`${JSON.stringify(payload)}\n`);
  }

  exit(code: number | null): void {
    if (this.exited) return;
    this.exited = true;
    this.events.emit('exit', code);
  }
}

const IDENTITY = {
  authenticated: true,
  token_valid: true,
  refresh_token_valid: true,
  corp_id: 'corp-1',
  corp_name: 'Test Org',
  user_id: 'agent-user',
  user_name: 'Cindy 助手',
};

function makeHost() {
  const secrets = new Map<string, string>([['dingtalk-dws-enabled', '1']]);
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
      handle: () => undefined,
      broadcast: () => undefined,
    },
    paths: { feishuMediaDir: '/unused' },
    httpPostForm: async () => ({ status: 200, body: {} }),
  };
  return { host, secrets };
}

function makeRunner(options: { identity?: unknown; available?: boolean } = {}) {
  const streams: FakeStream[] = [];
  const calls: Array<{ args: readonly string[]; cwd?: string }> = [];
  const history: unknown[] = [];
  const runner: DwsRunner = {
    isAvailable: async () => options.available ?? true,
    runJson: vi.fn(async (args: readonly string[], opts?: { cwd?: string }) => {
      calls.push({ args, cwd: opts?.cwd });
      if (args[0] === 'auth') return options.identity ?? IDENTITY;
      if (args[1] === '+chat-messages') return history.shift() ?? { messages: [] };
      if (args[1] === '+conversation-info') {
        return { result: { conversationInfo: { title: '项目群', openConversationId: args[3] } } };
      }
      return { success: true };
    }),
    spawnStream: vi.fn(() => {
      const stream = new FakeStream();
      streams.push(stream);
      // 下一拍再报 ready，模拟 dws 先建立订阅再输出就绪行。
      setTimeout(() => stream.ready(), 0);
      return stream;
    }),
  };
  return { runner, streams, calls, history };
}

function directEvent(overrides: Record<string, unknown> = {}) {
  return {
    type: DWS_EVENT_DIRECT,
    event_id: `evt-${Math.random()}`,
    message_id: 'msg-1',
    conversation_id: 'cid-dm',
    sender: '张三',
    sender_open_dingtalk_id: 'owner-open',
    content: '你好',
    ...overrides,
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

async function connected(options?: Parameters<typeof makeRunner>[0]) {
  const { host, secrets } = makeHost();
  const fake = makeRunner(options);
  const im = new DingTalkDwsIM(host, fake.runner);
  const messages: IMMessageEvent[] = [];
  im.onMessage((event) => messages.push(event));
  await im.init();
  return { im, host, secrets, messages, ...fake };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('DingTalkDwsIM connection', () => {
  it('connects after the ready line and subscribes to direct + mention events', async () => {
    const { im, runner } = await connected();
    expect(im.getStatus()).toEqual({ kind: 'connected', appId: 'corp-1:agent-user' });
    expect(runner.spawnStream).toHaveBeenCalledWith([
      'event',
      'consume',
      DWS_EVENT_DIRECT,
      DWS_EVENT_MENTION,
      '--flatten',
      '-f',
      'ndjson',
    ]);
    await im.dispose();
  });

  it('stays idle when the dws mode was never enabled', async () => {
    const { host, secrets } = makeHost();
    secrets.delete('dingtalk-dws-enabled');
    const { runner } = makeRunner();
    const im = new DingTalkDwsIM(host, runner);
    await im.init();
    expect(im.getStatus()).toEqual({ kind: 'idle' });
    expect(runner.spawnStream).not.toHaveBeenCalled();
  });

  it('reports not-logged-in when dws auth status is unauthenticated', async () => {
    const { host } = makeHost();
    const { runner } = makeRunner({ identity: { authenticated: false } });
    const im = new DingTalkDwsIM(host, runner);
    await expect(im.enable()).rejects.toThrow('[DINGTALK_DWS_NOT_LOGGED_IN]');
    expect(im.isEnabled()).toBe(false);
  });

  it('reports not-installed when the binary is missing', async () => {
    const { host } = makeHost();
    const { runner } = makeRunner({ available: false });
    const im = new DingTalkDwsIM(host, runner);
    await expect(im.enable()).rejects.toThrow('[DINGTALK_DWS_NOT_INSTALLED]');
  });

  it('stops gracefully by closing stdin instead of killing', async () => {
    const { im, streams } = await connected();
    await im.dispose();
    expect(streams[0].stdinClosed).toBe(true);
    expect(streams[0].killed).toBe(false);
    expect(im.getStatus()).toEqual({ kind: 'idle' });
  });

  it('restarts the stream after an unexpected exit', async () => {
    const { im, streams } = await connected();
    vi.useFakeTimers();
    streams[0].exit(1);
    expect(im.getStatus()).toEqual({ kind: 'connecting' });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(streams).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(im.getStatus()).toEqual({ kind: 'connected', appId: 'corp-1:agent-user' });
    vi.useRealTimers();
    await im.dispose();
  });

  it('keeps retrying when a restarted stream never becomes ready', async () => {
    const { im, streams, runner } = await connected();
    vi.useFakeTimers();
    // 之后拉起的进程都不输出 ready 行。
    vi.mocked(runner.spawnStream).mockImplementation(() => {
      const stream = new FakeStream();
      streams.push(stream);
      return stream;
    });
    streams[0].exit(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(streams).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(45_000);
    expect(streams[1].killed).toBe(true);
    expect(im.getStatus()).toEqual({ kind: 'connecting' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(streams.length).toBeGreaterThanOrEqual(3);
    vi.useRealTimers();
    await im.dispose();
  });

  it('exposes identity without credentials in the public state', async () => {
    const { im } = await connected();
    expect(im.getPublicState()).toMatchObject({
      enabled: true,
      installed: true,
      identity: { corpName: 'Test Org', userName: 'Cindy 助手' },
      ownerName: null,
    });
    expect(im.getPublicState().pairingCode).toMatch(/^\d{6}$/);
    expect(JSON.stringify(im.getPublicState())).not.toContain('corp-1');
    await im.dispose();
  });
});

/** 主人用设置页显示的配对码私聊完成绑定（这条配对消息本身不触发任务）。 */
async function bindOwner(im: DingTalkDwsIM, stream: FakeStream): Promise<void> {
  const code = im.getPublicState().pairingCode;
  expect(code).toMatch(/^\d{6}$/);
  stream.emit(directEvent({ event_id: 'evt-pair', message_id: 'msg-pair', content: code }));
  await flush();
}

describe('DingTalkDwsIM inbound', () => {
  it('binds the owner only through the pairing code and ignores everything before it', async () => {
    const { im, streams, messages } = await connected();
    // 同事先发来的普通私聊不能抢占主人。
    streams[0].emit(directEvent({ sender: '同事', sender_open_dingtalk_id: 'colleague' }));
    await flush();
    expect(im.getPublicState().ownerName).toBeNull();
    await bindOwner(im, streams[0]);
    expect(im.getPublicState()).toMatchObject({ ownerName: '张三', pairingCode: null });
    expect(messages).toHaveLength(0);

    streams[0].emit(directEvent({ message_id: 'msg-2' }));
    streams[0].emit(
      directEvent({ message_id: 'msg-3', sender: '陌生人', sender_open_dingtalk_id: 'stranger' }),
    );
    await flush();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      channelName: 'dingtalk',
      senderId: 'owner-open',
      contextId: 'corp-1:agent-user',
      messageId: 'msg-2',
      text: '你好',
    });
    await im.dispose();
  });

  it('issues a fresh pairing code after the owner is cleared', async () => {
    const { im, streams } = await connected();
    await bindOwner(im, streams[0]);
    expect(im.getPublicState().pairingCode).toBeNull();
    im.clearOwner();
    expect(im.getPublicState().pairingCode).toMatch(/^\d{6}$/);
    expect(im.getPublicState().ownerName).toBeNull();
    await im.dispose();
  });

  it('never binds an owner from a group mention, even with the code', async () => {
    const { im, streams, messages } = await connected();
    streams[0].emit({
      ...directEvent({ content: im.getPublicState().pairingCode }),
      type: DWS_EVENT_MENTION,
      conversation_id: 'cid-group',
    });
    await flush();
    expect(messages).toHaveLength(0);
    expect(im.getPublicState().ownerName).toBeNull();
    await im.dispose();
  });

  it('routes owner group mentions to a lane with speaker and strips the self mention', async () => {
    const { im, streams, messages } = await connected();
    await bindOwner(im, streams[0]);
    streams[0].emit({
      type: DWS_EVENT_MENTION,
      event_id: 'evt-group',
      message_id: 'msg-g',
      conversation_id: 'cid-group',
      sender: '张三',
      sender_open_dingtalk_id: 'owner-open',
      content: '@Cindy 助手 总结一下',
      quoted_message: { sender: '同事', content: '上面的方案' },
    });
    await flush();
    expect(messages[0]).toMatchObject({
      senderId: encodeLaneUserId('cid-group'),
      chatId: 'cid-group',
      text: '总结一下',
      speaker: { id: 'owner-open', name: '张三', isOwner: true },
      replyContext: { author: '同事', text: '上面的方案' },
    });
    await im.dispose();
  });

  // 群名进渠道说明，Agent 才知道是哪个群；同一群只查一次。
  it('names the group from conversation-info and caches it per conversation', async () => {
    const { im, streams, messages, calls } = await connected();
    await bindOwner(im, streams[0]);
    const mention = {
      type: DWS_EVENT_MENTION,
      conversation_id: 'cid-group',
      sender: '张三',
      sender_open_dingtalk_id: 'owner-open',
      content: '@Cindy 助手 在吗',
    };
    streams[0].emit({ ...mention, event_id: 'e1', message_id: 'g1' });
    streams[0].emit({ ...mention, event_id: 'e2', message_id: 'g2' });
    await flush();
    expect(messages.map((m) => m.interactionSource?.chatName)).toEqual(['项目群', '项目群']);
    expect(calls.filter((c) => c.args[1] === '+conversation-info')).toHaveLength(1);
    await im.dispose();
  });

  it('lets anyone in a group trigger a turn, marked as non-owner', async () => {
    const { im, streams, messages } = await connected();
    await bindOwner(im, streams[0]);
    streams[0].emit({
      type: DWS_EVENT_MENTION,
      event_id: 'evt-colleague',
      message_id: 'msg-c',
      conversation_id: 'cid-group',
      sender: '同事',
      sender_open_dingtalk_id: 'colleague',
      content: '@Cindy 助手 这个方案的预算是多少',
    });
    await flush();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      senderId: encodeLaneUserId('cid-group'),
      text: '这个方案的预算是多少',
      speaker: { id: 'colleague', name: '同事', isOwner: false },
    });
    await im.dispose();
  });

  it('still ignores direct messages from anyone but the owner', async () => {
    const { im, streams, messages } = await connected();
    await bindOwner(im, streams[0]);
    streams[0].emit(
      directEvent({ message_id: 'msg-s', sender: '同事', sender_open_dingtalk_id: 'colleague' }),
    );
    await flush();
    expect(messages).toHaveLength(0);
    await im.dispose();
  });

  it('does not let group members trigger before an owner is paired', async () => {
    const { im, streams, messages } = await connected();
    streams[0].emit({
      type: DWS_EVENT_MENTION,
      event_id: 'evt-early',
      message_id: 'msg-early',
      conversation_id: 'cid-group',
      sender: '同事',
      sender_open_dingtalk_id: 'colleague',
      content: '@Cindy 助手 你好',
    });
    await flush();
    expect(messages).toHaveLength(0);
    await im.dispose();
  });

  it('turns a bare group mention into a summon', async () => {
    const { im, streams, messages } = await connected();
    await bindOwner(im, streams[0]);
    streams[0].emit({
      type: DWS_EVENT_MENTION,
      event_id: 'evt-bare',
      message_id: 'msg-bare',
      conversation_id: 'cid-group',
      sender: '张三',
      sender_open_dingtalk_id: 'owner-open',
      content: '@Cindy 助手',
    });
    await flush();
    expect(messages[0]).toMatchObject({ text: '@', speaker: { isOwner: true } });
    await im.dispose();
  });

  it('deduplicates repeated events', async () => {
    const { im, streams, messages } = await connected();
    await bindOwner(im, streams[0]);
    const event = directEvent({ event_id: 'same' });
    streams[0].emit(event);
    streams[0].emit(event);
    await flush();
    expect(messages).toHaveLength(1);
    await im.dispose();
  });

  it.each([DWS_EVENT_DIRECT, DWS_EVENT_MENTION])(
    'delivers one message once when %s redelivers it with different event ids',
    async (type) => {
      const { im, streams, messages } = await connected();
      try {
        await bindOwner(im, streams[0]);
        const event = directEvent({ type, event_id: 'delivery-1' });
        // 重投发生在异步附件处理 / 同一 lane 排队期间，也只能触发一次。
        streams[0].emit(event);
        streams[0].emit({ ...event, event_id: 'delivery-2' });
        await flush();
        // 已派发后再次重投，或有的投递缺少 event_id，也仍是同一条消息。
        streams[0].emit({ ...event, event_id: 'delivery-3' });
        streams[0].emit({ ...event, event_id: undefined });
        await flush();
        expect(messages).toHaveLength(1);
        expect(messages[0]).toMatchObject({ messageId: event.message_id, text: event.content });
      } finally {
        await im.dispose();
      }
    },
  );

  it('keeps separate messages with identical text', async () => {
    const { im, streams, messages } = await connected();
    try {
      await bindOwner(im, streams[0]);
      streams[0].emit(directEvent({ event_id: 'delivery-1', message_id: 'first' }));
      streams[0].emit(directEvent({ event_id: 'delivery-2', message_id: 'second' }));
      await flush();
      expect(messages.map(({ messageId, text }) => ({ messageId, text }))).toEqual([
        { messageId: 'first', text: '你好' },
        { messageId: 'second', text: '你好' },
      ]);
    } finally {
      await im.dispose();
    }
  });

  it('scopes message ids to the conversation, not the delivery event', async () => {
    const { im, streams, messages } = await connected();
    try {
      await bindOwner(im, streams[0]);
      const event = directEvent({ type: DWS_EVENT_MENTION, event_id: 'same-delivery' });
      streams[0].emit({ ...event, conversation_id: 'group-a' });
      streams[0].emit({ ...event, conversation_id: 'group-b' });
      await flush();
      expect(messages.map(({ chatId }) => chatId)).toEqual(['group-a', 'group-b']);
    } finally {
      await im.dispose();
    }
  });

  it('deduplicates a message redelivered after stream reconnection', async () => {
    const { im, streams, messages } = await connected();
    try {
      await bindOwner(im, streams[0]);
      streams[0].emit(directEvent({ event_id: 'before-reconnect' }));
      await flush();
      vi.useFakeTimers();
      streams[0].exit(1);
      await vi.advanceTimersByTimeAsync(2_001);
      vi.useRealTimers();
      expect(streams).toHaveLength(2);
      streams[1].emit(directEvent({ event_id: 'after-reconnect' }));
      await flush();
      expect(messages).toHaveLength(1);
    } finally {
      vi.useRealTimers();
      await im.dispose();
    }
  });

  it('does not suppress another account with the same conversation and message ids', async () => {
    const identity = { ...IDENTITY };
    const { im, streams, messages } = await connected({ identity });
    try {
      await bindOwner(im, streams[0]);
      const event = directEvent({ event_id: 'same-delivery' });
      streams[0].emit(event);
      await flush();
      await im.disable();
      identity.user_id = 'another-agent';
      await im.enable();
      await bindOwner(im, streams[1]);
      streams[1].emit(event);
      await flush();
      expect(messages.map(({ contextId }) => contextId)).toEqual([
        'corp-1:agent-user',
        'corp-1:another-agent',
      ]);
    } finally {
      await im.dispose();
    }
  });

  it('ignores unrelated event types and malformed lines', async () => {
    const { im, streams, messages } = await connected();
    await bindOwner(im, streams[0]);
    streams[0].stdout.write('not json\n');
    streams[0].emit({ ...directEvent(), type: 'user_im_message_read_o2o' });
    await flush();
    expect(messages).toHaveLength(0);
    await im.dispose();
  });
});

describe('DingTalkDwsIM outbound', () => {
  it('sends markdown to the direct target with confirmation flag', async () => {
    const { im, calls } = await connected();
    await im.sendMarkdownText('owner-open', '**完成**');
    expect(calls.at(-1)?.args).toEqual([
      'chat',
      '+messages-send',
      '--open-dingtalk-id',
      'owner-open',
      '--markdown',
      '**完成**',
      '--yes',
      '-f',
      'json',
      '--profile',
      'corp-1:agent-user',
      '--idempotency-key',
      expect.any(String),
    ]);
    await im.dispose();
  });

  it('sends to the group for lane user ids and chunks long text', async () => {
    const { im, calls } = await connected();
    const before = calls.length;
    await im.sendText(encodeLaneUserId('cid-group'), 'a'.repeat(8_000));
    const sends = calls.slice(before);
    expect(sends).toHaveLength(3);
    expect(sends[0].args.slice(2, 4)).toEqual(['--group', 'cid-group']);
    expect(sends[0].args[4]).toBe('--text');
    await im.dispose();
  });

  it('sends files relative to their directory', async () => {
    const { im, calls } = await connected();
    const absPath = process.platform === 'win32' ? 'C:\\work\\report.pdf' : '/work/report.pdf';
    await expect(im.sendFile('owner-open', absPath)).resolves.toEqual({ ok: true });
    const call = calls.at(-1);
    expect(call?.args).toContain('--file');
    expect(call?.args).toContain('report.pdf');
    expect(call?.cwd).toBe(process.platform === 'win32' ? 'C:\\work' : '/work');
    await im.dispose();
  });

  it('commitFinal sends the text then managed media files', async () => {
    const { im, calls } = await connected();
    const before = calls.length;
    const absPath = process.platform === 'win32' ? 'C:\\media\\a.png' : '/media/a.png';
    await im.commitFinal({ userId: 'owner-open', text: '', terminal: 'done', mediaAbsPaths: [absPath] });
    const sends = calls.slice(before);
    expect(sends[0].args).toContain('✅ 本轮已完成，没有文本输出。');
    expect(sends[1].args).toContain('a.png');
    await im.dispose();
  });

  it('reports send failure for files without throwing', async () => {
    const { im, runner } = await connected();
    vi.mocked(runner.runJson).mockRejectedValueOnce(new DwsCommandError('x', 'boom'));
    const absPath = process.platform === 'win32' ? 'C:\\a.txt' : '/a.txt';
    await expect(im.sendFile('owner-open', absPath)).resolves.toEqual({ ok: false, reason: 'SEND_FAIL' });
    await im.dispose();
  });
});

describe('DingTalkDwsIM delivery retries', () => {
  const rateLimit = () => new DwsCommandError('RATE_LIMIT_ERROR', 'rate limited');

  it('retries only the rejected chunk, keeping its profile and idempotency key', async () => {
    const { im, runner } = await connected();
    vi.useFakeTimers();
    const run = vi.mocked(runner.runJson).mockClear();
    run.mockResolvedValueOnce({ success: true }).mockRejectedValueOnce(rateLimit());
    const pending = im.sendText('owner-open', 'a'.repeat(4_000));
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(run).toHaveBeenCalledTimes(3);
    expect(run.mock.calls[2]).toEqual(run.mock.calls[1]);
    expect(run.mock.calls[0][0].at(-1)).not.toBe(run.mock.calls[1][0].at(-1));
    expect(run.mock.calls[2][0]).toContain('corp-1:agent-user');
    await im.dispose();
  });

  it('reports failure after three retries and clears the hint after a successful send', async () => {
    const { im, runner } = await connected();
    vi.useFakeTimers();
    const run = vi.mocked(runner.runJson).mockClear().mockRejectedValue(rateLimit());
    const assertion = expect(im.sendText('owner-open', 'hello')).rejects.toMatchObject({
      code: 'RATE_LIMIT_ERROR',
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(run).toHaveBeenCalledTimes(2);
    expect(im.getPublicState().lastSendError).toBeNull();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(run).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
    expect(run).toHaveBeenCalledTimes(4);
    expect(new Set(run.mock.calls.map(([args]) => args.at(-1))).size).toBe(1);
    expect(im.getPublicState().lastSendError).toBe('rate_limited');
    run.mockResolvedValueOnce({ success: true });
    await im.sendText('owner-open', 'next reply');
    expect(im.getPublicState().lastSendError).toBeNull();
    await im.dispose();
  });

  it.each(['FORBIDDEN', 'empty_output', 'invalid_output', 'process_failed'])(
    'does not retry a permanent or ambiguous failure: %s',
    async (code) => {
      const { im, runner } = await connected();
      vi.useFakeTimers();
      const run = vi
        .mocked(runner.runJson)
        .mockClear()
        .mockRejectedValueOnce(new DwsCommandError(code, 'failed'));
      await expect(im.sendText('owner-open', 'hello')).rejects.toMatchObject({ code });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(run).toHaveBeenCalledTimes(1);
      expect(im.getPublicState().lastSendError).toBe('failed');
      await im.dispose();
      expect(im.getPublicState().lastSendError).toBeNull();
    },
  );

  it('retries a file without resending the preceding final text', async () => {
    const { im, runner } = await connected();
    vi.useFakeTimers();
    const run = vi.mocked(runner.runJson).mockClear();
    run.mockResolvedValueOnce({ success: true }).mockRejectedValueOnce(rateLimit());
    const absPath = process.platform === 'win32' ? 'C:\\media\\a.png' : '/media/a.png';
    const pending = im.commitFinal({
      userId: 'owner-open',
      text: 'done',
      terminal: 'done',
      mediaAbsPaths: [absPath],
    });
    await vi.advanceTimersByTimeAsync(5_000);
    await pending;
    expect(run).toHaveBeenCalledTimes(3);
    expect(run.mock.calls[0][0]).toContain('--markdown');
    expect(run.mock.calls[1][0]).toContain('--file');
    expect(run.mock.calls[2]).toEqual(run.mock.calls[1]);
    await im.dispose();
  });

  it('propagates final attachment failure instead of marking delivery complete', async () => {
    const { im, runner } = await connected();
    vi.mocked(runner.runJson)
      .mockResolvedValueOnce({ success: true })
      .mockRejectedValueOnce(new DwsCommandError('FORBIDDEN', 'failed'));
    const absPath = process.platform === 'win32' ? 'C:\\media\\a.png' : '/media/a.png';
    await expect(
      im.commitFinal({
        userId: 'owner-open',
        text: 'done',
        terminal: 'done',
        mediaAbsPaths: [absPath],
      }),
    ).rejects.toThrow('DINGTALK_DWS_FILE_SEND_FAILED');
    expect(im.getPublicState().lastSendError).toBe('failed');
    await im.dispose();
  });

  it('cancels a waiting retry when the channel stops', async () => {
    const { im, runner } = await connected();
    vi.useFakeTimers();
    const run = vi.mocked(runner.runJson).mockClear().mockRejectedValueOnce(rateLimit());
    const assertion = expect(im.sendText('owner-open', 'hello')).rejects.toThrow(
      'DINGTALK_DWS_CONNECTION_REPLACED',
    );
    await vi.advanceTimersByTimeAsync(0);
    await im.dispose();
    await assertion;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('does not schedule a retry when the channel stops during the failed command', async () => {
    const { im, runner } = await connected();
    vi.useFakeTimers();
    let reject!: (error: Error) => void;
    const run = vi
      .mocked(runner.runJson)
      .mockClear()
      .mockImplementationOnce(
        () =>
          new Promise((_, fail) => {
            reject = fail;
          }),
      );
    const assertion = expect(im.sendText('owner-open', 'hello')).rejects.toThrow(
      'DINGTALK_DWS_CONNECTION_REPLACED',
    );
    await im.dispose();
    reject(rateLimit());
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('does not retry or publish stale failure state into a different host account', async () => {
    const { im, host, runner } = await connected();
    let current = 'account-1';
    host.accountScope = {
      capture: () => current,
      isCurrent: (token) => token === current,
      run: async (_token, operation) => operation(),
    };
    vi.useFakeTimers();
    const run = vi.mocked(runner.runJson).mockClear().mockRejectedValueOnce(rateLimit());
    const assertion = expect(im.sendText('owner-open', 'hello')).rejects.toThrow('IM_NOT_READY');
    await vi.advanceTimersByTimeAsync(0);
    current = 'account-2';
    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;
    expect(run).toHaveBeenCalledTimes(1);
    expect(im.getPublicState().lastSendError).toBeNull();
    await im.dispose();
  });
});

describe('DingTalkDwsIM text interactions', () => {
  it('resolves a pending reply from the owner instead of emitting a message', async () => {
    const { im, streams, messages } = await connected();
    await bindOwner(im, streams[0]);
    const reply = im.requestTextReply('owner-open', '允许吗？', (text) =>
      text === '允许' ? 'allow' : null,
    );
    await flush();
    streams[0].emit(directEvent({ message_id: 'msg-2', content: '允许' }));
    await expect(reply).resolves.toBe('allow');
    expect(messages).toHaveLength(0);
    await im.dispose();
  });

  it('only the owner can answer a pending reply in a group lane', async () => {
    const { im, streams, messages } = await connected();
    await bindOwner(im, streams[0]);
    const lane = encodeLaneUserId('cid-group');
    let settled = false;
    const reply = im
      .requestTextReply(lane, '允许吗？', (text) => (text === '允许' ? 'allow' : null))
      .finally(() => {
        settled = true;
      });
    await flush();
    streams[0].emit({
      type: DWS_EVENT_MENTION,
      event_id: 'evt-x',
      message_id: 'msg-x',
      conversation_id: 'cid-group',
      sender: '同事',
      sender_open_dingtalk_id: 'colleague',
      content: '允许',
    });
    await flush();
    expect(settled).toBe(false);
    expect(messages).toHaveLength(0);
    streams[0].emit({
      type: DWS_EVENT_MENTION,
      event_id: 'evt-y',
      message_id: 'msg-y',
      conversation_id: 'cid-group',
      sender: '张三',
      sender_open_dingtalk_id: 'owner-open',
      content: '允许',
    });
    await expect(reply).resolves.toBe('allow');
    await im.dispose();
  });

  it('rejects pending replies on disconnect', async () => {
    const { im } = await connected();
    const reply = im.requestTextReply('owner-open', '允许吗？', () => 'x');
    await flush();
    await im.disable();
    await expect(reply).rejects.toThrow('DINGTALK_DISCONNECTED');
  });
});

describe('DingTalkDwsIM group history', () => {
  it('reads recent messages in chronological order', async () => {
    const { im, history, calls } = await connected();
    history.push({
      messages: [
        { messageId: 'm2', sender: 'B', senderId: 'b', text: 'second', createTime: '2026-10-05 10:02:00' },
        { messageId: 'm1', sender: 'A', senderId: 'a', text: 'first', createTime: '2026-10-05 10:01:00' },
        { messageId: 'm3', sender: 'C', senderId: 'c', text: '', createTime: '2026-10-05 10:03:00' },
      ],
    });
    const result = await im.fetchRecentGroupMessages('cid-group', 30);
    // 无文字的消息也保留（可能是纯图片，附件随后挂上）；未要求资源时不下载。
    expect(result.map((m) => m.text)).toEqual(['first', 'second', '']);
    expect(result.every((m) => m.attachments.length === 0)).toBe(true);
    expect(calls.at(-1)?.args).toEqual([
      'chat',
      '+chat-messages',
      '--open-conversation-id',
      'cid-group',
      '--limit',
      '30',
      '--no-reactions',
      '-f',
      'json',
    ]);
    await im.dispose();
  });
});

describe('DingTalkDwsIM probe', () => {
  it('reports not installed without spawning anything', async () => {
    const { host, secrets } = makeHost();
    secrets.delete('dingtalk-dws-enabled');
    const { runner } = makeRunner({ available: false });
    vi.mocked(runner.runJson).mockRejectedValue(new Error(DWS_NOT_INSTALLED));
    const im = new DingTalkDwsIM(host, runner);
    await expect(im.probe()).resolves.toMatchObject({ installed: false, identity: null, enabled: false });
    expect(runner.spawnStream).not.toHaveBeenCalled();
  });
});
