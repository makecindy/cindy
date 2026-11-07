/**
 * PrimeAgentRpcProcess 单元测试 —— fake transport 驱动协议语义。
 *
 * 覆盖 Prime Agent 特有的信封契约:
 *   - `success` 必须是 boolean, `command` 必须回带且匹配(crates/pa-daemon/src/rpc/
 *     protocol.rs:24-50)
 *   - `data` 键可整个缺失(`ResponseData::Absent`, protocol.rs:8-13) —— 调用方不能
 *     把「没有 data」当成失败
 *   - `error` 是字符串(protocol.rs:48)
 *   - parse error 帧**不带 id**(protocol.rs:76-89) —— 不能误伤合法 pending request
 *   - 请求 id 自增关联 `c1`, `c2`, …
 */

import { describe, expect, it, vi } from 'vitest';

import {
  PRIME_AGENT_RPC_OVERSIZED_FRAME_ERROR,
  PrimeAgentRpcProcess,
  PrimeAgentRpcRequestTimeoutError,
  type PrimeAgentRpcSpawnOptions,
} from '../rpc-client.js';
import type {
  PrimeAgentCloseHandler,
  PrimeAgentLineHandler,
  PrimeAgentOversizedFrameHandler,
  PrimeAgentTransport,
} from '../transport.js';

function makeFakeTransport() {
  const written: Array<{ line: string; resolve: () => void; reject: (e: Error) => void }> = [];
  let lineHandler: PrimeAgentLineHandler | undefined;
  let closeHandler: PrimeAgentCloseHandler | undefined;
  let oversizedHandler: PrimeAgentOversizedFrameHandler | undefined;
  const transport = {
    writeLine: vi.fn((line: string) => new Promise<void>((resolve, reject) => {
      written.push({ line, resolve, reject });
    })),
    onLine: vi.fn((h: PrimeAgentLineHandler) => {
      lineHandler = h;
      return () => { lineHandler = undefined; };
    }),
    onClose: vi.fn((h: PrimeAgentCloseHandler) => {
      closeHandler = h;
      return () => { closeHandler = undefined; };
    }),
    onOversizedFrame: vi.fn((h: PrimeAgentOversizedFrameHandler) => {
      oversizedHandler = h;
      return () => { oversizedHandler = undefined; };
    }),
    onStderr: vi.fn(() => () => undefined),
    close: vi.fn(async () => { closeHandler?.({ code: 0, signal: null, reason: 'test close' }); }),
    isClosed: vi.fn(() => false),
    get pid() { return 4242; },
  } satisfies PrimeAgentTransport;
  const emitLine = (line: string) => lineHandler?.(line);
  const emitOversized = () => oversizedHandler?.();
  const drain = () => {
    for (const w of written.splice(0)) w.resolve();
  };
  return { transport, emitLine, emitOversized, drain, written };
}

function makeProc(overrides: Partial<PrimeAgentRpcSpawnOptions> = {}) {
  const logger = {
    trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn(),
    child: () => logger,
  };
  const onEvent = vi.fn();
  const onExit = vi.fn();
  const proc = new PrimeAgentRpcProcess({
    transport: undefined as never,
    logger,
    onEvent,
    onExit,
    ...overrides,
  });
  return { proc, logger, onEvent, onExit };
}

