import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../im/index.ts', import.meta.url), 'utf8');

describe('im startup default route backfill wiring', () => {
  // 启动期补齐历史任务的跟随记录(PR #5155 review P2): 回填不能只等设置保存/
  // 重置触发 —— 从未动过设置的升级老任务要靠 startImConnection(localDb 就绪
  // 权威时点)带起的这次补齐拿到记录。
  it('kicks the startup backfill from startImConnection', () => {
    const start = source.indexOf('export function startImConnection');
    expect(start).toBeGreaterThanOrEqual(0);
    const backfill = source.indexOf('void backfillImDefaultRoutesAtStartup();', start);
    const connect = source.indexOf('connectionLifecycle.start();', start);
    expect(backfill).toBeGreaterThan(start);
    expect(connect).toBeGreaterThan(backfill);
  });
});
