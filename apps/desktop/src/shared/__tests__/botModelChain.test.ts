import { serializeModelRoutes } from '@cindy/maker-shared/model-route';
import { describe, expect, it } from 'vitest';

import {
  BOT_MODEL_CHAIN_MAX,
  nextBotModelRoute,
  normalizeBotModelChain,
  normalizeBotProfileModelChain,
  primaryBotModelRoute,
  selectBotFallbackRoute,
  type BotModelRoute,
} from '../botModelChain';

describe('Bot model chain', () => {
  it('keeps a legacy single-model Bot as a one-route chain', () => {
    expect(
      normalizeBotModelChain(undefined, {
        harness: 'pi',
        model: 'z-ai/glm-5.3-flash',
        providerId: 'xd',
        effort: 'medium',
        fastMode: true,
      }),
    ).toEqual([
      {
        harness: 'pi',
        model: 'z-ai/glm-5.3-flash',
        providerId: 'xd',
        effort: 'medium',
        fastMode: true,
      },
    ]);
  });

  // 2026-11-26 user decision: a buddy uses one model (or one smart route); backup models are gone. Older peers may still
  // send up to five routes: the first valid one is kept.
  it('keeps only the first route of an older multi-route chain', () => {
    const routes = Array.from({ length: 7 }, (_, index) => ({
      harness: index % 2 === 0 ? 'pi' : 'codex',
      model: `model-${index}`,
      providerId: `provider-${index}`,
      effort: '',
      fastMode: false,
    }));
    routes.splice(2, 0, { ...routes[0]! });

    const normalized = normalizeBotModelChain(routes);

    expect(BOT_MODEL_CHAIN_MAX).toBe(1);
    expect(normalized.map((route) => route.model)).toEqual(['model-0']);
  });

  it('drops invalid entries without replacing a valid ordered chain from legacy fields', () => {
    expect(
      normalizeBotModelChain(
        [null, { harness: 'pi', model: '  ' }, { harness: 'pi', model: 'good' }],
        { harness: 'claude', model: 'legacy' },
      ),
    ).toEqual([
      {
        harness: 'pi',
        model: 'good',
        providerId: null,
        effort: '',
        fastMode: false,
      },
    ]);
  });

  it('uses the first complete route as the runtime primary', () => {
    expect(
      primaryBotModelRoute([
        { harness: 'codex', model: 'first', providerId: 'a' },
        { harness: 'pi', model: 'second', providerId: 'b' },
      ]),
    ).toMatchObject({ harness: 'codex', model: 'first', providerId: 'a' });
  });

  it('falls through in configured order and skips a route already proven bad', () => {
    const chain = [
      { harness: 'pi', model: 'primary', providerId: 'xd' },
      { harness: 'codex', model: 'fallback-1', providerId: 'openai' },
      { harness: 'claude', model: 'fallback-2', providerId: null },
    ];
    expect(
      nextBotModelRoute(
        chain,
        { harness: 'pi', model: 'primary', providerId: null },
        ['codex\u0000openai\u0000fallback-1'],
      ),
    ).toMatchObject({ harness: 'claude', model: 'fallback-2' });
  });

  // Unit, #13206: ordered fallback after a pool merge; previous cases only skipped visited routes.
  it('skips a merged local account as a new fallback and retains explicit runnable routes', () => {
    const [primary, old, backup] = normalizeBotModelChain([
      { harness: 'claude', model: 'opus', providerId: 'anthropic' },
      { harness: 'claude', model: 'opus', providerId: 'subscription-a' },
      { harness: 'codex', model: 'gpt', providerId: 'openai' },
    ]) as [BotModelRoute, BotModelRoute, BotModelRoute];
    const merged = (id: string) => id === old.providerId ? 'account-a' : undefined;
    const select = (routes: BotModelRoute[], host?: string) =>
      selectBotFallbackRoute([primary, ...routes], primary, [], host, merged);
    expect(select([old, backup])).toEqual({ route: backup, routeLocked: false });
    expect(select([old])).toEqual({ route: null, routeLocked: true });
    expect(selectBotFallbackRoute([primary, old], primary, [], null, () => undefined).route).toEqual(old);
    const deviceRoute = { ...old, agentDeviceId: 'device-b' };
    expect(select([deviceRoute]).route).toEqual(deviceRoute);
    expect(select([old], 'ssh-host').route).toEqual(old);
  });

  it('treats the harness as part of the route identity', () => {
    const chain = [
      { harness: 'claude', model: 'shared', providerId: 'xd' },
      { harness: 'pi', model: 'shared', providerId: 'xd' },
      { harness: 'codex', model: 'last', providerId: 'openai' },
    ];
    expect(
      nextBotModelRoute(
        chain,
        { harness: 'claude', model: 'shared', providerId: 'xd' },
        ['claude-code\u0000xd\u0000shared'],
      ),
    ).toMatchObject({ harness: 'pi', model: 'shared', providerId: 'xd' });
  });

  it('locates the exact provider before an implicit same-model route', () => {
    const chain = [
      { harness: 'pi', model: 'shared', providerId: null },
      { harness: 'pi', model: 'shared', providerId: 'xd' },
      { harness: 'codex', model: 'last', providerId: 'openai' },
    ];
    expect(
      nextBotModelRoute(
        chain,
        { harness: 'pi', model: 'shared', providerId: 'xd' },
      ),
    ).toMatchObject({ harness: 'codex', model: 'last' });
  });

  it('skips an unusable harness without stopping later provider fallback', () => {
    const chain = [
      { harness: 'pi', model: 'primary', providerId: 'xd' },
      { harness: 'codex', model: 'remote-incompatible', providerId: 'openai' },
      { harness: 'pi', model: 'remote-safe', providerId: 'other' },
    ];
    expect(
      nextBotModelRoute(
        chain,
        { harness: 'pi', model: 'primary', providerId: 'xd' },
        [],
        (route) => route.harness === 'pi',
      ),
    ).toMatchObject({ harness: 'pi', model: 'remote-safe' });
  });

  it('stops after the last configured route instead of guessing from the catalog', () => {
    expect(
      nextBotModelRoute(
        [{ harness: 'pi', model: 'only', providerId: 'xd' }],
        { harness: 'pi', model: 'only', providerId: 'xd' },
      ),
    ).toBeNull();
  });
});

