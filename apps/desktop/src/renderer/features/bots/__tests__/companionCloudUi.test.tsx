// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompanionCloudSnapshot } from '../../../../shared/companionCloud';

const h = vi.hoisted(() => ({
  owner: { dataOwnerId: 'test-owner', generation: 0 },
  navigate: vi.fn(),
  toast: vi.fn(),
  ensureLoaded: vi.fn(async (): Promise<Array<{ id: string; status: string }>> => []),
  profiles: [] as Array<{ id: string; status: string }>,
  devices: [{ deviceId: 'tablet', name: 'Tablet', isSelf: false }],
}));
vi.mock('@/contexts/dataOwnerGeneration', () => ({
  getDataOwnerGeneration: () => h.owner,
  isDataOwnerGenerationCurrent: (owner: unknown) => owner === h.owner,
  isDataOwnerPushCurrent: () => true,
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
import { BotHomeComputerSetting, companionArrivedHere, useCompanionHomeSwitch } from '../BotHomeComputerSetting';
import { resetCompanionCloudStoreForTests, useCompanionCloud } from '../companionCloudStore';
import { cloudOnlyRemoteBots, cloudRemoteBots, isCloudCompanionRemote, withoutCloudCompanions, withoutShadowedBots } from '../companionCloudPresentation';
import { BotConnectionStatus } from '../BotConnectionStatus';

const maker = {
  chatDisplayCache: vi.fn(),
  getCompanionCloudState: vi.fn(),
  onCompanionCloudChanged: vi.fn(() => () => undefined),
  getCompanionTranscript: vi.fn(),
  getCompanionAttachment: vi.fn(),
  takeOverCompanion: vi.fn(),
  repairCompanionProfile: vi.fn(),
  getCompanionHomeChoices: vi.fn(),
  switchCompanionHome: vi.fn(),
};

const snapshot = (home: string | null, enabled = true): CompanionCloudSnapshot => ({
  enabled, selfDeviceId: 'desk', humanActorId: 'human', demotedBotIds: [],
  actors: [{ id: 'a-mia', externalId: 'mia', name: 'Mia', avatar: null, homeDeviceId: home,
    homeDevice: home ? { deviceId: home, name: home === 'desk' ? 'Desk' : 'Laptop', online: false, isSelf: home === 'desk' } : null }],
});

beforeEach(() => {
  h.owner = { dataOwnerId: 'test-owner', generation: h.owner.generation + 1 };
  for (const fn of Object.values(maker)) fn.mockReset();
  maker.chatDisplayCache.mockResolvedValue(null);
  maker.onCompanionCloudChanged.mockImplementation(() => () => undefined);
  h.navigate.mockReset();
  h.toast.mockReset();
  h.ensureLoaded.mockReset().mockResolvedValue([{ id: 'local-orphan', status: 'active' }]);
  Object.defineProperty(window, 'electronAPI', { configurable: true, writable: true, value: { maker } });
});
afterEach(() => { cleanup(); });

// Integration tier: slow/failing IPC must not obscure a locally saved transcript.
it('renders the saved cloud transcript before the remote read and preserves it on failure', async () => {
  maker.chatDisplayCache.mockResolvedValue({ messages: [{ id: 'saved', seq: '1', text: 'Saved cloud chat', role: 'user', createdAt: 1 }] });
  let fail!: (error: Error) => void;
  maker.getCompanionTranscript.mockImplementation(() => new Promise((_resolve, reject) => { fail = reject; }));
  render(<CloudCompanionOfflineView botId="mia" deviceId="laptop" name="Mia" deviceName="Laptop" />);
  expect(await screen.findByText('Saved cloud chat')).toBeTruthy();
  await act(async () => fail(new Error('offline')));
  expect(screen.getByText('Saved cloud chat')).toBeTruthy();
});

describe('presentation helpers', () => {
  // #10112, unit tier: a rejected shadow must have a recovery entry, never a runnable copy.
  it('retains a read-only entry for a rejected local restore, then removes it on recovery', () => {
    const cloud = snapshot('desk');
    cloud.demotedBotIds = ['mia'];
    cloud.actors[0]!.profileFailure = { field: 'identitySource', maxLength: 12000 };
    expect(withoutShadowedBots([{ id: 'mia' }], cloud)).toEqual([]);
    expect(cloudRemoteBots(cloud, [])).toMatchObject([{ id: 'mia', deviceId: 'desk', online: false, sessionId: null }]);
    delete cloud.actors[0]!.profileFailure;
    cloud.demotedBotIds = [];
    expect(cloudRemoteBots(cloud, [])).toEqual([]);
    expect(withoutShadowedBots([{ id: 'mia' }], cloud)).toEqual([{ id: 'mia' }]);
  });
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
  // #10112, integration tier: enter through the failed companion, edit the complete
  // 12001-character source, retain edits on a failed save, then return to the recovered buddy.
  it('corrects the rejected profile through its real form and preserves edits when saving fails', async () => {
    maker.getCompanionTranscript.mockResolvedValue({ messages: [] });
    const source = 'x'.repeat(12001);
    maker.repairCompanionProfile.mockResolvedValueOnce({ ok: true, draft: { token: 'draft', fields: [
      { field: 'identitySource', source, maxLength: 12000 },
    ] } }).mockResolvedValueOnce({ ok: false, code: 'FAILED', profileRepairError: 'backup' }).mockResolvedValueOnce({ ok: true });
    render(<CloudCompanionOfflineView botId="mia" deviceId="desk" name="Mia" deviceName="Desk"
      profileFailure={{ field: 'identitySource', maxLength: 12000 }} />);
    fireEvent.click(screen.getByRole('button', { name: 'bots.cloud.repair.action' }));
    const field = await screen.findByRole('textbox', { name: 'bots.profile.personality' });
    expect((field as HTMLTextAreaElement).value).toBe(source);
    const save = screen.getByRole('button', { name: 'bots.cloud.repair.save' });
    expect(save.hasAttribute('disabled')).toBe(true);
    expect(field.getAttribute('aria-invalid')).toBe('true');
    fireEvent.change(field, { target: { value: 'y'.repeat(12000) } });
    expect(save.hasAttribute('disabled')).toBe(false);
    fireEvent.click(save);
    expect(await screen.findByText('bots.cloud.repair.backupFailed')).toBeTruthy();
    expect((field as HTMLTextAreaElement).value).toBe('y'.repeat(12000));
    expect(h.navigate).not.toHaveBeenCalled();
    fireEvent.click(save);
    await waitFor(() => expect(h.navigate).toHaveBeenCalledWith('/bots/mia'));
    expect(maker.repairCompanionProfile).toHaveBeenLastCalledWith('mia', { action: 'save', token: 'draft', values: { identitySource: 'y'.repeat(12000) } });
  });

  it('requires a new draft after the home changes and ignores a load from a previous account', async () => {
    maker.getCompanionTranscript.mockResolvedValue({ messages: [] });
    maker.repairCompanionProfile.mockResolvedValueOnce({ ok: true, draft: { token: 'old', fields: [
      { field: 'identitySource', source: 'x'.repeat(12001), maxLength: 12000 },
    ] } }).mockResolvedValueOnce({ ok: false, code: 'HOME_CONFLICT' });
    render(<CloudCompanionOfflineView botId="mia" deviceId="desk" name="Mia" deviceName="Desk"
      profileFailure={{ field: 'identitySource', maxLength: 12000 }} />);
    fireEvent.click(screen.getByRole('button', { name: 'bots.cloud.repair.action' }));
    const field = await screen.findByRole('textbox');
    fireEvent.change(field, { target: { value: 'my edit' } });
    fireEvent.click(screen.getByRole('button', { name: 'bots.cloud.repair.save' }));
    expect(await screen.findByText('bots.cloud.repair.changed')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'bots.cloud.repair.save' }).hasAttribute('disabled')).toBe(true);
    let resolve!: (value: unknown) => void;
    maker.repairCompanionProfile.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    fireEvent.click(screen.getByRole('button', { name: 'bots.cloud.repair.reload' }));
    h.owner = { dataOwnerId: 'other', generation: h.owner.generation + 1 };
    await act(async () => resolve({ ok: true, draft: { token: 'obsolete', fields: [{ field: 'identitySource', source: 'private old account text', maxLength: 12000 }] } }));
    expect(screen.queryByDisplayValue('private old account text')).toBeNull();
    expect(h.navigate).not.toHaveBeenCalled();
  });

  // #10112, integration tier: actual error UI and retry API; an unchanged source
  // stays visible, a corrected source returns to the local companion.
  it('shows the permanent source rejection and retries without losing the cloud conversation', async () => {
    const failure = { field: 'identitySource' as const, maxLength: 12000 };
    maker.getCompanionTranscript.mockResolvedValue({ messages: [{ id: 'kept', seq: '1', role: 'user', text: 'Keep this conversation', createdAt: 1 }] });
    maker.takeOverCompanion.mockResolvedValueOnce({ ok: false, code: 'FAILED', profileFailure: failure }).mockResolvedValueOnce({ ok: true });
    render(<CloudCompanionOfflineView botId="mia" deviceId="desk" name="Mia" deviceName="Desk" profileFailure={failure} />);
    expect(await screen.findByText('Keep this conversation')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('bots.cloud.profileIdentityTooLong');
    fireEvent.click(screen.getByRole('button', { name: 'bots.retry' }));
    await waitFor(() => expect(maker.takeOverCompanion).toHaveBeenCalledTimes(1));
    expect(h.navigate).not.toHaveBeenCalled();
    expect(screen.getByText('Keep this conversation')).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('button', { name: 'bots.retry' }).hasAttribute('disabled')).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'bots.retry' }));
    await waitFor(() => expect(h.navigate).toHaveBeenCalledWith('/bots/mia'));
  });
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

  it('says the main computer is offline unless it is online with remote control off', async () => {
    maker.getCompanionTranscript.mockResolvedValue(page);
    const { rerender } = renderView();
    expect(screen.getByText('bots.cloud.homeOffline:{"device":"Laptop"}')).toBeTruthy();
    rerender(<CloudCompanionOfflineView botId="mia" deviceId="laptop" name="Mia" deviceName="Laptop" controlOff />);
    expect(screen.getByText('bots.cloud.homeControlOff:{"device":"Laptop"}')).toBeTruthy();
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

  it.each([false, true])('opens the absent local Cindy settings only when chosen (profile recovery: %s)', async recovering => {
    resetCompanionCloudStoreForTests(snapshot('laptop'));
    maker.getCompanionCloudState.mockResolvedValue(snapshot('laptop'));
    maker.getCompanionTranscript.mockResolvedValue(page);
    maker.takeOverCompanion.mockResolvedValue({ ok: false, code: 'LOCAL_CINDY_CONFLICT', conflictingBotId: 'local-orphan', conflictingDeviceId: 'desk' });
    render(<CloudCompanionOfflineView botId="mia" deviceId="laptop" name="Mia" deviceName="Laptop"
      profileFailure={recovering ? { field: 'identitySource', maxLength: 12000 } : undefined} />);
    fireEvent.click(screen.getByText(recovering ? 'bots.retry' : 'bots.cloud.continueHere'));
    expect(await screen.findByText('bots.cloud.localCindyConflict:{"name":"Mia"}')).toBeTruthy();
    expect(h.navigate).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: 'bots.cloud.localCindyConflictAction' }));
    await waitFor(() => expect(h.navigate).toHaveBeenCalledWith('/bots/local-orphan?settings=1'));
  });

  it.each([undefined, 'other-device'])('never opens a local same-ID copy for an unverified conflict source: %s', async conflictingDeviceId => {
    resetCompanionCloudStoreForTests(snapshot('laptop'));
    maker.getCompanionCloudState.mockResolvedValue(snapshot('laptop'));
    maker.getCompanionTranscript.mockResolvedValue(page);
    maker.takeOverCompanion.mockResolvedValue({ ok: false, code: 'LOCAL_CINDY_CONFLICT', conflictingBotId: 'local-orphan', conflictingDeviceId });
    renderView();
    fireEvent.click(screen.getByText('bots.cloud.continueHere'));
    await screen.findByText('bots.cloud.localCindyConflict:{"name":"Mia"}');
    expect(screen.queryByRole('button', { name: 'bots.cloud.localCindyConflictAction' })).toBeNull();
    expect(h.navigate).not.toHaveBeenCalled();
  });

  // #9960: a demoted copy can still reserve this computer's singleton, but its settings
  // are read-only in BotSettingsDrawer. Do not offer a route that cannot open that drawer.
  it.each(['already demoted', 'demoted during profile read'])('respects settings eligibility when the conflict is %s', async boundary => {
    const cloud = snapshot('laptop');
    if (boundary === 'already demoted') cloud.demotedBotIds = ['local-orphan'];
    resetCompanionCloudStoreForTests(cloud);
    maker.getCompanionCloudState.mockResolvedValue(cloud);
    maker.getCompanionTranscript.mockResolvedValue(page);
    maker.takeOverCompanion.mockResolvedValue({ ok: false, code: 'LOCAL_CINDY_CONFLICT', conflictingBotId: 'local-orphan', conflictingDeviceId: 'desk' });
    let finish!: (rows: Array<{ id: string; status: string }>) => void;
    h.ensureLoaded.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    renderView();
    fireEvent.click(screen.getByText('bots.cloud.continueHere'));
    await screen.findByText('bots.cloud.localCindyConflict:{"name":"Mia"}');
    if (boundary === 'already demoted') {
      expect(screen.queryByRole('button', { name: 'bots.cloud.localCindyConflictAction' })).toBeNull();
      expect(h.ensureLoaded).not.toHaveBeenCalled();
    } else {
      fireEvent.click(await screen.findByRole('button', { name: 'bots.cloud.localCindyConflictAction' }));
      resetCompanionCloudStoreForTests({ ...cloud, demotedBotIds: ['local-orphan'] });
      await act(async () => finish([{ id: 'local-orphan', status: 'active' }]));
      expect(h.toast).toHaveBeenCalledWith('bots.lifecycle.actionFailed');
    }
    expect(h.navigate).not.toHaveBeenCalled();
  });

  it.each(['owner switch', 'unmount'])('ignores a delayed local profile read after %s', async boundary => {
    resetCompanionCloudStoreForTests(snapshot('laptop'));
    maker.getCompanionCloudState.mockResolvedValue(snapshot('laptop'));
    maker.getCompanionTranscript.mockResolvedValue(page);
    maker.takeOverCompanion.mockResolvedValue({ ok: false, code: 'LOCAL_CINDY_CONFLICT', conflictingBotId: 'local-orphan', conflictingDeviceId: 'desk' });
    let finish!: (rows: Array<{ id: string; status: string }>) => void;
    h.ensureLoaded.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const view = renderView();
    fireEvent.click(screen.getByText('bots.cloud.continueHere'));
    fireEvent.click(await screen.findByRole('button', { name: 'bots.cloud.localCindyConflictAction' }));
    if (boundary === 'unmount') view.unmount();
    else h.owner = { dataOwnerId: 'next-owner', generation: h.owner.generation + 1 };
    await act(async () => finish([{ id: 'local-orphan', status: 'active' }]));
    expect(h.navigate).not.toHaveBeenCalled();
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

  it.each([false, true])('ends the arrival wait on this computer (profile rejected: %s)', async rejected => {
    maker.getCompanionHomeChoices.mockResolvedValue({ homeDeviceId: 'laptop', mode: 'remote',
      targets: [{ deviceId: 'desk', name: 'Desk', online: true, isSelf: true }, { deviceId: 'tablet', name: 'Tablet', online: true, isSelf: false }] });
    maker.switchCompanionHome.mockResolvedValue({ ok: true });
    const arrived = snapshot('desk');
    if (rejected) {
      arrived.demotedBotIds = ['mia'];
      arrived.actors[0]!.profileFailure = { field: 'identitySource', maxLength: 12000 };
    }
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
    await waitFor(() => expect(h.navigate).toHaveBeenCalledWith(rejected ? '/bots/remote/desk/mia' : '/bots/mia'));
    if (rejected) expect(screen.getByRole('alert').textContent).toContain('bots.cloud.profileIdentityTooLong');
    expect(maker.switchCompanionHome).toHaveBeenCalledWith('mia', 'desk', undefined);
  });

  it('explains when the main computer runs an older Cindy', async () => {
    maker.getCompanionHomeChoices.mockResolvedValue({ homeDeviceId: 'laptop', mode: 'unavailable', reason: 'HOME_OUTDATED', targets: [] });
    show(snapshot('laptop'));
    openMenu();
    expect(await screen.findByText('bots.cloud.homeOutdated:{"name":"Mia","device":"Laptop"}')).toBeTruthy();
  });

  it('explains a local Cindy conflict when changing the main computer', async () => {
    h.ensureLoaded.mockResolvedValue([{ id: 'local-orphan', status: 'active' }]);
    maker.getCompanionHomeChoices.mockResolvedValue(local());
    maker.switchCompanionHome.mockResolvedValue({ ok: false, code: 'LOCAL_CINDY_CONFLICT', conflictingBotId: 'local-orphan', conflictingDeviceId: 'desk' });
    show(snapshot('desk'));
    openMenu();
    fireEvent.click(await screen.findByText('bots.cloud.switchTo:{"device":"Laptop"}'));
    fireEvent.click(await screen.findByRole('button', { name: 'bots.cloud.switchAction:{"device":"Laptop"}' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'bots.cloud.localCindyConflict:{"name":"Mia","device":"Laptop"}');
    expect(h.navigate).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: 'bots.cloud.localCindyConflictAction' }));
    await waitFor(() => expect(h.navigate).toHaveBeenCalledWith('/bots/local-orphan?settings=1'));
  });

  it('keeps the local settings action available in the glance popover’s failure toast', async () => {
    resetCompanionCloudStoreForTests(snapshot('desk'));
    maker.getCompanionCloudState.mockResolvedValue(snapshot('desk'));
    h.ensureLoaded.mockResolvedValue([{ id: 'local-orphan', status: 'active' }]);
    maker.switchCompanionHome.mockResolvedValue({ ok: false, code: 'LOCAL_CINDY_CONFLICT', conflictingBotId: 'local-orphan', conflictingDeviceId: 'desk' });
    function GlanceSwitch() {
      const state = useCompanionHomeSwitch(bot, 'toast');
      return <button onClick={() => void state.confirm(laptop)}>Move Cindy</button>;
    }
    render(<GlanceSwitch />);
    fireEvent.click(screen.getByText('Move Cindy'));
    await waitFor(() => expect(h.toast).toHaveBeenCalled());
    const options = h.toast.mock.calls.at(-1)?.[1];
    expect(options.action.label).toBe('bots.cloud.localCindyConflictAction');
    options.action.onClick();
    await waitFor(() => expect(h.navigate).toHaveBeenCalledWith('/bots/local-orphan?settings=1'));
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

  it('explains why this computer is missing from the choices of a remote home', async () => {
    maker.getCompanionHomeChoices.mockResolvedValue({ homeDeviceId: 'laptop', mode: 'remote', thisComputer: 'REMOTE_CONTROL_OFF',
      targets: [{ deviceId: 'tablet', name: 'Tablet', online: true, isSelf: false }] });
    show(snapshot('laptop'));
    openMenu();
    expect(await screen.findByText('bots.cloud.hereControlOff')).toBeTruthy();
    expect(screen.getByText('bots.cloud.switchTo:{"device":"Tablet"}')).toBeTruthy();
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
  it('explains the local Cindy conflict on the shadowed copy', async () => {
    const { CompanionShadowBanner } = await import('../CompanionShadowBanner');
    resetCompanionCloudStoreForTests(snapshot('laptop'));
    maker.getCompanionCloudState.mockResolvedValue(snapshot('laptop'));
    maker.takeOverCompanion.mockResolvedValue({ ok: false, code: 'LOCAL_CINDY_CONFLICT', conflictingBotId: 'local-orphan', conflictingDeviceId: 'desk' });
    render(<CompanionShadowBanner botId="mia" name="Mia" />);
    fireEvent.click(screen.getByText('bots.cloud.continueHere'));
    expect(await screen.findByText('bots.cloud.localCindyConflict:{"name":"Mia"}')).toBeTruthy();
    expect(h.navigate).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: 'bots.cloud.localCindyConflictAction' }));
    await waitFor(() => expect(h.navigate).toHaveBeenCalledWith('/bots/local-orphan?settings=1'));
  });

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
