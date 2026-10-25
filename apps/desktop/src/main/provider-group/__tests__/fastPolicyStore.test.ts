import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { providerShareGuestPeer } from '@cindy/device-link';
import { hostSessionIdFor } from '../../remote-agent/host/sessionIdentity.js';

vi.mock('../../logger.js', () => ({ createLogger: () => ({ info() {}, warn() {}, error() {} }) }));
vi.mock('../../appSessionState.js', () => ({
  activeOwnerScopeKey: () => 'test',
  ownerScopedUserDataPath: () => {
    throw Error('unexpected singleton IO');
  },
}));
const { createGroupFastPolicyStore } = await import('../fastPolicyStore.js');
const { createProviderFastPolicyStore } =
  await import('../../maker-host/provider-fast-policy-store.js');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-fast-policy-'));
afterAll(() => fs.rmSync(temporary, { recursive: true, force: true }));
let sequence = 0;
const fixture = () => {
  sequence++;
  const file = path.join(temporary, `${sequence}.json`);
  return { filePath: () => file, scopeKey: () => 'test' };
};
const current = () => {};

describe('durable subscription Fast constraints', () => {
  it('updates actual account keys atomically across instances and survives reload', async () => {
    const config = fixture();
    const a = createProviderFastPolicyStore(config),
      b = createProviderFastPolicyStore(config);
    expect(a.allows('account-a')).toBe(true);
    await Promise.all([a.set('account-a', false, current), b.set('account-b', false, current)]);
    const restored = createProviderFastPolicyStore(config);
    expect(restored.allows('account-a')).toBe(false);
    expect(restored.allows('account-b')).toBe(false);
    expect(restored.allows('account-c')).toBe(true);
    await restored.set('account-a', true, current);
    expect(createProviderFastPolicyStore(config).allows('account-a')).toBe(true);
  });

  it('never interprets unreadable or invalid policy files as permission', async () => {
    for (const contents of ['{broken', '{"providers":null}', '{"providers":[]}']) {
      const config = fixture();
      fs.writeFileSync(config.filePath(), contents);
      const store = createProviderFastPolicyStore(config);
      expect(store.allows('account')).toBe(false);
      await expect(store.set('account', true, current)).rejects.toThrow();
      expect(fs.readFileSync(config.filePath(), 'utf8')).toBe(contents);
    }
  });

  it('binds same-account direct controllers and local hosted tasks without affecting other tasks', async () => {
    const config = fixture(),
      store = createGroupFastPolicyStore(config);
    await store.receive(
      'group-owner',
      {
        group: 'openai',
        revision: 1,
        allowFast: false,
        binding: { sessionId: 'task-1', controllerDeviceId: 'consumer' },
      },
      'executor',
      current,
    );
    expect(store.allows(hostSessionIdFor('consumer', 'task-1'))).toBe(false);
    expect(store.allows('task-1')).toBe(true);
    expect(store.allows(hostSessionIdFor('other', 'task-1'))).toBe(true);
    await store.receive(
      'owner',
      {
        group: 'openai',
        revision: 1,
        allowFast: false,
        binding: { sessionId: 'local-task', controllerDeviceId: 'executor' },
      },
      'executor',
      current,
    );
    expect(store.allows('local-task')).toBe(false);
    expect(createGroupFastPolicyStore(config).allows('local-task')).toBe(false);
  });

  it('cannot bind another share member or the executor owner from a guest command', async () => {
    const store = createGroupFastPolicyStore(fixture());
    const guest = providerShareGuestPeer('share-a', 'member-a', 'owner-device');
    await store.receive(
      guest,
      {
        group: 'openai',
        revision: 1,
        allowFast: false,
        binding: { sessionId: 'task', controllerDeviceId: 'executor' },
      },
      'executor',
      current,
    );
    const constrained = providerShareGuestPeer('share-a', 'member-a', 'executor');
    expect(store.allows(hostSessionIdFor(constrained, 'task'))).toBe(false);
    expect(store.allows('task')).toBe(true);
    expect(
      store.allows(
        hostSessionIdFor(providerShareGuestPeer('share-a', 'member-b', 'executor'), 'task'),
      ),
    ).toBe(true);
  });

  it('keeps relay identities isolated and ignores out-of-order relaxation', async () => {
    const store = createGroupFastPolicyStore(fixture());
    const binding = { sessionId: 'task', relay: 'abcdefghijklmnop' };
    await store.receive(
      'owner',
      { group: 'openai', revision: 4, allowFast: false, binding },
      'executor',
      current,
    );
    const task = hostSessionIdFor('owner\0relay:abcdefghijklmnop', 'task');
    expect(store.allows(task)).toBe(false);
    await store.receive(
      'owner',
      { group: 'openai', revision: 3, allowFast: true },
      'executor',
      current,
    );
    await store.receive(
      'owner',
      { group: 'openai', revision: 4, allowFast: true },
      'executor',
      current,
    );
    expect(store.allows(task)).toBe(false);
    expect(store.allows(hostSessionIdFor('owner', 'task'))).toBe(true);
    await store.receive(
      'owner',
      { group: 'openai', revision: 5, allowFast: true },
      'executor',
      current,
    );
    expect(store.allows(task)).toBe(true);
  });

  it('invalidates acknowledgements on membership changes and rejects stale acknowledgements', async () => {
    const store = createGroupFastPolicyStore(fixture());
    const initial = await store.prepare('group', false, ['one', 'two'], current, true);
    await store.acknowledge('group', 'one', initial.revision, current);
    const changed = await store.prepare('group', false, ['two'], current, true);
    expect(changed.revision).toBeGreaterThan(initial.revision);
    expect(changed.targets.one).toBe(initial.revision);
    await store.acknowledge('group', 'two', initial.revision, current);
    expect(store.outgoing().group.targets.two).toBe(-1);
  });

  it('admits tasks beyond the old 10,000 binding limit without evicting resumable restrictions', async () => {
    const config = fixture();
    const source = JSON.stringify(['owner', 'openai']);
    fs.writeFileSync(
      config.filePath(),
      JSON.stringify({
        sources: { [source]: { revision: 1, allowFast: false } },
        bindings: Object.fromEntries(
          Array.from({ length: 10_000 }, (_, i) => [`old-${i}`, { owner: source }]),
        ),
        outgoing: {},
      }),
    );
    const store = createGroupFastPolicyStore(config);
    await store.receive(
      'owner',
      {
        group: 'openai',
        revision: 1,
        allowFast: false,
        binding: { sessionId: 'new-task', controllerDeviceId: 'executor' },
      },
      'executor',
      current,
    );
    const restored = createGroupFastPolicyStore(config);
    expect(restored.allows('old-0')).toBe(false);
    expect(restored.allows('old-9999')).toBe(false);
    expect(restored.allows('new-task')).toBe(false);
    await restored.receive(
      'owner',
      { group: 'openai', revision: 2, allowFast: true },
      'executor',
      current,
    );
    expect(store.allows('old-0')).toBe(true);
    expect(store.allows('new-task')).toBe(true);
  });

  it('denies an interrupted binding write until its policy source commits, then recovers on retry', async () => {
    const config = fixture();
    const shard = path.join(
      `${config.filePath()}.bindings`,
      `${createHash('sha256').update('new-task').digest('hex').slice(0, 2)}.json`,
    );
    const command = {
      group: 'openai',
      revision: 1,
      allowFast: true,
      binding: { sessionId: 'new-task', controllerDeviceId: 'executor' },
    };
    const store = createGroupFastPolicyStore(config);
    await expect(
      store.receive('owner', command, 'executor', () => {
        if (fs.existsSync(shard)) throw Error('owner changed after binding commit');
      }),
    ).rejects.toThrow('owner changed');
    expect(fs.existsSync(shard)).toBe(true);
    expect(createGroupFastPolicyStore(config).allows('new-task')).toBe(false);
    await store.receive('owner', command, 'executor', current);
    expect(createGroupFastPolicyStore(config).allows('new-task')).toBe(true);
  });

  it('preserves a damaged binding shard and denies instead of treating it as an empty task history', async () => {
    const config = fixture();
    const store = createGroupFastPolicyStore(config);
    const command = {
      group: 'openai',
      revision: 1,
      allowFast: false,
      binding: { sessionId: 'new-task', controllerDeviceId: 'executor' },
    };
    await store.receive('owner', command, 'executor', current);
    const shard = path.join(
      `${config.filePath()}.bindings`,
      fs.readdirSync(`${config.filePath()}.bindings`).find((name) => name.endsWith('.json'))!,
    );
    fs.writeFileSync(shard, '{broken');
    const restored = createGroupFastPolicyStore(config);
    expect(restored.allows('new-task')).toBe(false);
    await expect(restored.receive('owner', command, 'executor', current)).rejects.toThrow();
    expect(fs.readFileSync(shard, 'utf8')).toBe('{broken');
  });

  it('reclaims only permanently purged tasks and retains other tasks and revision tombstones', async () => {
    const config = fixture();
    const source = JSON.stringify(['owner', 'openai']);
    fs.writeFileSync(
      config.filePath(),
      JSON.stringify({
        sources: { [source]: { revision: 3, allowFast: false } },
        bindings: { legacy: { owner: source } },
        outgoing: {},
      }),
    );
    const store = createGroupFastPolicyStore(config);
    for (const sessionId of ['purged', 'retained'])
      await store.receive(
        'owner',
        {
          group: 'openai',
          revision: 3,
          allowFast: false,
          binding: { sessionId, controllerDeviceId: 'executor' },
        },
        'executor',
        current,
      );
    await store.forgetSessions(['legacy', 'purged'], current);
    const restored = createGroupFastPolicyStore(config);
    expect(restored.allows('legacy')).toBe(true);
    expect(restored.allows('purged')).toBe(true);
    expect(restored.allows('retained')).toBe(false);
    await restored.receive(
      'owner',
      { group: 'openai', revision: 2, allowFast: true },
      'executor',
      current,
    );
    expect(restored.allows('retained')).toBe(false);
  });

  it('preserves concurrent bindings in the same shard across store instances', async () => {
    const config = fixture();
    const first = 'collision-0';
    const prefix = (id: string) => createHash('sha256').update(id).digest('hex').slice(0, 2);
    let second = '';
    for (let i = 1; !second; i++)
      if (prefix(`collision-${i}`) === prefix(first)) second = `collision-${i}`;
    const a = createGroupFastPolicyStore(config),
      b = createGroupFastPolicyStore(config);
    await Promise.all(
      [a, b].map((store, i) =>
        store.receive(
          `owner-${i}`,
          {
            group: 'openai',
            revision: 1,
            allowFast: false,
            binding: { sessionId: i === 0 ? first : second, controllerDeviceId: 'executor' },
          },
          'executor',
          current,
        ),
      ),
    );
    const restored = createGroupFastPolicyStore(config);
    expect(restored.allows(first)).toBe(false);
    expect(restored.allows(second)).toBe(false);
  });

  it('does not write across an account boundary', async () => {
    const config = fixture(),
      store = createProviderFastPolicyStore(config);
    await expect(
      store.set('account', false, () => {
        throw Error('owner changed');
      }),
    ).rejects.toThrow('owner changed');
    expect(fs.existsSync(config.filePath())).toBe(false);
  });
});
