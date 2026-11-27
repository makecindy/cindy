// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  read: vi.fn(), navigate: vi.fn(), reopen: vi.fn(), hydrate: vi.fn(), pin: vi.fn(),
  parentPatch: vi.fn(), remotePush: vi.fn(),
  tabChanges: new Set<(id: string) => void>(),
  hydrated: false, open: false,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, values?: { title: string }) => values ? `${key} ${values.title}` : key }) }));
vi.mock('react-router-dom', () => ({ useNavigate: () => mocks.navigate }));
vi.mock('@/lib/sessionBatchRead', () => ({ readSessionBatch: mocks.read }));
vi.mock('@/lib/rightSidebarWindowState', () => ({ useRightSidebarWindowState: () => ({ loaded: true, detached: false }) }));
vi.mock('@/lib/remoteDataOwnerPushFence', () => ({ isDeviceLinkRemotePushCurrent: () => true }));
vi.mock('@/features/device-link/remoteProjectsStore', () => ({ remoteProjectsStore: { pinSessionOrigin: mocks.pin } }));
vi.mock('@/features/right-sidebar/lib/openSideChatTab', () => ({
  findLinkedSideChatTab: () => mocks.open ? { id: 'tab' } : undefined,
  reopenLinkedSideChat: mocks.reopen,
}));
vi.mock('@/features/right-sidebar/store', () => ({
  ensureHydrated: mocks.hydrate,
  getBucket: () => ({ hydrated: mocks.hydrated }),
  subscribe: (listener: (id: string) => void) => {
    mocks.tabChanges.add(listener);
    return () => mocks.tabChanges.delete(listener);
  },
}));
vi.mock('../lib/sessionDisplayTitle', () => ({ getSessionDisplayTitle: ({ title }: { title: string }) => title }));

import { LinkedSideChatOrigin } from '../LinkedSideChatOrigin';

const parent = { id: 'parent', status: 'active', title: 'Original task' };
const label = { back: 'chat.sideChat.returnToSideChat', reopen: 'chat.sideChat.reopenSideChat' };

describe('linked side chat origin', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.hydrated = false;
    mocks.open = false;
    mocks.parentPatch.mockReturnValue(() => {});
    mocks.remotePush.mockReturnValue(() => {});
    mocks.hydrate.mockResolvedValue(undefined);
    mocks.reopen.mockResolvedValue(undefined);
    mocks.read.mockResolvedValue([{ value: parent }]);
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: {
      localDb: { sessionsPush: { onPatched: mocks.parentPatch } },
      deviceLink: { onRemotePush: mocks.remotePush },
    } });
  });
  afterEach(cleanup);

  // Unit: an unhydrated bucket is not a closed tab. The action reacts to the
  // parent bucket and retains the resolved execution device on explicit clicks.
  it('waits for tab hydration and tracks open and closed tabs on the original device', async () => {
    await act(async () => render(<LinkedSideChatOrigin childId="child" parentId="parent" deviceId="host" parentAccessAvailable />));
    expect(screen.getByText('chat.sideChat.originNamed Original task')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    expect(mocks.read).toHaveBeenCalledWith(['parent'], 'host');
    expect(mocks.pin).toHaveBeenCalledWith('host', 'parent');

    await act(async () => {
      mocks.hydrated = true;
      mocks.open = true;
      mocks.tabChanges.forEach(fn => fn('parent'));
    });
    expect(screen.getByRole('button', { name: label.back })).toBeTruthy();
    expect(mocks.reopen).not.toHaveBeenCalled();

    await act(async () => {
      mocks.open = false;
      mocks.tabChanges.forEach(fn => fn('parent'));
    });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: label.reopen })));
    expect(mocks.reopen).toHaveBeenCalledExactlyOnceWith('parent', 'child', 'host', mocks.navigate);
  });

  // Unit: a deletion push arriving before the detail response prevents a stale
  // name or a return link from appearing. A shared view must not read the parent.
  it('keeps the origin generic when a newer deletion or missing access prevents return', async () => {
    let complete!: (result: unknown) => void;
    mocks.read.mockReturnValueOnce(new Promise(resolve => { complete = resolve; }));
    const ui = render(<LinkedSideChatOrigin childId="child" parentId="parent" deviceId={null} parentAccessAvailable />);
    expect(screen.getByText('chat.sideChat.origin')).toBeTruthy();
    await act(async () => {
      mocks.parentPatch.mock.calls[0][0]({ sessionId: 'parent', patch: { status: 'deleted' } });
      complete([{ value: parent }]);
    });
    expect(screen.getByText('chat.sideChat.originUnavailable')).toBeTruthy();
    expect(screen.queryByText(/Original task/)).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    expect(mocks.hydrate).not.toHaveBeenCalled();

    ui.rerender(<LinkedSideChatOrigin key="no-access" childId="child" parentId="parent" deviceId="guest" parentAccessAvailable={false} />);
    expect(screen.getByText('chat.sideChat.originUnavailable')).toBeTruthy();
    expect(mocks.read).toHaveBeenCalledTimes(1);
  });
});
