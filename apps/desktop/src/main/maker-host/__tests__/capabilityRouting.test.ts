import { describe, expect, it } from 'vitest';
import type { CapabilityRoutingPolicy } from '@cindy/maker-core';

import { buildDesktopCapabilityRoutingPolicy } from '../capability-routing.js';

function computerUseRoutes(policy: CapabilityRoutingPolicy) {
  return policy.overrides.filter((route) => route.capabilityId === 'computer-use');
}

describe('desktop Computer Use capability routing', () => {
  it('keeps only the node_repl compatibility restriction before Cindy Computer Use is applied', () => {
    const routes = computerUseRoutes(
      buildDesktopCapabilityRoutingPolicy({
        cindyComputerAvailable: false,
      }),
    ).filter((route) => route.source.kind !== 'user-mcp');

    expect(routes).toEqual([
      expect.objectContaining({
        source: expect.objectContaining({
          surface: 'skill',
          id: 'computer-use:computer-use',
          containerId: 'computer-use@openai-bundled',
        }),
        invocation: 'disabled',
      }),
    ]);
  });

  it('disables the downstream plugin only after cindy_computer is applied', () => {
    const routes = computerUseRoutes(
      buildDesktopCapabilityRoutingPolicy({
        cindyComputerAvailable: true,
      }),
    );

    expect(routes.filter((route) => route.source.kind !== 'user-mcp')).toHaveLength(2);
    expect(routes.filter((route) => route.source.kind !== 'user-mcp')[1]).toMatchObject({
      source: {
        surface: 'plugin',
        id: 'computer-use@openai-bundled',
      },
      invocation: 'disabled',
      replacement: {
        kind: 'cindy-host',
        id: 'cindy_computer',
      },
    });
  });

  // CU-013 (2026-10-31 audit): the user's own cua-driver / cua MCP registrations
  // in ~/.claude.json won the model's choice over cindy_computer in 26 of 45
  // sessions, and connected with all tools in a sandbox where Computer Use was
  // off. They are replaced regardless of the Cindy capability state.
  it('always replaces the user-registered desktop driver MCPs for Claude', () => {
    const claudeUserRoutes = (available: boolean) =>
      computerUseRoutes(buildDesktopCapabilityRoutingPolicy({ cindyComputerAvailable: available }))
        .filter((route) => route.source.kind === 'user-mcp');

    expect(claudeUserRoutes(false)).toEqual(claudeUserRoutes(true));
    expect(claudeUserRoutes(false)).toEqual([
      expect.objectContaining({
        source: { kind: 'user-mcp', harness: 'claude-code', surface: 'mcp', id: 'cua-driver' },
        invocation: 'disabled',
        replacement: { kind: 'cindy-host', id: 'cindy_computer' },
      }),
      expect.objectContaining({
        source: { kind: 'user-mcp', harness: 'claude-code', surface: 'mcp', id: 'cua' },
        invocation: 'disabled',
      }),
    ]);
  });
});
