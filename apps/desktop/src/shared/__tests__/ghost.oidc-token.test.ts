import { describe, expect, it } from 'vitest';

import { ghostPermissionItems, validateGhostManifest } from '../ghost.js';

function manifest(secret: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    schemaVersion: 2,
    id: 'plugin-a',
    name: 'Plugin A',
    version: '1.0.0',
    entry: 'main.js',
    slots: ['tool', 'network'],
    tools: [{ name: 'whoami_a', description: 'Show the current enterprise identity' }],
    network: {
      hosts: ['service-a.x.test', 'other.x.test'],
      secrets: [
        {
          key: 'cindy_identity',
          label: 'Cindy Enterprise Identity',
          source: 'oidc-token',
          inject: {
            header: 'Authorization',
            format: 'Bearer {value}',
            hosts: ['service-a.x.test'],
          },
          ...secret,
        },
      ],
    },
    ...extra,
  };
}

describe('ghost manifest oidc-token source', () => {
  it('accepts the fixed Host-managed form without settingsHtml', () => {
    const result = validateGhostManifest(manifest({}));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.network?.secrets?.[0]).toMatchObject({
      source: 'oidc-token',
      inject: {
        header: 'Authorization',
        format: 'Bearer {value}',
        hosts: ['service-a.x.test'],
      },
    });
    expect(ghostPermissionItems(result.manifest)).toContainEqual(
      expect.objectContaining({
        key: 'network:secret:cindy_identity:oidc-token',
        labelKey: 'networkSecretOrganizationIdentity',
      }),
    );
  });

  it.each([
    [{ inject: { header: 'Authorization', format: 'Bearer {value}' } }, 'inject.hosts'],
    [{ inject: { header: 'Authorization', format: 'Bearer {value}', hosts: [] } }, 'inject.hosts'],
    [{ inject: { header: 'X-Identity', format: 'Bearer {value}', hosts: ['service-a.x.test'] } }, 'Authorization'],
    [{ inject: { header: 'Authorization', format: '{value}', hosts: ['service-a.x.test'] } }, 'Bearer'],
    [{ url: 'https://service-a.x.test/settings' }, 'url'],
    [{ input: 'ghost' }, 'input'],
    [
      {
        exchange: {
          url: 'https://service-a.x.test/token',
          bodyFormat: '{"token":"{value}"}',
          tokenPath: 'token',
        },
      },
      'exchange',
    ],
    [
      {
        oauth: {
          authorizeUrl: 'https://service-a.x.test/authorize',
          tokenUrl: 'https://service-a.x.test/token',
        },
      },
      'oauth',
    ],
  ])('rejects an unsafe or ambiguous declaration', (secret, reason) => {
    const result = validateGhostManifest(manifest(secret));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain(reason);
  });

  it('rejects setup references because there is no user configuration action', () => {
    const result = validateGhostManifest(
      manifest({}, { setup: { requires: [{ anyOf: ['secret:cindy_identity'] }] } }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('oidc-token');
  });

  it('rejects wildcard injection hosts for Connection JWTs', () => {
    const raw = manifest({}) as ReturnType<typeof manifest> & {
      network: {
        hosts: string[];
        secrets: Array<{ inject: { hosts: string[] } }>;
      };
    };
    raw.network.hosts = ['*.x.test'];
    raw.network.secrets[0]!.inject.hosts = ['*.x.test'];

    const result = validateGhostManifest(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('不允许通配');
  });
});
