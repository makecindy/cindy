// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { TabKindHostContext } from '../../../types';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { SideChatTabBody } from '../SideChatTabBody';

const m = vi.hoisted(() => ({
  get: vi.fn(), promote: vi.fn(), navigate: vi.fn(), close: vi.fn(), confirm: vi.fn(), setStatus: vi.fn(),
  t: (key: string) => key,
  local: new Set<(payload: any, stamp?: any) => void>(),
  remote: new Set<(push: any, stamp?: any) => void>(),
}));
vi.mock('react-router-dom', () => ({ useNavigate: () => m.navigate }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: m.t }) }));
vi.mock('@/components/ui/button', () => ({ Button: ({ children, onClick, disabled }: any) => <button disabled={disabled} onClick={onClick}>{children}</button> }));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({ useConfirmDialog: () => ({ confirm: m.confirm }) }));
vi.mock('@/features/cc-agent/CCAgentSessionView', () => ({ CCAgentSessionView: () => <textarea aria-label="Side chat composer" /> }));
vi.mock('@/features/device-link/remoteProjectsStore', () => ({ remoteProjectsStore: { pinSessionOrigin: vi.fn(), mergeDeviceSessions: vi.fn(), getDeviceName: () => 'Host' } }));
vi.mock('@/hooks/useWindowVisible', () => ({ useWindowVisible: () => true, useDocumentVisible: () => true }));
vi.mock('@/lib/sidebarWindow', () => ({ isSidebarWindow: () => false }));
vi.mock('@/lib/makerChatStore', () => ({ makerChatStore: { closeSessionQuery: vi.fn(), purgeSession: vi.fn() } }));
vi.mock('@/lib/composerDraftStore', () => ({ discardDraft: vi.fn() }));
vi.mock('@/lib/sessionService', () => ({ setStatus: m.setStatus }));
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn() } }));
vi.mock('../../../store', () => ({ closeTab: m.close }));
vi.mock('../../../lib/sidebarHostSession', () => ({ SidebarHostSessionProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock('../../../lib/mergeSidebarWindowBack', () => ({ mergeSidebarWindowBack: vi.fn() }));

const child = { id: 'child', source: 'side-chat', parentSessionId: 'parent', status: 'active' };
const ctx = { sessionId: 'parent', tabId: 'tab', setCloseInterceptor: () => () => {} } as unknown as TabKindHostContext;
const mount = (deviceId: string | null, active = true) => render(
  <SideChatTabBody state={{ sessionId: 'child', deviceId }} ctx={ctx} active={active} />,
);
const deleted = (deviceId: string | null, stamp?: any) => {
  const payload = { sessionId: 'child', patch: { status: 'deleted' } };
  if (deviceId) m.remote.forEach(fn => fn({ deviceId, channel: 'local-db:sessions:patched', payload }, stamp));
  else m.local.forEach(fn => fn(payload, stamp));
};

beforeEach(() => {
  vi.clearAllMocks();
  setDataOwnerGeneration('owner', 1);
  m.get.mockResolvedValue(child);
  m.close.mockResolvedValue(undefined);
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: {
    maker: { promoteSideChat: m.promote },
    localDb: { sessions: { get: m.get }, sessionsPush: { onPatched: (fn: any) => { m.local.add(fn); return () => m.local.delete(fn); } } },
    deviceLink: {
      invoke: (device: string, channel: string, args: unknown[]) => channel === 'maker:side-chat:promote:v1' ? m.promote(device, ...args) : m.get(device, channel, args),
      onRemotePush: (fn: any) => { m.remote.add(fn); return () => m.remote.delete(fn); },
    },
  } });
});
afterEach(() => { cleanup(); m.local.clear(); m.remote.clear(); });

// Unit regression: deleting on another controller must immediately remove the side-chat composer.
// Existing opener tests exercise tab creation only, not the mounted editor.
// Minimal inputs: a deleted host snapshot or a deletion push while GET is in flight.
it.each([null, 'host'])('removes a deleted branch without another confirmation (%s)', async deviceId => {
  mount(deviceId);
  await act(async () => {});
  expect(screen.queryByRole('textbox', { name: 'Side chat composer' })).not.toBeNull();
  await act(async () => deleted(deviceId));
  expect(screen.queryByRole('textbox', { name: 'Side chat composer' })).toBeNull();
  expect(m.close).toHaveBeenCalledWith('parent', 'tab', { skipBeforeClose: true });
  expect(m.confirm).not.toHaveBeenCalled();
  expect(m.setStatus).not.toHaveBeenCalled();
});

it.each([null, { ...child, status: 'deleted' }])('does not mount a composer for an unavailable remote snapshot', async value => {
  m.get.mockResolvedValue(value);
  mount('host');
  await act(async () => {});
  expect(screen.queryByRole('textbox', { name: 'Side chat composer' })).toBeNull();
  expect(m.close).toHaveBeenCalledWith('parent', 'tab', { skipBeforeClose: true });
});

it('does not revive a deleted branch when an older active snapshot completes', async () => {
  let finish!: (value: typeof child) => void;
  m.get.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  mount('host');
  await act(async () => deleted('host'));
  await act(async () => finish(child));
  expect(screen.queryByRole('textbox', { name: 'Side chat composer' })).toBeNull();
  expect(m.close).toHaveBeenCalledTimes(1);
});

it('keeps a hidden tab subscribed and ignores another device or stale owner', async () => {
  mount('host', false);
  await act(async () => {
    deleted('different-host');
    deleted('host', { dataOwnerId: 'old-owner', ownerGeneration: 1 });
  });
  expect(m.close).not.toHaveBeenCalled();
  await act(async () => deleted('host'));
  expect(m.close).toHaveBeenCalledTimes(1);
});

it('keeps a transient read failure retryable instead of removing the tab', async () => {
  m.get.mockRejectedValue(new Error('offline'));
  mount('host');
  await act(async () => {});
  expect(screen.queryByRole('button', { name: 'commonUi.retry' })).not.toBeNull();
  expect(m.close).not.toHaveBeenCalled();
});

// Unit: manual promotion is absent from the existing deletion-only cases. Render
// the real action and check one receipt, origin-preserving navigation and failure.
it.each([null, 'host'])('promotes the existing conversation on its execution host (%s)', async deviceId => {
  let finish!: () => void;
  m.promote.mockReturnValue(new Promise<void>(resolve => { finish = resolve; }));
  mount(deviceId);
  await act(async () => {});
  const button = screen.getByRole('button', { name: 'chat.sideChat.promote' });
  await act(async () => { button.click(); button.click(); });
  expect(m.promote).toHaveBeenCalledTimes(1);
  expect(m.promote).toHaveBeenCalledWith(...(deviceId ? [deviceId, 'child', 'parent'] : ['child', 'parent']));
  expect(m.navigate).not.toHaveBeenCalled();
  await act(async () => finish());
  expect(m.navigate).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('button', { name: 'chat.sideChat.promote' })).toBeNull();
  expect(screen.getByRole('button', { name: 'chat.sideChat.openConversation' })).not.toBeNull();
  expect(m.setStatus).not.toHaveBeenCalled();
});

it('keeps an unsupported host side chat open without navigating', async () => {
  m.promote.mockRejectedValue(new Error('[DEVICE_LINK_CHANNEL_NOT_ALLOWED] Unsupported'));
  mount('host'); await act(async () => {});
  await act(async () => screen.getByRole('button', { name: 'chat.sideChat.promote' }).click());
  expect(m.navigate).not.toHaveBeenCalled();
  expect(screen.getByRole('textbox', { name: 'Side chat composer' })).not.toBeNull();
  expect(m.close).not.toHaveBeenCalled();
});
