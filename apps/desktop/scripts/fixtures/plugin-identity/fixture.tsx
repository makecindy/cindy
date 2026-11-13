import { mountPage } from '../../ui-page/harness';
import { useTranslation } from 'react-i18next';
import { GhostPluginCard, MarketPluginCard } from '../../../src/renderer/features/plugin/GhostPluginPage';
import { PluginDetailHeader } from '../../../src/renderer/features/plugin/GhostPluginDetailView';
import { MarketPluginDetailView } from '../../../src/renderer/features/plugin/MarketPluginDetailView';
import type { PluginMarketItem } from '../../../src/shared/pluginMarket';
import taptapIcon from './assets/taptap-cli.png?url';
import notionIcon from './assets/notion.png?url';
import simulatorIcon from './assets/simulator.png?url';

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

const previewRecommendations: PluginMarketItem[] = [
  { ...official, pluginId: 'fixture-taptap', ghostId: 'taptap-cli', name: 'TapTap CLI',
    description: 'TapTap 开发者业务插件：调用本机已安装的官方 taptap-cli，处理登录、身份与开发者业务。',
    downloadStatistics: { requestCount: '4041' }, icon: {
      url: taptapIcon, mimeType: 'image/png', sha256: '1'.repeat(64), sizeBytes: 9030, expiresAt: '2099-01-01T00:00:00.000Z',
    } },
  { ...official, pluginId: 'fixture-notion', ghostId: 'cindy-notion', name: 'Notion',
    description: '连接你的 Notion 工作区，搜索和读取页面、查询 data source，并创建或更新页面内容。',
    downloadStatistics: { requestCount: '573' }, icon: {
      url: notionIcon, mimeType: 'image/png', sha256: '2'.repeat(64), sizeBytes: 76525, expiresAt: '2099-01-01T00:00:00.000Z',
    } },
  { ...official, pluginId: 'fixture-simulator', ghostId: 'baguette-simulator', name: '设备模拟器',
    description: '在统一设备列表和任务侧栏中查看、操作 iPhone、iPad、Apple TV、Vision Pro 等设备。',
    downloadStatistics: { requestCount: '5255' }, icon: {
      url: simulatorIcon, mimeType: 'image/png', sha256: '3'.repeat(64), sizeBytes: 15074, expiresAt: '2099-01-01T00:00:00.000Z',
    } },
];

function PluginIdentityFixture({ mode }: { mode: string }) {
  const { t } = useTranslation();
  const recommended = mode === 'preview' ? previewRecommendations : recommendations;
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
            {recommended.map(item => <MarketPluginCard compact key={item.pluginId} item={item}
              busy={false} onSelect={noop} onInstall={noop} onIconLoadError={noop} />)}
          </div>
        </section>
        <section className="mt-6">
          <h2 className="mb-4 text-20 font-medium text-[var(--text-primary)]">{t('settings.ghosts.page.marketSection')}</h2>
          <div className="grid grid-cols-1 gap-3 min-[640px]:grid-cols-2">
            {(mode === 'preview' ? previewRecommendations : [official, community, team, custom]).map(item => <MarketPluginCard key={item.pluginId}
              item={item} busy={false} onSelect={noop} onInstall={noop} onIconLoadError={noop} />)}
            {mode !== 'preview' ? <GhostPluginCard item={{ id: 'local-report', name: 'Weekly report', description: 'A plugin developed on this computer.', origin: 'local' }}
              onPrimary={noop} onManage={noop} /> : null}
          </div>
        </section>
      </main>;
}

mountPage({ render: ctx => <PluginIdentityFixture mode={ctx.case} /> });
