import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeishuIM, IMMessageEvent } from '@cindy/im';
import type { BotImConnectionRecord } from '../../../../shared/botImConnection';

// Production entry: owner control handler and route callback. Protect explicit
// sharing, identity/history isolation and account/app fences. Existing transport
// tests do not exercise commands. Minimal input: one dedicated connection and
// /share on, then /bot; unit with injected in-memory storage/DB boundaries.
const h = vi.hoisted(() => ({
  record: null as BotImConnectionRecord | null,
  owner: 'account-a', appId: 'cli_a', openId: 'ou_a', connected: true,
  profiles: [{ id: 'a', name: 'Alpha', status: 'active' }, { id: 'b', name: 'Beta', status: 'active' }],
  detach: vi.fn(async () => {}), send: vi.fn(async () => ({ messageId: 'test' })),
}));
vi.mock('../../../appSessionState', () => ({ activeOwnerScopeKey: () => h.owner, isAppSessionBoundaryPending: () => false }));
vi.mock('../../../i18n', () => ({ t: (key: string) => key.split('.').at(-1) + ':' }));
vi.mock('../../binding', () => ({ bindingStore: { detach: h.detach } }));
vi.mock('../../shared/controlState', () => ({ isInControl: () => false }));
vi.mock('../../shared/botImConnectionStore', () => ({
  readBotImConnection: () => h.record,
  listBotImConnections: () => h.record ? [h.record] : [],
  updateBotImConnectionRecord: async (_id: string, patch: object, assertCurrent?: () => void) => {
    assertCurrent?.(); h.record = { ...h.record!, ...patch }; return h.record;
  },
}));
vi.mock('../../../localDb/schema', () => ({ botProfiles: {}, botSessionLinks: {} }));
vi.mock('drizzle-orm', () => ({ eq: () => ({}) }));
vi.mock('../../../localDb/client/current', () => {
  const snapshot = { client: { drizzle: { select: () => ({ from: () => Promise.resolve(h.profiles) }) } } };
  return { getCurrentDbClientSnapshot: () => snapshot };
});
import { createSharedFeishuControls } from '../sharedConnection';

const im = {
  getBotAppId: () => h.appId, getOwnerOpenId: () => h.openId,
  getStatus: () => ({ kind: h.connected ? 'connected' : 'offline', appId: h.appId }),
  sendText: h.send,
} as unknown as FeishuIM;
const controls = createSharedFeishuControls('aaaaaaaaaaaa', im);
const event = (text: string, extra: Partial<IMMessageEvent> = {}): IMMessageEvent => ({
  contextId: 'cli_a', senderId: 'ou_a', chatId: 'oc_a', text, messageId: 'om_test',
  attachments: [], unsupported: [], ...extra,
} as IMMessageEvent);

beforeEach(() => {
  h.record = { id: 'aaaaaaaaaaaa', botId: 'a', channel: 'feishu', botContextId: 'cli_a', createdAt: 0 };
  h.owner = 'account-a'; h.appId = 'cli_a'; h.openId = 'ou_a'; h.connected = true;
  h.profiles = [{ id: 'a', name: 'Alpha', status: 'active' }, { id: 'b', name: 'Beta', status: 'active' }];
  h.send.mockClear(); h.detach.mockReset().mockResolvedValue(undefined);
});

