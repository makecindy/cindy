import type {
  CapabilityRouteOverride,
  CapabilityRoutingPolicy,
} from '../../types/capability-routing.js';

const CODEX_HARNESS_ID = 'codex';

interface CodexSkillState {
  path: string;
  enabled: boolean;
}

interface CodexPluginCacheIdentity {
  pluginName: string;
  marketplace: string;
}

interface CodexSkillDisableTarget {
  plugin: CodexPluginCacheIdentity;
  /** Undefined means every Skill contributed by the plugin. */
  skillArtifactId?: string;
}

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

export interface CodexSessionCapabilityRoutingOptions {
  /** Whether this Codex host can invoke replacements served by Cindy itself. */
  cindyHostReplacementsAvailable: boolean;
}

/**
 * Codex thread config accepts flattened TOML paths. Plugin config names contain
 * `@`, so they must be rendered as quoted dotted-key segments.
 */
function quoteTomlKeySegment(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function renderThreadConfigKeySegment(value: string): string {
  // app-server's thread config takes flattened paths, but unlike CLI `-c` it
  // does not parse quotes around a bare-safe segment. Quoting `node_repl`
  // therefore addresses a literal `"node_repl"` server and makes transport
  // resolution fail. Keep quoting only for names that TOML cannot render bare.
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : quoteTomlKeySegment(value);
}

function isCodexHarnessPluginDirective(
  directive: CapabilityRouteOverride,
): boolean {
  return (
    directive.source.kind === 'harness-plugin' &&
    directive.source.harness === CODEX_HARNESS_ID
  );
}

function isDisabledCodexSkillSourceDirective(
  directive: CapabilityRouteOverride,
): boolean {
  return (
    isCodexHarnessPluginDirective(directive) &&
    (directive.source.surface === 'plugin' ||
      directive.source.surface === 'skill') &&
    directive.invocation === 'disabled'
  );
}

function parseCodexPluginCacheIdentity(
  pluginId: string,
): CodexPluginCacheIdentity | null {
  const separator = pluginId.lastIndexOf('@');
  if (separator <= 0 || separator === pluginId.length - 1) return null;
  return {
    pluginName: pluginId.slice(0, separator),
    marketplace: pluginId.slice(separator + 1),
  };
}

function isSkillFromPluginDistribution(
  skillPath: string,
  target: CodexSkillDisableTarget,
): boolean {
  const segments = skillPath.replace(/\\/g, '/').split('/');
  for (let index = 0; index < segments.length; index += 1) {
    if (
      index + 6 < segments.length &&
      segments[index] === 'plugins' &&
      segments[index + 1] === 'cache' &&
      segments[index + 2] === target.plugin.marketplace &&
      segments[index + 3] === target.plugin.pluginName &&
      segments[index + 4] !== '' &&
      segments[index + 5] === 'skills' &&
      (target.skillArtifactId === undefined ||
        segments[index + 6] === target.skillArtifactId)
    ) {
      return true;
    }
    const bundledMarketplace = segments[index + 1];
    if (
      index + 5 < segments.length &&
      segments[index] === 'bundled-marketplaces' &&
      (bundledMarketplace === target.plugin.marketplace ||
        bundledMarketplace?.startsWith(
          `${target.plugin.marketplace}.staging-`,
        )) &&
      segments[index + 2] === 'plugins' &&
      segments[index + 3] === target.plugin.pluginName &&
      segments[index + 4] === 'skills' &&
      (target.skillArtifactId === undefined ||
        segments[index + 5] === target.skillArtifactId)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Remove replacement-arbitration routes that the selected Codex host cannot
 * satisfy. Compatibility-only restrictions without a replacement remain in
 * force, so remote sessions still hide Skills that depend on unavailable APIs.
 */
export function buildCodexSessionCapabilityRoutingPolicy(
  policy: CapabilityRoutingPolicy | undefined,
  opts: CodexSessionCapabilityRoutingOptions,
): CapabilityRoutingPolicy | undefined {
  if (opts.cindyHostReplacementsAvailable || !policy) return policy;
  const overrides = policy.overrides.filter(
    (directive) => directive.replacement?.kind !== 'cindy-host',
  );
  return overrides.length === policy.overrides.length ? policy : { overrides };
}

/** Whether a session must inspect Codex's effective Skill catalog before start. */
export function requiresCodexCapabilitySkillDiscovery(
  policy: CapabilityRoutingPolicy | undefined,
): boolean {
  return policy?.overrides.some(isDisabledCodexSkillSourceDirective) ?? false;
}

/**
 * Hide a selected plugin Skill, or every Skill from a disabled plugin.
 *
 * Codex 0.145 keeps plugin Skills enabled in the model-facing catalog even
 * when the plugin-wide `enabled` override is false. `skills.config` is the
 * supported per-Skill control. Cindy also uses the same narrow control when a
 * specific downstream Skill depends on a host interface that is unavailable.
 * Derive paths from app-server's own catalog rather than guessing local or
 * remote homes. Existing disabled Skills in this cwd are carried forward
 * because the per-thread array may replace the base array.
 */
export function buildCodexCapabilitySkillConfigOverrides(
  policy: CapabilityRoutingPolicy | undefined,
  skills: readonly CodexSkillState[],
): Record<string, unknown> {
  const targets: CodexSkillDisableTarget[] = [];
  for (const directive of policy?.overrides ?? []) {
    if (!isDisabledCodexSkillSourceDirective(directive)) continue;
    const pluginId = directive.source.surface === 'plugin'
      ? directive.source.id
      : directive.source.containerId;
    if (!pluginId) {
      const requiredField = directive.source.surface === 'plugin'
        ? 'source.id'
        : 'source.containerId';
      throw new Error(
        `Cannot disable Codex Skill ${directive.source.id}: ${requiredField} is required`,
      );
    }
    const plugin = parseCodexPluginCacheIdentity(pluginId);
    if (!plugin) {
      throw new Error(
        `Cannot enforce disabled Codex Skill routing for ${directive.source.id}: expected plugin id in <name>@<marketplace> form`,
      );
    }
    const skillArtifactId = directive.source.surface === 'skill'
      ? directive.source.artifactId
      : undefined;
    if (directive.source.surface === 'skill' && !skillArtifactId) {
      throw new Error(
        `Cannot disable Codex Skill ${directive.source.id}: source.artifactId is required`,
      );
    }
    targets.push({
      plugin,
      ...(skillArtifactId ? { skillArtifactId } : {}),
    });
  }
  if (targets.length === 0) return {};

  const routedSkillPaths = skills
    .filter((skill) =>
      targets.some((target) =>
        isSkillFromPluginDistribution(skill.path, target),
      ),
    )
    .map((skill) => skill.path);
  if (routedSkillPaths.length === 0) return {};

  const disabledPaths = new Set([
    ...skills.filter((skill) => !skill.enabled).map((skill) => skill.path),
    ...routedSkillPaths,
  ]);
  return {
    'skills.config': [...disabledPaths]
      .sort()
      .map((skillPath) => ({ path: skillPath, enabled: false })),
  };
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
      directive.invocation === 'disabled'
    ) {
      config[
        `mcp_servers.${renderThreadConfigKeySegment(directive.source.id)}.enabled`
      ] = false;
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
          `plugins.${quoteTomlKeySegment(directive.source.containerId)}.mcp_servers.${renderThreadConfigKeySegment(artifactId)}.enabled`
        ] = false;
      }
      config[
        `plugins.${quoteTomlKeySegment(directive.source.containerId)}.mcp_servers.${renderThreadConfigKeySegment(directive.source.id)}.default_tools_approval_mode`
      ] = 'prompt';
    }
  }
  return config;
}
