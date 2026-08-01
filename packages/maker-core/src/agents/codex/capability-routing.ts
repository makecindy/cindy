import type {
  CapabilityRouteOverride,
  CapabilityRoutingPolicy,
} from '../../types/capability-routing.js';

const CODEX_HARNESS_ID = 'codex';

export interface CodexCapabilityRoutingOptions {
  /**
   * Whether the host prepared a provenance-preserving plugin overlay for this
   * Codex home.
   *
   * Local Cindy sessions have one. Remote Codex runs from a separate isolated
   * CODEX_HOME, so until the host synchronizes the overlay there we must disable
   * an explicit-only downstream plugin as a whole instead of pretending its
   * renamed MCP and non-implicit Skill are available.
   */
  isolatedPluginOverlays?: boolean;
}

/**
 * Codex thread config accepts flattened TOML paths. Plugin config names contain
 * `@`, so they must be rendered as quoted dotted-key segments.
 */
function quoteTomlKeySegment(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function isCodexHarnessPluginDirective(
  directive: CapabilityRouteOverride,
): boolean {
  return (
    directive.source.kind === 'harness-plugin' &&
    directive.source.harness === CODEX_HARNESS_ID
  );
}

/**
 * Convert host policy into per-thread Codex config overrides.
 *
 * Codex 0.145 exposes plugin-wide enablement but has no host-side equivalent of
 * Claude's `user-invocable-only` skill override. Local explicit-only sources
 * are narrowed by the provenance-preserving plugin overlay plus the approval
 * guard. When that overlay is unavailable (currently remote Codex), the whole
 * targeted plugin is disabled rather than silently widened.
 */
export function buildCodexCapabilityConfigOverrides(
  policy: CapabilityRoutingPolicy | undefined,
  opts: CodexCapabilityRoutingOptions = {},
): Record<string, unknown> {
  const config: Record<string, unknown> = Object.create(null);
  if (!policy) return config;

  for (const directive of policy.overrides) {
    if (!isCodexHarnessPluginDirective(directive)) continue;
    if (
      opts.isolatedPluginOverlays === false &&
      directive.invocation === 'explicit-only'
    ) {
      const pluginId =
        directive.source.surface === 'plugin'
          ? directive.source.id
          : directive.source.containerId;
      if (!pluginId) {
        const requiredField =
          directive.source.surface === 'plugin'
            ? 'source.id'
            : 'source.containerId';
        throw new Error(
          `Cannot enforce explicit-only Codex capability ${directive.capabilityId} without an isolated plugin overlay: ${requiredField} is required for ${directive.source.surface} source ${directive.source.id}`,
        );
      }
      config[`plugins.${quoteTomlKeySegment(pluginId)}.enabled`] = false;
      continue;
    }
    if (
      directive.source.surface === 'plugin' &&
      directive.invocation === 'disabled'
    ) {
      config[`plugins.${quoteTomlKeySegment(directive.source.id)}.enabled`] =
        false;
      continue;
    }
    if (
      directive.source.surface === 'mcp' &&
      directive.invocation === 'explicit-only' &&
      directive.source.containerId
    ) {
      const artifactId = directive.source.artifactId;
      if (artifactId && artifactId !== directive.source.id) {
        // The isolated plugin overlay renames the downstream MCP server so the
        // runtime approval request cannot collide with a user-owned MCP of the
        // same name. Disabling the original name also makes overlay failures
        // fail closed for the MCP surface.
        config[
          `plugins.${quoteTomlKeySegment(directive.source.containerId)}.mcp_servers.${quoteTomlKeySegment(artifactId)}.enabled`
        ] = false;
      }
      config[
        `plugins.${quoteTomlKeySegment(directive.source.containerId)}.mcp_servers.${quoteTomlKeySegment(directive.source.id)}.default_tools_approval_mode`
      ] = 'prompt';
    }
  }
  return config;
}
