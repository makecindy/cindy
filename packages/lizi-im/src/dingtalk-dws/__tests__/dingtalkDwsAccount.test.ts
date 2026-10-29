import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { IMHost, IMMessageEvent } from '../../types.js';
import { DingTalkDwsIM } from '../index.js';
import { DWS_EVENT_DIRECT } from '../events.js';
import type { DwsRunner, DwsStreamProcess } from '../runner.js';

/** 事件流桩：可手动 ready / 退出，用来模拟断线重连。 */
class FakeStream implements DwsStreamProcess {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  private readonly events = new EventEmitter();
  private exited = false;
  closeStdin(): void {
    this.exit(0);
  }
  forceKill(): void {
    this.exit(null);
  }
  onExit(handler: (code: number | null) => void): void {
    if (this.exited) handler(0);
    else this.events.once('exit', handler);
  }
  onError(handler: (error: Error) => void): void {
    this.events.once('error', handler);
  }
  ready(): void {
    this.stderr.write('[event] ready event_count=2\n');
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

function identity(userId: string, userName: string) {
  return {
    authenticated: true,
    token_valid: true,
    corp_id: 'corp',
    corp_name: 'Org',
    user_id: userId,
    user_name: userName,
  };
}

function setup() {
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
  let login = identity('agent-a', '账号 A');
  const streams: FakeStream[] = [];
  const runner: DwsRunner = {
    isAvailable: async () => true,
    runJson: vi.fn(async (args: readonly string[]) => (args[0] === 'auth' ? login : { success: true })),
    spawnStream: vi.fn(() => {
      const stream = new FakeStream();
      streams.push(stream);
      setTimeout(() => stream.ready(), 0);
      return stream;
    }),
  };
  const im = new DingTalkDwsIM(host, runner);
  const messages: IMMessageEvent[] = [];
  im.onMessage((event) => messages.push(event));
  return {
    im,
    secrets,
    streams,
    messages,
    switchLogin: (userId: string, userName: string) => {
      login = identity(userId, userName);
    },
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

function ownerDm(stream: FakeStream, content: string, id: string) {
  stream.emit({
    type: DWS_EVENT_DIRECT,
    event_id: id,
    message_id: id,
    conversation_id: 'cid-dm',
    sender: '张三',
    sender_open_dingtalk_id: 'owner-open',
    content,
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('DingTalkDwsIM account changes', () => {
  it('drops the old owner binding when dws switches account during a reconnect', async () => {
    const ctx = setup();
    await ctx.im.init();
    ownerDm(ctx.streams[0], ctx.im.getPublicState().pairingCode!, 'pair');
    await flush();
    expect(ctx.im.getPublicState().ownerName).toBe('张三');

    // 断线期间用户在终端换了 dws 登录账号。
    ctx.switchLogin('agent-b', '账号 B');
    vi.useFakeTimers();
    ctx.streams[0].exit(1);
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(1);
    vi.useRealTimers();
    await flush();

    expect(ctx.streams).toHaveLength(2);
    expect(ctx.im.contextId).toBe('corp:agent-b');
    // 旧主人绑定被清掉，新账号需要重新配对。
    expect(ctx.im.getPublicState()).toMatchObject({ ownerName: null, identity: { userName: '账号 B' } });
    expect(ctx.im.getPublicState().pairingCode).toMatch(/^\d{6}$/);
    expect(ctx.secrets.has('dingtalk-dws-owner')).toBe(false);

    // 旧主人的消息在新账号下不再被当作主人消息。
    ownerDm(ctx.streams[1], '你好', 'after-switch');
    await flush();
    expect(ctx.messages).toHaveLength(0);
    await ctx.im.dispose();
  });

  it('keeps the owner when the reconnect finds the same account', async () => {
    const ctx = setup();
    await ctx.im.init();
    ownerDm(ctx.streams[0], ctx.im.getPublicState().pairingCode!, 'pair');
    await flush();
    vi.useFakeTimers();
    ctx.streams[0].exit(1);
    await vi.advanceTimersByTimeAsync(2_001);
    vi.useRealTimers();
    await flush();
    expect(ctx.im.getPublicState().ownerName).toBe('张三');
    ownerDm(ctx.streams[1], '你好', 'same-account');
    await flush();
    expect(ctx.messages).toHaveLength(1);
    await ctx.im.dispose();
  });

  it('does not let a probe swap the identity while the stream is reconnecting', async () => {
    const ctx = setup();
    await ctx.im.init();
    ownerDm(ctx.streams[0], ctx.im.getPublicState().pairingCode!, 'pair');
    await flush();
    ctx.switchLogin('agent-b', '账号 B');
    vi.useFakeTimers();
    ctx.streams[0].exit(1);
    // 重连计时中，设置页触发了一次探测。
    const state = await ctx.im.probe();
    expect(state.identity).toEqual({ corpName: 'Org', userName: '账号 A' });
    expect(state.ownerName).toBe('张三');
    vi.useRealTimers();
    await ctx.im.dispose();
  });

  it('treats a stored owner from another account as unbound', async () => {
    const ctx = setup();
    ctx.secrets.set(
      'dingtalk-dws-owner',
      JSON.stringify({ contextId: 'corp:someone-else', openId: 'owner-open', name: '张三' }),
    );
    await ctx.im.init();
    ownerDm(ctx.streams[0], '你好', 'stale-owner');
    await flush();
    expect(ctx.messages).toHaveLength(0);
    expect(ctx.im.getPublicState().ownerName).toBeNull();
    await ctx.im.dispose();
  });
});
