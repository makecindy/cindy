/**
 * dispatchSendSafety.test.ts — 被控端隧道「发送兜底」契约(PR #166 reviewer [13]/[14])。
 * -------------------------------------------------------------------------------------
 * 两条都源于:device-link 帧超 MAX_FRAME_BYTES 时 client.send* 抛 PAYLOAD_TOO_LARGE。
 *   [14] sendInvokeResultSafe:消息页 invoke-result 太大抛错 → 裁剪超大消息内容后重发 ok:true;
 *        其它 channel 回紧凑错误结果,控制端确定性失败(而非干等 30s 超时)。
 *   [13] forwardPush:转发 push 给某控制端抛错 → per-dst 接住,绝不冒泡回 broadcastToAllWindows
 *        (否则被控端本机 renderer 漏收事件),也不拖垮其它控制端的转发。
 * 只 mock electron(app)+ logger;subscriptions 用真实模块(注册控制端订阅)。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DeviceLinkError, MAX_FRAME_BYTES, PROTOCOL_VERSION, type InvokeResultPayload } from '@cindy/device-link';

vi.mock('electron', () => ({
  app: {
    getAppPath: () => '/tmp/xdt-maker-test/app',
    getPath: () => '/tmp/xdt-maker-test',
    getVersion: () => '0.0.0-test',
  },
  // power-blocker.ts 模块级单例引用 powerSaveBlocker,需占位避免 vitest 报 mock 未定义
  powerSaveBlocker: { start: () => 0, stop: () => {}, isStarted: () => false },
  // notificationService.ts 顶层 IIFE 在 !isPackaged 时调 nativeImage.createFromPath
  // (经 scheduler-host 传递性 import 被拉进来),补桩避免 collect 阶段报 mock 未定义
  nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
}));
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { __testing } from '../dispatch';
import * as subscriptions from '../subscriptions';

/** 最小 mock client:只实现被测路径用到的两个发送方法。 */
function mkClient(over: Partial<{ sendInvokeResult: ReturnType<typeof vi.fn>; sendPush: ReturnType<typeof vi.fn> }> = {}) {
  return {
    sendInvokeResult: over.sendInvokeResult ?? vi.fn(),
    sendPush: over.sendPush ?? vi.fn(),
  };
}

const tooLarge = () => new DeviceLinkError('PAYLOAD_TOO_LARGE', 'frame exceeds 2097152 bytes');
const encodedByteLength = (value: string) => new TextEncoder().encode(value).byteLength;
const invokeResultFrameBytes = (dst: string, requestId: string, payload: InvokeResultPayload) =>
  encodedByteLength(JSON.stringify({ v: PROTOCOL_VERSION, kind: 'invoke-result', id: requestId, dst, payload }));

beforeEach(() => {
  __testing.reset();
});

