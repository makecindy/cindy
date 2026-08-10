import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * enqueue 弱网重试的写序边界(codex review P1 + auto-review P1 回归锚点):
 * - NOT_CONNECTED 不保证未送达——断连时 in-flight invoke 会被 failAllPending 批量
 *   reject 成 NOT_CONNECTED(请求可能已出、ack 丢失);
 * - BACKPRESSURE 要么在本地发送前拒绝,要么由被控端 admission 明确拒绝执行;
 * - projection 也无法证明未入队——空闲 agent 下 enqueue-immediate 会把消息瞬间
 *   slice 进 activeTurn,pendingQueue 里查不到;
 */
describe('send enqueue weak-network retry ordering', () => {
  const source = readFileSync(resolve(process.cwd(), 'app/sessions/[sessionId].tsx'), 'utf8');

  /**
   * 提取全部 enqueue 弱网重试循环体(send 原路径 + outbox 派发路径各一个),
   * 每个循环以其后最近的 projection store 写入为界。
   * 两条路径共用同一套写序边界,守卫必须逐个覆盖,不能只查第一个。
   */
  const LOOP_MARKER = 'for (let attempt = 0; ; attempt++) {';
  const extractRetryLoops = (): string[] => {
    const loops: string[] = [];
    for (let from = source.indexOf(LOOP_MARKER); from > -1; from = source.indexOf(LOOP_MARKER, from + 1)) {
      const endMatch = /remoteSessionStore\.setInputProjectionIfCurrent\(\s*[^,]+,\s*projection,\s*projectionEpochAtRequestStart,\s*projectionRemoteEpochAtRequestStart,\s*queued\.clientId,\s*\);/.exec(source.slice(from));
      expect(endMatch).not.toBeNull();
      loops.push(source.slice(from, from + (endMatch?.index ?? 0)));
    }
    return loops;
  };

  it('重试门槛必须要求可安全重发的传输错误且非 in-flight(send 与 outbox 两条路径)', () => {
    expect(source).toContain("import { isInFlightDeviceLinkError } from '@cindy/device-link';");
    expect(source).toContain("code === 'NOT_CONNECTED' || code === 'BACKPRESSURE'");
    expect(source).toContain("formatted.includes('[BACKPRESSURE]')");
    const loops = extractRetryLoops();
    expect(loops).toHaveLength(2);
    for (const loopBody of loops) {
      expect(loopBody).toContain('|| isInFlightDeviceLinkError(err)');
      expect(loopBody).toContain('|| !isRetryableEnqueueTransportError(err)');
    }
  });

  it('不允许回归为「NOT_CONNECTED 保证未送达」的盲重注释,也不允许用 pendingQueue 对账当放行依据', () => {
    expect(source).not.toContain('被控端不可能收到');
    expect(source).not.toContain('绝不会造成重复入队');
    // 循环内不允许出现「refetch pendingQueue 判未入队 → 放行重发」——activeTurn
    // 不在 projection 里,该判据在空闲 agent 场景必然漏判(auto-review P1)。
    // getProjection 只允许出现在循环结束后的回滚对账段(catch 分支),不得参与重发决策。
    for (const loopBody of extractRetryLoops()) {
      expect(loopBody).not.toContain('getProjection');
    }
  });
});
