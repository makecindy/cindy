/**
 * 堆采样摘要的归因规则:泄漏排查读的是「最近一帧应用代码」排名。叶子帧常是
 * JSON.parse / Array.push / 字符串拼接这类通用帧,若不往上归到打包产物里的调用方,
 * 摘要第一名会是 V8 内部函数,指不到泄漏模块。单独成文件:与 memory-log 是不同模块。
 */
import { describe, expect, it } from 'vitest';

import { summarizeSamplingProfile, type SamplingHeapProfileNode } from '../heap-sampling.js';

const APP = 'file:///repo/apps/desktop/.vite/build/bootstrap-electron.js';
const DEP = 'file:///repo/apps/desktop/node_modules/ws/lib/receiver.js';

function node(functionName: string, url: string, selfSize: number, children: SamplingHeapProfileNode[] = []): SamplingHeapProfileNode {
  return { callFrame: { functionName, url, lineNumber: 9, columnNumber: 0 }, selfSize, children };
}

describe('summarizeSamplingProfile', () => {
  it('attributes generic and dependency allocations to the nearest app frame', () => {
    const profile = {
      head: node('(root)', '', 0, [
        node('cacheSessionHistory', APP, 1_000, [
          node('parse', '', 50_000),
          node('onMessage', DEP, 0, [node('concat', '', 20_000)]),
        ]),
        node('(garbage collector)', '', 5_000),
      ]),
    };
    const summary = summarizeSamplingProfile(profile);
    expect(summary.totalBytes).toBe(76_000);
    expect(summary.byAppFrame).toEqual([
      { site: `cacheSessionHistory ${APP}:10:1`, bytes: 71_000 },
      { site: '(no app frame)', bytes: 5_000 },
    ]);
    expect(summary.byAllocationFrame[0]).toEqual({ site: 'parse', bytes: 50_000 });
  });
});
