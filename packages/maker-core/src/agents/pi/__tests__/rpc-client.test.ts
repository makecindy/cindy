/**
 * PiRpcProcess 单元测试 —— fake transport 驱动 handleStdoutLine 的协议语义。
 *
 * 重点覆盖轮 40-w4-t4 CRITICAL:response envelope 集中校验 —— success 必须
 * boolean、command 必须匹配 pending request, 畸形/不匹配响应 reject 而非
 * resolve(防 get_state 失败被当成启动成功 + 伪 session id)。
 */

import { describe, expect, it, vi } from 'vitest';

import {
  PiRpcProcess,
  PiRpcRequestTimeoutError,
  type PiRpcSpawnOptions,
} from '../rpc-client.js';
import type { PiTransport, PiLineHandler, PiCloseHandler } from '../transport.js';

// ── Fake transport:捕获 writeLine,手动触发 onLine/onClose ─────────────
function makeFakeTransport() {
  const written: Array<{ line: string; resolve: () => void; reject: (e: Error) => void }> = [];
  let lineHandler: PiLineHandler | undefined;
  let closeHandler: PiCloseHandler | undefined;
  const transport = {
    writeLine: vi.fn((line: string) => {
      return new Promise<void>((resolve, reject) => {
        written.push({ line, resolve, reject });
      });
    }),
    onLine: vi.fn((h: PiLineHandler) => { lineHandler = h; return () => { lineHandler = undefined; }; }),
    onClose: vi.fn((h: PiCloseHandler) => { closeHandler = h; return () => { closeHandler = undefined; }; }),
    onStderr: vi.fn(() => () => undefined),
    close: vi.fn(async () => { closeHandler?.({ code: 0, signal: null, reason: 'test close' }); }),
    isClosed: vi.fn(() => false),
    get pid() { return 1234; },
  } as unknown as PiTransport;
  const emitLine = (line: string) => lineHandler?.(line);
  const drain = () => {
    for (const w of written.splice(0)) w.resolve();
  };
  return { transport, emitLine, drain, written };
}

function makeProc(overrides: Partial<PiRpcSpawnOptions> = {}) {
  const logger = {
    debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    child: () => logger,
  };
  const onEvent = vi.fn();
  const onExit = vi.fn();
  const proc = new PiRpcProcess({
    transport: undefined as never,
    logger,
    onEvent,
    onExit,
    ...overrides,
  });
  return { proc, logger, onEvent, onExit };
}

