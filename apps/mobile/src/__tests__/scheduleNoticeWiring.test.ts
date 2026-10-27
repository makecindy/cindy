// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, createElement, useCallback, useEffect, type EffectCallback } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import ts from 'typescript';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { projectScheduleEvent } from '@cindy/maker-shared/schedule-events';
import type { MobileMakerTransport } from '@/device-link/mobileMakerTransport';
import { withTransientRemoteRetry } from '@/device-link/remoteRetry';
import { remoteScheduleEventStore } from '@/scheduler/remoteScheduleEvents';
import { loadSharedSessionScheduleIndex, resetScheduleIndexThrottleForTesting, sessionMayHaveScheduleRuns } from '@/session/scheduleIndex';
import { markSessionScheduleRunsRead } from '@/session/scheduleRunRead';

// Keep the historical session-bound/visibility regression, but execute the
// production focus-effect expression and real mark-read orchestration instead
// of asserting its dependency strings. Deferred idle work is run synchronously.
const screen = ts.createSourceFile('screen.tsx', readFileSync(resolve(process.cwd(), 'app/sessions/[sessionId].tsx'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let expression: string | undefined;
function visit(node: ts.Node) {
  if (ts.isCallExpression(node) && node.expression.getText(screen) === 'useFocusEffect'
    && node.getText(screen).includes('setScheduleFailure')) expression = node.getText(screen);
  ts.forEachChild(node, visit);
}
visit(screen);
if (!expression) throw new Error('Schedule notice focus effect was not found');
const emitted = ts.transpileModule(expression, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
function useFocusEffect(effect: EffectCallback) { useEffect(effect, [effect]); }
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  resetScheduleIndexThrottleForTesting();
  remoteScheduleEventStore.clearDevice('notice-device');
  root = createRoot(document.createElement('div'));
});
afterEach(() => {
  act(() => root.unmount());
  resetScheduleIndexThrottleForTesting();
  remoteScheduleEventStore.clearDevice('notice-device');
});

it.each(['binding-event', 'history-ready', 'app-active'] as const)(
  'reads a later-bound run and updates its failure notice when %s changes', async trigger => {
    let runs: Record<string, unknown>[] = [];
    const markRunRead = vi.fn(async () => undefined);
    const maker = { schedule: {
      list: async () => [{ id: 'schedule', name: 'Report', status: 'active' }],
      listRuns: async () => runs,
      markRunRead,
    } } as unknown as MobileMakerTransport;
    await loadSharedSessionScheduleIndex('notice-device', maker);
    const setScheduleFailure = vi.fn();
    const stable = { useCallback, useFocusEffect, maker, withTransientRemoteRetry,
      sessionMayHaveScheduleRuns, markSessionScheduleRunsRead, setScheduleFailure,
      deviceId: 'notice-device', sessionId: 'task', connectionEpoch: 1, invoke: vi.fn(),
      sessionSourceForSchedule: 'desktop', scheduleNoticeSource: 'owner/notice-device/task',
      messageScreenFocusedRef: { current: true }, messageAppActiveRef: { current: true },
      deferScheduleIndexHydration: (callback: () => void) => { callback(); return vi.fn(); },
    };
    const execute = new Function(...Object.keys(stable), 'appStateActive', 'remoteHistoryAvailable', 'scheduleEventSnapshot', emitted);
    type Gates = { appStateActive: boolean; remoteHistoryAvailable: boolean; version: number };
    function Notice({ appStateActive, remoteHistoryAvailable, version }: Gates) {
      execute(...Object.values(stable), appStateActive, remoteHistoryAvailable, { sessionIndexVersion: version });
      return null;
    }
    const gates = { appStateActive: trigger !== 'app-active', remoteHistoryAvailable: trigger !== 'history-ready', version: remoteScheduleEventStore.getSnapshot('notice-device').sessionIndexVersion };
    await act(async () => root.render(createElement(Notice, gates)));
    expect(markRunRead).not.toHaveBeenCalled();
    expect(setScheduleFailure).not.toHaveBeenCalled();

    runs = [{ id: 'run', scheduleId: 'schedule', sessionId: 'task', status: 'failed', firedAt: 1 }];
    const event = { type: 'session-bound' as const, scheduleId: 'schedule', runId: 'run', sessionId: 'task' };
    const projection = projectScheduleEvent(event);
    expect(projection.refresh.sessionIndex).toBe(true);
    expect(projection.refresh.unreadSummary).toBe(false);
    remoteScheduleEventStore.apply('notice-device', event);
    gates.version = remoteScheduleEventStore.getSnapshot('notice-device').sessionIndexVersion;
    await act(async () => root.render(createElement(Notice, { ...gates })));
    if (trigger !== 'binding-event') {
      expect(markRunRead).not.toHaveBeenCalled();
      expect(setScheduleFailure).not.toHaveBeenCalled();
      gates.appStateActive = true;
      gates.remoteHistoryAvailable = true;
      await act(async () => root.render(createElement(Notice, { ...gates })));
    }
    expect(markRunRead).toHaveBeenCalledExactlyOnceWith('run');
    expect(setScheduleFailure).toHaveBeenCalledExactlyOnceWith({ source: 'owner/notice-device/task', run: { runId: 'run', scheduleId: 'schedule', firedAt: 1, failureKind: 'execution' } });
  },
);
