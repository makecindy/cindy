// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  skills: [] as SkillhubSkill[], refresh: vi.fn(), confirm: vi.fn(),
  setEnabled: vi.fn(), uninstall: vi.fn(),
  t: (key: string) => key,
}));
vi.mock('../../hooks/useSkillhub', () => ({
  useSkillhub: () => ({ skills: mocks.skills }), refresh: mocks.refresh,
}));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({ useConfirmDialog: () => ({ confirm: mocks.confirm }) }));
vi.mock('@/components/chat/MarkdownRenderer', () => ({ MarkdownRenderer: () => null }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ dataOwnerId: null }) }));
vi.mock('../../ScanResultDialog', () => ({ ScanResultDialog: () => null }));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('react-i18next', async (importOriginal) => ({ ...await importOriginal<typeof import('react-i18next')>(), useTranslation: () => ({
  t: mocks.t, i18n: { language: 'en' },
}) }));

import type { MarketSkill } from '../../hooks/useMarketList';
import { MarketCard } from '../MarketCard';
import { HomeMarketCard } from '../HomeMarketCard';
import { MarketLocalSkills } from '../MarketLocalSkills';
import { SkillhubMarketPreviewPanel } from '../../SkillhubMarketPreviewPanel';

const market: MarketSkill = {
  name: 'gws-calendar', latestVersion: '1.0.2', isMine: false, catalogScope: 'market',
  authorName: 'Publisher', visibility: 'PUBLIC', tags: [], downloads: 0, installedLocally: true,
  displayName: 'gws-calendar', description: 'Calendar', authorId: 'publisher',
  authorAvatarUrl: null, avatarInitial: 'P', canManage: false,
  visibleDeptIds: [], categories: [], githubUrl: null, publishedAt: '2026-09-01T00:00:00Z',
  relativeTime: 'today', installedVersion: '1.0.2',
  installedAbsolutePath: '/fixture/.agents/skills/gws-calendar', hasAnyInstall: true,
  latestPublishedFromDeviceId: null, cardState: 'installed-latest',
};
const local = {
  id: 'global-calendar',
  name: market.name, kind: 'skill', absolutePath: '/fixture/.agents/skills/gws-calendar',
  scope: 'global', registryEntry: { catalogScope: 'market', version: '1.0.2' },
  cindyEnabled: true, canUninstall: true,
} as SkillhubSkill;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.skills = [local];
  mocks.refresh.mockResolvedValue([]);
  mocks.confirm.mockResolvedValue(true);
  mocks.setEnabled.mockResolvedValue({ cindyEnabled: false });
  mocks.uninstall.mockResolvedValue({ success: true });
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { skillhub: {
    setEnabled: mocks.setEnabled, uninstall: mocks.uninstall,
    getPublishedFiles: vi.fn().mockResolvedValue({ success: true, files: [] }),
  } } });
});
afterEach(cleanup);

describe.each(['home', 'card'] as const)('market %s list', (surface) => {
  it('opens Skill details and does not expose local management controls', () => {
    const onClick = vi.fn();
    render(surface === 'home'
      ? <HomeMarketCard skill={market} onClick={onClick} />
      : <MarketCard skill={market} primaryAction="none" onClone={vi.fn()} onClick={onClick} />);
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.queryByRole('button', { name: 'skillhub.management.moreLabel' })).toBeNull();
    fireEvent.click(screen.getByText(market.name));
    expect(onClick).toHaveBeenCalledWith(market);
  });
});

describe('market Skill details', () => {
  it('shows gws-calendar 1.0.2 controls and targets the scanned local copy', async () => {
    render(<MemoryRouter><SkillhubMarketPreviewPanel skill={market} open onClose={vi.fn()}
      primaryAction="clone" onClone={vi.fn()} /></MemoryRouter>);
    expect(screen.queryByText('skillhub.sidebar.marketInstalledHeading')).toBeNull();
    const clone = screen.getByRole('button', { name: 'skillhub.marketCard.clone' });
    expect(clone.parentElement?.contains(screen.getByRole('switch'))).toBe(true);
    expect(screen.getByRole('switch').getAttribute('data-state')).toBe('checked');
    fireEvent.click(screen.getByRole('switch'));
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledOnce());
    expect(mocks.setEnabled).toHaveBeenCalledWith({ absolutePath: local.absolutePath, skillId: local.id, enabled: false });
    fireEvent.keyDown(screen.getByRole('button', { name: 'skillhub.management.moreLabel' }), { key: 'Enter' });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'skillhub.detail.uninstall' }));
    await waitFor(() => expect(mocks.uninstall).toHaveBeenCalledWith(local.absolutePath, local.id));
  });
});

