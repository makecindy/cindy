// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompanionCloudSnapshot } from '../../../../shared/companionCloud';

const h = vi.hoisted(() => ({ navigate: vi.fn(), toast: vi.fn(), ensureLoaded: vi.fn(async () => []) }));
vi.mock('react-router-dom', () => ({ useNavigate: () => h.navigate }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, opts?: Record<string, unknown>) => opts ? `${key}:${JSON.stringify(opts)}` : key }),
}));
vi.mock('@/lib/toast', () => ({ toast: { info: h.toast, error: h.toast } }));
vi.mock('../botStore', () => ({ ensureBotProfilesLoaded: h.ensureLoaded }));

import { CindyMergeSetting } from '../CindyMergeSetting';
import { resetCompanionCloudStoreForTests } from '../companionCloudStore';

const maker = {
  getCompanionCloudState: vi.fn(),
  onCompanionCloudChanged: vi.fn(() => () => undefined),
  listCindyCopies: vi.fn(),
  mergeCindy: vi.fn(),
};
const cloud: CompanionCloudSnapshot = {
  enabled: true, selfDeviceId: 'desk', humanActorId: 'human', demotedBotIds: [],
  actors: [
    { id: 'a1', externalId: 'cindy-default', name: 'Cindy', avatar: null, homeDeviceId: 'desk', homeDevice: { deviceId: 'desk', name: 'Desk', online: true, isSelf: true } },
    { id: 'a2', externalId: 'bot_laptop', name: 'Cindy', avatar: null, homeDeviceId: 'laptop', homeDevice: { deviceId: 'laptop', name: 'Laptop', online: true, isSelf: false } },
  ],
};
const copies = [{ botId: 'cindy-default', name: 'Cindy', homeDeviceId: 'desk' }, { botId: 'bot_laptop', name: 'Cindy', homeDeviceId: 'laptop' }];

beforeEach(() => {
  for (const fn of Object.values(maker)) fn.mockReset();
  maker.onCompanionCloudChanged.mockImplementation(() => () => undefined);
  maker.getCompanionCloudState.mockResolvedValue(cloud);
  h.navigate.mockReset(); h.toast.mockReset();
  Object.defineProperty(window, 'electronAPI', { configurable: true, writable: true, value: { maker } });
  resetCompanionCloudStoreForTests(cloud);
});
afterEach(() => { cleanup(); });

describe('CindyMergeSetting', () => {
  it('is hidden while there is only one Cindy', async () => {
    maker.listCindyCopies.mockResolvedValue([]);
    render(<CindyMergeSetting bot={{ id: 'cindy-default', name: 'Cindy' }} />);
    await waitFor(() => expect(maker.listCindyCopies).toHaveBeenCalled());
    expect(screen.queryByTestId('cindy-merge-row')).toBeNull();
  });

  it('lets the user choose which Cindy to keep and merges the others into it', async () => {
    maker.listCindyCopies.mockResolvedValue(copies);
    maker.mergeCindy.mockResolvedValue({ ok: true, merged: 1, messages: 12, memories: 3, skills: 0, renamed: [] });
    render(<CindyMergeSetting bot={{ id: 'cindy-default', name: 'Cindy' }} />);
    fireEvent.click(await screen.findByTestId('cindy-merge-row'));
    // Keep the one on the laptop instead.
    fireEvent.click(screen.getByText('bots.cloud.runsOn:{"device":"Laptop"}'));
    fireEvent.click(screen.getByRole('button', { name: 'bots.cloud.mergeAction' }));
    await waitFor(() => expect(maker.mergeCindy).toHaveBeenCalledWith('bot_laptop', ['cindy-default']));
    await waitFor(() => expect(h.navigate).toHaveBeenCalledWith('/bots/remote/laptop/bot_laptop'));
    expect(h.toast).toHaveBeenCalledWith('bots.cloud.merged:{"count":2,"messages":12}');
  });

  it('explains when the kept Cindy\'s computer cannot be reached', async () => {
    maker.listCindyCopies.mockResolvedValue(copies);
    maker.mergeCindy.mockResolvedValue({ ok: false, code: 'OFFLINE' });
    render(<CindyMergeSetting bot={{ id: 'bot_laptop', name: 'Cindy' }} />);
    fireEvent.click(await screen.findByTestId('cindy-merge-row'));
    fireEvent.click(screen.getByRole('button', { name: 'bots.cloud.mergeAction' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'bots.cloud.mergeOffline:{"device":"Laptop"}');
    expect(h.navigate).not.toHaveBeenCalled();
  });
});