describe('[14] sendInvokeResultSafe — 结果超限兜底', () => {
  it('消息页首发抛 PAYLOAD_TOO_LARGE → 先压缩超大消息内容并重发 ok:true,不冒泡', () => {
    const sendInvokeResult = vi.fn().mockImplementationOnce(() => {
      throw tooLarge();
    });
    const client = mkClient({ sendInvokeResult });
    const bigContent = 'x'.repeat(32 * 1024);
    const big: InvokeResultPayload = {
      ok: true,
      result: [{
        agentMeta: null,
        clientId: 'c1',
        content: bigContent,
        createdAt: '2026-06-23T00:00:00.000Z',
        id: 'm1',
        role: 'tool_result',
        sessionId: 's1',
        toolUseId: 'tu1',
      }],
    };

    expect(() =>
      __testing.sendInvokeResultSafe(client as never, 'ctrl-1', 'req-1', big, 'local-db:messages:list'),
    ).not.toThrow();

    expect(sendInvokeResult).toHaveBeenCalledTimes(2);
    const second = sendInvokeResult.mock.calls[1];
    expect(second[0]).toBe('ctrl-1');
    expect(second[1]).toBe('req-1');
    expect(second[2]).toMatchObject({
      ok: true,
      result: [
        {
          agentMeta: { remoteContentTruncated: true },
          clientId: 'c1',
          role: 'tool_result',
        },
      ],
    });
    expect(second[2].result[0].content).toContain('[remote content truncated: payload too large]');
    expect(second[2].result[0].content.length).toBeLessThan(bigContent.length);
  });

  it('消息页非字符串 content 超限 → 用占位文本替代,不返回半截 JSON', () => {
    const sendInvokeResult = vi.fn().mockImplementationOnce(() => {
      throw tooLarge();
    });
    const client = mkClient({ sendInvokeResult });
    const big: InvokeResultPayload = {
      ok: true,
      result: [{
        agentMeta: null,
        clientId: 'c1',
        content: { blocks: ['x'.repeat(32 * 1024)] },
        createdAt: '2026-06-23T00:00:00.000Z',
        id: 'm1',
        role: 'tool_result',
        sessionId: 's1',
        toolUseId: 'tu1',
      }],
    };

    expect(() =>
      __testing.sendInvokeResultSafe(client as never, 'ctrl-1', 'req-1', big, 'local-db:messages:list'),
    ).not.toThrow();

    expect(sendInvokeResult).toHaveBeenCalledTimes(2);
    const compact = sendInvokeResult.mock.calls[1][2] as { ok: true; result: Array<{ content: unknown }> };
    expect(compact.result[0].content).toBe('[remote content truncated: payload too large]');
  });

  it('tool_use content 超限 → 保留工具 envelope,只截断 input 大字段', () => {
    const sendInvokeResult = vi.fn().mockImplementationOnce(() => {
      throw tooLarge();
    });
    const client = mkClient({ sendInvokeResult });
    const bigCommand = 'x'.repeat(160 * 1024);
    const big: InvokeResultPayload = {
      ok: true,
      result: [{
        agentMeta: null,
        clientId: 'c1',
        content: {
          toolUseId: 'toolu-1',
          toolName: 'Bash',
          input: {
            command: bigCommand,
            timeout: 1,
          },
        },
        createdAt: '2026-06-23T00:00:00.000Z',
        id: 'm1',
        role: 'tool_use',
        sessionId: 's1',
        toolUseId: 'toolu-1',
      }],
    };

    expect(() =>
      __testing.sendInvokeResultSafe(client as never, 'ctrl-1', 'req-1', big, 'local-db:messages:list'),
    ).not.toThrow();

    expect(sendInvokeResult).toHaveBeenCalledTimes(2);
    const compact = sendInvokeResult.mock.calls[1][2] as { ok: true; result: Array<{ content: unknown }> };
    expect(compact.ok).toBe(true);
    const content = compact.result[0].content as {
      toolUseId?: string;
      toolName?: string;
      input?: { command?: string; timeout?: number };
    };
    expect(content.toolUseId).toBe('toolu-1');
    expect(content.toolName).toBe('Bash');
    expect(content.input?.timeout).toBe(1);
    expect(content.input?.command).toContain('[remote content truncated: payload too large]');
    expect(content.input?.command?.length).toBeLessThan(bigCommand.length);
  });

  it('消息页单条内容未超限但整帧仍超限 → 二次压缩到 MAX_FRAME_BYTES 内', () => {
    const sendInvokeResult = vi.fn().mockImplementationOnce(() => {
      throw tooLarge();
    });
    const client = mkClient({ sendInvokeResult });
    const messages = Array.from({ length: 22 }, (_, index) => ({
      agentMeta: null,
      clientId: `c${index}`,
      content: 'x'.repeat(120 * 1024),
      createdAt: '2026-06-23T00:00:00.000Z',
      id: `m${index}`,
      role: 'assistant',
      sessionId: 's1',
    }));
    const big: InvokeResultPayload = { ok: true, result: messages };

    expect(() =>
      __testing.sendInvokeResultSafe(client as never, 'ctrl-1', 'req-1', big, 'local-db:messages:list'),
    ).not.toThrow();

    expect(sendInvokeResult).toHaveBeenCalledTimes(2);
    const compact = sendInvokeResult.mock.calls[1][2] as InvokeResultPayload;
    expect(invokeResultFrameBytes('ctrl-1', 'req-1', compact)).toBeLessThan(MAX_FRAME_BYTES);
    expect(compact.ok).toBe(true);
    if (compact.ok) {
      const compactMessages = compact.result as Array<{ content: unknown }>;
      expect(compactMessages).toHaveLength(messages.length);
      expect(compactMessages[0].content).toBe('[remote content truncated: payload too large]');
    }
  });

  it('messages:list 二次压缩后仍需裁行 → 保留 desc 页面的最新行', () => {
    const sendInvokeResult = vi.fn().mockImplementationOnce(() => {
      throw tooLarge();
    });
    const client = mkClient({ sendInvokeResult });
    const messages = Array.from({ length: 6 }, (_, index) => ({
      agentMeta: { debugBlob: 'm'.repeat(480 * 1024) },
      clientId: `newest-first-${index}`,
      content: index === 0
        ? { toolUseId: 'toolu-0', toolName: 'Bash', input: { command: 'echo ok', timeout: 1 } }
        : 'x',
      createdAt: new Date(Date.UTC(2026, 5, 23, 0, 0, 6 - index)).toISOString(),
      id: `m${index}`,
      role: index === 0 ? 'tool_use' : 'assistant',
      sessionId: 's1',
    }));
    const big: InvokeResultPayload = { ok: true, result: messages };

    expect(() =>
      __testing.sendInvokeResultSafe(client as never, 'ctrl-1', 'req-1', big, 'local-db:messages:list'),
    ).not.toThrow();

    expect(sendInvokeResult).toHaveBeenCalledTimes(2);
    const compact = sendInvokeResult.mock.calls[1][2] as InvokeResultPayload;
    expect(invokeResultFrameBytes('ctrl-1', 'req-1', compact)).toBeLessThan(MAX_FRAME_BYTES);
    expect(compact.ok).toBe(true);
    if (compact.ok) {
      const compactMessages = compact.result as Array<{
        agentMeta?: { remoteRowsTrimmed?: boolean; remoteOriginalRowCount?: number };
        clientId: string;
        content?: unknown;
      }>;
      const ids = compactMessages.map((message) => message.clientId);
      expect(ids[0]).toBe('newest-first-0');
      expect(ids).not.toContain('newest-first-5');
      expect(compactMessages[0].content).toMatchObject({
        toolUseId: 'toolu-0',
        toolName: 'Bash',
        input: { command: 'echo ok', timeout: 1 },
      });
      expect(compactMessages[0].agentMeta).toEqual(
        expect.objectContaining({
          remoteRowsTrimmed: true,
          remoteOriginalRowCount: messages.length,
        }),
      );
    }
  });

  it('messages:around 二次压缩后仍需裁行 → 保留请求的 message anchor', () => {
    const sendInvokeResult = vi.fn().mockImplementationOnce(() => {
      throw tooLarge();
    });
    const client = mkClient({ sendInvokeResult });
    const messages = Array.from({ length: 6 }, (_, index) => ({
      agentMeta: { debugBlob: 'm'.repeat(480 * 1024) },
      clientId: `c${index}`,
      content: 'x',
      createdAt: new Date(Date.UTC(2026, 5, 23, 0, 0, index)).toISOString(),
      id: index === 1 ? 'anchor-message' : `m${index}`,
      role: 'assistant',
      sessionId: 's1',
    }));
    const big: InvokeResultPayload = { ok: true, result: messages };

    expect(() =>
      __testing.sendInvokeResultSafe(
        client as never,
        'ctrl-1',
        'req-1',
        big,
        'local-db:messages:around',
        ['s1', 'anchor-message', { radius: 20 }],
      ),
    ).not.toThrow();

    expect(sendInvokeResult).toHaveBeenCalledTimes(2);
    const compact = sendInvokeResult.mock.calls[1][2] as InvokeResultPayload;
    expect(invokeResultFrameBytes('ctrl-1', 'req-1', compact)).toBeLessThan(MAX_FRAME_BYTES);
    expect(compact.ok).toBe(true);
    if (compact.ok) {
      const ids = (compact.result as Array<{ id: string }>).map((message) => message.id);
      expect(ids).toContain('anchor-message');
    }
  });

  it('messages:around-client-id 二次压缩后仍需裁行 → 保留请求的 client anchor', () => {
    const sendInvokeResult = vi.fn().mockImplementationOnce(() => {
      throw tooLarge();
    });
    const client = mkClient({ sendInvokeResult });
    const messages = Array.from({ length: 6 }, (_, index) => ({
      agentMeta: { debugBlob: 'm'.repeat(480 * 1024) },
      clientId: index === 1 ? 'anchor-client' : `c${index}`,
      content: 'x',
      createdAt: new Date(Date.UTC(2026, 5, 23, 0, 0, index)).toISOString(),
      id: `m${index}`,
      role: 'assistant',
      sessionId: 's1',
    }));
    const big: InvokeResultPayload = { ok: true, result: messages };

    expect(() =>
      __testing.sendInvokeResultSafe(
        client as never,
        'ctrl-1',
        'req-1',
        big,
        'local-db:messages:around-client-id',
        ['s1', 'anchor-client', { radius: 20 }],
      ),
    ).not.toThrow();

    expect(sendInvokeResult).toHaveBeenCalledTimes(2);
    const compact = sendInvokeResult.mock.calls[1][2] as InvokeResultPayload;
    expect(invokeResultFrameBytes('ctrl-1', 'req-1', compact)).toBeLessThan(MAX_FRAME_BYTES);
    expect(compact.ok).toBe(true);
    if (compact.ok) {
      const clientIds = (compact.result as Array<{ clientId: string }>).map((message) => message.clientId);
      expect(clientIds).toContain('anchor-client');
    }
  });

  it('非消息页首发抛 PAYLOAD_TOO_LARGE → 重发紧凑 {ok:false} 错误结果(沿用原 code),不冒泡', () => {
    const sendInvokeResult = vi.fn().mockImplementationOnce(() => {
      throw tooLarge();
    });
    const client = mkClient({ sendInvokeResult });
    const big: InvokeResultPayload = { ok: true, result: { huge: 'x' } };

    expect(() =>
      __testing.sendInvokeResultSafe(client as never, 'ctrl-1', 'req-1', big, 'maker:get-session'),
    ).not.toThrow();

    expect(sendInvokeResult).toHaveBeenCalledTimes(2);
    const second = sendInvokeResult.mock.calls[1];
    expect(second[0]).toBe('ctrl-1');
    expect(second[1]).toBe('req-1');
    expect(second[2]).toEqual({ ok: false, error: { code: 'PAYLOAD_TOO_LARGE', message: expect.any(String) } });
  });

  it('紧凑错误结果也发不出去 → 仍不抛(只 log,彻底放弃)', () => {
    const sendInvokeResult = vi.fn().mockImplementation(() => {
      throw tooLarge();
    });
    const client = mkClient({ sendInvokeResult });
    expect(() =>
      __testing.sendInvokeResultSafe(client as never, 'ctrl-1', 'req-1', { ok: true, result: {} }, 'x'),
    ).not.toThrow();
    expect(sendInvokeResult).toHaveBeenCalledTimes(2);
  });

  it('正常结果 → 直发一次,不重试', () => {
    const sendInvokeResult = vi.fn();
    const client = mkClient({ sendInvokeResult });
    const ok: InvokeResultPayload = { ok: true, result: { a: 1 } };
    __testing.sendInvokeResultSafe(client as never, 'ctrl-1', 'req-1', ok, 'x');
    expect(sendInvokeResult).toHaveBeenCalledTimes(1);
    expect(sendInvokeResult.mock.calls[0][2]).toBe(ok);
  });
});