describe('Feishu shared owner controls', () => {
  it('resolves real descriptor names by unique short name, full name and exact ID in that order of specificity', async () => {
    h.profiles = [{ id: 'a', name: '五条@韩服|对账|公告', status: 'active' }, { id: 'b', name: '真人@wiki', status: 'active' }];
    await controls.handleControlMessage(event('/share on'));
    for (const [arg, expected] of [['五条', 'a'], ['真人', 'b'], ['五条@韩服|对账|公告', 'a'], ['b', 'b']]) {
      await controls.handleControlMessage(event(`/bot ${arg}`));
      expect(controls.readBinding('cli_a', 'ou_a')).toBe(expected);
    }
    h.profiles.push({ id: 'c', name: '五条@其他工作', status: 'active' });
    await controls.handleControlMessage(event('/bot 五条'));
    expect(controls.readBinding('cli_a', 'ou_a')).toBe('b');
    expect(h.send).toHaveBeenLastCalledWith('ou_a', expect.stringContaining('五条@韩服|对账|公告: /bot a'));
    expect(h.send).toHaveBeenLastCalledWith('ou_a', expect.stringContaining('五条@其他工作: /bot c'));
    h.profiles.push({ id: 'd', name: '五条', status: 'active' });
    await controls.handleControlMessage(event('/bot 五条'));
    expect(controls.readBinding('cli_a', 'ou_a')).toBe('d'); // exact full name beats short aliases
    h.profiles.push({ id: 'e', name: 'a', status: 'active' });
    await controls.handleControlMessage(event('/bot a'));
    expect(controls.readBinding('cli_a', 'ou_a')).toBe('a'); // ID beats another profile's name
    await controls.handleControlMessage(event('/bot 五'));
    expect(controls.readBinding('cli_a', 'ou_a')).toBe('a'); // no arbitrary prefix guessing
  });
  it('keeps legacy dedicated routing, defaults shared DMs to Cindy, and restores the original binding', async () => {
    expect(controls.readBinding('cli_a', 'ou_a')).toBe('a');
    await controls.handleControlMessage(event('/share on'));
    expect(controls.readBinding('cli_a', 'ou_a')).toBe('cindy-default');
    expect(controls.readBinding('cli_a', 'g/group')).toBe('a');
    expect(controls.readBinding('cli_a', 'ou_guest')).toBe('a');
    await controls.handleControlMessage(event('/share off'));
    expect(controls.readBinding('cli_a', 'ou_a')).toBe('a');
  });

  it('lists explicit IDs and switches between two canonical identities and back to Cindy', async () => {
    await controls.handleControlMessage(event('/share on'));
    await controls.handleControlMessage(event('/bot'));
    expect(h.send).toHaveBeenLastCalledWith('ou_a', expect.stringContaining('/bot b'));
    for (const [arg, expected] of [['Beta', 'b'], ['a', 'a'], ['cindy', 'cindy-default']]) {
      await controls.handleControlMessage(event(`/bot ${arg}`));
      expect(controls.readBinding('cli_a', 'ou_a')).toBe(expected);
    }
    expect(h.record?.botId).toBe('a'); // no identity reassignment or history rewrite
    expect(h.detach).toHaveBeenCalledWith({ channel: 'feishu', botContextId: 'cli_a', userId: 'ou_a' });
  });

  it('rejects unknown, duplicate and inactive names without changing the selection', async () => {
    await controls.handleControlMessage(event('/share on'));
    h.profiles[1].name = 'Alpha';
    for (const arg of ['missing', 'Alpha']) {
      await controls.handleControlMessage(event(`/bot ${arg}`));
      expect(h.send).toHaveBeenLastCalledWith('ou_a', expect.stringMatching(/^unknown:/));
      expect(controls.readBinding('cli_a', 'ou_a')).toBe('cindy-default');
    }
    h.profiles[0].status = 'paused';
    await controls.handleControlMessage(event('/bot a'));
    expect(controls.readBinding('cli_a', 'ou_a')).toBe('cindy-default');
  });

  it('never treats guests, groups, quoted commands or attachments as owner control commands', async () => {
    for (const extra of [
      { senderId: 'ou_guest' }, { senderId: 'g/group', speaker: { id: 'ou_a', isOwner: true } },
      { replyThread: { rootMessageId: 'om_other' } }, { attachments: [{}] },
    ]) {
      expect(await controls.handleControlMessage(event('/share on', extra as Partial<IMMessageEvent>))).toBe(false);
      expect(h.record?.sharedFeishu).toBeUndefined();
    }
  });

  it('preserves selection across re-creation and refuses a different app or owner', async () => {
    await controls.handleControlMessage(event('/share on'));
    await controls.handleControlMessage(event('/bot b'));
    const restarted = createSharedFeishuControls('aaaaaaaaaaaa', im);
    expect(restarted.readBinding('cli_a', 'ou_a')).toBe('b');
    h.appId = 'cli_other';
    expect(() => restarted.readBinding('cli_other', 'ou_a')).toThrow('shared owner changed');
    h.appId = 'cli_a'; h.openId = 'ou_other';
    expect(() => restarted.readBinding('cli_a', 'ou_other')).toThrow('shared owner changed');
  });

  it('cannot commit a selection after the account changes while detaching a previous takeover', async () => {
    await controls.handleControlMessage(event('/share on'));
    h.detach.mockImplementationOnce(async () => { h.owner = 'account-b'; });
    await expect(controls.handleControlMessage(event('/bot b'))).rejects.toThrow('Feishu account changed');
    expect(h.record?.sharedFeishu?.selectedBotId).toBeNull();
  });
});
