/**
 * Host-owned routing policy for capabilities that may also be supplied by an
 * agent harness.
 *
 * The model-facing capability id is intentionally separate from a harness
 * implementation id. A future harness can map the same stable capability id to
 * its own plugin/tool name without changing Cindy's product policy.
 */

export type CapabilityInvocationPolicy = 'auto' | 'explicit-only' | 'disabled';

export type CapabilitySourceKind =
  | 'cindy-host'
  | 'cindy-plugin'
  | 'user-skill'
  | 'project-skill'
  | 'harness-builtin'
  | 'harness-plugin';

export type CapabilitySurface = 'skill' | 'plugin' | 'mcp' | 'app' | 'tool';

export interface CapabilitySourceSelector {
  kind: CapabilitySourceKind;
  /**
   * Adapter id such as `codex` or `claude-code`.
   *
   * This remains a string instead of AgentKind so adding a third harness does
   * not require widening the shared routing contract first.
   */
  harness?: string;
  surface: CapabilitySurface;
  /**
   * Harness-native stable id.
   *
   * Plugin skills must use the name exposed by the harness, including its
   * namespace (for example `feishu-delegate:message-feishu-coworkers`).
   * This keeps a plugin skill distinct from a same-named user or project skill.
   */
  id: string;
  /**
   * Optional on-disk artifact id when it differs from the harness-native id.
   *
   * For example, a namespaced plugin skill may be exposed as
   * `feishu-delegate:message-feishu-coworkers` while its directory remains
   * `skills/message-feishu-coworkers`.
   */
  artifactId?: string;
  /**
   * Optional owner id for a nested surface.
   *
   * Example: a Codex plugin skill uses
   * `id: feishu-delegate:message-feishu-coworkers` and
   * `containerId: feishu-delegate@personal`.
   */
  containerId?: string;
}

export interface CapabilityReplacement {
  kind: 'cindy-host' | 'cindy-plugin';
  id: string;
}

export interface CapabilityRouteOverride {
  /** Product-level identity shared across implementations. */
  capabilityId: string;
  source: CapabilitySourceSelector;
  invocation: CapabilityInvocationPolicy;
  /**
   * User-visible selectors that explicitly choose this source for the current
   * turn, for example
   * `$feishu-delegate:message-feishu-coworkers` or
   * `/feishu-delegate:message-feishu-coworkers`.
   *
   * Only unambiguous command tokens are accepted. A plain display name must
   * never unlock a source in a sentence such as "do not use Feishu Delegate".
   */
  explicitSelectors?: readonly string[];
  replacement?: CapabilityReplacement;
  reason?: string;
}

export interface CapabilityRoutingPolicy {
  overrides: readonly CapabilityRouteOverride[];
}

export interface CapabilityRouteTarget {
  harness: string;
  surface: CapabilitySurface;
  id: string;
}

export function isHarnessOwnedCapabilitySource(
  source: CapabilitySourceSelector,
): boolean {
  return (
    source.kind === 'harness-builtin' ||
    source.kind === 'harness-plugin'
  );
}

export function findCapabilityRouteOverride(
  policy: CapabilityRoutingPolicy | undefined,
  target: CapabilityRouteTarget,
): CapabilityRouteOverride | undefined {
  return policy?.overrides.find(
    (directive) =>
      isHarnessOwnedCapabilitySource(directive.source) &&
      directive.source.harness === target.harness &&
      directive.source.surface === target.surface &&
      directive.source.id === target.id,
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchesExplicitSelector(text: string, selector: string): boolean {
  const normalizedSelector = selector.trim();
  if (!normalizedSelector) return false;
  if (normalizedSelector.startsWith('$')) {
    return new RegExp(
      `(^|[^A-Za-z0-9_:-])${escapeRegExp(normalizedSelector)}(?![A-Za-z0-9_:-])`,
      'iu',
    ).test(text);
  }
  if (normalizedSelector.startsWith('/')) {
    return new RegExp(
      `(^|\\s)${escapeRegExp(normalizedSelector)}(?=$|\\s|[.,!?;:，。！？；：])`,
      'iu',
    ).test(text);
  }
  return false;
}

export function isCapabilitySourceExplicitlySelected(
  directive: CapabilityRouteOverride,
  userText: string,
): boolean {
  return (
    directive.explicitSelectors?.some((selector) =>
      matchesExplicitSelector(userText, selector),
    ) ?? false
  );
}

export function isCapabilityRouteInvocationAllowed(
  directive: CapabilityRouteOverride,
  userText: string,
): boolean {
  switch (directive.invocation) {
    case 'auto':
      return true;
    case 'disabled':
      return false;
    case 'explicit-only':
      return isCapabilitySourceExplicitlySelected(directive, userText);
  }
}

export function findClaudeMcpCapabilityRoute(
  policy: CapabilityRoutingPolicy | undefined,
  toolName: string,
): CapabilityRouteOverride | undefined {
  return policy?.overrides.find(
    (directive) =>
      isHarnessOwnedCapabilitySource(directive.source) &&
      directive.source.harness === 'claude-code' &&
      directive.source.surface === 'mcp' &&
      toolName.startsWith(claudeMcpToolPrefix(directive.source.id)),
  );
}

export function claudeMcpToolPrefix(serverId: string): string {
  return `mcp__${serverId.replace(/[^a-zA-Z0-9_-]/g, '_')}__`;
}
