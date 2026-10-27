// @vitest-environment jsdom
/**
 * 「自动跟进所有任务」设置：账号里只有一位伙伴负责（默认关闭）。真实的
 * BotAutonomySettings + botStore 里的自动跟进设置存储；宿主用一个按 override 语义工作的假
 * IPC 代替（set = 写 override，reset = 删 override，变化推 onBotAutonomyChanged）。
 * 依据：伙伴自主跟进方案的设置合同——打开即移走、提示「已从 X 移到这里」、开启先说明并确认，关闭直接生效、
 * 只在改过时给「恢复默认」、别的窗口改了也跟着变。
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { BotAutonomySettingsView } from '../../../../shared/botAutonomy';

const m = vi.hoisted(() => ({ confirm: vi.fn(async () => true), toastError: vi.fn() }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'en' },
    t: (key: string, values?: Record<string, unknown>) =>
      values ? `${key}:${Object.values(values).map(String).join(',')}` : key,
  }),
}));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({ useConfirmDialog: () => ({ confirm: m.confirm }) }));
vi.mock('@/lib/toast', () => ({ toast: { error: m.toastError } }));
vi.mock('../botStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../botStore')>()),
  useBotProfiles: () => [
    { id: 'cindy-default', name: 'Cindy' },
    { id: 'bot-b', name: 'Bea' },
  ],
}));

import { __testing as dataOwnerTesting, setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { BotAutonomySettings } from '../BotAutonomySettings';
import { BotFollowUpInvitation } from '../BotFollowUpInvitation';
import { RemoteBotFollowUpInvitation } from '../RemoteBotFollowUpInvitation';

const DEFAULTS = { schedulerBotId: null };
let override: string | null | undefined;
let listeners: Array<(payload: { botIds?: string[] }) => void> = [];
const host = {
  getSettings: vi.fn(async (): Promise<BotAutonomySettingsView> => view()),
  setSettings: vi.fn(async (patch: { schedulerBotId: string | null }) => {
    override = patch.schedulerBotId;
    return view();
  }),
  resetSettings: vi.fn(async () => {
    override = undefined;
    return view();
  }),
};

function view(): BotAutonomySettingsView {
  return {
    schedulerBotId: override === undefined ? DEFAULTS.schedulerBotId : override,
    isCustomized: override !== undefined,
    defaults: DEFAULTS,
  };
}

function settingsFor(botId: string, onAllow = vi.fn()) {
  return (
    <div data-testid={botId}>
      <BotAutonomySettings
        botId={botId}
        botName={botId === 'bot-b' ? 'Bea' : 'Cindy'}
        allowSchedulerFollow={false}
        onAllowSchedulerFollowChange={onAllow}
      />
    </div>
  );
}

const mainSwitch = (botId: string) =>
  within(screen.getByTestId(botId)).getByRole('switch', { name: 'bots.autonomy.title' });

beforeEach(() => {
  vi.clearAllMocks();
  override = undefined;
  listeners = [];
  m.confirm.mockResolvedValue(true);
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    localDb: { bots: { autonomy: host } },
    maker: {
      onBotAutonomyChanged: (cb: (payload: { botIds?: string[] }) => void) => {
        listeners.push(cb);
        return () => { listeners = listeners.filter((item) => item !== cb); };
      },
    },
  };
});
afterEach(() => cleanup());

it('moves follow-up to this teammate, tells where it came from, and turns the previous one off', async () => {
  override = 'cindy-default';
  const onAllow = vi.fn();
  render(<>{settingsFor('cindy-default')}{settingsFor('bot-b', onAllow)}</>);
  await waitFor(() => expect(mainSwitch('cindy-default').getAttribute('aria-checked')).toBe('true'));
  const bea = within(screen.getByTestId('bot-b'));
  expect(mainSwitch('bot-b').getAttribute('aria-checked')).toBe('false');
  expect(bea.getByText('bots.autonomy.heldBy:Cindy')).toBeTruthy();
  // 别的伙伴才有「它开的任务也交给 Cindy 跟进」；负责的伙伴自己没有。
  fireEvent.click(bea.getByRole('switch', { name: 'bots.autonomy.allowSchedulerFollow.title:Cindy' }));
  expect(onAllow).toHaveBeenCalledWith(true);
  expect(within(screen.getByTestId('cindy-default')).queryByRole('switch', { name: /allowSchedulerFollow/ })).toBeNull();

  fireEvent.click(mainSwitch('bot-b'));
  await waitFor(() => expect(mainSwitch('bot-b').getAttribute('aria-checked')).toBe('true'));
  expect(host.setSettings).toHaveBeenCalledWith({ schedulerBotId: 'bot-b' });
  expect(bea.getByText('bots.autonomy.movedFrom:Cindy')).toBeTruthy();
  expect(mainSwitch('cindy-default').getAttribute('aria-checked')).toBe('false');
  expect(bea.queryByRole('switch', { name: /allowSchedulerFollow/ })).toBeNull();

  // 恢复默认删除 override，回到关闭；不能重新激活 Cindy。
  fireEvent.click(bea.getByRole('button', { name: 'settings.defaults.restore' }));
  await waitFor(() => expect(mainSwitch('cindy-default').getAttribute('aria-checked')).toBe('false'));
  expect(host.resetSettings).toHaveBeenCalledOnce();
  expect(screen.queryByText(/bots.autonomy.restoreDefault/)).toBeNull();
});

it('starts off, explains scope and usage before enabling, and turns off immediately', async () => {
  render(settingsFor('cindy-default'));
  await waitFor(() => expect(screen.getByText('bots.autonomy.heldByNobody')).toBeTruthy());
  expect(mainSwitch('cindy-default').getAttribute('aria-checked')).toBe('false');
  expect(host.setSettings).not.toHaveBeenCalled();

  m.confirm.mockResolvedValueOnce(false);
  fireEvent.click(mainSwitch('cindy-default'));
  await waitFor(() => expect(m.confirm).toHaveBeenCalledOnce());
  expect(m.confirm).toHaveBeenCalledWith(expect.objectContaining({ description: 'bots.autonomy.consent' }));
  expect(host.setSettings).not.toHaveBeenCalled();

  fireEvent.click(mainSwitch('cindy-default'));
  await waitFor(() => expect(mainSwitch('cindy-default').getAttribute('aria-checked')).toBe('true'));
  expect(host.setSettings).toHaveBeenCalledWith({ schedulerBotId: 'cindy-default' });
  fireEvent.click(mainSwitch('cindy-default'));
  await waitFor(() => expect(mainSwitch('cindy-default').getAttribute('aria-checked')).toBe('false'));
  expect(host.setSettings).toHaveBeenLastCalledWith({ schedulerBotId: null });
  expect(m.confirm).toHaveBeenCalledTimes(2);
});

// 2026-10-21 opt-in contract: a real chat interaction reveals an invitation without
// writing settings. Accept/decline persist through the existing settings IPC (unit).
it.each([true, false])('invites only after engagement, then persists the choice (%s)', async (enable) => {
  const { rerender, unmount } = render(<BotFollowUpInvitation botId="cindy-default" engaged={false} />);
  await waitFor(() => expect(host.getSettings).toHaveBeenCalled());
  expect(screen.queryByRole('region')).toBeNull();
  expect(host.setSettings).not.toHaveBeenCalled();
  rerender(<BotFollowUpInvitation botId="cindy-default" engaged />);
  await screen.findByRole('region', { name: 'bots.autonomy.invitation.title' });
  expect(host.setSettings).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: enable ? 'bots.autonomy.invitation.start' : 'bots.autonomy.invitation.notNow' }));
  await waitFor(() => expect(screen.queryByRole('region')).toBeNull());
  expect(host.setSettings).toHaveBeenCalledWith({ schedulerBotId: enable ? 'cindy-default' : null });
  // Starting shows scope and usage in the same confirmation as settings before saving; declining needs none.
  if (enable) expect(m.confirm).toHaveBeenCalledWith(expect.objectContaining({ description: 'bots.autonomy.consent' }), expect.any(AbortSignal));
  else expect(m.confirm).not.toHaveBeenCalled();
  unmount();
  render(<BotFollowUpInvitation botId="cindy-default" engaged />);
  await waitFor(() => expect(host.getSettings).toHaveBeenCalledTimes(2));
  expect(screen.queryByRole('region')).toBeNull();
});

it('keeps the invitation and saves nothing when the confirmation is cancelled', async () => {
  render(<BotFollowUpInvitation botId="cindy-default" engaged />);
  m.confirm.mockResolvedValueOnce(false);
  fireEvent.click(await screen.findByRole('button', { name: 'bots.autonomy.invitation.start' }));
  await waitFor(() => expect(m.confirm).toHaveBeenCalledOnce());
  expect(host.setSettings).not.toHaveBeenCalled();
  expect(screen.getByRole('region')).toBeTruthy();
});

it('asks once for a double click and drops a confirmation that returns after the account changed', async () => {
  render(<BotFollowUpInvitation botId="cindy-default" engaged />);
  let answer!: (value: boolean) => void;
  m.confirm.mockImplementationOnce(() => new Promise<boolean>((done) => { answer = done; }));
  const button = await screen.findByRole('button', { name: 'bots.autonomy.invitation.start' });
  fireEvent.click(button);
  fireEvent.click(button);
  expect(m.confirm).toHaveBeenCalledOnce();
  setDataOwnerGeneration('account-b');
  await act(async () => answer(true));
  expect(host.setSettings).not.toHaveBeenCalled();
  dataOwnerTesting.reset();
});

it('still saves a confirmation across a same-account generation repair', async () => {
  render(<BotFollowUpInvitation botId="cindy-default" engaged />);
  let answer!: (value: boolean) => void;
  m.confirm.mockImplementationOnce(() => new Promise<boolean>((done) => { answer = done; }));
  fireEvent.click(await screen.findByRole('button', { name: 'bots.autonomy.invitation.start' }));
  setDataOwnerGeneration(null);
  await act(async () => answer(true));
  expect(host.setSettings).toHaveBeenCalledWith({ schedulerBotId: 'cindy-default' });
  dataOwnerTesting.reset();
});

it('closes a pending confirmation when the invitation goes away', async () => {
  const { unmount } = render(<BotFollowUpInvitation botId="cindy-default" engaged />);
  m.confirm.mockImplementationOnce(() => new Promise<boolean>(() => {}));
  fireEvent.click(await screen.findByRole('button', { name: 'bots.autonomy.invitation.start' }));
  const signal = (m.confirm.mock.calls[0] as unknown as [unknown, AbortSignal])[1];
  expect(signal.aborted).toBe(false);
  unmount();
  expect(signal.aborted).toBe(true);
});

it('keeps the invitation available when saving fails', async () => {
  render(<BotFollowUpInvitation botId="cindy-default" engaged />);
  const button = await screen.findByRole('button', { name: 'bots.autonomy.invitation.start' });
  host.setSettings.mockRejectedValueOnce(new Error('disk unavailable'));
  fireEvent.click(button);
  await waitFor(() => expect(m.toastError).toHaveBeenCalledWith('bots.autonomy.saveFailed'));
  expect(button.hasAttribute('disabled')).toBe(false);
  expect(screen.getByRole('region')).toBeTruthy();
});

it('follows a change made elsewhere (another window or the agent) through the host push', async () => {
  override = 'cindy-default';
  render(settingsFor('bot-b'));
  await waitFor(() => expect(screen.getByText('bots.autonomy.heldBy:Cindy')).toBeTruthy());
  override = 'bot-b';
  await act(async () => { listeners.forEach((cb) => cb({})); });
  await waitFor(() => expect(mainSwitch('bot-b').getAttribute('aria-checked')).toBe('true'));
  // 不是在这里打开的，不显示「已从…移到这里」。
  expect(screen.queryByText(/bots.autonomy.movedFrom/)).toBeNull();
});

it.each([true, false])('remote invitation uses the host-bound choice, enable=%s', async enable => {
  const ref = { collectionId: 'teammates', kind: 'bot', id: 'settings:cindy-default/follow-up' };
  const resource = { ref, revision: 'v1', display: { title: 'Follow up' }, links: [],
    blocks: [{ id: 'follow-up', primitive: 'form', fallbackMarkdown: 'Reads task summaries on the teammate computer; uses model allowance.',
      data: { actionId: 'opaque-enable', values: { enabled: false }, invitationAvailable: true, operationActions: { dismiss: 'opaque-dismiss' } } }],
    actions: [{ id: 'opaque-enable', label: 'Follow', fields: [{ id: 'enabled', kind: 'toggle', label: 'Follow' }] }, { id: 'opaque-dismiss', label: 'Not now' }],
  };
  const invoke = vi.fn(async (_device, channel) => channel.endsWith(':get') ? resource : { effects: [] });
  Object.assign(window.electronAPI, { deviceLink: { invoke } });
  render(<RemoteBotFollowUpInvitation deviceId="host-computer" botId="cindy-default" />);
  await screen.findByRole('button', { name: 'bots.autonomy.invitation.start' });
  expect(invoke).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByText(enable ? 'bots.autonomy.invitation.start' : 'bots.autonomy.invitation.notNow'));
  await waitFor(() => expect(screen.queryByRole('region')).toBeNull());
  // The host-owned scope (not this computer's copy) is what the confirmation shows.
  if (enable) expect(m.confirm).toHaveBeenCalledWith(expect.objectContaining({ description: resource.blocks[0].fallbackMarkdown }), expect.any(AbortSignal));
  expect(invoke).toHaveBeenLastCalledWith('host-computer', 'maker:remote-resources:invoke', [expect.objectContaining({
    resourceRef: ref, actionId: enable ? 'opaque-enable' : 'opaque-dismiss', input: enable ? { enabled: true } : {},
  })]);
  // Starting re-reads the Host after confirmation so an expired ticket is renewed; declining uses the shown one.
  expect(invoke.mock.calls.filter(([, channel]) => String(channel).endsWith(':get'))).toHaveLength(enable ? 2 : 1);
  expect(host.setSettings).not.toHaveBeenCalled();
});
