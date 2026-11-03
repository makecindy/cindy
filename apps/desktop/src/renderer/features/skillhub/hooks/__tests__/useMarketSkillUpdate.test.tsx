// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import type { MarketSkill } from '../useMarketList';
import { useMarketSkillUpdate } from '../useMarketSkillUpdate';
import { HomeMarketCard } from '../../components/HomeMarketCard';
import { MarketCard } from '../../components/MarketCard';

const mocks = vi.hoisted(() => ({
  comparePublished: vi.fn(), refresh: vi.fn(), install: vi.fn(), invalidateHash: vi.fn(), invalidateInfo: vi.fn(),
  success: vi.fn(), error: vi.fn(), t: (key: string) => key,
}));
vi.mock('../useSkillhub', () => ({ refresh: mocks.refresh }));
vi.mock('../useSkillFolderHash', () => ({ invalidateHash: mocks.invalidateHash }));
vi.mock('../../lib/infoDedupe', () => ({ invalidate: mocks.invalidateInfo }));
vi.mock('@/lib/toast', () => ({ toast: { success: mocks.success, error: mocks.error } }));
vi.mock('react-i18next', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: mocks.t, i18n: { language: 'en' } }),
}));

const skill: MarketSkill = {
  name: 'calendar', displayName: 'Calendar', description: 'Calendar tools',
  authorId: 'publisher', authorName: 'Publisher', authorAvatarUrl: null, avatarInitial: 'P',
  isMine: false, canManage: false, latestVersion: '1.0.2', visibility: 'PUBLIC',
  catalogScope: 'market', visibleDeptIds: [], categories: [], tags: [], githubUrl: null,
  publishedAt: '2026-09-01', relativeTime: 'today', downloads: 0,
  installedLocally: true, installedVersion: '1.0.1', installedAbsolutePath: '/global/calendar',
  hasAnyInstall: true, latestPublishedFromDeviceId: null, cardState: 'installed-outdated', updateAvailable: true,
};
const local = {
  name: skill.name, kind: 'skill', absolutePath: skill.installedAbsolutePath,
  registryEntry: { version: '1.0.1', catalogScope: 'market' },
} as SkillhubSkill;
const success = { success: true, name: skill.name, version: skill.latestVersion, absolutePath: local.absolutePath };

beforeEach(() => {
  vi.resetAllMocks();
  setDataOwnerGeneration('owner');
  mocks.refresh.mockResolvedValue([local]);
  mocks.install.mockResolvedValue(success);
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { skillhub: { install: mocks.install, comparePublished: mocks.comparePublished } } });
});
afterEach(cleanup);

describe.each(['home', 'market'] as const)('%s direct update action', (surface) => {
  it('updates in place from the card, blocks repeated clicks, then shows installed', async () => {
    let finish!: (value: typeof success) => void;
    mocks.install.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const onClick = vi.fn();
    const onClone = vi.fn();
    function Card({ value }: { value: MarketSkill }) {
      const { update, updatingNames } = useMarketSkillUpdate();
      const props = { skill: value, onUpdate: update, updating: updatingNames.has(value.name), onClick };
      return surface === 'home' ? <HomeMarketCard {...props} /> : <MarketCard {...props} onClone={onClone} />;
    }
    const { container, rerender } = render(<Card value={skill} />);
    const button = screen.getByRole('button', { name: 'skillhub.marketCard.updateAvailable' });
    expect(container.querySelector('button button')).toBeNull();
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(mocks.install).toHaveBeenCalledExactlyOnceWith({
      name: skill.name, version: skill.latestVersion, catalogScope: 'market',
      installPath: local.absolutePath, force: true, skipBackup: false,
    }));
    expect((screen.getByRole('button', { name: 'skillhub.detail.updating' }) as HTMLButtonElement).disabled).toBe(true);
    expect(onClick).not.toHaveBeenCalled();
    expect(onClone).not.toHaveBeenCalled();
    await act(async () => { finish(success); });
    expect(mocks.refresh).toHaveBeenCalledTimes(2);
    expect(mocks.invalidateHash).toHaveBeenCalledWith(local.absolutePath);
    expect(mocks.invalidateInfo).toHaveBeenCalledWith(skill.name, 'market');
    expect(mocks.success).toHaveBeenCalledOnce();
    rerender(<Card value={{ ...skill, updateAvailable: false, installedVersion: skill.latestVersion }} />);
    expect(screen.queryByRole('button', { name: 'skillhub.marketCard.updateAvailable' })).toBeNull();
    expect(screen.getByText('skillhub.home.installed')).toBeTruthy();
  });

  it('keeps update and detail keyboard actions separate', async () => {
    const onUpdate = vi.fn();
    const onClick = vi.fn();
    const props = { skill, onUpdate, onClick };
    render(surface === 'home' ? <HomeMarketCard {...props} /> : <MarketCard {...props} onClone={vi.fn()} />);
    screen.getByRole('button', { name: 'skillhub.marketCard.updateAvailable' }).focus();
    await userEvent.keyboard('{Enter}');
    await userEvent.keyboard(' ');
    expect(onUpdate).toHaveBeenCalledTimes(2);
    expect(onClick).not.toHaveBeenCalled();
    screen.getByRole('button', { name: skill.displayName }).focus();
    await userEvent.keyboard('{Enter}');
    expect(onClick).toHaveBeenCalledExactlyOnceWith(skill);
  });
});

