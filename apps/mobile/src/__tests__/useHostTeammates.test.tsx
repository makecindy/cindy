// @vitest-environment jsdom
import { act, createElement, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  auth: { user: { id: 'owner' }, accountGeneration: 1 },
  link: { invoke: vi.fn(), openLink: vi.fn() },
  snapshot: vi.fn(),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ i18n: { language: 'en' } }) }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => h.auth }));
vi.mock('@/device-link/DeviceLinkContext', () => ({ useDeviceLink: () => h.link }));
vi.mock('@/device-link/remoteResourceCache', () => ({ readRemoteResourceSnapshot: h.snapshot }));
import { useHostTeammates } from '@/session/useHostTeammates';
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const host = { deviceId: 'pc', deviceName: 'PC' };
const item = (id: string, title = id) => ({ ref: { collectionId: 'teammates', kind: 'bot', id }, revision: '1', display: { title }, links: [] });
let root: Root | undefined;
let result: ReturnType<typeof useHostTeammates>;
function Probe({ query = '', enabled = true }: { query?: string; enabled?: boolean }) {
  result = useHostTeammates(host, enabled, query);
  return null;
}
async function render(props: ComponentProps<typeof Probe> = {}) {
  root ??= createRoot(document.createElement('div'));
  await act(async () => root!.render(createElement(Probe, props)));
}
async function settleSearch() { await act(async () => vi.advanceTimersByTimeAsync(300)); }
beforeEach(() => {
  vi.clearAllMocks(); vi.useFakeTimers();
  h.auth.user.id = 'owner'; h.auth.accountGeneration = 1;
  h.link.openLink.mockResolvedValue(undefined);
  h.snapshot.mockResolvedValue({ items: { teammates: [] } });
  h.link.invoke.mockResolvedValue({ items: [] });
});
afterEach(() => { act(() => root?.unmount()); root = undefined; vi.useRealTimers(); });

it('finds an addable teammate beyond the first 200 using the existing host-side query', async () => {
  const roster = Array.from({ length: 201 }, (_, i) => item(`bot-${i + 1}`, i === 200 ? 'Beyond first page' : `Teammate ${i + 1}`));
  h.link.invoke.mockImplementation(async (_device, _channel, [request]) => ({
    items: roster.filter(row => !request.query || row.display.title.toLowerCase().includes(request.query.toLowerCase())).slice(0, request.limit),
  }));
  await render();
  expect(result.rows).toHaveLength(200);
  await render({ query: 'Beyond first page' });
  await settleSearch();
  expect(result.rows.map(row => row.item.ref.id)).toEqual(['bot-201']);
  expect(h.link.invoke).toHaveBeenLastCalledWith('pc', 'maker:remote-resources:list', [expect.objectContaining({ collectionId: 'teammates', limit: 200, query: 'Beyond first page' })]);
});

it('debounces searches and ignores late results from a previous query', async () => {
  let finish!: (value: unknown) => void;
  h.link.invoke.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  await render({ query: 'old' }); await settleSearch();
  h.link.invoke.mockResolvedValue({ items: [item('new-result')] });
  await render({ query: 'n' });
  await render({ query: 'new' });
  expect(result.rows).toEqual([]);
  expect(result.loading).toBe(true);
  await settleSearch();
  expect(h.link.invoke).toHaveBeenCalledTimes(2);
  expect(result.rows[0]?.item.ref.id).toBe('new-result');
  await act(async () => finish({ items: [item('old-result')] }));
  expect(result.rows[0]?.item.ref.id).toBe('new-result');
});

it('does not hydrate an unfiltered cache into search results, including failed searches', async () => {
  h.snapshot.mockResolvedValue({ items: { teammates: [{ host, key: 'cached', item: item('unrelated') }] } });
  h.link.invoke.mockRejectedValue(new Error('offline'));
  await render({ query: 'missing' }); await settleSearch();
  expect(result.rows).toEqual([]);
  expect(result.failed).toBe(true);
});

it('cancels a pending search when the picker closes', async () => {
  await render({ query: 'pending' });
  await render({ query: 'pending', enabled: false });
  await settleSearch();
  expect(h.link.invoke).not.toHaveBeenCalled();
});

it('fences old account responses after switching accounts', async () => {
  let finish!: (value: unknown) => void;
  h.link.invoke.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  await render({ query: 'private' }); await settleSearch();
  h.auth.user.id = 'other'; h.auth.accountGeneration = 2;
  h.link.invoke.mockResolvedValue({ items: [item('other-account')] });
  await render({ query: 'private' }); await settleSearch();
  await act(async () => finish({ items: [item('private-old-account')] }));
  expect(result.rows.map(row => row.item.ref.id)).toEqual(['other-account']);
});

it('does not send a search request after closing while the link opens', async () => {
  let finish!: () => void;
  h.link.openLink.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  await render({ query: 'pending' }); await settleSearch();
  await render({ query: 'pending', enabled: false });
  await act(async () => finish());
  expect(h.link.invoke).not.toHaveBeenCalled();
});
