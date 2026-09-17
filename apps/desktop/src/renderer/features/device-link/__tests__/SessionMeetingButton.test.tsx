// @vitest-environment jsdom
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SessionMeetingButton } from '../SessionMeetingButton';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import type { Session } from '@/lib/ccAgent.types';
const state = vi.hoisted(() => ({ invoke: vi.fn(), t: (key: string) => key }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: state.t }) }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ dataOwnerId: 'owner' }) }));
vi.mock('@/components/ui/popover', () => {
  const Wrapper = ({ children }: { children?: ReactNode }) => children;
  return { Popover: Wrapper, PopoverTrigger: Wrapper, PopoverContent: Wrapper };
});
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
let container: HTMLDivElement;
let root: Root;
const session = { id: 'session', deviceLinkDeviceId: 'host' } as Session;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks(); setDataOwnerGeneration('owner');
  Object.assign(window, { electronAPI: { deviceLink: { invoke: state.invoke } } });
  container = document.createElement('div'); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); });
it('renders an upgrade instruction when an old host rejects the new channel', async () => {
  state.invoke.mockRejectedValue(new Error('[DEVICE_LINK_CHANNEL_NOT_ALLOWED] unsupported'));
  await act(async () => root.render(createElement(SessionMeetingButton, { session })));
  expect(container.textContent).toContain('sessionMeeting.upgrade');
  expect(container.textContent).not.toContain('sessionMeeting.open');
});
it('does not mislabel a timeout as an old host', async () => {
  state.invoke.mockRejectedValue(new Error('[DEVICE_LINK_TIMEOUT] timeout'));
  await act(async () => root.render(createElement(SessionMeetingButton, { session })));
  expect(container.textContent).not.toContain('sessionMeeting.upgrade');
});
it('ignores a late unsupported response after the data owner changes', async () => {
  let reject!: (error: unknown) => void;
  state.invoke.mockReturnValue(new Promise((_resolve, fail) => { reject = fail; }));
  await act(async () => root.render(createElement(SessionMeetingButton, { session })));
  setDataOwnerGeneration('other');
  await act(async () => reject(new Error('[DEVICE_LINK_CHANNEL_NOT_ALLOWED] unsupported')));
  expect(container.textContent).not.toContain('sessionMeeting.upgrade');
});