it.each(['home', 'market'])('never performs publication comparisons on the %s catalog card', async (surface) => {
  const authored = { ...skill, isCreator: true, isMine: true, canManage: true };
  render(surface === 'home' ? <HomeMarketCard skill={authored} onClick={vi.fn()} /> : <MarketCard skill={authored} onClone={vi.fn()} />);
  await act(async () => {});
  expect(mocks.comparePublished).not.toHaveBeenCalled();
  expect(screen.queryByText('skillhub.publishComparison.updateAvailable')).toBeNull();
});

it('updates the original author copy from its public projection with a backup', async () => {
  const authored = { ...local, registryEntry: { version: '1.0.0', origin: 'published', authorId: skill.authorId } };
  mocks.refresh.mockResolvedValue([authored]);
  const { result } = renderHook(useMarketSkillUpdate);
  await act(() => result.current.update({ ...skill, isCreator: true, isMine: true, canManage: true }));
  expect(mocks.install).toHaveBeenCalledExactlyOnceWith({
    name: skill.name, version: skill.latestVersion, catalogScope: 'market',
    installPath: local.absolutePath, force: true, skipBackup: false,
  });
});

it('does not update a same-slug native publication belonging to another owner', async () => {
  mocks.refresh.mockResolvedValue([{ ...local, registryEntry: { version: '1.0.0', origin: 'published', authorId: 'other' } }]);
  const { result } = renderHook(useMarketSkillUpdate);
  await act(() => result.current.update({ ...skill, isCreator: true, isMine: true, canManage: true }));
  expect(mocks.install).not.toHaveBeenCalled();
});

describe('direct update registry and owner boundaries', () => {
  it.each([
    [],
    [{ ...local, registryEntry: null }],
    [{ ...local, registryEntry: { ...local.registryEntry, catalogScope: 'team' } }],
    [{ ...local, registryEntry: { ...local.registryEntry, version: skill.latestVersion } }],
    [{ ...local, registryEntry: { ...local.registryEntry, version: '2.0.0' } }],
    [{ ...local, name: 'another-skill' }],
    [{ ...local, absolutePath: '/another/calendar' }],
  ])('does not overwrite a stale or unrelated installation %#', async (...locals) => {
    mocks.refresh.mockResolvedValue(locals);
    const { result } = renderHook(useMarketSkillUpdate);
    await act(() => result.current.update(skill));
    expect(mocks.install).not.toHaveBeenCalled();
    expect(result.current.updatingNames.size).toBe(0);
  });

  it.each(['failure', 'throw'] as const)('recovers from %s and allows retry', async (mode) => {
    if (mode === 'failure') mocks.install.mockResolvedValueOnce({ success: false, errorCode: 'DOWNLOAD_FAILED' });
    else mocks.install.mockRejectedValueOnce(new Error('IPC disconnected'));
    const { result } = renderHook(useMarketSkillUpdate);
    await act(() => result.current.update(skill));
    expect(mocks.error).toHaveBeenCalledExactlyOnceWith('skillhub.marketCard.updateFailed');
    expect(result.current.updatingNames.size).toBe(0);
    await act(() => result.current.update(skill));
    expect(mocks.install).toHaveBeenCalledTimes(2);
    expect(mocks.success).toHaveBeenCalledOnce();
  });

  it('stops before installation if the owner changes during the rescan', async () => {
    mocks.refresh.mockImplementationOnce(async () => { setDataOwnerGeneration('other'); return [local]; });
    const { result } = renderHook(useMarketSkillUpdate);
    await act(() => result.current.update(skill));
    expect(mocks.install).not.toHaveBeenCalled();
    expect(mocks.success).not.toHaveBeenCalled();
    expect(mocks.error).not.toHaveBeenCalled();
  });

  it('ignores completion from a previous owner', async () => {
    mocks.install.mockImplementationOnce(async () => { setDataOwnerGeneration('other'); return success; });
    const { result } = renderHook(useMarketSkillUpdate);
    await act(() => result.current.update(skill));
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    expect(mocks.invalidateHash).not.toHaveBeenCalled();
    expect(mocks.success).not.toHaveBeenCalled();
  });
});