// Regression: shared/local accounts used to collapse to the same candidate and lose their location.
it('preserves locations through persistence and ordered fallback', () => {
  const local = { harness: 'codex' as const, model: 'same-model', providerId: 'openai', effort: 'medium', fastMode: false };
  const shared = { ...local, agentDeviceId: 'share:one' };
  const other = { ...local, agentDeviceId: 'device-two' };
  for (const route of [shared, local, other]) expect(normalizeBotModelChain(JSON.parse(JSON.stringify([route])))).toEqual([route]);
  // A smart route expands into routes at several locations; failover walks them in order.
  const chain = [shared, local, other];
  expect(nextBotModelRoute(chain, shared)).toEqual(local);
  expect(nextBotModelRoute(chain, local)).toEqual(other);
  expect(nextBotModelRoute(chain, other)).toBeNull();
});

// Unit regression: chain-only coverage missed a stale top-level location after returning home.
it('mirrors the primary location on save and clears it when only the fallback is remote', () => {
  const local = { harness: 'codex' as const, model: 'same-model', providerId: 'openai', effort: '', fastMode: false };
  const remote = { ...local, agentDeviceId: 'share:one' };
  const saved = normalizeBotProfileModelChain({ modelChain: [remote, local] });
  expect(saved.agentDeviceId).toBe('share:one');
  const restored = normalizeBotProfileModelChain({ ...saved, modelChain: [local, remote] });
  expect(restored.agentDeviceId).toBeNull();
  expect(normalizeBotModelChain(JSON.parse(JSON.stringify(restored)).modelChain)).toEqual([local]);
});

it('round trips remote forms without exposing a same-named local source to older peers', () => {
  const route = { harness: 'codex' as const, model: 'same-model', providerId: 'openai', effort: '', fastMode: false, agentDeviceId: 'share:one' };
  const wire = JSON.parse(serializeModelRoutes([route]));
  expect(wire[0].providerId).not.toBe('openai');
  delete wire[0].agentDeviceId; // old editors keep providerId but strip unknown fields
  expect(normalizeBotModelChain(wire)).toEqual([route]);
});

// Companion settings round-trip local, remote and shared plugin routes without losing location; damaged sources are dropped.
it('round-trips host, remote and shared plugin models and rejects damaged sources', () => {
  const plugin = { harness: 'acp' as const, model: 'sample-model', providerId: 'acp-plugin:sample:engine', effort: 'high', fastMode: false };
  const remotePlugin = { ...plugin, agentDeviceId: 'other-device' };
  const sharedPlugin = { ...plugin, agentDeviceId: 'share:friend' };
  const fallback = { harness: 'pi' as const, model: 'other', providerId: 'source', effort: '', fastMode: false };
  const wire = JSON.parse(serializeModelRoutes([plugin, remotePlugin, sharedPlugin, fallback]));
  expect(wire[1].providerId).not.toBe(plugin.providerId);
  expect(wire[2].providerId).not.toBe(plugin.providerId);
  expect(wire.map((route: unknown) => normalizeBotModelChain([route])[0])).toEqual([plugin, remotePlugin, sharedPlugin, fallback]);
  expect(nextBotModelRoute(wire, plugin)).toEqual(remotePlugin);
  expect(nextBotModelRoute(wire, remotePlugin)).toEqual(sharedPlugin);
  expect(nextBotModelRoute(wire, sharedPlugin)).toEqual(fallback);
  expect(normalizeBotModelChain([
    { ...plugin, harness: 'claude' }, { ...plugin, providerId: 'source' },
  ])).toEqual([]);
});
