// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ read: vi.fn(), markRead: vi.fn(), alert: vi.fn() }));
vi.mock('react-native', () => ({ Alert: { alert: h.alert }, Keyboard: { dismiss: vi.fn() } }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ user: { id: 'owner' } }) }));
vi.mock('@/device-link/DeviceLinkContext', () => ({ useDeviceLink: () => ({ invoke: h.read }) }));
vi.mock('@/device-link/remoteResources', () => ({ invokeRemoteResourceAction: (...args: unknown[]) => h.read(...args) }));
vi.mock('@/device-link/remoteResourceCache', () => ({
  isRemoteResourceUnread: () => true, markRemoteResourceRead: h.markRead,
  subscribeRemoteResourceCache: () => () => {},
}));
vi.mock('@/chat/cloudCompanion', () => ({ CLOUD_ROW_REVISION: 'cloud' }));
vi.mock('@/session/teammateNavigation', () => ({ orderedTeammates: (items: unknown) => items }));
vi.mock('@/session/useTeammateStatus', () => ({ useRosterActivities: () => new Map() }));
vi.mock('@/session/useTeammateNavigation', () => ({ useTeammateNavigation: () => ({ openTeammate: vi.fn() }) }));
vi.mock('@/session/TeammateList', () => ({
  teammateRowState: () => ({ status: 'unread' }),
  conversationSessionId: (r: { item?: { links?: Array<{ kind?: string; ref?: { id?: string } }> } }) =>
    r?.item?.links?.find((link) => link.kind === 'conversation')?.ref?.id ?? null,
}));
vi.mock('@/session/SwipeableSessionRow', () => ({ SwipeableSessionRow: () => null }));
vi.mock('@/session/TaskSnoozeSheet', () => ({ TaskSnoozeSheet: () => null }));
vi.mock('@/session/MountOnFirstOpen', () => ({ MountOnFirstOpen: () => null }));

import { useInboxTeammates } from '@/session/InboxTeammates';

const row = { key: 'host:bot', host: { deviceId: 'host', deviceName: 'Computer' }, item: {
  ref: { collectionId: 'teammates', kind: 'bot', id: 'bot' }, revision: '1', links: [],
  display: { title: 'Companion', lastReplyAt: 100, lastReadAt: 0 },
} };
let root: Root;
let inbox: ReturnType<typeof useInboxTeammates>;
function Fixture() {
  inbox = useInboxTeammates({ context: { shared: { roster: { items: [row], isOnline: () => false } } } as any,
    cloud: { supported: false } as any, enabled: true, query: '', push: vi.fn(), registry: { closeOpenRow: vi.fn() } as any });
  return null;
}
beforeEach(async () => {
  vi.clearAllMocks();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  root = createRoot(document.createElement('div'));
  await act(async () => root.render(createElement(Fixture)));
});
afterEach(async () => { await act(async () => root.unmount()); });

// Unit regression #11623, real hook/action entry. Existing pure classification tests never
// exercised failed read receipts. Minimal input: an offline host with one unread reply.
it('keeps the unread position retryable and reports a failed shared read', async () => {
  h.read.mockRejectedValueOnce(new Error('offline'));
  await act(async () => inbox.value!.complete(row.key));
  expect(h.markRead).not.toHaveBeenCalled();
  expect(h.alert).toHaveBeenCalledWith('devices.list.alert.actionFailed');
  h.read.mockResolvedValueOnce({});
  await act(async () => inbox.value!.complete(row.key));
  expect(h.markRead).toHaveBeenCalledWith('owner', 'host', 'bot', 100);
});

it('waits for the shared read receipt before clearing the phone unread position', async () => {
  let confirm!: () => void;
  h.read.mockReturnValueOnce(new Promise<void>(resolve => { confirm = resolve; }));
  await act(async () => inbox.value!.complete(row.key));
  expect(h.markRead).not.toHaveBeenCalled();
  await act(async () => confirm());
  expect(h.markRead).toHaveBeenCalledWith('owner', 'host', 'bot', 100);
  expect(h.alert).not.toHaveBeenCalled();
});
