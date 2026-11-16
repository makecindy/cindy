import { useState } from 'react';
import { mountPage } from '../../ui-page/harness';
import { WorkerListToolbar } from '../../../src/renderer/features/cc-agent/RolePillDropdown';
import type { WorkerInfo } from '../../../src/renderer/features/cc-agent/hooks/useWorkers';

const workers: WorkerInfo[] = ['frontend', 'reviewer', 'tester', 'docs', 'design', 'research'].map((role, i) => ({
  workerId: role, sessionId: role, role, agent: 'codex', model: 'gpt-5', effort: 'high',
  label: null, status: 'idle', focused: i === 0, idleSince: null,
}));
function Fixture() {
  const [selected, setSelected] = useState('frontend');
  const [version, setVersion] = useState(0);
  return (
    <main className="w-full p-4">
      <section className="flex min-w-0 border border-[var(--border-default)] rounded-xl p-2">
        <WorkerListToolbar key={version} leadSessionId="fixture-lead" worker={workers.find((w) => w.workerId === selected)!}
          workers={workers} selectedWorkerId={selected} activeWorkerCount={6} softLimit={7} hardLimit={8}
          onSwitchFocus={setSelected} onOpenCreate={() => {}} onArchiveWorker={() => {}} />
      </section>
      <div data-ui-page-control className="mt-4 text-sm text-[var(--text-secondary)]">
        <output data-testid="focused-worker">{selected}</output>
        <button className="ml-4" onClick={() => setVersion((v) => v + 1)}>Remount</button>
      </div>
    </main>
  );
}
void mountPage({
  host: {
    notificationMarkSessionAttention: async () => {},
    notificationClearSessionAttention: async () => {},
    localDb: { orcaWorkflows: { projectLabel: async () => null } },
  },
  render: () => {
    localStorage.setItem('orca-worker-list-layout-v1', 'tabs');
    return <Fixture />;
  },
});
