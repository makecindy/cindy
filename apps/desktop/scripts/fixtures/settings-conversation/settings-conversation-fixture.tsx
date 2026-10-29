import { useTranslation } from 'react-i18next';
import { MainViewHistoryContext } from '../../../src/renderer/contexts/MainViewHistoryContext';
import { SettingsConversationButton } from '../../../src/renderer/components/settings/SettingsConversationButton';
import { SettingsSidebarNav } from '../../../src/renderer/components/settings/SettingsSidebarNav';
import { mountPage } from '../../ui-page/harness';

function SettingsNavigation() {
  const { t } = useTranslation();
  return (
    <aside className="flex h-full w-[260px] flex-col gap-2 bg-[var(--settings-bg)] pl-6 pr-4 pt-7">
      <h1 className="px-3 pb-[18px] text-24 font-medium text-[var(--settings-back-text)]">{t('settings.title')}</h1>
      <SettingsConversationButton />
      <SettingsSidebarNav tabIds={['general', 'providers', 'ghosts', 'help']} activeTab="providers" onSelectTab={() => {}} />
    </aside>
  );
}

mountPage({
  route: '/settings?tab=providers',
  host: () => ({ maker: { openSessionInNewWindow: async () => {} } }),
  render: () => (
    <MainViewHistoryContext.Provider value={{ current: { lastMatchedKey: 'cc-agent', paths: { 'cc-agent': '/cc-agent/fixture-task' } } }}>
      <SettingsNavigation />
    </MainViewHistoryContext.Provider>
  ),
});