describe('PiRpcProcess response envelope validation', () => {
  it('resolves a well-formed response (success boolean + matching command)', async () => {
    const { transport, emitLine } = makeFakeTransport();
    const { proc } = makeProc({ transport });

    const p = proc.request({ type: 'get_state' });
    const sent = transport.writeLine.mock.calls[0][0] as string;
    const sentFrame = JSON.parse(sent) as { id: string; type: string };
    emitLine(JSON.stringify({
      type: 'response', id: sentFrame.id, command: 'get_state', success: true,
      data: { sessionFile: '/sessions/abc.jsonl' },
    }));

    const resp = await p;
    expect(resp.success).toBe(true);
    expect(resp.data?.sessionFile).toBe('/sessions/abc.jsonl');
  });

  it('rejects when success is not a boolean (round 40-w4-t4 CRITICAL)', async () => {
    const { transport, emitLine } = makeFakeTransport();
    const { proc } = makeProc({ transport });

    const p = proc.request({ type: 'get_state' });
    const sentFrame = JSON.parse(transport.writeLine.mock.calls[0][0] as string) as { id: string };
    emitLine(JSON.stringify({
      type: 'response', id: sentFrame.id, command: 'get_state', success: 'yes',
      data: { sessionFile: '/sessions/abc.jsonl' },
    }));

    await expect(p).rejects.toThrow(/missing boolean success/);
  });

  it('rejects when response command mismatches pending request (round 40-w4-t4 CRITICAL)', async () => {
    const { transport, emitLine } = makeFakeTransport();
    const { proc } = makeProc({ transport });

    const p = proc.request({ type: 'get_state' });
    const sentFrame = JSON.parse(transport.writeLine.mock.calls[0][0] as string) as { id: string };
    // 语义失败但 success:true 的畸形帧 —— 必须 reject, 不能 resolve 成 get_state 成功。
    emitLine(JSON.stringify({
      type: 'response', id: sentFrame.id, command: 'prompt', success: true, data: {},
    }));

    await expect(p).rejects.toThrow(/command mismatch/);
  });

  it('still resolves success:false (caller decides) — but envelope is intact', async () => {
    const { transport, emitLine } = makeFakeTransport();
    const { proc } = makeProc({ transport });

    const p = proc.request({ type: 'prompt' });
    const sentFrame = JSON.parse(transport.writeLine.mock.calls[0][0] as string) as { id: string };
    emitLine(JSON.stringify({
      type: 'response', id: sentFrame.id, command: 'prompt', success: false, error: 'session load failed',
    }));

    const resp = await p;
    expect(resp.success).toBe(false);
    expect(resp.error).toBe('session load failed');
  });

  it('reports request timeouts with a stable command-aware error', async () => {
    vi.useFakeTimers();
    try {
      const { transport } = makeFakeTransport();
      const { proc } = makeProc({ transport });

      const pending = proc.request({ type: 'prompt' }, { timeoutMs: 75_000 });
      const rejected = expect(pending).rejects.toEqual(expect.objectContaining({
        name: 'PiRpcRequestTimeoutError',
        code: 'PI_RPC_TIMEOUT',
        commandType: 'prompt',
        timeoutMs: 75_000,
      } satisfies Partial<PiRpcRequestTimeoutError>));
      await vi.advanceTimersByTimeAsync(75_000);

      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });

  it('refreshes a request idle timeout on matching progress events', async () => {
    vi.useFakeTimers();
    try {
      const { transport, emitLine, written } = makeFakeTransport();
      const { proc } = makeProc({ transport });
      const pending = proc.request(
        { type: 'prompt' },
        {
          timeoutMs: 100,
          refreshTimeoutOnEvent: (event) => event.type === 'compaction_start',
        },
      );
      const sentFrame = JSON.parse(written[0]!.line) as { id: string };

      await vi.advanceTimersByTimeAsync(90);
      emitLine(JSON.stringify({ type: 'compaction_start', reason: 'threshold' }));
      await vi.advanceTimersByTimeAsync(90);
      emitLine(JSON.stringify({
        type: 'response',
        id: sentFrame.id,
        command: 'prompt',
        success: true,
      }));

      await expect(pending).resolves.toMatchObject({ success: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('unmatched response (late/wrong id) is dropped with a warn, not resolved', async () => {
    const { transport, emitLine } = makeFakeTransport();
    const { proc, logger } = makeProc({ transport });

    const p = proc.request({ type: 'get_state' });
    emitLine(JSON.stringify({
      type: 'response', id: 'c999', command: 'get_state', success: true, data: {},
    }));

    // 迟到/错 id:不 resolve, 只 warn;原 pending 仍等(测试后清理)。
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('unmatched response'), expect.anything());
    // 防止测试悬挂:关掉 proc 触发 failAllPending。
    await proc.close();
    await expect(p).rejects.toThrow(/pi process exited/);
  });
});

describe('PiRpcProcess close semantics (bridge-disconnect vs explicit close)', () => {
  it('still kills the remote session when the bridge closed first (onClose)', async () => {
    // 轮 42 P2(codex-connector):bridge 断链(onClose 置 closed)后, 用户显式
    // close() 仍必须执行 killRemoteSession —— 它走独立 SSH RPC 可送达 daemon;
    // 复用 closed 做 close() 守卫会让显式关闭直接 return, 远端 pi 带凭证跑到
    // idle 回收。成功 close 的共享 Promise 跟踪「已经明确关闭」。
    const killRemoteSession = vi.fn(async () => {});
    const { transport } = makeFakeTransport();
    const { proc } = makeProc({ transport });
    (transport as unknown as { killRemoteSession: unknown }).killRemoteSession = killRemoteSession;

    // 模拟 SSH 断链: transport 触发 onClose(bridge 死)。
    const closeHandler = (transport.onClose as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as (info: { code: number | null; signal: string | null }) => void;
    closeHandler({ code: null, signal: null });
    expect(proc.isClosed).toBe(true);

    // 用户显式关闭: 必须 kill 远端(不能因 closed 跳过)。
    await proc.close();
    expect(killRemoteSession).toHaveBeenCalledTimes(1);

    // 重复 close 幂等: 不再二次 kill。
    await proc.close();
    expect(killRemoteSession).toHaveBeenCalledTimes(1);
  });

  it('retries transport shutdown after an unconfirmed local close', async () => {
    const { transport } = makeFakeTransport();
    const transportClose = vi.mocked(transport.close);
    transportClose
      .mockRejectedValueOnce(new Error('pi process did not confirm exit after SIGKILL'))
      .mockResolvedValueOnce(undefined);
    const { proc } = makeProc({ transport });

    await expect(proc.close()).rejects.toThrow(/did not confirm exit after SIGKILL/);
    await expect(proc.close()).resolves.toBeUndefined();

    expect(transportClose).toHaveBeenCalledTimes(2);
  });

  it('retries remote termination after a failed close instead of reporting false success', async () => {
    const killRemoteSession = vi
      .fn()
      .mockRejectedValueOnce(new Error('relay offline'))
      .mockResolvedValueOnce(undefined);
    const { transport } = makeFakeTransport();
    const { proc } = makeProc({ transport });
    (transport as unknown as { killRemoteSession: unknown }).killRemoteSession = killRemoteSession;

    await expect(proc.close()).rejects.toThrow(/remote daemon session may still be running/);
    await expect(proc.close()).resolves.toBeUndefined();

    expect(killRemoteSession).toHaveBeenCalledTimes(2);
  });
});
