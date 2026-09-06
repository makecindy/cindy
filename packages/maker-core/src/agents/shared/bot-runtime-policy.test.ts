import { describe, expect, it } from 'vitest';

import { isBotMcpServerAllowed } from './bot-runtime-policy.js';

describe('Bot MCP policy', () => {
  const policy = {
    mode: 'allowlist' as const,
    configured: ['custom-a'],
    catalog: [
      { name: 'cindy_memory', source: 'builtin' as const },
      { name: 'cindy_group_history', source: 'builtin' as const },
      { name: 'custom-a', source: 'custom' as const },
      { name: 'custom-b', source: 'custom' as const },
    ],
  };

  it('keeps only the narrow Bot-owned built-ins', () => {
    expect(isBotMcpServerAllowed(policy, 'cindy_memory')).toBe(true);
    expect(isBotMcpServerAllowed(policy, 'cindy_helper')).toBe(true);
    expect(isBotMcpServerAllowed(policy, 'cindy')).toBe(false);
    expect(isBotMcpServerAllowed(policy, 'cindy_group_history')).toBe(false);
  });

  it('enforces the custom MCP allowlist', () => {
    expect(isBotMcpServerAllowed(policy, 'custom-a')).toBe(true);
    expect(isBotMcpServerAllowed(policy, 'custom-b')).toBe(false);
  });

  it('allows a builtin capability server only when explicitly configured', () => {
    const withDocs = {
      mode: 'allowlist' as const,
      configured: ['cindy_docs'],
      catalog: [
        ...policy.catalog,
        { name: 'cindy_docs', source: 'builtin' as const },
      ],
    };
    // Mounting the docs toolset writes cindy_docs into the policy; without
    // that explicit mount the same server stays invisible.
    expect(isBotMcpServerAllowed(withDocs, 'cindy_docs')).toBe(true);
    expect(isBotMcpServerAllowed(policy, 'cindy_docs')).toBe(false);
    expect(
      isBotMcpServerAllowed(
        { ...withDocs, catalog: policy.catalog },
        'cindy_docs',
      ),
    ).toBe(false);
  });
});
