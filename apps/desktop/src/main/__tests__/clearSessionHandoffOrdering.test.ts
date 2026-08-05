/**
 * `/clear` handler 里三步的**先后契约**:立墓碑 → cleared_at 落库 → 封 clear 边界。
 *
 * 纪元的作用是作废「在 clear 之前取过纪元、之后才写回」的交接。它一旦先于落库推进,
 * 那个 await 窗口里启动的引擎切换 / 消息删除就会同时拿到「clear 之后的纪元」和
 * 「clear 之前的 DB 历史」——校验通过,基于已清空历史算出的交接照样盖掉墓碑,下次发送
 * 把用户刚显式清空的上下文重新灌回模型(#738 review P1)。
 *
 * 墓碑必须留在最前:窗口内到达的 send 走 peek,墓碑是同步生效且不回落 DB 的那一层。
 * 而窗口内**写回**的那批(纪元还是 clear 前的值、校验会通过)由 sealClearBoundary 的
 * 重立墓碑兜住——它不只是推进纪元,顺序细节见该方法注释。
 *
 * register.ts 是超大 handler 注册文件、没有可注入的测试入口,repo 里既有的做法就是对
 * 源码断言(见 deviceLinkAutoTitleWiring.test.ts / interruptedContinuationContract.test.ts)。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const registerSource = readFileSync(
  resolve(__dirname, '..', 'maker-ipc', 'register.ts'),
  'utf8',
).replace(/\r\n?/g, '\n');

describe('/clear:墓碑 → cleared_at 落库 → 封 clear 边界', () => {
  const handlerStart = registerSource.indexOf('MAKER_INVOKE.INPUT_CLEAR_SESSION');
  const handlerEnd = registerSource.indexOf('MAKER_INVOKE.ABORT_SESSION', handlerStart);
  const handler = registerSource.slice(handlerStart, handlerEnd);

  it('三步都在同一个 handler 内', () => {
    expect(handlerStart).toBeGreaterThan(-1);
    expect(handlerEnd).toBeGreaterThan(handlerStart);
    expect(handler).toContain('agentHandoffPending.invalidate(sid)');
    expect(handler).toContain('await clearSessionContextInDb(sid, clearBoundaryMs)');
    expect(handler).toContain('agentHandoffPending.sealClearBoundary(sid)');
  });

  it('顺序不可颠倒:纪元推进排在 cleared_at 落库之后,墓碑排在最前', () => {
    const tombstoneAt = handler.indexOf('agentHandoffPending.invalidate(sid)');
    const persistAt = handler.indexOf('await clearSessionContextInDb(sid, clearBoundaryMs)');
    const epochAt = handler.indexOf('agentHandoffPending.sealClearBoundary(sid)');
    expect(tombstoneAt).toBeLessThan(persistAt);
    expect(persistAt).toBeLessThan(epochAt);
  });

  it('落库失败不跳过纪元推进:catch 掉而不是让 handler 抛出', () => {
    // 抛出的话 sealClearBoundary 不会执行,在途那批按过期历史算出的交接
    // 就能顺利写回。失败时宁可一并丢弃。
    const persistAt = handler.indexOf('await clearSessionContextInDb(sid, clearBoundaryMs)');
    const epochAt = handler.indexOf('agentHandoffPending.sealClearBoundary(sid)');
    const between = handler.slice(persistAt, epochAt);
    expect(between).toContain('} catch (err) {');
    expect(between).not.toContain('throw');
  });
});
