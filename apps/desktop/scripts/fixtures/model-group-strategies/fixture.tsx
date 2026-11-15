import { mountPage } from '../../ui-page/harness';
import { ModelGroupsSection } from '../../../src/renderer/components/settings/ModelGroupsSection';
import type { ModelGroupsConfig } from '../../../src/shared/modelGroups';

void mountPage({
  host: () => {
    let config: ModelGroupsConfig = { routes: [{ id: 'fixture-mode', name: 'Development', strategy: 'order', candidates: [] }] };
    return { modelGroups: {
      get: async () => config,
      set: async (next: ModelGroupsConfig) => { config = next; return config; },
      decisions: async () => [],
      resolve: async () => ({ outcome: 'unavailable', trace: [] }),
    } };
  },
  render: () => <main className="min-h-screen min-w-0 bg-[var(--surface)] p-4 text-[var(--text-primary)]">
    <div className="mx-auto min-w-0 max-w-[640px]"><ModelGroupsSection /></div>
  </main>,
});
