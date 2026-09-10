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

it('consumes a mirror invalidation generation once even as session identities churn', () => {
  expect(mirrorEffectDependencies).toEqual(
    expect.arrayContaining(['deviceId', 'scheduleMirrorInvalidations', 'sessions']),
  );
  const consumedMirrorGenerationsRef = { current: new Map<string, number>() };
  const current = new Map([['s1', { running: true }]]);
  const setScheduleIndex = vi.fn((updater: (map: typeof current) => typeof current) => updater(current));
  const sessions = [{ id: 's1' }, { id: 's2' }];
  const run = (generation: number | undefined, nextSessions: typeof sessions) => runMirrorEffect(
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

  // 新 generation(失效后有新事件快照再被清)才允许消费下一次。
  run(2, sessions);
  expect(setScheduleIndex).toHaveBeenCalledTimes(2);
  // 标记被清除(generation 消失)后回到静止,不得再触发。
  run(undefined, sessions);
  expect(setScheduleIndex).toHaveBeenCalledTimes(2);
});
