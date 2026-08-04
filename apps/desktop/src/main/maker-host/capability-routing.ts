import type {
  CapabilityRouteOverride,
  CapabilityRoutingPolicy,
} from '@cindy/maker-core';

const CODEX_COMPUTER_USE_REPLACEMENT_ROUTE = {
  capabilityId: 'computer-use',
  source: {
    kind: 'harness-plugin',
    harness: 'codex',
    surface: 'plugin',
    id: 'computer-use@openai-bundled',
  },
  invocation: 'disabled',
  replacement: {
    kind: 'cindy-host',
    id: 'cindy_computer',
  },
  reason: 'Cindy owns desktop-control enablement, permissions, and execution.',
} as const satisfies CapabilityRouteOverride;

/**
 * Product-level arbitration for capability sources that collide inside Cindy.
 *
 * User/project Skills and normal plugin capabilities remain available. Only a
 * named overlapping downstream source is narrowed, and explicit selectors keep
 * that source reachable when the user deliberately chooses it.
 */
export const DESKTOP_CAPABILITY_ROUTING_POLICY = {
  overrides: [
    {
      capabilityId: 'feishu',
      source: {
        kind: 'harness-plugin',
        harness: 'claude-code',
        surface: 'skill',
        id: 'feishu-delegate:message-feishu-coworkers',
        artifactId: 'message-feishu-coworkers',
        containerId: 'feishu-delegate',
      },
      invocation: 'explicit-only',
      explicitSelectors: [
        '/feishu-delegate:message-feishu-coworkers',
      ],
      replacement: {
        kind: 'cindy-plugin',
        id: 'xd-feishu',
      },
      reason: 'Natural-language Feishu requests should use the Cindy-connected account.',
    },
    {
      capabilityId: 'feishu',
      source: {
        kind: 'harness-plugin',
        harness: 'codex',
        surface: 'skill',
        id: 'feishu-delegate:message-feishu-coworkers',
        artifactId: 'message-feishu-coworkers',
        containerId: 'feishu-delegate@personal',
      },
      invocation: 'explicit-only',
      explicitSelectors: [
        '$feishu-delegate:message-feishu-coworkers',
        '/feishu-delegate:message-feishu-coworkers',
      ],
      replacement: {
        kind: 'cindy-plugin',
        id: 'xd-feishu',
      },
      reason: 'Natural-language Feishu requests should use the Cindy-connected account.',
    },
    {
      capabilityId: 'feishu',
      source: {
        kind: 'harness-plugin',
        harness: 'claude-code',
        surface: 'mcp',
        id: 'plugin:feishu-delegate:feishu-delegate',
        containerId: 'feishu-delegate',
      },
      invocation: 'explicit-only',
      explicitSelectors: [
        '/feishu-delegate:message-feishu-coworkers',
      ],
      replacement: {
        kind: 'cindy-plugin',
        id: 'xd-feishu',
      },
      reason: 'The downstream Feishu account must not be used without an explicit source choice.',
    },
    {
      capabilityId: 'feishu',
      source: {
        kind: 'harness-plugin',
        harness: 'codex',
        surface: 'mcp',
        // Codex does not expose plugin provenance in the MCP approval request
        // itself. Give the plugin server a Cindy-only runtime name in the
        // isolated overlay, then verify its owning pluginId from the preceding
        // mcpToolCall item. A user MCP may legally reuse either server name and
        // must remain unaffected.
        id: 'cindy-routed-feishu-delegate',
        artifactId: 'feishu-delegate',
        containerId: 'feishu-delegate@personal',
      },
      invocation: 'explicit-only',
      explicitSelectors: [
        '$feishu-delegate:message-feishu-coworkers',
        '/feishu-delegate:message-feishu-coworkers',
      ],
      replacement: {
        kind: 'cindy-plugin',
        id: 'xd-feishu',
      },
      reason: 'The downstream Feishu account must not be used without an explicit source choice.',
    },
    // The bundled Skill requires node_repl, which Cindy's Codex host does not
    // expose. Keep this compatibility restriction independent from whether the
    // user enabled Cindy's own Computer Use replacement.
    {
      capabilityId: 'computer-use',
      source: {
        kind: 'harness-plugin',
        harness: 'codex',
        surface: 'skill',
        id: 'computer-use:computer-use',
        artifactId: 'computer-use',
        containerId: 'computer-use@openai-bundled',
      },
      invocation: 'disabled',
      reason: 'The bundled Skill requires node_repl, which is unavailable in Cindy.',
    },
  ],
} as const satisfies CapabilityRoutingPolicy;

/**
 * Freeze the routing policy for one Codex session.
 *
 * Disabling the downstream plugin is replacement arbitration, so it only
 * applies after the current Codex environment actually exposes cindy_computer.
 * The base policy still hides the incompatible node_repl Skill when the Cindy
 * replacement is unavailable, without changing the plugin-wide setting.
 */
export function buildDesktopCapabilityRoutingPolicy(opts: {
  cindyComputerAvailable: boolean;
}): CapabilityRoutingPolicy {
  if (!opts.cindyComputerAvailable) return DESKTOP_CAPABILITY_ROUTING_POLICY;
  return {
    overrides: [
      ...DESKTOP_CAPABILITY_ROUTING_POLICY.overrides,
      CODEX_COMPUTER_USE_REPLACEMENT_ROUTE,
    ],
  };
}
