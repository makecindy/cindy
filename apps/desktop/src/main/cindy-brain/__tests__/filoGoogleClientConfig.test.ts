import { describe, expect, it } from 'vitest';

import type { GhostManifest } from '../../../shared/ghost.js';
import { withFiloGoogleBuildClientConfig } from '../filoGoogleClientConfig.js';

function manifest(oauth: Record<string, unknown> = {}): GhostManifest {
  return {
    schemaVersion: 2,
    id: 'filo-google',
    name: 'Filo Google',
    version: '1.0.0',
    kind: 'chip',
    entry: 'main.js',
    network: {
      hosts: ['accounts.google.com'],
      secrets: [{
        key: 'google_account',
        label: 'Google 账号',
        source: 'oauth',
        inject: { header: 'Authorization', format: 'Bearer {value}' },
        oauth: {
          authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
          tokenUrl: 'https://oauth2.googleapis.com/token',
          ...oauth,
        },
      }],
    },
  };
}

describe('withFiloGoogleBuildClientConfig', () => {
  it('does not inject build-env OAuth client based on the filo-google name', () => {
    const source = manifest();
    const hydrated = withFiloGoogleBuildClientConfig(source, {
      clientId: ' build-client ',
      clientSecret: ' build-secret ',
    });
    expect(hydrated).toBe(source);
    expect(source.network?.secrets?.[0]?.oauth?.clientId).toBeUndefined();
  });

  it('returns the original manifest for any id', () => {
    const source = manifest();
    expect(withFiloGoogleBuildClientConfig(source, {})).toBe(source);
    const other = { ...source, id: 'other' };
    expect(withFiloGoogleBuildClientConfig(other, { clientId: 'x' })).toBe(other);
  });

  it('does not rewrite a manifest that already has a client', () => {
    const source = manifest({ clientId: 'old-client', clientSecret: 'old-secret' });
    const hydrated = withFiloGoogleBuildClientConfig(source, { clientId: 'new-client' });
    expect(hydrated).toBe(source);
    expect(hydrated.network?.secrets?.[0]?.oauth?.clientId).toBe('old-client');
    expect(hydrated.network?.secrets?.[0]?.oauth?.clientSecret).toBe('old-secret');
  });
});
