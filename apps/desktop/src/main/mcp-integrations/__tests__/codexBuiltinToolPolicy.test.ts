import { describe, expect, it } from 'vitest';

import {
  CODEX_ALLOWED_BUILTIN_PLUGIN_IDS_KEY,
  CODEX_DISABLED_BUILTIN_PLUGIN_IDS_KEY,
  isFrozenBuiltinPluginAllowed,
} from '../codexBuiltinToolPolicy.js';

describe('frozen built-in tool policy', () => {
  it('blocks stable collab and iOS gateways when the Bot Profile disables them', () => {
    const vendorOptions = {
      [CODEX_DISABLED_BUILTIN_PLUGIN_IDS_KEY]: ['collab', 'ios-simulator'],
    };
    expect(isFrozenBuiltinPluginAllowed(vendorOptions, 'collab')).toBe(false);
    expect(isFrozenBuiltinPluginAllowed(vendorOptions, 'ios-simulator')).toBe(false);
    expect(isFrozenBuiltinPluginAllowed(vendorOptions, 'memory')).toBe(true);
  });

  it('fails open only when no valid frozen policy exists', () => {
    expect(isFrozenBuiltinPluginAllowed(undefined, 'collab')).toBe(true);
    expect(
      isFrozenBuiltinPluginAllowed(
        {
          [CODEX_DISABLED_BUILTIN_PLUGIN_IDS_KEY]: ['collab', 1],
        },
        'collab',
      ),
    ).toBe(true);
  });

  it('uses a Bot allowlist to block Toolsets installed after the task was frozen', () => {
    const vendorOptions = {
      [CODEX_ALLOWED_BUILTIN_PLUGIN_IDS_KEY]: ['memory', 'collab'],
      [CODEX_DISABLED_BUILTIN_PLUGIN_IDS_KEY]: [],
    };
    expect(isFrozenBuiltinPluginAllowed(vendorOptions, 'memory')).toBe(true);
    expect(isFrozenBuiltinPluginAllowed(vendorOptions, 'browser')).toBe(false);
    expect(isFrozenBuiltinPluginAllowed(vendorOptions, 'newly-installed')).toBe(false);
  });
});
