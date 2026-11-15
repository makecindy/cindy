// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, string | number>) =>
      vars ? `${key}:${Object.values(vars).join('|')}` : key,
  }),
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

import { DiscordChannelAccessUnsupportedError } from '@/hooks/useDiscordChannelAccess';

import { DiscordChannelAccessSection } from '../DiscordChannelAccessSection';

const ALL = {
  view: true,
  send: true,
  readHistory: true,
  embed: true,
  attachFiles: true,
  sendInThreads: true,
};
const T = 'settings.discordBot.channels';

const api = {
  listChannels: vi.fn(),
  getChannelAccess: vi.fn(),
  setChannelAccess: vi.fn(),
};

function listing(overrides: Partial<DiscordBotChannelListing> = {}): DiscordBotChannelListing {
  return {
    status: { kind: 'connected', appId: 'bot#1' },
    guilds: [
      {
        id: '11',
        name: 'Guild One',
        channels: [
          { id: '21', name: 'general', permissions: ALL },
          { id: '22', name: 'locked', permissions: { ...ALL, send: false } },
          { id: '23', name: 'plain', permissions: { ...ALL, readHistory: false, embed: false } },
        ],
      },
      { id: '12', name: 'Guild Two', channels: [{ id: '31', name: 'ideas', permissions: ALL }] },
    ],
    ...overrides,
  };
}

const guildSwitch = (name: string) =>
  screen.getByRole('switch', { name: new RegExp(`guild.toggleAria:${name}`) });
const moreButton = (row: HTMLElement) =>
  within(row).getByRole('button', { name: new RegExp(`${T}.guild.more`) });

async function open() {
  render(<DiscordChannelAccessSection connected />);
  fireEvent.click(screen.getByRole('button', { name: new RegExp(`${T}.title`) }));
  await waitFor(() => expect(api.listChannels).toHaveBeenCalled());
}

beforeEach(() => {
  vi.resetAllMocks();
  api.listChannels.mockResolvedValue(listing());
  api.getChannelAccess.mockResolvedValue({ channels: [] });
  api.setChannelAccess.mockImplementation(async (access: unknown) => access);
  (window as unknown as { electronAPI: unknown }).electronAPI = { discordBot: api };
});
afterEach(cleanup);

