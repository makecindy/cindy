/**
 * Plugin engine process ↔ ACP line transport (docs/plans/acp-plugin-bridge.md).
 *
 * 测试价值
 * - 生产入口与可观察结果：createAcpProcessTransport（每个插件引擎任务的 stdio 通道）；断言写入插件
 *   入口 stdin 的字节、收到的协议行、断链原因，以及 close() 只在进程确认退出后才 resolve。
 * - 规则依据：设计稿「引擎进程」约定（原样 stdio 子进程，stdin 为 base64 分块）；Maker 启动失败清理
 *   契约（close 成功即退出证明，见 docs/dev-rules/maker-core-and-agent-behavior.md「启动失败与工作目录占用」）。
 * - 现有覆盖缺口：新模块；原样 stdio 子进程的 stdin 按帧收 base64，单帧超过 2 MiB 会被
 *   插件进程整段丢弃（apps/desktop/src/main/cindy-brain/nodeRuntimeWorkerProcess.ts）。
 * - 最小失败输入：被切开的多字节字符；进程不响应 stdin 关闭；1.33 MB 图片所在的一条 ACP 消息
 *   （两次 base64 后约 2.48 MB，修前只写一帧，接收端丢弃）。
 * - tier：unit（内存假进程，fake timers，无真实子进程）。
 */

import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createConsoleLogger } from '@cindy/maker-core';
import type { NodeWorkerProcess } from '../../cindy-brain/nodeRuntimeBroker.js';
import { createAcpProcessTransport } from '../acp-transport.js';

function fakeProcess(options: { exitOnStdinEnd?: boolean; exitOnKill?: 'SIGTERM' | 'SIGKILL' | 'never' } = {}) {
  const events = new EventEmitter();
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const stdinWrites: string[] = [];
  const controls: unknown[] = [];
  const kills: Array<string | undefined> = [];
  const exit = (code: number | null) => events.emit('exit', code, null);
  const proc = {
    stdin: { destroyed: false, write: (chunk: string) => { stdinWrites.push(chunk); return true; } },
    stdout,
    stderr,
    on(event: string, listener: (...args: unknown[]) => void) { events.on(event, listener); return proc; },
    once(event: string, listener: (...args: unknown[]) => void) { events.once(event, listener); return proc; },
    kill(signal?: string) {
      kills.push(signal);
      const exitOn = options.exitOnKill ?? 'SIGTERM';
      if (exitOn !== 'never' && (exitOn === 'SIGTERM' || signal === 'SIGKILL')) queueMicrotask(() => exit(null));
      return true;
    },
    sendControl(message: unknown) {
      controls.push(message);
      if (options.exitOnStdinEnd) queueMicrotask(() => exit(0));
      return true;
    },
  };
  return { proc: proc as unknown as NodeWorkerProcess, stdout, stderr, stdinWrites, controls, kills, exit };
}

const logger = createConsoleLogger('acp-transport-test');

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('createAcpProcessTransport', () => {
  it('frames writes as base64 lines and splits stdout chunks into whole lines', () => {
    const fake = fakeProcess();
    const transport = createAcpProcessTransport(fake.proc, logger);
    const lines: string[] = [];
    transport.onLine((line) => lines.push(line));

    transport.write('{"jsonrpc":"2.0","id":1,"method":"initialize"}');
    expect(Buffer.from(fake.stdinWrites[0]!, 'base64').toString('utf8')).toBe('{"jsonrpc":"2.0","id":1,"method":"initialize"}\n');

    const bytes = Buffer.from('{"text":"你好"}\r\n{"b":1}\n', 'utf8');
    fake.stdout.emit('data', bytes.subarray(0, 11)); // cuts inside a multi-byte character
    fake.stdout.emit('data', bytes.subarray(11));
    expect(lines).toEqual(['{"text":"你好"}', '{"b":1}']);
  });

  it('splits an oversized ACP line into base64 frames the worker accepts', () => {
    const fake = fakeProcess();
    const transport = createAcpProcessTransport(fake.proc, logger);
    // 会话续聊带一张约 1.33 MB 的 PNG：图片先内嵌进 ACP 行，整行再 base64，约 2.48 MB。
    // 修前只写一帧，超过插件进程 2 MiB 的帧上限后被整段丢弃，引擎收不到这一轮。
    const line = JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/prompt',
      params: { content: [{ type: 'image', data: 'A'.repeat(1_800_000) }] },
    });
    transport.write(line);

    expect(fake.stdinWrites.length).toBeGreaterThan(1);
    for (const frame of fake.stdinWrites) expect(frame.length).toBeLessThanOrEqual(2 * 1024 * 1024);
    const decoded = Buffer.concat(fake.stdinWrites.map((frame) => Buffer.from(frame, 'base64')));
    expect(decoded.equals(Buffer.from(`${line}\n`, 'utf8'))).toBe(true);
  });

  it('reports an endpoint exit as peer-exited and refuses later writes', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fake = fakeProcess();
    const transport = createAcpProcessTransport(fake.proc, logger);
    const closed = new Promise((resolve) => transport.onClose(resolve));
    fake.stderr.emit('data', Buffer.from('dsh: model not configured\n'));
    fake.exit(1);
    await expect(closed).resolves.toEqual({ reason: 'peer-exited', detail: 'exit 1' });
    expect(() => transport.write('{}')).toThrow('not running');
  });

  it('close() ends stdin and resolves only after the endpoint exited', async () => {
    const fake = fakeProcess({ exitOnStdinEnd: true });
    const transport = createAcpProcessTransport(fake.proc, logger);
    const closed = new Promise((resolve) => transport.onClose(resolve));
    await transport.close();
    expect(fake.controls).toEqual([{ type: 'stdin-end' }]);
    expect(fake.kills).toEqual([]);
    await expect(closed).resolves.toMatchObject({ reason: 'closed-by-client' });
  });

  it('escalates to terminate and force-kill, and fails when no exit is ever confirmed', async () => {
    vi.useFakeTimers();
    const stubborn = fakeProcess({ exitOnKill: 'SIGKILL' });
    const stubbornClose = createAcpProcessTransport(stubborn.proc, logger).close();
    await vi.advanceTimersByTimeAsync(6_000);
    await expect(stubbornClose).resolves.toBeUndefined();
    expect(stubborn.kills).toEqual([undefined, 'SIGKILL']);

    const stuck = fakeProcess({ exitOnKill: 'never' });
    const stuckClose = createAcpProcessTransport(stuck.proc, logger).close();
    const outcome = expect(stuckClose).rejects.toThrow('did not exit');
    await vi.advanceTimersByTimeAsync(9_000);
    await outcome;
  });
});
