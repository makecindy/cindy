import { UsageHistorySection } from '../../../src/renderer/components/settings/usage/UsageHistorySection';
import { SettingsSidebarNav } from '../../../src/renderer/components/settings/SettingsSidebarNav';
import { mountPage } from '../../ui-page/harness';

void mountPage({
  host: () => {
    let participating = true;
    return {
      companyTokenView: async () => ({ generation: 1, participating }),
      companyTokenParticipation: async (next: boolean) => { participating = next; },
    };
  },
  render: () => (
    <div className="flex h-screen">
      <aside className="w-52 shrink-0 overflow-auto border-r border-[var(--border-default)] p-3">
        <SettingsSidebarNav activeTab="usage" tabIds={['general', 'appearance', 'providers', 'billing', 'usage',
          'personalization', 'shortcuts', 'remote-control', 'ghosts', 'help', 'about']} onSelectTab={() => {}} />
      </aside>
      <main className="min-w-0 flex-1 overflow-y-auto p-7"><UsageHistorySection /></main>
    </div>
  ),
});
