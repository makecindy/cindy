// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompanionCloudSnapshot } from '../../../../shared/companionCloud';

const h = vi.hoisted(() => ({
  navigate: vi.fn(),
  toast: vi.fn(),
  ensureLoaded: vi.fn(async (): Promise<Array<{ id: string; status: string }>> => []),
  profiles: [] as Array<{ id: string; status: string }>,
  devices: [{ deviceId: 'tablet', name: 'Tablet', isSelf: false }],
}));
vi.mock('react-router-dom', () => ({ useNavigate: () => h.navigate }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, opts?: Record<string, unknown>) => opts ? `${key}:${JSON.stringify(opts)}` : key }),
}));
vi.mock('@/components/chat/MarkdownRenderer', () => ({ MarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div> }));
vi.mock('../BotSessionContentHeader', () => ({ BotSessionContentHeaderRegistration: () => null }));
vi.mock('../BotAvatar', () => ({ BotAvatar: () => <span /> }));
vi.mock('../BotGroupMessageAttachments', () => ({
  BotGroupMessageAttachments: ({ attachments }: { attachments: Array<{ name: string; state?: string; url?: string | null }> }) =>
    <ul>{attachments.map((file) => <li key={file.name}>{`${file.name}:${file.state ?? file.url}`}</li>)}</ul>,
}));
vi.mock('../botStore', () => ({ ensureBotProfilesLoaded: h.ensureLoaded, useBotProfiles: () => h.profiles }));
vi.mock('@/features/device-link/useDeviceLinkDeviceList', () => ({ useDeviceLinkDeviceList: () => h.devices }));
vi.mock('@/lib/toast', () => ({ toast: { info: h.toast, error: h.toast } }));

import { CLOUD_ATTACHMENT_LOADS, CloudCompanionOfflineView } from '../CloudCompanionOfflineView';
import { BotHomeComputerSetting, companionArrivedHere } from '../BotHomeComputerSetting';
import { resetCompanionCloudStoreForTests, useCompanionCloud } from '../companionCloudStore';
import { cloudOnlyRemoteBots, cloudRemoteBots, isCloudCompanionRemote, withoutCloudCompanions, withoutShadowedBots } from '../companionCloudPresentation';
import { BotConnectionStatus } from '../BotConnectionStatus';

const maker = {
  getCompanionCloudState: vi.fn(),
  onCompanionCloudChanged: vi.fn(() => () => undefined),
  getCompanionTranscript: vi.fn(),
  getCompanionAttachment: vi.fn(),
  takeOverCompanion: vi.fn(),
  getCompanionHomeChoices: vi.fn(),
  switchCompanionHome: vi.fn(),
};

const snapshot = (home: string | null, enabled = true): CompanionCloudSnapshot => ({
  enabled, selfDeviceId: 'desk', humanActorId: 'human', demotedBotIds: [],
  actors: [{ id: 'a-mia', externalId: 'mia', name: 'Mia', avatar: null, homeDeviceId: home,
    homeDevice: home ? { deviceId: home, name: home === 'desk' ? 'Desk' : 'Laptop', online: false, isSelf: home === 'desk' } : null }],
});

beforeEach(() => {
  for (const fn of Object.values(maker)) fn.mockReset();
  maker.onCompanionCloudChanged.mockImplementation(() => () => undefined);
  h.navigate.mockReset();
  h.toast.mockReset();
  Object.defineProperty(window, 'electronAPI', { configurable: true, writable: true, value: { maker } });
});
afterEach(() => { cleanup(); });

