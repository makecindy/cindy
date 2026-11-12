// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { useMarketList } from '../useMarketList';

const mocks = vi.hoisted(() => ({ skills: [] as SkillhubSkill[], listMarket: vi.fn(), t: (key: string) => key }));
vi.mock('../useSkillhub', () => ({ useSkillhub: () => ({ skills: mocks.skills }) }));
vi.mock('react-i18next', async (original) => ({
  ...await original<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: mocks.t, i18n: { language: 'en' } }),
}));
const item = {
  name: 'google-play-console', authorId: 'creator', authorName: 'Creator', isMine: true, isCreator: true,
  canManage: true, catalogScope: 'market', latestVersion: '1.0.1', publishedAt: '2026-09-20T00:00:00Z',
};
const page = { success: true, items: [item], nextCursor: 'next' };
function mount() { return renderHook(() => useMarketList('all', { initialScope: 'market' })); }
beforeEach(() => {
  setDataOwnerGeneration('owner-a', 1);
  mocks.skills = [];
  mocks.listMarket.mockReset().mockResolvedValue(page);
  vi.stubGlobal('electronAPI', { skillhub: { listMarket: mocks.listMarket } });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it.each(['error', 'throw'])('preserves loaded data on refresh failure (%s), then retries without re-entering', async (failure) => {
  const hook = mount();
  await waitFor(() => expect(hook.result.current.items).toHaveLength(1));
  if (failure === 'error') mocks.listMarket.mockResolvedValueOnce({ success: false, error: 'RATE_LIMITED' });
  else mocks.listMarket.mockRejectedValueOnce(new Error('RATE_LIMITED'));
  act(() => hook.result.current.reload());
  await waitFor(() => expect(hook.result.current.error).toBe('RATE_LIMITED'));
  expect(hook.result.current.items[0]?.name).toBe(item.name);
  expect(hook.result.current.hasMore).toBe(true);
  mocks.listMarket.mockResolvedValueOnce({ ...page, items: [{ ...item, latestVersion: '1.0.2' }] });
  act(() => hook.result.current.reload());
  await waitFor(() => expect(hook.result.current.items[0]?.latestVersion).toBe('1.0.2'));
  expect(hook.result.current.error).toBeNull();
});

it('exposes pagination failures while keeping the current page', async () => {
  const hook = mount();
  await waitFor(() => expect(hook.result.current.items).toHaveLength(1));
  mocks.listMarket.mockResolvedValueOnce({ success: false, error: 'RATE_LIMITED' });
  await act(() => hook.result.current.loadMore());
  expect(hook.result.current.error).toBe('RATE_LIMITED');
  expect(hook.result.current.items).toHaveLength(1);
});

it('does not retain another filter or account list when the next request fails', async () => {
  const hook = mount();
  await waitFor(() => expect(hook.result.current.items).toHaveLength(1));
  mocks.listMarket.mockResolvedValue({ success: false, error: 'offline' });
  act(() => hook.result.current.setCategoryFilter('new-category'));
  await waitFor(() => expect(hook.result.current.error).toBe('offline'));
  expect(hook.result.current.items).toEqual([]);
  mocks.listMarket.mockResolvedValue(page);
  act(() => hook.result.current.reload());
  await waitFor(() => expect(hook.result.current.items).toHaveLength(1));
  mocks.listMarket.mockResolvedValue({ success: false, error: 'offline' });
  setDataOwnerGeneration('owner-b', 2);
  hook.rerender();
  expect(hook.result.current.items).toEqual([]);
  await waitFor(() => expect(hook.result.current.error).toBe('offline'));
  expect(hook.result.current.items).toEqual([]);
});

it('ignores a stale reply from a previous account', async () => {
  let finish!: (value: typeof page) => void;
  mocks.listMarket.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const hook = mount();
  setDataOwnerGeneration('owner-b', 2);
  await act(async () => finish(page));
  mocks.listMarket.mockImplementationOnce(() => new Promise(() => {}));
  hook.rerender();
  expect(hook.result.current.items).toEqual([]);
});

it('derives download updates for the native author copy using list metadata only', async () => {
  mocks.skills = [{
    id: 'authored', kind: 'skill', name: 'local-folder', registrySkillName: item.name,
    absolutePath: '/skills/google-play-console', scope: 'global',
    registryEntry: { version: '1.0.0', origin: 'published', authorId: item.authorId },
  } as SkillhubSkill];
  const hook = mount();
  await waitFor(() => expect(hook.result.current.items[0]).toMatchObject({
    isCreator: true, updateAvailable: true, installedLocally: true,
    installedAbsolutePath: '/skills/google-play-console', installedVersion: '1.0.0',
  }));
  expect(mocks.listMarket).toHaveBeenCalledTimes(1);
});

it.each([
  { isCreator: false }, { isCreator: undefined }, { canManage: false }, { authorId: 'someone-else' },
])('does not merge an unrelated native author copy (%j)', async (overrides) => {
  mocks.skills = [{
    kind: 'skill', name: item.name, absolutePath: '/skills/other', scope: 'global',
    registryEntry: { version: '1.0.0', origin: 'published', authorId: item.authorId },
  } as SkillhubSkill];
  mocks.listMarket.mockResolvedValue({ ...page, items: [{ ...item, ...overrides }] });
  const hook = mount();
  await waitFor(() => expect(hook.result.current.items).toHaveLength(1));
  expect(hook.result.current.items[0]).toMatchObject({ installedLocally: false, updateAvailable: false });
});
