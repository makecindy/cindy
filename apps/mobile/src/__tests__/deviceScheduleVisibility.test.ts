import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { beforeEach, expect, it, vi } from 'vitest';
import {
  getScheduleIndexInvalidationVersion,
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
