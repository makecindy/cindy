/**
 * RemoteHost.exec maxOutputBytes 源头截断测试。
 *
 * 用 fake ssh2 Client（EventEmitter channel）注入私有字段驱动 exec：验证
 * 越界即停止缓冲、teardown 远端命令（signal+close 兜底）、resolve 带
 * truncated 标记，以及未设 cap 时保持旧行为。
 */

import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';

import { RemoteHost } from '../RemoteHost.js';
import type { HostConfig } from '../types.js';

class FakeChannel extends EventEmitter {
  stderr = new EventEmitter();
  signals: string[] = [];
  closed = false;

  signal(sig: string): void {
    this.signals.push(sig);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    // 模拟 sshd:close 之后 channel 触发 'close' 事件(exitCode null / SIGHUP 语义简化为 null)。
    queueMicrotask(() => this.emit('close', null, null));
  }

  write(): void {}
  end(): void {}
}

const HOST_CONFIG: HostConfig = {
  id: 'test-host',
  hostname: '10.0.0.1',
  port: 22,
  user: 'deploy',
  authMethod: 'agent',
  source: 'manual',
  managedByCindy: false,
};

const noopLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** 构造一个状态 ready、client 为 fake 的 RemoteHost，返回 host + 最近一次 exec 的 channel。 */
function makeHostWithFakeExec(): { host: RemoteHost; channels: FakeChannel[] } {
  const host = new RemoteHost(HOST_CONFIG, { logger: noopLogger });
  const channels: FakeChannel[] = [];
  const fakeClient = {
    exec: (
      _cmd: string,
      _opts: unknown,
      cb: (err: Error | undefined, channel: FakeChannel) => void,
    ) => {
      const ch = new FakeChannel();
      channels.push(ch);
      queueMicrotask(() => cb(undefined, ch));
    },
  };
  // 测试注入:exec 只经 requireReady 读 status + client 两个私有字段。
  (host as unknown as { status: string }).status = 'ready';
  (host as unknown as { client: unknown }).client = fakeClient;
  return { host, channels };
}

async function flushMicrotasks(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

describe('RemoteHost.exec maxOutputBytes', () => {
  it('caps stdout at the byte limit, tears down the command, resolves truncated', async () => {
    const { host, channels } = makeHostWithFakeExec();
    const pending = host.exec('cat big.log', { maxOutputBytes: 10 });
    await flushMicrotasks();
    const ch = channels[0];

    ch.emit('data', Buffer.from('0123456789ABCDEF')); // 16 bytes > cap 10
    const result = await pending;

    expect(result.truncated).toBe(true);
    expect(result.stdout).toBe('0123456789'); // 精确切到 cap
    expect(ch.signals).toContain('TERM');
    expect(ch.closed).toBe(true);
  });

  it('stops buffering further chunks after the cap', async () => {
    const { host, channels } = makeHostWithFakeExec();
    const pending = host.exec('yes', { maxOutputBytes: 4 });
    await flushMicrotasks();
    const ch = channels[0];

    ch.emit('data', Buffer.from('aaaa'));
    ch.emit('data', Buffer.from('bbbb')); // cap 已满,该 chunk 触发 teardown 且不入缓冲
    const result = await pending;

    expect(result.truncated).toBe(true);
    expect(result.stdout).toBe('aaaa');
  });

  it('caps stderr independently from stdout', async () => {
    const { host, channels } = makeHostWithFakeExec();
    const pending = host.exec('noisy', { maxOutputBytes: 5 });
    await flushMicrotasks();
    const ch = channels[0];

    ch.emit('data', Buffer.from('out')); // 3 bytes,stdout 未越界
    ch.stderr.emit('data', Buffer.from('0123456789')); // stderr 越界
    const result = await pending;

    expect(result.truncated).toBe(true);
    expect(result.stdout).toBe('out');
    expect(result.stderr).toBe('01234');
  });

  it('without maxOutputBytes keeps legacy unbounded behavior (no truncated flag)', async () => {
    const { host, channels } = makeHostWithFakeExec();
    const pending = host.exec('probe --version');
    await flushMicrotasks();
    const ch = channels[0];

    ch.emit('data', Buffer.from('v1.2.3\n'));
    ch.emit('close', 0, null);
    const result = await pending;

    expect(result.truncated).toBeUndefined();
    expect(result.stdout).toBe('v1.2.3\n');
    expect(result.exitCode).toBe(0);
    expect(ch.signals).toEqual([]);
  });

  it('output exactly at the cap is kept intact without teardown', async () => {
    const { host, channels } = makeHostWithFakeExec();
    const pending = host.exec('probe', { maxOutputBytes: 4 });
    await flushMicrotasks();
    const ch = channels[0];

    ch.emit('data', Buffer.from('abcd')); // == cap,不越界
    ch.emit('close', 0, null);
    const result = await pending;

    expect(result.truncated).toBeUndefined();
    expect(result.stdout).toBe('abcd');
    expect(ch.signals).toEqual([]);
  });
});
