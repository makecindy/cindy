/**
 * 任务隧道的往来记录(#5764)：托管 Codex 的线程启动经设备互联逐个读项目文件，Codex 据这里的
 * 最近往来时间判断慢启动是否仍在推进，超时时用这里的计数说明停在哪一步。
 */
import { describe, expect, it } from 'vitest';

import { TunnelLinkActivity, rpcEnvelope } from '../host/linkActivity';

describe('tunnel link activity', () => {
  it('reads JSON-RPC ids and methods, including error replies with the id last and large messages', () => {
    expect(rpcEnvelope('{"id":2,"method":"fs/readFile","params":{}}')).toEqual({ id: '2', method: 'fs/readFile' });
    // exec-server 的错误回复把 id 放在最后。
    expect(rpcEnvelope('{"error":{"code":-32004,"message":"x"},"id":3}')).toEqual({ id: '3' });
    expect(rpcEnvelope('{"method":"initialized","params":{}}')).toEqual({ method: 'initialized' });
    // 数字与字符串 id 不混淆。
    expect(rpcEnvelope('{"id":"3","result":{}}')).toEqual({ id: '"3"' });
    // 整段文件内容只看开头。
    expect(rpcEnvelope(`{"id":7,"result":{"dataBase64":"${'A'.repeat(100_000)}"}}`)).toEqual({ id: '7' });
    expect(rpcEnvelope(`{"id":8,"method":"fs/writeFile","params":{"dataBase64":"${'A'.repeat(100_000)}"}}`))
      .toEqual({ id: '8', method: 'fs/writeFile' });
    expect(rpcEnvelope(JSON.stringify({ method: 'process/output', params: { data: 'A'.repeat(100_000) } }))).toEqual({
      method: 'process/output',
    });
    expect(rpcEnvelope('not json')).toBeNull();
  });

  it('counts requests, replies, round trips and the oldest unanswered request', () => {
    let now = 1_000;
    const activity = new TunnelLinkActivity(() => now);
    expect(activity.snapshot()).toEqual({
      lastActivityAt: null,
      execRequests: 0,
      execResponses: 0,
      execMaxInFlight: 0,
      httpInFlight: 0,
    });

    activity.connection('c1', false);
    activity.agentMessage('c1', '{"id":1,"method":"fs/walk","params":{}}');
    activity.agentMessage('c1', '{"method":"initialized","params":{}}');
    now += 100;
    activity.agentMessage('c1', '{"id":2,"method":"fs/readFile","params":{}}');
    now += 400;
    activity.environmentMessage('c1', '{"id":1,"result":{}}');
    activity.environmentMessage('c1', '{"method":"process/output","params":{}}');
    activity.environmentMessage(
      'c1',
      JSON.stringify({ method: 'process/output', params: { data: 'A'.repeat(100_000) } }),
    );
    // 另一条连接上同 id 的回复不算这条连接的。
    activity.environmentMessage('c2', '{"id":2,"result":{}}');
    now += 1_000;
    // 执行环境主动推的通知(后台命令输出)不算往来：Agent 卡住时它们照样会来。
    activity.environmentMessage('c1', '{"method":"process/output","params":{}}');
    expect(activity.snapshot()).toEqual({
      lastActivityAt: 1_500,
      execRequests: 2,
      execResponses: 1,
      execMaxInFlight: 2,
      execOldestPending: { method: 'fs/readFile', waitedMs: 1_400 },
      execRoundTripAvgMs: 500,
      execRoundTripMaxMs: 500,
      httpInFlight: 0,
    });

    // 连接关掉后，它上面没等到的回复不会再来。
    activity.connection('c1', true);
    expect(activity.snapshot().execOldestPending).toBeUndefined();

    activity.httpStarted();
    expect(activity.snapshot()).toMatchObject({ httpInFlight: 1, lastActivityAt: 2_500 });
    activity.httpFinished();
    activity.httpFinished();
    expect(activity.snapshot().httpInFlight).toBe(0);
  });
});
