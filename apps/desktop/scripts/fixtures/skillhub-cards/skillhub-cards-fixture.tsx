import { mountPage } from '../../ui-page/harness';
import { useFontSettings } from '../../../src/renderer/hooks/useFontSettings';
import { HomeMarketCard } from '../../../src/renderer/features/skillhub/components/HomeMarketCard';
import type { MarketSkill } from '../../../src/renderer/features/skillhub/hooks/useMarketList';

// Synthetic presentation-only data, never used as the product catalog.
const skill: MarketSkill = {
  name: 'fixture', displayName: 'Research workspace',
  description: 'A deliberately long description that wraps across two lines to verify readable line boxes at the largest supported interface font size.',
  authorName: 'Fixture publisher', authorId: 'fixture', avatarInitial: 'F',
  isMine: false, canManage: false, latestVersion: '1.0.0',
  visibility: 'PUBLIC', publishedVisibility: 'public', visibleDeptIds: [],
  categories: ['research'], tags: [{ slug: 'research', name: 'Research' }],
  githubUrl: null, publishedAt: '2026-10-19T00:00:00Z', relativeTime: 'today',
  downloads: 1234, installedLocally: true, installedVersion: '1.0.0',
  installedAbsolutePath: null, hasAnyInstall: true,
  latestPublishedFromDeviceId: null, cardState: 'installed-latest',
};

function CardsFixture() {
  const { setUiSize } = useFontSettings();
  return <main className="min-h-screen bg-[var(--surface)] p-8 text-[var(--text-primary)]">
    <button type="button" onClick={() => setUiSize(14)}>Default font</button>
    <button type="button" onClick={() => setUiSize(24)}>Large font</button>
    <div data-testid="home-card" className="mt-4 w-full max-w-[680px]">
      <HomeMarketCard skill={skill} onClick={() => {}} />
    </div>
  </main>;
}

mountPage({ render: () => <CardsFixture /> });