describe('presentation helpers', () => {
  it('hides demoted copies and adds unseen cloud homes as offline rows', () => {
    const cloud = { ...snapshot('laptop'), demotedBotIds: ['mia'] };
    expect(withoutShadowedBots([{ id: 'mia' }, { id: 'ada' }], cloud)).toEqual([{ id: 'ada' }]);
    // Persisted demotion holds with the feature off or the server unreachable.
    expect(withoutShadowedBots([{ id: 'mia' }], { ...cloud, enabled: false })).toEqual([]);
    const extra = cloudOnlyRemoteBots(cloud, []);
    expect(extra).toMatchObject([{ id: 'mia', deviceId: 'laptop', deviceName: 'Laptop', online: false }]);
    expect(cloudOnlyRemoteBots(cloud, extra)).toEqual([]);
    expect(isCloudCompanionRemote(cloud, extra[0]!)).toBe(true);
    expect(isCloudCompanionRemote(cloud, { id: 'mia', deviceId: 'elsewhere' })).toBe(false);
    expect(isCloudCompanionRemote(snapshot('desk'), { id: 'mia', deviceId: 'desk' })).toBe(false);
  });

  it('hides a local copy as soon as its main computer is known to be elsewhere', () => {
    expect(withoutShadowedBots([{ id: 'mia' }, { id: 'ada' }], snapshot('laptop'))).toEqual([{ id: 'ada' }]);
    expect(withoutShadowedBots([{ id: 'mia' }], snapshot('desk'))).toEqual([{ id: 'mia' }]);
    expect(withoutShadowedBots([{ id: 'mia' }], snapshot(null))).toEqual([{ id: 'mia' }]);
    // Feature off: per-computer behaviour unchanged.
    expect(withoutShadowedBots([{ id: 'mia' }], snapshot('laptop', false))).toEqual([{ id: 'mia' }]);
  });

  it('keeps cloud companions out of the per-computer Cindy merge', () => {
    expect(withoutCloudCompanions([{ id: 'mia' }, { id: 'ada' }], snapshot('laptop'))).toEqual([{ id: 'ada' }]);
    expect(withoutCloudCompanions([{ id: 'mia' }], snapshot('laptop', false))).toEqual([{ id: 'mia' }]);
  });

  it('lists a companion once, on its main computer, dropping old computers\' cached copies', () => {
    const row = (deviceId: string, id = 'mia') => ({ id, deviceId, deviceName: deviceId, name: id, avatar: '', avatarColor: 'violet',
      description: '', preview: '', activityAt: 0, sessionId: null, online: false, connectionKnown: true }) as const;
    // The old computer is offline and only its cached row is left: replaced by the main computer's row.
    expect(cloudRemoteBots(snapshot('laptop'), [row('old-mac'), row('old-mac', 'ada')]).map((bot) => `${bot.deviceId}/${bot.id}`))
      .toEqual(['old-mac/ada', 'laptop/mia']);
    expect(cloudRemoteBots(snapshot('laptop'), [row('old-mac'), row('laptop')]).map((bot) => bot.deviceId)).toEqual(['laptop']);
    // Homed here: other computers' copies are not separate entries.
    expect(cloudRemoteBots(snapshot('desk'), [row('old-mac')])).toEqual([]);
    expect(cloudRemoteBots(snapshot('laptop', false), [row('old-mac')])).toHaveLength(1);
  });

  it('does not announce an unreachable main computer in the row status, like IM', () => {
    const { container } = render(<><BotConnectionStatus inline online={false} quiet deviceName="Laptop" /><BotConnectionStatus online={false} quiet /></>);
    expect(container.textContent).toBe('Laptop');
    expect(container.querySelector('[title]')?.getAttribute('title')).toBe('Laptop');
    expect(container.querySelectorAll('span')).toHaveLength(1);
  });
});

