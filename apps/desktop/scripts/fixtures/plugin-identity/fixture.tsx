import { mountPage } from '../../ui-page/harness';
import { useTranslation } from 'react-i18next';
import { GhostPluginCard, MarketPluginCard } from '../../../src/renderer/features/plugin/GhostPluginPage';
import { PluginDetailHeader } from '../../../src/renderer/features/plugin/GhostPluginDetailView';
import { MarketPluginDetailView } from '../../../src/renderer/features/plugin/MarketPluginDetailView';
import type { PluginMarketItem } from '../../../src/shared/pluginMarket';

const noop = () => {};
const official: PluginMarketItem = {
  pluginId: 'fixture-official', ghostId: 'github', namespace: null, name: 'GitHub',
  description: 'Search repositories, review pull requests and manage issues.',
  author: 'Cindy', publisherKind: 'official', scope: 'public', sourceType: 'server',
  sourceMarketName: null, organizationId: null, defaultInstall: false,
  releaseId: 'fixture-release', version: '1.0.0', publishedAt: '2026-11-09T00:00:00Z',
  icon: null, installState: 'not-installed', enabled: null,
  downloadStatistics: { requestCount: '12480' },
};
const community: PluginMarketItem = { ...official, pluginId: 'fixture-community', ghostId: 'ntfy',
  name: 'ntfy', author: 'PRIVATE_AUTHOR', publisherKind: 'personal',
  description: 'Send notifications to your devices.', downloadStatistics: { requestCount: '0' } };
const team: PluginMarketItem = { ...official, pluginId: 'fixture-team', ghostId: 'xd-atlassian',
  name: 'XD Atlassian', scope: 'organization', organizationId: 'fixture-team', author: 'XD',
  description: 'Work with Jira issues and Confluence pages.' };
const custom: PluginMarketItem = { ...official, pluginId: 'fixture-custom', ghostId: 'cindy-ping',
  name: 'Cindy Ping', sourceType: 'git-market', sourceMarketName: 'My marketplace',
  description: 'Post expressions anywhere on your desktop.', downloadStatistics: undefined };
const recommendations = [official,
  { ...official, pluginId: 'fixture-notion', ghostId: 'notion', name: 'Notion',
    description: 'Search and update your workspace.', downloadStatistics: { requestCount: '3201' } },
  { ...official, pluginId: 'fixture-long', ghostId: 'google-drive',
    name: 'Google Drive with an intentionally long plugin name',
    description: 'Find and organize your files.', downloadStatistics: { requestCount: '10934' } }];

function PluginIdentityFixture({ mode }: { mode: string }) {
  const { t } = useTranslation();
  return mode === 'market-detail'
    ? <MarketPluginDetailView detail={{ ...community, manifest: {
      schemaVersion: 3, id: 'ntfy', name: 'ntfy', version: '1.0.0', kind: 'chip', entry: 'main.js',
    } }} busy={false} onBack={noop} onInstall={noop} onIconLoadError={noop} />
    : mode === 'local-detail'
      ? <main className="mx-auto max-w-[824px] p-6"><PluginDetailHeader id="local-report"
        name="Weekly report" description="A plugin developed on this computer."
        origin="local" version="1.0.0" /></main>
      : <main className="mx-auto min-w-0 max-w-[944px] p-6">
        <section>
          <h2 className="mb-4 text-20 font-medium text-[var(--text-primary)]">{t('settings.ghosts.page.todayRecommendations')}</h2>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,220px),1fr))] gap-3">
            {recommendations.map(item => <MarketPluginCard compact key={item.pluginId} item={item}
              busy={false} onSelect={noop} onInstall={noop} onIconLoadError={noop} />)}
          </div>
        </section>
        <section className="mt-6">
          <h2 className="mb-4 text-20 font-medium text-[var(--text-primary)]">{t('settings.ghosts.page.marketSection')}</h2>
          <div className="grid grid-cols-1 gap-3 min-[640px]:grid-cols-2">
            {[official, community, team, custom].map(item => <MarketPluginCard key={item.pluginId}
              item={item} busy={false} onSelect={noop} onInstall={noop} onIconLoadError={noop} />)}
            <GhostPluginCard item={{ id: 'local-report', name: 'Weekly report', description: 'A plugin developed on this computer.', origin: 'local' }}
              onPrimary={noop} onManage={noop} />
          </div>
        </section>
      </main>;
}

mountPage({ render: ctx => <PluginIdentityFixture mode={ctx.case} /> });
