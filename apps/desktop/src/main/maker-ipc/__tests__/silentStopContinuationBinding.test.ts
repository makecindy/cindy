/**
 * silentStopContinuationBinding.test.ts
 * ---------------------------------------------------------------------------
 * silent-stop 自动续跑走 Session.sendHostTurnContinuation()，不经过 send 事务
 * (makerSendTransaction)，因此不会触发把 onTurnReserved 转发给输入协调器的
 * 常规接线。这条旁路必须自己完成两件事，否则协调器残留的 activeTurn 会与真实
 * 终态永久失配，输入边界卡在忙(僵尸 activeTurn，2026-09-24 实报)：
 *   1. 预约时把新 vendor generation 交给协调器(noteHostTurnContinuation)；
 *   2. send 在派发确认前失败(Session 回滚 turnGeneration)时回滚绑定
 *      (noteHostTurnContinuationFailed)。
 *
 * 这里用源码契约守住触发端接线 —— 协调器侧的单测覆盖行为，但覆盖不到
 * register.ts 是否真的把回调传进 sendHostTurnContinuation、失败分支是否回滚。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const registerSource = readFileSync(resolve(__dirname, '..', 'register.ts'), 'utf8').replace(
  /\r\n?/g,
  '\n',
);

function extractBetween(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0) {
    throw new Error(`source markers not found: ${startMarker} .. ${endMarker}`);
  }
  return source.slice(start, end);
}

describe('silent-stop continuation generation binding', () => {
  it('binds the reserved generation to the coordinator and rolls it back on send failure', () => {
    const resumeBlock = extractBetween(
      registerSource,
      'async function handleSilentStopTurnEnd(',
      'function isFencedStaleProductTerminal(',
    );
    // 预约时把新 generation 交给协调器(只在一个回调里,不重复或漏传)。
    expect(resumeBlock).toContain('onTurnReserved: (reservedGeneration)');
    expect(resumeBlock).toContain('reservedContinuationGeneration = reservedGeneration;');
    expect(resumeBlock.match(/noteHostTurnContinuation\(/g)).toHaveLength(1);
    // 未派发(not accepted)与抛错两条失败收口都要走回滚 helper。
    expect(resumeBlock.match(/rollbackHostContinuationBinding\(/g)).toHaveLength(2);

    const rollbackBlock = extractBetween(
      registerSource,
      'function rollbackHostContinuationBinding(',
      'async function handleSilentStopTurnEnd(',
    );
    expect(rollbackBlock).toContain('noteHostTurnContinuationFailed(sessionId, reservedGeneration)');
  });
});
