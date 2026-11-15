// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { SettingsSearchBox } from '@/components/settings/SettingsSearchBox';
import { SettingsLinkChip } from '@/components/chat/SettingsLinkChip';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/features/device-link/useDeviceLinkDeviceList', () => ({ useDeviceLinkDeviceList: () => [{ deviceId: 'computer-a', name: 'Studio' }] }));
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn() } }));
const invoke = vi.fn(async () => ({ ok: true, deviceId: 'computer-a' }));
const open = vi.fn(async () => {});
function Location() { return <output>{useLocation().pathname}{useLocation().search}</output>; }
afterEach(() => { cleanup(); vi.clearAllMocks(); });
function mount(self: string) {
  Object.assign(window, { electronAPI: { getDeviceId: async () => self, deviceLink: { invoke }, openRemoteDesktop: open } });
  render(<MemoryRouter><SettingsLinkChip target={{ tab: 'appearance', deviceId: 'computer-a', query: 'font' }} /><Location /></MemoryRouter>);
}
// Unit: the real chip must navigate locally only on its owning computer.
it('opens the exact setting on this computer', async () => {
  mount('computer-a');
  fireEvent.click(screen.getByRole('button'));
  await waitFor(() => expect(screen.getByRole('status').textContent).toBe('/settings?tab=appearance&query=font'));
  expect(invoke).not.toHaveBeenCalled();
});
it('opens the target computer instead of changing local settings remotely', async () => {
  mount('computer-b');
  fireEvent.click(screen.getByRole('button'));
  await waitFor(() => expect(open).toHaveBeenCalledWith({ deviceId: 'computer-a', name: expect.any(String) }));
  expect(screen.getByRole('status').textContent).toBe('/');
  expect(invoke).toHaveBeenCalledWith('computer-a', 'maker:settings:navigate', [expect.objectContaining({ tab: 'appearance' })]);
});

// The destination must expose the requested setting search rather than a blank settings page.
it('prefills the real settings search from a navigation link', async () => {
  render(<MemoryRouter initialEntries={['/settings?tab=appearance&query=font']}>
    <SettingsSearchBox requestedQuery="font" visibleTabIds={['appearance']} />
  </MemoryRouter>);
  expect((screen.getByRole('combobox') as HTMLInputElement).value).toBe('font');
});
