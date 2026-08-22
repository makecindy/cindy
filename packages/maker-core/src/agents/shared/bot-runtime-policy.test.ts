import { describe, expect, it } from 'vitest';

import { isBotMcpServerAllowed } from './bot-runtime-policy.js';

describe('Bot MCP policy', () => {
  const policy = {
    mode: 'allowlist' as const,
    configured: ['custom-a'],
    catalog: [
      { name: 'cindy_memory', source: 'builtin' as const },
      { name: 'custom-a', source: 'custom' as const },
      { name: 'custom-b', source: 'custom' as const },
    ],
  };

  it('keeps built-ins under their native Toolset and permission policy', () => {
    expect(isBotMcpServerAllowed(policy, 'cindy_memory')).toBe(true);
  });

  it('enforces the custom MCP allowlist', () => {
    expect(isBotMcpServerAllowed(policy, 'custom-a')).toBe(true);
    expect(isBotMcpServerAllowed(policy, 'custom-b')).toBe(false);
  });
});
