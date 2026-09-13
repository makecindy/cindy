import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { beforeEach, expect, it, vi } from 'vitest';
import {
  getScheduleIndexInvalidationVersion,
  invalidateRunningSessionScheduleEntries,
  loadSharedSessionScheduleIndex,
  resetScheduleIndexThrottleForTesting,
} from '@/session/scheduleIndex';
import type { MobileMakerTransport } from '@/device-link/mobileMakerTransport';

// Execute the screen's actual effect, including its guards, rather than copying
// them into a test helper. The shared loader remains real to check cache reuse.
const source = ts.createSourceFile('screen.tsx', readFileSync('app/devices/[deviceId].tsx', 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let effectSource = '';
let dependencies: string[] = [];
function visit(node: ts.Node) {
  if (ts.isCallExpression(node) && node.expression.getText(source) === 'useEffect'
    && node.arguments[0]?.getText(source).includes('loadSharedSessionScheduleIndex')) {
    effectSource = node.arguments[0].getText(source);
    dependencies = (node.arguments[1] as ts.ArrayLiteralExpression).elements.map((e) => e.getText(source));
  }
  ts.forEachChild(node, visit);
}
visit(source);
const effect = new Function('screenFocused', 'appStateActive', 'scheduleEventSnapshot', 'deviceId', 'maker', 'canLoadScheduleIndex', 'loadSharedSessionScheduleIndex', 'getScheduleIndexInvalidationVersion', 'setScheduleIndex', 'lastSyncedAt', ts.transpile(`(${effectSource})();`));
beforeEach(resetScheduleIndexThrottleForTesting);

it.each(['blur', 'background'] as const)('reloads a cancelled first index after %s with no schedule events', async (reason) => {
  expect(dependencies).toEqual(expect.arrayContaining(['screenFocused', 'appStateActive', 'lastSyncedAt']));
  let focused = reason !== 'blur';
  let foreground = reason !== 'background';
  const canStart = () => focused && foreground;
  const list = vi.fn(async () => []);
  const maker = { schedule: { list, listRuns: vi.fn(async () => []) } } as unknown as Pick<MobileMakerTransport, 'schedule'>;
  // sessions:list settled after leaving the screen; its subsequent scan cancels.
  await expect(loadSharedSessionScheduleIndex('device', maker, canStart)).rejects.toThrow('consumer inactive');
  const setIndex = vi.fn();
  const pending: Promise<unknown>[] = [];
  const load: typeof loadSharedSessionScheduleIndex = (...args) => {
    const result = loadSharedSessionScheduleIndex(...args);
    pending.push(result);
    return result;
  };
  const run = (lastSyncedAt: number | null = 1) => effect(focused, foreground, { sessionIndexVersion: 0, scheduleListVersion: 0, unreadClearVersion: 0 }, 'device', maker, canStart, load, getScheduleIndexInvalidationVersion, setIndex, lastSyncedAt);
  run();
  expect(list).not.toHaveBeenCalled();
  focused = foreground = true;
  run(null);
  expect(list).not.toHaveBeenCalled();
  run();
  run(); // Repeated visible triggers still share the pending scan.
  await Promise.all(pending);
  expect(list).toHaveBeenCalledTimes(1);
  expect(setIndex).toHaveBeenCalledWith(new Map());
  // Further visits reuse the same success cache rather than scanning again.
  run();
  await Promise.all(pending);
  expect(list).toHaveBeenCalledTimes(1);
});

// 2026-09-10 Android Maximum update depth 崩溃回归:mirror 失效标记在权威同步
// 成功前持续存在,effect 必须对同一 generation 只消费一次,不能随 `sessions`
// 引用变化(离线标记、后台对账)反复把 setScheduleIndex 拉进更新链。
let mirrorEffectSource = '';
let mirrorEffectDependencies: string[] = [];
function visitMirrorEffect(node: ts.Node) {
  if (ts.isCallExpression(node) && node.expression.getText(source) === 'useEffect'
    && node.arguments[0]?.getText(source).includes('invalidateRunningSessionScheduleEntries')) {
    mirrorEffectSource = node.arguments[0].getText(source);
    mirrorEffectDependencies = (node.arguments[1] as ts.ArrayLiteralExpression).elements.map((e) => e.getText(source));
  }
  ts.forEachChild(node, visitMirrorEffect);
}
visitMirrorEffect(source);
const runMirrorEffect = new Function(
  'deviceId',
  'scheduleMirrorInvalidations',
  'consumedMirrorGenerationsRef',
  'invalidateRunningSessionScheduleEntries',
  'sessions',
  'setScheduleIndex',
  ts.transpile(`(${mirrorEffectSource})();`),
);

it('consumes a mirror invalidation generation once, with incremental sessions and reset on clear', () => {
  expect(mirrorEffectDependencies).toEqual(
    expect.arrayContaining(['deviceId', 'scheduleMirrorInvalidations', 'sessions']),
  );
  const consumedMirrorGenerationsRef = {
    current: new Map<string, { generation: number; sessionIds: Set<string> }>(),
  };
  // s3 在 scheduleIndex 里 running,但尚未进入当前可见会话列表。
  const current = new Map([['s1', { running: true }], ['s3', { running: true }]]);
  const setScheduleIndex = vi.fn((updater: (map: typeof current) => typeof current) => updater(current));
  const sessions = [{ id: 's1' }, { id: 's2' }];
  const run = (generation: number | undefined, nextSessions: Array<{ id: string }>) => runMirrorEffect(
    'device',
    generation === undefined ? new Map() : new Map([['device', generation]]),
    consumedMirrorGenerationsRef,
    invalidateRunningSessionScheduleEntries,
    nextSessions,
    setScheduleIndex,
  );

  run(1, sessions);
  // 同一 generation 内 sessions 引用变化(离线标记、对账重渲染)不得再次入链。
  run(1, [...sessions]);
  expect(setScheduleIndex).toHaveBeenCalledTimes(1);
  const cleared = setScheduleIndex.mock.results[0]?.value;
  expect(cleared?.get('s1')).toMatchObject({ running: false });
  // 不可见的 s3 本轮不被触碰。
  expect(cleared?.get('s3')).toMatchObject({ running: true });

  // 代次内后进入可见列表的会话要增量清理 running(greptile P1:遗漏后到会话)。
  run(1, [...sessions, { id: 's3' }]);
  expect(setScheduleIndex).toHaveBeenCalledTimes(2);
  const incremental = setScheduleIndex.mock.results[1]?.value;
  expect(incremental?.get('s3')).toMatchObject({ running: false });

  // 标记被清除时丢弃消费记录;新一轮失效(更高代次)重新消费
  // (codex P2:代次跨 marker 清除单调,不回绕)。
  run(undefined, sessions);
  expect(consumedMirrorGenerationsRef.current.has('device')).toBe(false);
  run(2, sessions);
  expect(setScheduleIndex).toHaveBeenCalledTimes(3);
});
