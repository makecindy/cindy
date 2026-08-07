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

const CODEX_IN_APP_BROWSER_UNAVAILABLE_OVERRIDE = {
  capabilityId: 'browser-use',
  source: {
    kind: 'harness-plugin',
    harness: 'codex',
    surface: 'plugin',
    id: 'browser@openai-bundled',
  },
  invocation: 'disabled',
  reason: 'Cindy does not host the ChatGPT in-app browser runtime.',
} as const satisfies CapabilityRoutingPolicy['overrides'][number];

const CODEX_CHROME_USE_OVERRIDES = [
  {
    capabilityId: 'browser-use',
    source: {
      kind: 'harness-plugin',
      harness: 'codex',
      surface: 'plugin',
      id: 'chrome@openai-bundled',
    },
    invocation: 'disabled',
    replacement: {
      kind: 'cindy-plugin',
      id: 'browser',
    },
    reason: 'Cindy Browser owns browser automation while it is enabled for this workspace.',
  },
  {
    capabilityId: 'browser-use',
    source: {
      kind: 'harness-plugin',
      harness: 'codex',
      surface: 'mcp',
      id: 'node_repl',
    },
    invocation: 'disabled',
    replacement: {
      kind: 'cindy-plugin',
      id: 'browser',
    },
    reason: 'Cindy Browser owns browser automation while it is enabled for this workspace.',
  },
] as const satisfies CapabilityRoutingPolicy['overrides'];

const CODEX_CHROME_USE_UNAVAILABLE_OVERRIDES = CODEX_CHROME_USE_OVERRIDES.map(
  (override) => ({
    capabilityId: override.capabilityId,
    source: override.source,
    invocation: override.invocation,
    reason: 'The official Codex Browser companion is unavailable in this runtime.',
  }),
) satisfies CapabilityRoutingPolicy['overrides'];

/**
 * codex 0.145.0's config loader requires every `mcp_servers` entry to carry a
 * complete transport even when disabled, and thread/start validates per-thread
 * overrides against the same loader. The spawn config defines a node_repl
 * entry only when the verified Browser companion was provisioned; without it,
 * the per-thread `mcp_servers.node_repl.enabled=false` override synthesizes a
 * transport-less entry and every thread/start fails with "invalid transport"
 * (-32600). Emit the node_repl MCP route only when the spawn transport exists
 * — when it does not, the capability is already absent and fail-closed holds
 * without the directive.
 *
 * The gate is spawn-time provisioning, NOT session-time availability: a
 * provisioned companion whose Chrome readiness probe failed still has the
 * full node_repl transport in its spawn config, so the disable both merges
 * cleanly and is required to keep the privileged surface off.
 */
function withoutUnprovisionedNodeReplRoute(
  overrides: readonly CapabilityRouteOverride[],
  codexBrowserUseProvisioned: boolean | undefined,
): CapabilityRouteOverride[] {
  if (codexBrowserUseProvisioned === true) return [...overrides];
  return overrides.filter(
    (override) =>
      !(override.source.surface === 'mcp' && override.source.id === 'node_repl'),
  );
}

/** Freeze workspace-scoped capability arbitration for one new runtime. */
export function buildDesktopCapabilityRoutingPolicy(opts: {
  /** Whether the current Codex bridge exposes Cindy's Computer Use host. */
  cindyComputerAvailable?: boolean;
  /** Workspace-scoped Cindy Browser ownership snapshot. */
  cindyBrowserEnabled?: boolean;
  /** Session-time snapshot: companion provisioned AND Chrome currently ready. */
  codexBrowserUseAvailable?: boolean;
  /**
   * Spawn-time snapshot: the verified companion supplied a full node_repl
   * transport to this app-server. Gates the mcp node_repl route (a per-thread
   * disable is only valid — and only needed — when the entry exists).
   */
  codexBrowserUseProvisioned?: boolean;
  /** Remote Codex cannot invoke the local Cindy Browser plugin bridge. */
  remoteHostId?: string | null;
}): CapabilityRoutingPolicy {
  const cindyBrowserEnabled = opts.remoteHostId
    ? undefined
    : opts.cindyBrowserEnabled;
  const computerUseAvailable =
    opts.cindyComputerAvailable ?? cindyBrowserEnabled !== undefined;
  const computerOverrides = computerUseAvailable
    ? [CODEX_COMPUTER_USE_REPLACEMENT_ROUTE]
    : [];
  const chromeOverrides = cindyBrowserEnabled === undefined
    ? []
    : cindyBrowserEnabled
    ? withoutUnprovisionedNodeReplRoute(
        CODEX_CHROME_USE_OVERRIDES,
        opts.codexBrowserUseProvisioned,
      )
    : opts.codexBrowserUseAvailable === false
      ? withoutUnprovisionedNodeReplRoute(
          CODEX_CHROME_USE_UNAVAILABLE_OVERRIDES,
          opts.codexBrowserUseProvisioned,
        )
      : [];
  return {
    overrides: [
      ...DESKTOP_CAPABILITY_ROUTING_POLICY.overrides,
      ...computerOverrides,
      {
        ...CODEX_IN_APP_BROWSER_UNAVAILABLE_OVERRIDE,
        ...(cindyBrowserEnabled === true
          ? { replacement: { kind: 'cindy-plugin' as const, id: 'browser' } }
          : {}),
      },
      ...chromeOverrides,
    ],
  };
}