describe('market installed location matching', () => {
  it.each(['market', 'team'] as const)('manages a case-variant local directory in the %s catalog', async (catalogScope) => {
    const copy = { ...local, name: 'Gws-Calendar', registrySkillName: market.name, absolutePath: '/fixture/.agents/skills/Gws-Calendar',
      registryEntry: { ...local.registryEntry!, catalogScope } };
    mocks.skills = [copy];
    render(<MarketLocalSkills skill={{ ...market, catalogScope }} />);
    fireEvent.click(screen.getByRole('switch'));
    await waitFor(() => expect(mocks.setEnabled).toHaveBeenCalledWith({
      absolutePath: copy.absolutePath, skillId: copy.id, enabled: false,
    }));
    fireEvent.keyDown(screen.getByRole('button', { name: 'skillhub.management.moreLabel' }), { key: 'Enter' });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'skillhub.detail.uninstall' }));
    await waitFor(() => expect(mocks.uninstall).toHaveBeenCalledWith(copy.absolutePath, copy.id));
  });

  it('selects a local copy in the toolbar and falls back after that copy is removed', async () => {
    const project = { ...local, id: 'project-calendar', scope: 'project', projectRoot: '/project',
      absolutePath: '/project/.agents/skills/gws-calendar', cindyEnabled: false } as SkillhubSkill;
    mocks.skills = [local, project];
    const { rerender } = render(<MarketLocalSkills skill={market} />);
    expect(screen.getAllByRole('switch')).toHaveLength(1);
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true');
    fireEvent.keyDown(screen.getByRole('button', { name: 'skillhub.sidebar.marketInstalledHeading' }), { key: 'Enter' });
    fireEvent.click(await screen.findByRole('menuitemradio', { name: new RegExp(project.absolutePath) }));
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false');
    fireEvent.click(screen.getByRole('switch'));
    await waitFor(() => expect(mocks.setEnabled).toHaveBeenCalledWith({ absolutePath: project.absolutePath, skillId: project.id, enabled: true }));
    mocks.skills = [local];
    rerender(<MarketLocalSkills skill={market} />);
    expect(screen.getAllByRole('switch')).toHaveLength(1);
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true');
    mocks.skills = [];
    rerender(<MarketLocalSkills skill={market} />);
    expect(screen.queryByRole('switch')).toBeNull();
  });

  it.each(['global', 'project'] as const)('selects the second entry sharing a physical path with a %s entry', async (firstScope) => {
    const first = { ...local, scope: firstScope, projectRoot: '/first-project' };
    const second = { ...local, id: 'second-project-calendar', scope: 'project', projectRoot: '/second-project' } as SkillhubSkill;
    mocks.skills = [first, second];
    render(<MarketLocalSkills skill={market} />);
    fireEvent.keyDown(screen.getByRole('button', { name: 'skillhub.sidebar.marketInstalledHeading' }), { key: 'Enter' });
    const locations = await screen.findAllByRole('menuitemradio');
    expect(locations[1]!.textContent).toContain('/second-project');
    fireEvent.click(locations[1]!);
    fireEvent.click(screen.getByRole('switch'));
    await waitFor(() => expect(mocks.setEnabled).toHaveBeenCalledWith({
      absolutePath: second.absolutePath, skillId: second.id, enabled: false,
    }));
    fireEvent.keyDown(screen.getByRole('button', { name: 'skillhub.management.moreLabel' }), { key: 'Enter' });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'skillhub.detail.uninstall' }));
    await waitFor(() => expect(mocks.uninstall).toHaveBeenCalledWith(second.absolutePath, second.id));
  });

  it('does not manage same-name copies from another catalog or unregistered third-party copies', () => {
    mocks.skills = [
      { ...local, name: 'Gws-Calendar', registrySkillName: market.name, registryEntry: { ...local.registryEntry!, catalogScope: 'team' } },
      { ...local, name: 'Gws-Calendar', absolutePath: '/untracked', registryEntry: null },
      { ...local, name: 'Gws-Calendar', registrySkillName: market.name, absolutePath: '/native', registryEntry: { ...local.registryEntry!, catalogScope: undefined } },
    ];
    render(<MarketLocalSkills skill={market} />);
    expect(screen.queryByRole('switch')).toBeNull();
  });

  it('includes an owned unregistered copy and keeps package-owned copies toggleable', () => {
    mocks.skills = [{ ...local, registryEntry: null, canUninstall: false }];
    render(<MarketLocalSkills skill={{ ...market, isMine: true }} />);
    expect(screen.getByRole('switch')).toBeTruthy();
  });

  it('keeps unrelated case-sensitive copies separate even on an owned market page', () => {
    mocks.skills = [
      { ...local, name: 'Gws-Calendar', registryEntry: null },
      { ...local, name: 'Gws-Calendar', registrySkillName: 'other-market-skill' },
      { ...local, name: market.name, registrySkillName: 'other-market-skill' },
      { ...local, name: 'Gws-Calendar' }, // Old scan without registry slug: exact match only.
    ];
    render(<MarketLocalSkills skill={{ ...market, isMine: true }} />);
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.queryByRole('button', { name: 'skillhub.management.moreLabel' })).toBeNull();
  });
});
