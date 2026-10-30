/**
 * 反向请求回包交付：链路抖动导致 reply 发送失败时必须重试——对方一直在等同一
 * requestId 的回包，只记日志不重试会让任务停在权限确认 / 工具请求上无法推进。
 */
import { describe, expect, it } from 'vitest';

import type { RemoteAgentPoller } from '../controller/poller';
import { RemoteAgentRunClient } from '../controller/runClient';

describe('RemoteAgentRunClient reply delivery', () => {
  it('retries a reply through transient link failures so the other side does not stall', async () => {
    const replyAttempts: number[] = [];
    const replyPayloads: unknown[] = [];
    let failuresLeft = 2;
    const invoke = async (args: unknown[]): Promise<unknown> => {
      const op = (args[0] as { op: string }).op;
      if (op === 'reply') {
        replyAttempts.push(replyAttempts.length + 1);
        replyPayloads.push((args[0] as { payload: unknown }).payload);
        if (failuresLeft > 0) {
          failuresLeft -= 1;
          throw new Error('TIMEOUT: link dropped mid-reply');
        }
      }
      return {};
    };
    const client = new RemoteAgentRunClient(
      'run-1',
      { invoke, unregister: () => undefined } as unknown as RemoteAgentPoller,
      {
        onEvent: () => undefined,
        onState: () => undefined,
        onWs: () => undefined,
        onClosed: () => undefined,
        onRequest: async () => ({ type: 'interaction', result: { kind: 'permission', behavior: 'allow' } }),
      },
      () => 'generated-id',
    );
    client.onData(Buffer.from(`${JSON.stringify({
      t: 'request',
      requestId: '11111111-2222-4333-8444-555555555555',
      request: {
        type: 'interaction',
        request: { kind: 'permission', requestId: 'r1', toolName: 'bash', input: { command: 'echo hi' } },
      },
    })}\n`), false);
    // 两次链路失败(退避 500ms / 1000ms)后第三次交付成功。
    const deadline = Date.now() + 10_000;
    while (replyAttempts.length < 3 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(replyAttempts).toHaveLength(3);
    expect(failuresLeft).toBe(0);
    // 重试复用同一份载荷(同一引用)：重建载荷会在对方 staging 里多留一份无人消费的上传。
    expect(new Set(replyPayloads).size).toBe(1);
  });

  it('reuses one uploaded payload when retrying a large reply', async () => {
    const uploadIds = new Set<string>();
    const replyUploadIds: Array<string | undefined> = [];
    let failuresLeft = 1;
    const invoke = async (args: unknown[]): Promise<unknown> => {
      const op = args[0] as { op: string; uploadId?: string; payload?: { uploadId?: string } };
      if (op.op === 'upload' && op.uploadId) uploadIds.add(op.uploadId);
      if (op.op === 'reply') {
        replyUploadIds.push(op.payload?.uploadId);
        if (failuresLeft > 0) {
          failuresLeft -= 1;
          throw new Error('TIMEOUT: link dropped mid-reply');
        }
      }
      return {};
    };
    let seq = 0;
    const client = new RemoteAgentRunClient(
      'run-1',
      { invoke, unregister: () => undefined } as unknown as RemoteAgentPoller,
      {
        onEvent: () => undefined,
        onState: () => undefined,
        onWs: () => undefined,
        onClosed: () => undefined,
        // 大回包(超过内联上限)走分段上传。
        onRequest: async () => ({ type: 'callback', value: 'x'.repeat(2 * 1024 * 1024) }),
      },
      () => `generated-${(seq += 1)}`,
    );
    client.onData(Buffer.from(`${JSON.stringify({
      t: 'request',
      requestId: '11111111-2222-4333-8444-555555555555',
      request: { type: 'callback', name: 'onTranscriptUserEntry', args: ['call-1', 'entry-1'] },
    })}\n`), false);
    const deadline = Date.now() + 10_000;
    while (replyUploadIds.length < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    // 重试复用同一份上传载荷(同一个 uploadId)：每次都造新 upload 会把载荷留在对方
    // 暂存区直到过期，反复歧义交付会占满配额、挡住无关上传。
    expect(replyUploadIds).toHaveLength(2);
    expect(new Set(replyUploadIds).size).toBe(1);
    expect(replyUploadIds[0]).toBeDefined();
    expect(uploadIds.size).toBe(1);
  });
});