describe('CloudCompanionOfflineView', () => {
  const page = { messages: [
    { id: 'm1', seq: '1', role: 'user', text: 'hello', createdAt: 1 },
    { id: 'm2', seq: '2', role: 'assistant', text: 'hi there', createdAt: 2 },
  ] };
  const renderView = () => render(<CloudCompanionOfflineView botId="mia" deviceId="laptop" name="Mia" deviceName="Laptop" />);

  it('shows the banner and the read-only cloud conversation, oldest first', async () => {
    maker.getCompanionTranscript.mockResolvedValue(page);
    renderView();
    expect(screen.getByText('bots.cloud.homeOffline:{"device":"Laptop"}')).toBeTruthy();
    await waitFor(() => expect(screen.getByText('hi there')).toBeTruthy());
    const texts = [...document.querySelectorAll('article')].map((node) => node.textContent);
    expect(texts).toEqual(['hello', 'hi there']);
    expect(maker.getCompanionTranscript).toHaveBeenCalledWith('mia', undefined);
    expect(screen.getByText('bots.cloud.readOnlyNote')).toBeTruthy();
  });

  it('shows the files of a cloud message, brought from the room', async () => {
    maker.getCompanionTranscript.mockResolvedValue({ messages: [
      { id: 'm1', seq: '1', role: 'user', text: '', createdAt: 1, attachments: [{ mediaId: 'media-1', name: 'cat.png' }] }] });
    maker.getCompanionAttachment.mockResolvedValue({ id: 'media-1', name: 'cat.png', category: 'image', mimeType: 'image/png', size: 3,
      url: 'cindy-media://blobs/a.png', path: null });
    renderView();
    expect(await screen.findByText('cat.png:loading')).toBeTruthy();
    expect(await screen.findByText('cat.png:cindy-media://blobs/a.png')).toBeTruthy();
    expect(maker.getCompanionAttachment).toHaveBeenCalledWith('mia', 'media-1');
  });

  it('brings a long conversation\'s files down a few at a time, never all at once', async () => {
    const files = Array.from({ length: 5 }, (_, i) => ({ mediaId: `media-${i}`, name: `f${i}.txt` }));
    maker.getCompanionTranscript.mockResolvedValue({ messages: [{ id: 'm1', seq: '1', role: 'user', text: '', createdAt: 1, attachments: files }] });
    const pending: Array<() => void> = [];
    maker.getCompanionAttachment.mockImplementation((_bot: string, mediaId: string) => new Promise((resolve) => {
      pending.push(() => resolve({ id: mediaId, name: mediaId, category: 'file', mimeType: 'text/plain', size: 1, url: null, path: `/tmp/${mediaId}` }));
    }));
    renderView();
    await waitFor(() => expect(maker.getCompanionAttachment).toHaveBeenCalledTimes(CLOUD_ATTACHMENT_LOADS));
    await act(async () => { pending.shift()!(); });
    await waitFor(() => expect(maker.getCompanionAttachment).toHaveBeenCalledTimes(CLOUD_ATTACHMENT_LOADS + 1));
    while (pending.length) await act(async () => { pending.shift()!(); });
    await waitFor(() => expect(maker.getCompanionAttachment).toHaveBeenCalledTimes(5));
    while (pending.length) await act(async () => { pending.shift()!(); });
  });

  it('loads older messages on request', async () => {
    maker.getCompanionTranscript.mockResolvedValueOnce({ ...page, nextBefore: '1' })
      .mockResolvedValueOnce({ messages: [{ id: 'm0', seq: '0', role: 'user', text: 'earlier', createdAt: 0 }] });
    renderView();
    await waitFor(() => expect(screen.getByText('bots.cloud.loadOlder')).toBeTruthy());
    fireEvent.click(screen.getByText('bots.cloud.loadOlder'));
    await waitFor(() => expect(screen.getByText('earlier')).toBeTruthy());
    expect(maker.getCompanionTranscript).toHaveBeenLastCalledWith('mia', '1');
    expect([...document.querySelectorAll('article')].map((node) => node.textContent)).toEqual(['earlier', 'hello', 'hi there']);
  });

  it('continues on this computer and opens the local companion', async () => {
    maker.getCompanionTranscript.mockResolvedValue(page);
    let finish!: (value: unknown) => void;
    maker.takeOverCompanion.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    renderView();
    fireEvent.click(screen.getByText('bots.cloud.continueHere'));
    await waitFor(() => expect(screen.getByText('bots.cloud.takingOver:{"name":"Mia"}')).toBeTruthy());
    await act(async () => { finish({ ok: true }); });
    await waitFor(() => expect(h.navigate).toHaveBeenCalledWith('/bots/mia'));
    expect(maker.takeOverCompanion).toHaveBeenCalledWith('mia');
    expect(h.ensureLoaded).toHaveBeenCalledWith(true);
  });

  it('follows the companion when another computer already continued', async () => {
    maker.getCompanionTranscript.mockResolvedValue(page);
    maker.takeOverCompanion.mockResolvedValue({ ok: false, code: 'HOME_CONFLICT', homeDeviceId: 'tablet' });
    renderView();
    fireEvent.click(screen.getByText('bots.cloud.continueHere'));
    await waitFor(() => expect(h.navigate).toHaveBeenCalledWith('/bots/remote/tablet/mia'));
    expect(h.toast).toHaveBeenCalledWith('bots.cloud.takeOverConflict:{"name":"Mia","device":"Tablet"}');
  });

  it('explains a failed take-over inline and lets the user try again', async () => {
    maker.getCompanionTranscript.mockResolvedValue(page);
    maker.takeOverCompanion.mockResolvedValueOnce({ ok: false, code: 'OFFLINE' }).mockResolvedValueOnce({ ok: true });
    renderView();
    fireEvent.click(screen.getByText('bots.cloud.continueHere'));
    await waitFor(() => expect(screen.getByText('bots.cloud.takeOverOffline:{"name":"Mia"}')).toBeTruthy());
    expect(h.navigate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('bots.cloud.continueHere'));
    await waitFor(() => expect(h.navigate).toHaveBeenCalledWith('/bots/mia'));
  });
});

