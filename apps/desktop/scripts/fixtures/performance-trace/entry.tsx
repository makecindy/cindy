import { useEffect } from 'react';
import { mountPage, ctx } from '../../ui-page/harness';
import {
  PerformanceTrace,
  openPerformanceTrace,
} from '../../../src/renderer/components/performance-trace/PerformanceTrace';
import type { PerformanceTraceState } from '../../../src/shared/performanceTrace';
import { MenuButton } from '../../../src/renderer/components/title-bar/MenuButton';

if (ctx.case === 'secondary-menu') {
  const url = new URL(window.location.href);
  url.searchParams.set('secondaryWindow', '1');
  window.history.replaceState(null, '', url);
}

const listeners = new Set<(state: PerformanceTraceState) => void>();
let state: PerformanceTraceState = {
  phase: 'idle',
  startedAt: null,
  reportId: null,
  uploaded: false,
  partial: false,
  durationMs: 0,
};
if (ctx.case !== 'default')
  state = {
    phase: ctx.case === 'recording' ? 'recording' : 'ready',
    startedAt: Date.now() - 12_000,
    reportId: 'ABCD-EFGH',
    uploaded: ctx.case === 'reopened-submitted',
    partial: ctx.case === 'partial',
    durationMs: 12_000,
  };
function Entry() {
  useEffect(() => {
    if (ctx.case === 'recording' || ctx.case.endsWith('-menu')) return;
    if (ctx.case === 'default' || ctx.case.startsWith('reopened')) openPerformanceTrace();
    else {
      // A completed capture pushes ready; merely reading a previous result does not.
      for (const listener of listeners) listener(state);
    }
  }, []);
  return ctx.case.endsWith('-menu') ? (
    <div className="p-4">
      <MenuButton />
    </div>
  ) : (
    <PerformanceTrace />
  );
}
void mountPage({
  route: '/',
  host: {
    performanceTrace: {
      command: async (command: string) => {
        if (command === 'upload' && ctx.case === 'upload-failed')
          throw new Error('[LOG_UPLOAD_FAILED] offline');
        if (command === 'upload') state = { ...state, uploaded: true };
        if (command === 'start')
          state = {
            ...state,
            phase: 'recording',
            reportId: 'ABCD-EFGH',
            startedAt: Date.now(),
            uploaded: false,
          };
        if (command === 'stop') state = { ...state, phase: 'ready', durationMs: 12_000 };
        if (command !== 'state' && command !== 'show-local') {
          for (const listener of listeners) listener(state);
        }
        return state;
      },
      events: () => {},
      onState: (listener: (state: PerformanceTraceState) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  },
  render: () => <Entry />,
});
