import { describe, expect, it } from 'vitest';

import { ghostSetupNavigationForAction } from '../ghostSetupNavigation';

describe('ghostSetupNavigationForAction', () => {
  it('binds plugin settings and connection routes to the waiter ghost id', () => {
    expect(
      ghostSetupNavigationForAction('trusted-gmail', {
        id: 'open_plugin_settings:secret:attacker-id',
        kind: 'open_plugin_settings',
      }),
    ).toEqual({ target: 'plugin_settings', ghostId: 'trusted-gmail' });
    expect(
      ghostSetupNavigationForAction('trusted-gmail', {
        id: 'manage_connection:connection:github',
        kind: 'manage_connection',
      }),
    ).toEqual({ target: 'plugin_settings', ghostId: 'trusted-gmail' });
  });

  it('keeps client settings on the fixed providers tab', () => {
    expect(
      ghostSetupNavigationForAction('cindy-art', {
        id: 'open_client_settings:client_config:image-provider',
        kind: 'open_client_settings',
      }),
    ).toEqual({ target: 'client_settings' });
  });
});
