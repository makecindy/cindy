import type {
  CapabilityRouteOverride,
  CapabilityRoutingPolicy,
} from '../../types/capability-routing.js';

const CODEX_HARNESS_ID = 'codex';

interface CodexSkillState {
  path: string;
  enabled: boolean;
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

function pluginIdFromCodexSkillPath(skillPath: string): string | null {
  const segments = skillPath.replace(/\\/g, '/').split('/');
  for (let index = 0; index < segments.length; index += 1) {
    if (
      segments[index] === 'plugins' &&
      segments[index + 1] === 'cache' &&
      segments[index + 2] &&
      segments[index + 3] &&
      segments[index + 4] &&
      segments[index + 5] === 'skills'
    ) {
      return `${segments[index + 3]}@${segments[index + 2]}`;
    }
    if (
      segments[index] === 'bundled-marketplaces' &&
      segments[index + 1] &&
      segments[index + 2] === 'plugins' &&
      segments[index + 3] &&
      segments[index + 4] === 'skills'
    ) {
      const marketplace = segments[index + 1].replace(/\.staging-[^/]+$/, '');
      return `${segments[index + 3]}@${marketplace}`;
    }
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function hasCodexMcpTransport(value: unknown): boolean {
  const config = asRecord(value);
  return [config.command, config.url].some(
    (transport) => typeof transport === 'string' && transport.trim().length > 0,
  );
}

/**
 * Disable every Codex plugin surface while preserving standalone user/project
 * Skills. Codex 0.145 may keep plugin Skills in the model catalog after the
 * plugin container is disabled, so their concrete paths must be disabled too.
 */
export function buildCodexPluginIsolationConfig(
  configuredPlugins: Record<string, unknown>,
  skills: readonly CodexSkillState[],
): Record<string, unknown> {
  const pluginIds = new Set(Object.keys(configuredPlugins));
  const disabledSkillPaths = new Set(
    skills.filter((skill) => !skill.enabled).map((skill) => skill.path),
  );
  let hasPluginSkill = false;

  for (const skill of skills) {
    const pluginId = pluginIdFromCodexSkillPath(skill.path);
    if (!pluginId) continue;
    hasPluginSkill = true;
    pluginIds.add(pluginId);
    disabledSkillPaths.add(skill.path);
  }

  const config: Record<string, unknown> = {
    'features.apps': false,
    'features.remote_plugin': false,
  };
  if (hasPluginSkill) {
    config['skills.config'] = [...disabledSkillPaths]
      .sort()
      .map((skillPath) => ({ path: skillPath, enabled: false }));
  }

  for (const pluginId of [...pluginIds].sort()) {
    config[`plugins.${quoteTomlKeySegment(pluginId)}.enabled`] = false;
    const pluginMcp = asRecord(asRecord(configuredPlugins[pluginId]).mcp_servers);
    for (const [serverName, serverConfig] of Object.entries(pluginMcp)) {
      if (!hasCodexMcpTransport(serverConfig)) continue;
      config[
        `plugins.${quoteTomlKeySegment(pluginId)}.mcp_servers.${renderThreadConfigKeySegment(serverName)}.enabled`
      ] = false;
    }
  }

  return config;
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

/**
 * Convert host policy into per-thread Codex config overrides.
 *
 * Cindy does not host Codex plugin overlays. Explicit-only plugin routes are
 * therefore disabled as a whole rather than silently widened.
 */
export function buildCodexCapabilityConfigOverrides(
  policy: CapabilityRoutingPolicy | undefined,
): Record<string, unknown> {
  const config: Record<string, unknown> = Object.create(null);
  if (!policy) return config;

  for (const directive of policy.overrides) {
    if (!isCodexHarnessPluginDirective(directive)) continue;
    if (directive.invocation === 'explicit-only') {
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
          `Cannot disable explicit-only Codex capability ${directive.capabilityId}: ${requiredField} is required for ${directive.source.surface} source ${directive.source.id}`,
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
  }
  return config;
}
