import { expect, it, vi } from 'vitest';
import { parsePluginConfigurationSummary, parsePluginUsageSummary } from '@cindy/device-link';
import type { GhostManifest, GhostSetupAssessment } from '../../../shared/ghost.js';
import { mobilePluginConfiguration } from '../mobilePluginConfiguration.js';
import { mobilePluginUsage } from '../mobilePluginUsage.js';
import type { GhostSetupProbes } from '../ghostSetupStatus.js';
const manifest = {
  id: 'demo-config',
  name: 'Demo config',
  version: '1',
  settingsHtml: 'settings.html',
  network: {
    secrets: [
      {
        key: 'api_key',
        label: 'Service API key',
        hint: 'From the service console',
        inject: { header: 'Authorization', template: 'Bearer {value}' },
      },
      {
        key: 'account',
        label: 'Calendar account',
        source: 'oauth',
        oauth: {},
        inject: { header: 'Authorization', template: 'Bearer {value}' },
      },
    ],
    connections: [{ key: 'instances', label: 'GitLab instances' }],
  },
  setup: { requires: [] },
} as unknown as GhostManifest;
const probes = (): GhostSetupProbes => ({
  secretSaved: () => true,
  oauthStatus: () => ({ clientConfigured: true, connected: 2, expired: 1 }),
  connectionCount: () => 2,
  kvValue: () => undefined,
});
it('includes optional declarations omitted from the use gate and only projects status/counts', () => {
  const value = mobilePluginConfiguration(manifest, probes());
  expect(value.items).toEqual([
    {
      id: 'secret:api_key',
      label: 'Service API key',
      hint: 'From the service console',
      kind: 'secret',
      state: 'configured',
    },
    {
      id: 'secret:account',
      label: 'Calendar account',
      kind: 'oauth',
      state: 'configured',
      count: 2,
      expiredCount: 1,
    },
    {
      id: 'connection:instances',
      label: 'GitLab instances',
      kind: 'connection',
      state: 'configured',
      count: 2,
    },
  ]);
  expect(value.alternatives).toEqual([]);
  expect(parsePluginConfigurationSummary(value)).toEqual(value);
  expect(JSON.stringify(value)).not.toContain('Bearer');
});
it('reports individual missing/expired/unknown facts without fabricating configured status', () => {
  expect(
    mobilePluginConfiguration(manifest, {
      ...probes(),
      secretSaved: () => false,
      oauthStatus: () => ({ clientConfigured: true, connected: 0, expired: 1 }),
      connectionCount: () => 0,
    }).items.map((item) => item.state),
  ).toEqual(['missing', 'expired', 'missing']);
  const throwing = () => {
    throw new Error('read failed');
  };
  expect(
    mobilePluginConfiguration(manifest, {
      secretSaved: throwing,
      oauthStatus: throwing,
      connectionCount: throwing,
      kvValue: throwing,
    }).items.map((item) => item.state),
  ).toEqual(['unknown', 'unknown', 'unknown']);
  expect(mobilePluginConfiguration(manifest).items.map((item) => item.state)).toEqual([
    'unknown',
    'unknown',
    'unknown',
  ]);
});
it('does not probe derived identity as a user-entered key', () => {
  const p = probes(),
    secretSaved = vi.fn(p.secretSaved);
  const value = mobilePluginConfiguration(
    {
      ...manifest,
      network: { hosts: [], secrets: [{ ...manifest.network!.secrets![0], source: 'oidc-token' }] },
    },
    { ...p, secretSaved },
  );
  expect(value.items[0]).toMatchObject({ kind: 'managed', state: 'managed' });
  expect(secretSaved).not.toHaveBeenCalled();
});
it('preserves any-of relationships and false/zero parameter existence without exporting values', () => {
  const m = {
    ...manifest,
    setup: {
      requires: [
        {
          anyOf: [
            { kind: 'secret' as const, key: 'api_key' },
            { kind: 'secret' as const, key: 'account' },
          ],
        },
        { anyOf: [{ kind: 'kv' as const, key: 'notify', label: 'Notifications' }] },
        { anyOf: [{ kind: 'kv' as const, key: 'limit', label: 'Limit' }] },
      ],
    },
  };
  const assessment = {
    state: 'ready',
    revision: 1,
    groups: [
      {
        id: 'either',
        mode: 'any_of',
        items: [
          {
            ref: 'secret:api_key',
            kind: 'secret',
            label: 'API key',
            state: 'satisfied',
            actions: [],
          },
          { ref: 'secret:account', kind: 'oauth', label: 'Account', state: 'missing', actions: [] },
        ],
      },
    ],
  } as GhostSetupAssessment;
  const value = mobilePluginConfiguration(
    m,
    { ...probes(), kvValue: (key) => (key === 'notify' ? false : 0) },
    assessment,
  );
  expect(value.alternatives).toEqual([['secret:api_key', 'secret:account']]);
  expect(value.items.filter((item) => item.kind === 'parameter')).toEqual([
    { id: 'kv:notify', kind: 'parameter', label: 'Notifications', state: 'configured' },
    { id: 'kv:limit', kind: 'parameter', label: 'Limit', state: 'configured' },
  ]);
  expect(value.items.every((item) => !('value' in item))).toBe(true);
});
it('validates the additive config summary without copying arbitrary remote fields', () => {
  const value = mobilePluginConfiguration(manifest, probes());
  expect(
    parsePluginConfigurationSummary({
      ...value,
      items: [{ ...value.items[0], value: 'must-not-copy' }],
    }),
  ).toEqual({ items: [value.items[0]], alternatives: [] });
  expect(
    parsePluginConfigurationSummary({ ...value, items: [{ ...value.items[0], count: -1 }] }),
  ).toBeNull();
  expect(
    parsePluginConfigurationSummary({ ...value, alternatives: [['secret:api_key', 'unknown']] }),
  ).toBeNull();
  const usage = mobilePluginUsage(
    { manifest, approval: { state: 'approved' } } as any,
    undefined,
    undefined,
    value,
  );
  expect(parsePluginUsageSummary(usage)?.configuration).toEqual(value);
  expect(parsePluginUsageSummary({ ...usage, configuration: { items: 'bad' } })).toBeNull();
});
