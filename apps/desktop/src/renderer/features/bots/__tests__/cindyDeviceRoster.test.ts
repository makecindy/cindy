import { describe, expect, it } from 'vitest';
import { cindyDeviceOptions, isCindyDeviceBot } from '../cindyDeviceRoster';
import type { BotProfile } from '../botStore';
import type { RemoteBot } from '../remoteBotRoster';

const local = { id: 'local', name: 'Renamed', templateId: 'cindy', status: 'active' } as BotProfile;
const remote = (deviceId: string, extra = {}): RemoteBot => ({
  id: 'cindy-default',
  name: 'Remote renamed',
  deviceId,
  deviceName: 'Mac',
  avatar: '',
  avatarColor: '',
  description: '',
  preview: '',
  activityAt: 0,
  sessionId: 'chat',
  online: true,
  ...extra,
});

describe('Cindy device roster', () => {
  it('uses durable identity rather than a matching name or avatar', () => {
    expect(isCindyDeviceBot(local)).toBe(true);
    expect(isCindyDeviceBot(remote('remote'))).toBe(true);
    expect(isCindyDeviceBot({ id: 'custom' })).toBe(false);
    const options = cindyDeviceOptions(
      [local],
      [remote('remote', { id: 'custom', name: 'Cindy' })],
      [],
      {},
      'Local',
    );
    expect(options.map((option) => option.bot.id)).toEqual(['local']);
  });

  it('keeps local first, disambiguates hosts, and preserves device-specific unread and routes', () => {
    const options = cindyDeviceOptions(
      [local],
      [remote('b'), remote('a', { lastReplyAt: 2, readAt: 1, online: false })],
      [],
      { local: 3 },
      'Local',
    );
    expect(options.map((option) => option.label)).toEqual(['Local', 'Mac (1)', 'Mac (2)']);
    expect(options[0]).toMatchObject({ route: '/bots/local', unread: true, unreadCount: 3 });
    expect(options[1]).toMatchObject({
      route: '/bots/remote/a/cindy-default',
      unread: true,
      online: false,
    });
    expect(options[2].unread).toBe(false);
  });

  it('does not append internal IDs because another non-selectable device has the same name', () => {
    const deviceId = 'dev-dev-3b2cd2a6aacf5d709d5c522cfcf432cd8536c74b45b3b243b5f3972b';
    const options = cindyDeviceOptions([local], [remote(deviceId, { deviceName: 'MagicLizi' })], [
      { deviceId: 'self', name: 'MagicLizi', isSelf: true },
      { deviceId: 'unrelated', name: 'MagicLizi' },
    ], {}, 'Local');
    expect(options[1].label).toBe('MagicLizi');
    expect(options[1].route).toBe(`/bots/remote/${deviceId}/cindy-default`);
  });

  it('keeps duplicate device labels short and stable when the roster order changes', () => {
    const peers = [remote('dev-aaaaaaaaaaaaaaaa', { deviceName: 'MagicLizi' }), remote('dev-bbbbbbbbbbbbbbbb', { deviceName: 'MagicLizi' })];
    const options = cindyDeviceOptions([local], peers, [], {}, 'Local');
    const reordered = cindyDeviceOptions([local], [...peers].reverse(), [], {}, 'Local');
    expect(options.map(option => option.label)).toEqual(['Local', 'MagicLizi (1)', 'MagicLizi (2)']);
    expect(reordered).toEqual(options);
  });

  it.each([{ status: 'archived' }, { status: 'deleting' }, { hiddenAt: 1 }])(
    'keeps unavailable local profiles out of the device menu: %j',
    (extra) => {
      expect(
        cindyDeviceOptions([{ ...local, ...extra } as BotProfile], [], [], {}, 'Local'),
      ).toEqual([]);
    },
  );

  it('escapes routes and keeps unnamed devices selectable', () => {
    const [option] = cindyDeviceOptions(
      [],
      [remote('host/name', { deviceName: ' ' })],
      [],
      {},
      'Local',
    );
    expect(option.label).toBe('host/name');
    expect(option.route).toBe('/bots/remote/host%2Fname/cindy-default');
  });
});