describe('DiscordChannelAccessSection (personal bot)', () => {
  it('renders nothing and reads nothing while the bot is not connected', () => {
    render(<DiscordChannelAccessSection connected={false} />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(api.listChannels).not.toHaveBeenCalled();
  });

  it('lists one row per server, all off by default, and the first enable opens all channels', async () => {
    await open();
    expect(await screen.findByText('Guild One')).toBeTruthy();
    expect(screen.getByText(`${T}.summary.off`)).toBeTruthy();
    // 频道不在主列表里，更多入口也只在开启后出现。
    expect(screen.queryByText('#general')).toBeNull();
    expect(screen.queryByText(`${T}.guild.more`)).toBeNull();

    fireEvent.click(guildSwitch('Guild One'));

    await waitFor(() =>
      expect(api.setChannelAccess).toHaveBeenCalledWith({
        channels: [],
        guilds: [{ guildId: '11', enabled: true, mode: 'all' }],
      }),
    );
    expect(await screen.findByText(`${T}.guild.summary.all`)).toBeTruthy();
    expect(screen.getByText(`${T}.summary.on:1`)).toBeTruthy();
  });

  it('keeps the "more" entry on the same row as the switch', async () => {
    api.getChannelAccess.mockResolvedValue({
      channels: [],
      guilds: [{ guildId: '11', enabled: true, mode: 'all' }],
    });
    await open();
    const toggle = await screen.findByRole('switch', { name: /guild.toggleAria:Guild One/ });
    expect(toggle.parentElement?.contains(moreButton(toggle.parentElement as HTMLElement))).toBe(
      true,
    );
  });

  it('reads an upgraded legacy channel list as enabled with the same selected channels, without any write', async () => {
    api.getChannelAccess.mockResolvedValue({ channels: [{ guildId: '11', channelId: '21' }] });
    await open();
    expect(await screen.findByText(`${T}.guild.summary.selected:1`)).toBeTruthy();
    expect(guildSwitch('Guild One').getAttribute('aria-checked')).toBe('true');
    expect(guildSwitch('Guild Two').getAttribute('aria-checked')).toBe('false');
    expect(api.setChannelAccess).not.toHaveBeenCalled();
  });

  it('shows channels only after "more", with permission hints, and blocks selecting a channel the bot cannot speak in', async () => {
    api.getChannelAccess.mockResolvedValue({ channels: [{ guildId: '11', channelId: '21' }] });
    await open();
    const toggle = await screen.findByRole('switch', { name: /guild.toggleAria:Guild One/ });
    fireEvent.click(moreButton(toggle.parentElement as HTMLElement));

    expect(await screen.findByText('#locked')).toBeTruthy();
    expect(screen.getByText(`${T}.permission.cannotSend`)).toBeTruthy();
    expect(screen.getByRole('switch', { name: /Guild One\|locked/ }).hasAttribute('disabled')).toBe(
      true,
    );
    expect(screen.getByText(new RegExp(`${T}.permission.limited`))).toBeTruthy();

    fireEvent.click(screen.getByRole('switch', { name: /Guild One\|plain/ }));
    await waitFor(() =>
      expect(api.setChannelAccess).toHaveBeenLastCalledWith({
        channels: [
          { guildId: '11', channelId: '21' },
          { guildId: '11', channelId: '23' },
        ],
        guilds: [{ guildId: '11', enabled: true, mode: 'selected' }],
      }),
    );
  });

  it('closing a selected server keeps its selection and opening it again restores the same channels', async () => {
    api.getChannelAccess.mockResolvedValue({ channels: [{ guildId: '11', channelId: '21' }] });
    await open();
    fireEvent.click(await screen.findByRole('switch', { name: /guild.toggleAria:Guild One/ }));
    await waitFor(() =>
      expect(guildSwitch('Guild One').getAttribute('aria-checked')).toBe('false'),
    );
    expect(api.setChannelAccess).toHaveBeenLastCalledWith({
      channels: [],
      guilds: [
        { guildId: '11', enabled: false, mode: 'selected', savedChannels: [{ channelId: '21' }] },
      ],
    });

    fireEvent.click(guildSwitch('Guild One'));
    await waitFor(() =>
      expect(api.setChannelAccess).toHaveBeenLastCalledWith({
        channels: [{ guildId: '11', channelId: '21' }],
        guilds: [{ guildId: '11', enabled: true, mode: 'selected' }],
      }),
    );
  });

  it('a server set to selected channels with none chosen stays that way after off and on (not the first-enable default)', async () => {
    await open();
    fireEvent.click(await screen.findByRole('switch', { name: /guild.toggleAria:Guild One/ }));
    const toggle = guildSwitch('Guild One');
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'));
    fireEvent.click(moreButton(toggle.parentElement as HTMLElement));
    fireEvent.click(await screen.findByRole('radio', { name: `${T}.guild.mode.selected` }));
    await waitFor(() => expect(screen.getByText(`${T}.guild.summary.none`)).toBeTruthy());

    fireEvent.click(guildSwitch('Guild One'));
    await waitFor(() =>
      expect(guildSwitch('Guild One').getAttribute('aria-checked')).toBe('false'),
    );
    fireEvent.click(guildSwitch('Guild One'));

    await waitFor(() => expect(guildSwitch('Guild One').getAttribute('aria-checked')).toBe('true'));
    expect(screen.getByText(`${T}.guild.summary.none`)).toBeTruthy();
    expect(screen.queryByText(`${T}.guild.summary.all`)).toBeNull();
  });

  it('lists servers and channels the connection can no longer see and lets the owner remove them', async () => {
    api.getChannelAccess.mockResolvedValue({
      channels: [
        { guildId: '99', channelId: '88' },
        { guildId: '11', channelId: '77' },
      ],
    });
    await open();
    await screen.findByText('99');
    expect(screen.getByText('11 / 77')).toBeTruthy();

    fireEvent.click(screen.getAllByText(`${T}.unavailable.remove`)[0]);

    await waitFor(() =>
      expect(api.setChannelAccess).toHaveBeenLastCalledWith({
        channels: [{ guildId: '11', channelId: '77' }],
      }),
    );
  });

  it('rolls back to the saved allowlist and reports an error when saving fails', async () => {
    api.setChannelAccess.mockRejectedValue(new Error('disk full'));
    await open();
    fireEvent.click(await screen.findByRole('switch', { name: /guild.toggleAria:Guild One/ }));

    expect(await screen.findByText(`${T}.error.save`)).toBeTruthy();
    await waitFor(() =>
      expect(guildSwitch('Guild One').getAttribute('aria-checked')).toBe('false'),
    );
  });

  it('explains how to add the bot when it is in no server, and can refresh', async () => {
    api.listChannels.mockResolvedValue(listing({ guilds: [] }));
    await open();
    expect(await screen.findByText(`${T}.empty`)).toBeTruthy();

    api.listChannels.mockResolvedValue(listing());
    fireEvent.click(screen.getByText(`${T}.refresh`));
    expect(await screen.findByText('Guild One')).toBeTruthy();
  });

  it('offers a retry when the server list cannot be read, and the title summary is not stuck on "loading"', async () => {
    api.listChannels.mockRejectedValueOnce(new Error('offline'));
    await open();
    expect(await screen.findByText(`${T}.error.load`)).toBeTruthy();
    expect(screen.queryByText(`${T}.summary.unknown`)).toBeNull();

    fireEvent.click(screen.getByText(`${T}.refresh`));
    expect(await screen.findByText('Guild One')).toBeTruthy();
  });
});

describe('DiscordChannelAccessSection (teammate connection)', () => {
  const teammate = (access: unknown, save = vi.fn(async (next: unknown) => next)) => {
    const load = vi.fn(async () => ({ guilds: listing().guilds, access, online: true }));
    return { load, save, source: { load, save } as never };
  };

  async function openTeammate(source: never, key = 'dev:conn-1') {
    const view = render(
      <DiscordChannelAccessSection
        connected
        source={source}
        sourceKey={key}
        members={{ botName: 'Mia' }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`${T}.title`) }));
    return view;
  }

  it('names the teammate in the notice and offers member admission per scope, off by default', async () => {
    const { source } = teammate({
      channels: [],
      guilds: [{ guildId: '11', enabled: true, mode: 'all' }],
    });
    await openTeammate(source);
    expect(await screen.findByText(`${T}.members.notice:Mia`)).toBeTruthy();
    expect(screen.queryByText(`${T}.ownerOnly`)).toBeNull();

    const toggle = await screen.findByRole('switch', { name: /guild.toggleAria:Guild One/ });
    fireEvent.click(moreButton(toggle.parentElement as HTMLElement));
    const members = await screen.findByRole('switch', { name: /members.guildAria/ });
    expect(members.getAttribute('aria-checked')).toBe('false');
  });

  it('saves the server-level member switch in all mode and the per-channel one in selected mode', async () => {
    const { source, save } = teammate({
      channels: [],
      guilds: [{ guildId: '11', enabled: true, mode: 'all' }],
    });
    await openTeammate(source);
    const toggle = await screen.findByRole('switch', { name: /guild.toggleAria:Guild One/ });
    fireEvent.click(moreButton(toggle.parentElement as HTMLElement));
    fireEvent.click(await screen.findByRole('switch', { name: /members.guildAria/ }));
    await waitFor(() =>
      expect(save).toHaveBeenLastCalledWith({
        channels: [],
        guilds: [{ guildId: '11', enabled: true, mode: 'all', allowMembers: true }],
      }),
    );

    fireEvent.click(screen.getByRole('radio', { name: `${T}.guild.mode.selected` }));
    fireEvent.click(await screen.findByRole('switch', { name: /Guild One\|general/ }));
    fireEvent.click(await screen.findByRole('switch', { name: /members.aria/ }));
    await waitFor(() =>
      expect(save).toHaveBeenLastCalledWith({
        channels: [{ guildId: '11', channelId: '21', allowMembers: true }],
        guilds: [{ guildId: '11', enabled: true, mode: 'selected', allowMembers: true }],
      }),
    );
  });

  it('shows nothing from the previous connection after switching connections, and never writes to the new one', async () => {
    const first = teammate({ channels: [{ guildId: '11', channelId: '21' }] });
    const second = teammate({ channels: [] });
    const view = await openTeammate(first.source, 'dev:conn-1');
    await screen.findByText('Guild One');

    view.rerender(
      <DiscordChannelAccessSection
        connected
        source={second.source}
        sourceKey="dev:conn-2"
        members={{ botName: 'Zed' }}
      />,
    );

    await waitFor(() => expect(second.load).toHaveBeenCalled());
    await waitFor(() =>
      expect(guildSwitch('Guild One').getAttribute('aria-checked')).toBe('false'),
    );
    expect(first.save).not.toHaveBeenCalled();
    expect(second.save).not.toHaveBeenCalled();
  });

  it('tells the owner when the bot is offline but keeps the saved allowlist visible', async () => {
    const load = vi.fn(async () => ({
      guilds: [],
      access: { channels: [{ guildId: '11', channelId: '21' }] },
      online: false,
    }));
    await openTeammate({ load, save: vi.fn() } as never);
    expect(await screen.findByText(`${T}.offline`)).toBeTruthy();
    expect(screen.getByText(`${T}.summary.on:1`)).toBeTruthy();
  });

  it('says the other computer must be upgraded when it cannot manage server-level access, with no retry or editing', async () => {
    const load = vi.fn(async () => {
      throw new DiscordChannelAccessUnsupportedError();
    });
    const save = vi.fn();
    await openTeammate({ load, save } as never);

    expect(await screen.findByText(`${T}.error.unsupported`)).toBeTruthy();
    expect(screen.queryByText(`${T}.refresh`)).toBeNull();
    expect(screen.queryByText(`${T}.summary.unknown`)).toBeNull();
    expect(screen.queryByRole('switch')).toBeNull();
    expect(save).not.toHaveBeenCalled();
  });
});