describe('BotHomeComputerSetting', () => {
  const bot = { id: 'mia', name: 'Mia' };
  const openMenu = () => fireEvent.keyDown(screen.getByTestId('bot-home-computer-row'), { key: 'ArrowDown' });
  const laptop = { deviceId: 'laptop', name: 'Laptop', online: true };
  const local = (targets = [laptop]) => ({ homeDeviceId: 'desk', mode: 'local', targets });
  const show = (cloud: CompanionCloudSnapshot, props: Partial<typeof bot & { status: string }> = {}) => {
    resetCompanionCloudStoreForTests(cloud);
    maker.getCompanionCloudState.mockResolvedValue(cloud);
    return render(<BotHomeComputerSetting bot={{ ...bot, ...props }} />);
  };
  beforeEach(() => { h.profiles = []; h.ensureLoaded.mockReset(); h.ensureLoaded.mockResolvedValue([]); });

  it.each([
    ['the feature is off', snapshot('desk', false)],
    ['the companion has no main computer yet', snapshot(null)],
  ])('is hidden when %s', (_name, cloud) => {
    show(cloud);
    expect(screen.queryByTestId('bot-home-computer-row')).toBeNull();
  });

  it('confirms before moving the companion, then opens it on the new computer', async () => {
    maker.getCompanionHomeChoices.mockResolvedValue(local());
    maker.switchCompanionHome.mockResolvedValue({ ok: true });
    show(snapshot('desk'));
    expect(screen.getByText('bots.cloud.thisComputer')).toBeTruthy();
    openMenu();
    fireEvent.click(await screen.findByText('bots.cloud.switchTo:{"device":"Laptop"}'));
    await screen.findByText('bots.cloud.switchDescription:{"name":"Mia","device":"Laptop"}');
    expect(maker.switchCompanionHome).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'bots.cloud.switchAction:{"device":"Laptop"}' }));
    await waitFor(() => expect(h.navigate).toHaveBeenCalledWith('/bots/remote/laptop/mia'));
    expect(maker.switchCompanionHome).toHaveBeenCalledWith('mia', 'laptop', undefined);
    expect(maker.getCompanionHomeChoices).toHaveBeenCalledWith('mia');
  });

  it('shows where a companion homed on another computer runs, and moves it to this one', async () => {
    maker.getCompanionHomeChoices.mockResolvedValue({ homeDeviceId: 'laptop', mode: 'remote',
      targets: [{ deviceId: 'desk', name: 'Desk', online: true, isSelf: true }, { deviceId: 'tablet', name: 'Tablet', online: true, isSelf: false }] });
    maker.switchCompanionHome.mockResolvedValue({ ok: true });
    const arrived = snapshot('desk');
    show(snapshot('laptop'));
    expect(screen.getByText('Laptop')).toBeTruthy();
    openMenu();
    expect(await screen.findByText('bots.cloud.switchTo:{"device":"Tablet"}')).toBeTruthy();
    fireEvent.click(screen.getByText('bots.cloud.switchHere'));
    // The move reaches this computer, which builds the companion before it opens.
    h.ensureLoaded.mockImplementation(async () => {
      resetCompanionCloudStoreForTests(arrived);
      return [{ id: 'mia', status: 'active' }];
    });
    fireEvent.click(await screen.findByRole('button', { name: 'bots.cloud.switchAction:{"device":"bots.cloud.thisComputer"}' }));
    await waitFor(() => expect(h.navigate).toHaveBeenCalledWith('/bots/mia'));
    expect(maker.switchCompanionHome).toHaveBeenCalledWith('mia', 'desk', undefined);
  });

  it('explains when the main computer runs an older Cindy', async () => {
    maker.getCompanionHomeChoices.mockResolvedValue({ homeDeviceId: 'laptop', mode: 'unavailable', reason: 'HOME_OUTDATED', targets: [] });
    show(snapshot('laptop'));
    openMenu();
    expect(await screen.findByText('bots.cloud.homeOutdated:{"name":"Mia","device":"Laptop"}')).toBeTruthy();
  });

  it('shows why a move did not happen', async () => {
    maker.getCompanionHomeChoices.mockResolvedValue(local());
    maker.switchCompanionHome.mockResolvedValue({ ok: false, code: 'OFFLINE' });
    show(snapshot('desk'));
    openMenu();
    fireEvent.click(await screen.findByText('bots.cloud.switchTo:{"device":"Laptop"}'));
    fireEvent.click(await screen.findByRole('button', { name: 'bots.cloud.switchAction:{"device":"Laptop"}' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'bots.cloud.switchOffline:{"name":"Mia","device":"Laptop"}');
    expect(h.navigate).not.toHaveBeenCalled();
  });

  it.each([['busyWait', 'wait'], ['busyStop', 'stop']])('offers to wait for or stop a reply in progress (%s)', async (button, whenBusy) => {
    maker.getCompanionHomeChoices.mockResolvedValue(local());
    maker.switchCompanionHome.mockResolvedValueOnce({ ok: false, code: 'BUSY' }).mockResolvedValueOnce({ ok: true });
    show(snapshot('desk'));
    openMenu();
    fireEvent.click(await screen.findByText('bots.cloud.switchTo:{"device":"Laptop"}'));
    fireEvent.click(await screen.findByRole('button', { name: 'bots.cloud.switchAction:{"device":"Laptop"}' }));
    await screen.findByText('bots.cloud.busyDescription:{"name":"Mia","device":"Laptop"}');
    fireEvent.click(screen.getByRole('button', { name: `bots.cloud.${button}` }));
    await waitFor(() => expect(h.navigate).toHaveBeenCalledWith('/bots/remote/laptop/mia'));
    expect(maker.switchCompanionHome).toHaveBeenLastCalledWith('mia', 'laptop', { whenBusy });
  });

  it('asks to resume a paused companion before moving it', async () => {
    show(snapshot('desk'), { status: 'paused' });
    openMenu();
    expect(await screen.findByText('bots.cloud.resumeToMove:{"name":"Mia"}')).toBeTruthy();
    expect(maker.getCompanionHomeChoices).not.toHaveBeenCalled();
  });

  it('says when no other computer can take over', async () => {
    maker.getCompanionHomeChoices.mockResolvedValue(local([]));
    show(snapshot('desk'));
    openMenu();
    expect(await screen.findByText('bots.cloud.noTargets')).toBeTruthy();
  });

  it('counts a companion as arrived only once it is built here and no longer demoted', () => {
    const cloud = snapshot('desk');
    expect(companionArrivedHere(cloud, 'mia', [])).toBe(false);
    expect(companionArrivedHere({ ...cloud, demotedBotIds: ['mia'] }, 'mia', ['mia'])).toBe(false);
    expect(companionArrivedHere(snapshot('laptop'), 'mia', ['mia'])).toBe(false);
    expect(companionArrivedHere(cloud, 'mia', ['mia'])).toBe(true);
  });
});

