// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';

const state = vi.hoisted(() => ({ skills: [] as SkillhubSkill[], canWrite: true, leave: vi.fn(), update: vi.fn() }));
vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  const t = (key: string) => key;
  return { ...actual, useTranslation: () => ({ t }) };
});
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'owner' } }) }));
vi.mock('../hooks/useSkillhubIdentityPolicy', () => ({ useSkillhubIdentityPolicy: () => ({ canWrite: state.canWrite }) }));
vi.mock('../hooks/useSkillhub', () => ({
  useSkillhub: () => ({ skills: state.skills, bootstrapped: true, loading: false, learnSkillEnabled: true }),
  refresh: vi.fn(async () => state.skills),
}));
vi.mock('../hooks/useMarketSkillUpdate', () => ({ useMarketSkillUpdate: () => ({ update: state.update, updatingNames: new Set() }) }));
vi.mock('../hooks/useMarketManagement', () => ({ useMarketManagement: () => ({}), MarketManagementDialogs: () => null }));
vi.mock('../components/InstallTargetPicker', () => ({ InstallTargetPicker: () => null }));
vi.mock('../components/LocalSkillControls', () => ({ LocalSkillControls: ({ skill }: { skill: SkillhubSkill }) => <span data-testid="controls">{skill.id}</span> }));
vi.mock('@/components/ui/select', () => ({ Select: ({ value, onValueChange, options }: {
  value: string; onValueChange: (value: string) => void; options: { value: string; label: string }[];
}) => <select aria-label="copy" value={value} onChange={(event) => onValueChange(event.target.value)}>
  {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
</select> }));
vi.mock('../SkillhubDetailView', () => ({ SkillhubDetailView: ({ entryOverride, renderNavigation }: {
  entryOverride: SkillhubSkill; renderNavigation: (leave: () => Promise<boolean>, disabled: boolean) => ReactNode;
}) => <><div data-testid="local">{entryOverride.id}</div>{renderNavigation(state.leave, false)}</> }));
vi.mock('../SkillhubMarketDetailView', () => ({ SkillhubMarketDetailView: ({ skill, navigation, localActions, onUpdate, onClose, selectedLocal, onPublishUpdate }: {
  skill: { installedAbsolutePath: string }; navigation: ReactNode; localActions: ReactNode; onUpdate: (skill: unknown) => void;
  onClose: () => void; selectedLocal: SkillhubSkill; onPublishUpdate?: (local: SkillhubSkill) => void;
}) => <><div data-testid="market">{skill.installedAbsolutePath}</div>{navigation}{localActions}
  <button onClick={() => onUpdate(skill)}>update</button><button onClick={onClose}>back</button>
  {onPublishUpdate && <button onClick={() => onPublishUpdate(selectedLocal)}>publish</button>}
</> }));

import { SkillhubDetailRoute, LegacySkillDetailRedirect } from '../SkillhubDetailRoute';
import { buildMarketSkillRoute } from '../lib/detailRoutes';
import { buildLocalSkillRoute } from '../lib/localRoutes';

const info = vi.fn();
const record = { name: 'demo', authorName: 'Owner', isCreator: true, isMine: true, canManage: true, latestVersion: '2.0.0' };
const local = (id: string, scope: 'global' | 'project', catalogScope: 'market' | 'team' = 'market') => ({
  id, name: 'demo', engine: 'pi', kind: 'skill', scope, sourceKey: id, projectHash: scope === 'project' ? id : undefined,
  absolutePath: `/skills/${id}`, projectRoot: scope === 'project' ? `/projects/${id}` : undefined,
  registryEntry: { version: '1.0.0', catalogScope },
}) as SkillhubSkill;
function Location() { const location = useLocation(); return <div data-testid="location">{location.pathname}{location.search}</div>; }
function mount(path: string) {
  return render(<MemoryRouter initialEntries={[path]}><Location /><Routes>
    <Route path="/skillhub/detail" element={<SkillhubDetailRoute />} />
    <Route path="/skillhub/local/:kind/project/:projectHash/:name" element={<LegacySkillDetailRedirect />} />
    <Route path="/skillhub/market/:name" element={<LegacySkillDetailRedirect market />} />
    <Route path="/skillhub/market" element={<div>market list</div>} />
  </Routes></MemoryRouter>);
}
beforeEach(() => {
  setDataOwnerGeneration('owner', 1);
  state.skills = [local('project', 'project'), local('global', 'global'), local('team', 'global', 'team')];
  state.canWrite = true;
  state.leave.mockReset().mockResolvedValue(true);
  state.update.mockReset();
  info.mockReset().mockResolvedValue({ success: true, info: record });
  vi.stubGlobal('electronAPI', { skillhub: { info } });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('unified Skill details', () => {
  it('resolves a direct market link, excludes same-slug other catalogs and retains return filters', async () => {
    const returnTo = '/skillhub/market?q=demo&sort=trending&visibility=mine';
    mount(buildMarketSkillRoute({ name: 'demo', catalogScope: 'market' }, returnTo));
    expect(await screen.findByTestId('market')).toHaveProperty('textContent', '/skills/global');
    expect(screen.getAllByRole('option')).toHaveLength(2);
    expect(info).toHaveBeenCalledWith('demo', 'market');
    fireEvent.change(screen.getByLabelText('copy'), { target: { value: 'project' } });
    await waitFor(() => expect(screen.getByTestId('controls').textContent).toBe('project'));
    fireEvent.click(screen.getByText('update'));
    expect(state.update).toHaveBeenCalledWith(expect.objectContaining({ installedAbsolutePath: '/skills/project' }));
    fireEvent.click(screen.getByText('back'));
    expect(screen.getByTestId('location').textContent).toBe(returnTo);
  });

  it('honors the local unsaved-edit guard before switching source or copy', async () => {
    mount(buildLocalSkillRoute(state.skills[0]!));
    await screen.findByRole('button', { name: 'skillhub.unifiedDetail.market' });
    fireEvent.click(screen.getByRole('button', { name: 'skillhub.unifiedDetail.local' }));
    expect(state.leave).not.toHaveBeenCalled();
    state.leave.mockResolvedValue(false);
    fireEvent.click(screen.getByRole('button', { name: 'skillhub.unifiedDetail.market' }));
    await waitFor(() => expect(state.leave).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('local').textContent).toBe('project');
    fireEvent.change(screen.getByLabelText('copy'), { target: { value: 'global' } });
    await waitFor(() => expect(state.leave).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId('local').textContent).toBe('project');
    state.leave.mockResolvedValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'skillhub.unifiedDetail.market' }));
    expect(await screen.findByTestId('market')).toHaveProperty('textContent', '/skills/project');
    expect(screen.queryByText('publish')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'skillhub.unifiedDetail.local' }));
    expect(await screen.findByTestId('local')).toHaveProperty('textContent', 'project');
    expect(screen.getByTestId('location').textContent).toContain('view=local');
  });

  it('keeps local unregistered content separate from another creator with the same name', async () => {
    state.skills = [{ ...state.skills[0]!, registryEntry: null }];
    info.mockResolvedValue({ success: true, info: { ...record, isCreator: false, isMine: true } });
    mount(buildLocalSkillRoute(state.skills[0]!));
    await act(async () => {});
    expect(screen.getByTestId('local').textContent).toBe('project');
    expect(screen.queryByRole('button', { name: 'skillhub.unifiedDetail.market' })).toBeNull();
  });

  it.each([false, true])('does not expose publishing in the market view (canWrite=%s)', async (canWrite) => {
    state.canWrite = canWrite;
    mount(buildMarketSkillRoute({ name: 'demo', catalogScope: 'market' }));
    await screen.findByTestId('market');
    expect(screen.queryByText('publish')).toBeNull();
  });

  it('associates the original native publication without merging another owner', async () => {
    const authored = { ...local('authored', 'global'), name: 'google-play-console', registryEntry: {
      version: '1.0.0', origin: 'published', authorId: 'creator',
    } } as SkillhubSkill;
    state.skills = [authored, { ...authored, id: 'other', registryEntry: { ...authored.registryEntry!, authorId: 'someone-else' } }];
    info.mockResolvedValue({ success: true, info: { ...record, name: authored.name, authorId: 'creator' } });
    mount(buildMarketSkillRoute({ name: authored.name, catalogScope: 'market' }));
    expect(await screen.findByTestId('market')).toHaveProperty('textContent', '/skills/authored');
    expect(screen.queryByLabelText('copy')).toBeNull();
    expect(screen.queryByText('publish')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'skillhub.unifiedDetail.local' }));
    expect(await screen.findByTestId('local')).toHaveProperty('textContent', 'authored');
  });

  it('discards an old account response even before React rerenders', async () => {
    let resolve!: (value: unknown) => void;
    info.mockReturnValue(new Promise((done) => { resolve = done; }));
    mount(buildMarketSkillRoute({ name: 'demo', catalogScope: 'market' }));
    setDataOwnerGeneration('other', 2);
    await act(async () => { resolve({ success: true, info: record }); });
    expect(screen.queryByTestId('market')).toBeNull();
  });

  it('redirects legacy project links without losing engine, source, or copy identity', async () => {
    mount('/skillhub/local/skill/project/project/demo?engine=pi&source=project');
    expect(await screen.findByTestId('local')).toHaveProperty('textContent', 'project');
    expect(screen.getByTestId('location').textContent).toContain('/skillhub/detail?');
    expect(screen.getByTestId('location').textContent).toContain('source=project');
  });

  it('redirects legacy market links to a readable market detail', async () => {
    mount('/skillhub/market/demo');
    await screen.findByTestId('market');
    expect(info).toHaveBeenCalledWith('demo', 'market');
    expect(screen.getByTestId('location').textContent).toContain('/skillhub/detail?');
  });
});
