import type { CapabilityRoutingPolicy } from '@cindy/maker-core';

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
    {
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
    },
  ],
} as const satisfies CapabilityRoutingPolicy;
