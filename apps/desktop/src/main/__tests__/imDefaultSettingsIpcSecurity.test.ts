import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../bootstrap-electron.ts', import.meta.url), 'utf8');

describe('im default settings IPC security contract', () => {
  // 保存/重置会按旧默认批量补写老任务的跟随记录, 并让下一条 IM 消息切换现有任务的
  // 运行路由 —— sender 校验必须拦在任何回填或写设置之前, 不能让导航到外部页面的
  // preload frame 改写渠道默认并推动任务切路由(codex review P1, PR #5155)。
  it.each([
    ['IM_DEFAULT_SETTINGS_SET', 'writeImDefaultSettingsPatch('],
    ['IM_DEFAULT_SETTINGS_RESET', 'resetImDefaultSettings'],
  ] as const)('guards %s before any backfill or settings write', (channel, writeCall) => {
    const handler = source.indexOf(`MAKER_IPC_INVOKE.${channel},`);
    expect(handler).toBeGreaterThanOrEqual(0);
    const guard = source.indexOf('assertTrustedAppRendererEvent(event);', handler);
    const backfill = source.indexOf('prepareImDefaultSettingsChange(', handler);
    const write = source.indexOf(writeCall, handler);
    expect(guard).toBeGreaterThan(handler);
    expect(backfill).toBeGreaterThan(guard);
    expect(write).toBeGreaterThan(guard);
  });

  // owner 边界(PR #5155 review P1): 回填跨多个 await, 期间登出/切号会让落库与设置
  // 写入漂到别的 owner —— 进入时快照 owner scope, 写设置前在同一同步块内复核
  // scope 未变且无 boundary 在途, 不满足即失败重试。
  it.each([
    ['IM_DEFAULT_SETTINGS_SET', 'writeImDefaultSettingsPatch('],
    ['IM_DEFAULT_SETTINGS_RESET', 'resetImDefaultSettings'],
  ] as const)('pins the owner scope at entry and re-checks it right before %s writes', (channel, writeCall) => {
    const handler = source.indexOf(`MAKER_IPC_INVOKE.${channel},`);
    expect(handler).toBeGreaterThanOrEqual(0);
    const capture = source.indexOf('const ownerScopeKey = activeOwnerScopeKey();', handler);
    const backfill = source.indexOf('prepareImDefaultSettingsChange(', handler);
    const ownerGuard = source.indexOf('assertOwnerScopeSettledForWrite(ownerScopeKey);', handler);
    const write = source.indexOf(writeCall, handler);
    expect(capture).toBeGreaterThan(handler);
    expect(backfill).toBeGreaterThan(capture);
    expect(ownerGuard).toBeGreaterThan(backfill);
    expect(write).toBeGreaterThan(ownerGuard);
  });

  // 仅路由默认实际变化时才要求阻塞式回填(PR #5155 review P2): 只改权限档等不动
  // 路由指纹的保存不该被无关的供应商目录故障挡下。
  it.each(['IM_DEFAULT_SETTINGS_SET', 'IM_DEFAULT_SETTINGS_RESET'] as const)(
    'requires the blocking backfill only when the route default actually changes (%s)',
    (channel) => {
      const handler = source.indexOf(`MAKER_IPC_INVOKE.${channel},`);
      expect(handler).toBeGreaterThanOrEqual(0);
      const gate = source.indexOf('routeDefaultChanged', handler);
      const backfill = source.indexOf('prepareImDefaultSettingsChange(', handler);
      expect(gate).toBeGreaterThan(handler);
      expect(gate).toBeLessThan(backfill);
    },
  );
});
