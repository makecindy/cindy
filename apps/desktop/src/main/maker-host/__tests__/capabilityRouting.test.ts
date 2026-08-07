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
    );

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

    expect(routes).toHaveLength(2);
    expect(routes[1]).toMatchObject({
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
});
