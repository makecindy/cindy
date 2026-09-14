import { describe, expect, it } from 'vitest';

import {
  BOT_MODEL_CHAIN_MAX,
  nextBotModelRoute,
  normalizeBotModelChain,
  primaryBotModelRoute,
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

  it('preserves order, removes duplicate routes, and caps the chain at five', () => {
    const routes = Array.from({ length: BOT_MODEL_CHAIN_MAX + 2 }, (_, index) => ({
      harness: index % 2 === 0 ? 'pi' : 'codex',
      model: `model-${index}`,
      providerId: `provider-${index}`,
      effort: '',
      fastMode: false,
    }));
    routes.splice(2, 0, { ...routes[0]! });

    const normalized = normalizeBotModelChain(routes);

    expect(normalized).toHaveLength(BOT_MODEL_CHAIN_MAX);
    expect(normalized.map((route) => route.model)).toEqual([
      'model-0',
      'model-1',
      'model-2',
      'model-3',
      'model-4',
    ]);
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