describe('companionCloudStore', () => {
  it('keeps a newer push when an older refresh answers later', async () => {
    const { renderHook } = await import('@testing-library/react');
    resetCompanionCloudStoreForTests(snapshot('desk'));
    let answer: (value: CompanionCloudSnapshot) => void = () => undefined;
    maker.getCompanionCloudState.mockReturnValue(new Promise(resolve => { answer = resolve; }));
    let push: (next: CompanionCloudSnapshot) => void = () => undefined;
    maker.onCompanionCloudChanged.mockImplementation(((listener: typeof push) => { push = listener; return () => undefined; }) as never);
    const { result, unmount } = renderHook(() => useCompanionCloud());
    await waitFor(() => expect(maker.getCompanionCloudState).toHaveBeenCalled());
    act(() => push(snapshot('laptop')));
    await act(async () => { answer(snapshot('desk')); await Promise.resolve(); });
    expect(result.current.actors[0]!.homeDeviceId).toBe('laptop');
    unmount();
  });
});

describe('CompanionShadowBanner', () => {
  it('opens the companion on its main computer or takes it over here', async () => {
    const { CompanionShadowBanner } = await import('../CompanionShadowBanner');
    resetCompanionCloudStoreForTests(snapshot('laptop'));
    maker.getCompanionCloudState.mockResolvedValue(snapshot('laptop'));
    maker.takeOverCompanion.mockResolvedValue({ ok: true });
    render(<CompanionShadowBanner botId="mia" name="Mia" />);
    expect(screen.getByText('bots.cloud.shadowTitle:{"device":"Laptop"}')).toBeTruthy();
    fireEvent.click(screen.getByText('bots.cloud.openOnHome:{"device":"Laptop"}'));
    expect(h.navigate).toHaveBeenCalledWith('/bots/remote/laptop/mia');
    fireEvent.click(screen.getByText('bots.cloud.continueHere'));
    await waitFor(() => expect(maker.takeOverCompanion).toHaveBeenCalledWith('mia'));
    await waitFor(() => expect(h.ensureLoaded).toHaveBeenCalledWith(true));
  });
});