describe('[13] forwardPush — 转发失败 best-effort,不冒泡', () => {
  it('某控制端 sendPush 抛 PAYLOAD_TOO_LARGE → 不冒泡(本地广播不受影响)', () => {
    const sendPush = vi.fn().mockImplementation(() => {
      throw tooLarge();
    });
    const client = mkClient({ sendPush });
    __testing.setActiveClient(client as never);
    subscriptions.subscribe('ctrl-1', ['session:s1']);

    // maker:event + {sessionId:'s1'} → topic 'session:s1' → ctrl-1 命中。
    expect(() => __testing.forwardPush('maker:event', { sessionId: 's1' })).not.toThrow();
    expect(sendPush).toHaveBeenCalledTimes(1);
  });

  it('maker:event 超大帧 → 裁剪实时 payload 后重试一次,不冒泡', () => {
    const sendPush = vi.fn().mockImplementationOnce(() => {
      throw tooLarge();
    });
    const client = mkClient({ sendPush });
    __testing.setActiveClient(client as never);
    subscriptions.subscribe('ctrl-1', ['session:s1']);
    const huge = 'x'.repeat(220_000);

    expect(() =>
      __testing.forwardPush('maker:event', {
        sessionId: 's1',
        event: {
          type: 'tool_result_full',
          data: { fullText: huge },
        },
        resolvedContent: huge,
      }),
    ).not.toThrow();

    expect(sendPush).toHaveBeenCalledTimes(2);
    const compact = sendPush.mock.calls[1][2] as {
      event: { data: { fullText: string } };
      resolvedContent: string;
      __deviceLinkTruncated?: boolean;
    };
    expect(compact.event.data.fullText.length).toBeLessThan(huge.length);
    expect(compact.event.data.fullText).toContain('[device-link truncated]');
    expect(compact.resolvedContent).toBe('[device-link truncated]');
    expect(compact.__deviceLinkTruncated).toBe(true);
  });

  it('多控制端:一个抛错不影响其它控制端收到转发', () => {
    const sendPush = vi
      .fn()
      .mockImplementationOnce(() => {
        throw tooLarge();
      })
      .mockImplementation(() => {});
    const client = mkClient({ sendPush });
    __testing.setActiveClient(client as never);
    subscriptions.subscribe('ctrl-1', ['session:s1']);
    subscriptions.subscribe('ctrl-2', ['session:s1']);

    expect(() => __testing.forwardPush('maker:event', { sessionId: 's1' })).not.toThrow();
    // 两个控制端都尝试过(第一个抛错被接住,第二个正常)。
    expect(sendPush).toHaveBeenCalledTimes(2);
  });
});