describe('PrimeAgentRpcProcess request/response correlation', () => {
  it('assigns incrementing c1, c2, … ids on the wire', async () => {
    const { transport, written, drain } = makeFakeTransport();
    const { proc } = makeProc({ transport });

    // 故意不 await: 只验证写出去的帧形态与 id 序列。
    // 但 close() 会经 failAllPending 拒绝这两个 pending —— 必须挂 catch，
    // 否则 Node 报 unhandled rejection。生产代码里每个 request 都是 await 的，
    // 没有这个 fire-and-forget 模式。
    void proc.request({ type: 'get_state' }).catch(() => undefined);
    void proc.request({ type: 'get_state' }).catch(() => undefined);
    const firstFrame = JSON.parse(written[0]!.line) as { id: string; type: string };
    const secondFrame = JSON.parse(written[1]!.line) as { id: string; type: string };
    expect(firstFrame).toMatchObject({ id: 'c1', type: 'get_state' });
    expect(secondFrame).toMatchObject({ id: 'c2', type: 'get_state' });

    drain();
    await proc.close();
  });

  it('resolves a well-formed response and preserves a data-less envelope', async () => {
    const { transport, emitLine, drain } = makeFakeTransport();
    const { proc } = makeProc({ transport });

    const pending = proc.request({ type: 'prompt', message: 'hi' });
    drain();
    const sent = JSON.parse(
      (transport.writeLine.mock.calls[0]![0]) as string,
    ) as { id: string };
    // Prime Agent 的 prompt 应答就是无 data 键的成功帧(protocol.rs:32-34)。
    emitLine(JSON.stringify({
      type: 'response', id: sent.id, command: 'prompt', success: true,
    }));

    const resp = await pending;
    expect(resp.success).toBe(true);
    expect('data' in resp).toBe(false);
  });

  it('keeps a JSON null data distinct from an absent data key', async () => {
    const { transport, emitLine, drain } = makeFakeTransport();
    const { proc } = makeProc({ transport });

    const pending = proc.request({ type: 'cycle_model' });
    drain();
    const sent = JSON.parse((transport.writeLine.mock.calls[0]![0]) as string) as { id: string };
    // `cycle_model` 在候选不足时答 ResponseData::Present(Value::Null)
    // (crates/pa-daemon/src/rpc/model_commands.rs:120-122)。
    emitLine(JSON.stringify({
      type: 'response', id: sent.id, command: 'cycle_model', success: true, data: null,
    }));

    const resp = await pending;
    expect('data' in resp).toBe(true);
    expect(resp.data).toBeNull();
  });

  it('rejects when success is not a boolean', async () => {
    const { transport, emitLine, drain } = makeFakeTransport();
    const { proc } = makeProc({ transport });

    const pending = proc.request({ type: 'get_state' });
    drain();
    const sent = JSON.parse((transport.writeLine.mock.calls[0]![0]) as string) as { id: string };
    emitLine(JSON.stringify({
      type: 'response', id: sent.id, command: 'get_state', success: 'yes', data: {},
    }));

    await expect(pending).rejects.toThrow(/missing boolean success/);
  });

  it('rejects when the response command mismatches the pending request', async () => {
    const { transport, emitLine, drain } = makeFakeTransport();
    const { proc } = makeProc({ transport });

    const pending = proc.request({ type: 'get_state' });
    drain();
    const sent = JSON.parse((transport.writeLine.mock.calls[0]![0]) as string) as { id: string };
    // 语义失败但 success:true 的畸形帧 —— 必须 reject, 不能 resolve 成 get_state 成功。
    emitLine(JSON.stringify({
      type: 'response', id: sent.id, command: 'prompt', success: true, data: {},
    }));

    await expect(pending).rejects.toThrow(/command mismatch/);
  });

  it('rejects when the response omits a command (malformed envelope)', async () => {
    const { transport, emitLine, drain } = makeFakeTransport();
    const { proc } = makeProc({ transport });

    const pending = proc.request({ type: 'get_state' });
    drain();
    const sent = JSON.parse((transport.writeLine.mock.calls[0]![0]) as string) as { id: string };
    // Prime Agent 的响应**总是**回带 command(protocol.rs:31/45)。缺失说明这帧
    // 畸形, 不能当成合法响应 resolve 给调用方。
    emitLine(JSON.stringify({
      type: 'response', id: sent.id, success: true, data: {},
    }));

    await expect(pending).rejects.toThrow(/missing a string command/);
  });

  it('rejects when the response command is not a string', async () => {
    const { transport, emitLine, drain } = makeFakeTransport();
    const { proc } = makeProc({ transport });

    const pending = proc.request({ type: 'get_state' });
    drain();
    const sent = JSON.parse((transport.writeLine.mock.calls[0]![0]) as string) as { id: string };
    emitLine(JSON.stringify({
      type: 'response', id: sent.id, command: 42, success: true, data: {},
    }));

    await expect(pending).rejects.toThrow(/missing a string command/);
  });

  it('still resolves success:false with a string error (caller decides)', async () => {
    const { transport, emitLine, drain } = makeFakeTransport();
    const { proc } = makeProc({ transport });

    const pending = proc.request({ type: 'compact' });
    drain();
    const sent = JSON.parse((transport.writeLine.mock.calls[0]![0]) as string) as { id: string };
    emitLine(JSON.stringify({
      type: 'response',
      id: sent.id,
      command: 'compact',
      success: false,
      error: 'Session is too short to compact — try again once it grows',
    }));

    const resp = await pending;
    expect(resp.success).toBe(false);
    expect(resp.error).toBe('Session is too short to compact — try again once it grows');
  });

  it('redacts a credential-looking error string before it reaches the caller', async () => {
    const { transport, emitLine, drain } = makeFakeTransport();
    const { proc } = makeProc({ transport });

    // 假 API key。安全门会把源码里连续的 `sk-` + 20 位以上当成泄露凭证，所以运行时拼装，
    // 让源码里不存在连续的 credential 形状。位数必须 >= 20：redactCredentialText() 的值形状
    // 正则是 sk-[A-Za-z0-9_-]{20,}，短于 20 位就只能靠 key-aware 分支兜住，测的就不是值形状脱敏了。
    const FAKE_KEY = 'sk-' + 'FAKE'.repeat(8);

    const pending = proc.request({ type: 'set_model', provider: 'p', modelId: 'm' });
    drain();
    const sent = JSON.parse((transport.writeLine.mock.calls[0]![0]) as string) as { id: string };
    emitLine(JSON.stringify({
      type: 'response',
      id: sent.id,
      command: 'set_model',
      success: false,
      error: 'provider refused: api_key=' + FAKE_KEY,
    }));

    const resp = await pending;
    expect(resp.error).not.toContain(FAKE_KEY);
    expect(resp.error).toContain('[REDACTED]');
  });

  it('redacts a Basic-scheme Authorization credential in a response error', async () => {
    const { transport, emitLine, drain } = makeFakeTransport();
    const { proc } = makeProc({ transport });

    const pending = proc.request({ type: 'set_model', provider: 'p', modelId: 'm' });
    drain();
    const sent = JSON.parse((transport.writeLine.mock.calls[0]![0]) as string) as { id: string };
    // `Authorization: Basic <base64>` 的 base64 部分不是已知的值形状, 只有
    // maker-shared 的 redactSensitiveText(redactCredentialHeaderFields) 认识它。
    emitLine(JSON.stringify({
      type: 'response',
      id: sent.id,
      command: 'set_model',
      success: false,
      error: 'provider refused: Authorization: Basic dXNlcjpwYXNz',
    }));

    const resp = await pending;
    expect(resp.error).not.toContain('dXNlcjpwYXNz');
    expect(resp.error).toContain('[REDACTED]');
  });

  it('redacts a Basic-scheme Authorization credential in a non-JSON stdout line', () => {
    const { transport, emitLine } = makeFakeTransport();
    const { logger } = makeProc({ transport });

    emitLine('Authorization: Basic dXNlcjpwYXNz');

    const logged = logger.warn.mock.calls.find(
      (call) => call[0] === 'prime-agent rpc: non-JSON stdout line dropped',
    );
    expect(logged, 'the non-JSON line is logged').toBeDefined();
    const context = logged?.[1] as { line?: string } | undefined;
    expect(context?.line).not.toContain('dXNlcjpwYXNz');
  });

  it('a parse-error frame without an id does not reject a live pending request', async () => {
    const { transport, emitLine, drain } = makeFakeTransport();
    const { proc, logger } = makeProc({ transport });

    const pending = proc.request({ type: 'get_state' });
    drain();
    // protocol.rs:76-89: parse error 一律不带 id, command='parse'。
    emitLine(JSON.stringify({
      type: 'response', command: 'parse', success: false,
      error: 'Invalid command: expected an object with a string type',
    }));

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('unmatched response'),
      expect.anything(),
    );
    // 原 pending 仍应能被正确响应。
    const sent = JSON.parse((transport.writeLine.mock.calls[0]![0]) as string) as { id: string };
    emitLine(JSON.stringify({
      type: 'response', id: sent.id, command: 'get_state', success: true, data: {},
    }));
    await expect(pending).resolves.toMatchObject({ success: true });
  });

  it('drops a non-JSON stdout line with a warn instead of throwing', async () => {
    const { transport, emitLine } = makeFakeTransport();
    const { logger } = makeProc({ transport });

    emitLine('not json at all');
    expect(logger.warn).toHaveBeenCalledWith(
      'prime-agent rpc: non-JSON stdout line dropped',
      expect.anything(),
    );
  });

  it('dispatches event frames to onEvent and refreshes a pending idle timeout', async () => {
    vi.useFakeTimers();
    try {
      const { transport, emitLine, written } = makeFakeTransport();
      const { proc, onEvent } = makeProc({ transport });
      const pending = proc.request(
        { type: 'compact' },
        {
          timeoutMs: 100,
          refreshTimeoutOnEvent: (event) => event.type === 'compaction_start',
        },
      );
      const sent = JSON.parse(written[0]!.line) as { id: string };

      await vi.advanceTimersByTimeAsync(90);
      emitLine(JSON.stringify({ type: 'compaction_start', reason: 'requested' }));
      await vi.advanceTimersByTimeAsync(90);
      // 没有刷新的话这里已经超时了。
      emitLine(JSON.stringify({
        type: 'response', id: sent.id, command: 'compact', success: true, data: {},
      }));

      await expect(pending).resolves.toMatchObject({ success: true });
      expect(onEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'compaction_start' }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a timeout with a stable command-aware error', async () => {
    vi.useFakeTimers();
    try {
      const { transport } = makeFakeTransport();
      const { proc } = makeProc({ transport });

      const pending = proc.request({ type: 'prompt' }, { timeoutMs: 75_000 });
      const rejected = expect(pending).rejects.toEqual(expect.objectContaining({
        name: 'PrimeAgentRpcRequestTimeoutError',
        code: 'PRIME_AGENT_RPC_TIMEOUT',
        commandType: 'prompt',
        timeoutMs: 75_000,
      } satisfies Partial<PrimeAgentRpcRequestTimeoutError>));
      await vi.advanceTimersByTimeAsync(75_000);

      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('PrimeAgentRpcProcess close and oversized-frame semantics', () => {
  it('fails every pending request when the transport closes', async () => {
    const { transport } = makeFakeTransport();
    const { proc, onExit } = makeProc({ transport });
    const pending = proc.request({ type: 'prompt' });

    const closeHandler = (transport.onClose as unknown as {
      mock: { calls: unknown[][] };
    }).mock.calls[0]![0] as (info: { code: number | null; signal: string | null }) => void;
    closeHandler({ code: 0, signal: null });

    await expect(pending).rejects.toThrow(/prime-agent process exited/);
    expect(onExit).toHaveBeenCalledWith({ code: 0, signal: null });
    expect(proc.isClosed).toBe(true);
  });

  it('retries transport shutdown after an unconfirmed close', async () => {
    const { transport } = makeFakeTransport();
    const transportClose = vi.mocked(transport.close);
    transportClose
      .mockRejectedValueOnce(new Error('prime-agent process did not confirm exit after SIGKILL'))
      .mockResolvedValueOnce(undefined);
    const { proc } = makeProc({ transport });

    await expect(proc.close()).rejects.toThrow(/did not confirm exit after SIGKILL/);
    await expect(proc.close()).resolves.toBeUndefined();
    expect(transportClose).toHaveBeenCalledTimes(2);
  });

  it('resolves an oversized-frame victim with a stable error', async () => {
    const { transport, emitOversized, drain } = makeFakeTransport();
    const { proc } = makeProc({ transport });
    const pending = proc.request({ type: 'get_state' });
    drain();
    emitOversized();

    await expect(pending).resolves.toMatchObject({
      success: false,
      command: 'get_state',
      error: PRIME_AGENT_RPC_OVERSIZED_FRAME_ERROR,
    });
  });

  it('does not fail a lone pending prompt when an oversized EVENT frame is dropped', async () => {
    const { transport, emitLine, emitOversized, drain } = makeFakeTransport();
    const { proc, logger } = makeProc({ transport });
    const pending = proc.request({ type: 'prompt', message: 'keep going' });
    drain();
    emitOversized();
    const sent = JSON.parse((transport.writeLine.mock.calls[0]![0]) as string) as { id: string };
    emitLine(JSON.stringify({
      type: 'response', id: sent.id, command: 'prompt', success: true,
    }));

    await expect(pending).resolves.toMatchObject({ success: true, command: 'prompt' });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('no matching pending get_state'),
    );
  });

  it('fire-and-forget send() never rejects', async () => {
    const { transport } = makeFakeTransport();
    const { proc } = makeProc({ transport });
    // writeLine 的 promise 永不 settle —— send() 必须不挂起也不抛。
    expect(() => proc.send({ type: 'abort' })).not.toThrow();
    expect(transport.writeLine).toHaveBeenCalledTimes(1);
    expect(JSON.parse((transport.writeLine.mock.calls[0]![0]) as string)).toEqual({ type: 'abort' });
  });
});
