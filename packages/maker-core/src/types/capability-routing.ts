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

interface CapabilitySourceSelectorBase {
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

interface HarnessOwnedCapabilitySourceSelector
  extends CapabilitySourceSelectorBase {
  kind: Extract<
    CapabilitySourceKind,
    'harness-builtin' | 'harness-plugin'
  >;
  /**
   * Adapter id such as `codex` or `claude-code`.
   *
   * This remains a string instead of AgentKind so adding a third harness does
   * not require widening the shared routing contract first.
   */
  harness: string;
}

interface NonHarnessCapabilitySourceSelector
  extends CapabilitySourceSelectorBase {
  kind: Exclude<
    CapabilitySourceKind,
    HarnessOwnedCapabilitySourceSelector['kind']
  >;
  /** Prevent host/user/project selectors from carrying harness provenance. */
  harness?: never;
}

export type CapabilitySourceSelector =
  | HarnessOwnedCapabilitySourceSelector
  | NonHarnessCapabilitySourceSelector;

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
): source is HarnessOwnedCapabilitySourceSelector {
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

/**
 * Return only selectors that a user newly introduced while editing a
 * model-authored plan. Copying the full edited plan into selection state would
 * let a selector already written by the model become an explicit user choice
 * when the user merely approves or edits an unrelated line.
 */
export function capabilitySelectionAddedByPlanEdit(
  policy: CapabilityRoutingPolicy | undefined,
  harness: string,
  originalPlan: string,
  editedPlan: string | undefined,
): string {
  if (editedPlan === undefined || editedPlan === originalPlan) return '';
  const added = new Set<string>();
  for (const directive of policy?.overrides ?? []) {
    if (
      directive.invocation !== 'explicit-only' ||
      directive.source.harness !== harness
    ) {
      continue;
    }
    for (const selector of directive.explicitSelectors ?? []) {
      if (
        !matchesExplicitSelector(originalPlan, selector) &&
        matchesExplicitSelector(editedPlan, selector)
      ) {
        added.add(selector.trim());
      }
    }
  }
  return [...added].filter(Boolean).join('\n');
}

export function findClaudeMcpCapabilityRoute(
  policy: CapabilityRoutingPolicy | undefined,
  toolName: string,
  nonHarnessServerIds: ReadonlySet<string> = new Set(),
): CapabilityRouteOverride | undefined {
  return policy?.overrides.find(
    (directive) =>
      isHarnessOwnedCapabilitySource(directive.source) &&
      directive.source.harness === 'claude-code' &&
      directive.source.surface === 'mcp' &&
      !hasClaudeMcpPrefixCollision(
        directive.source.id,
        nonHarnessServerIds,
      ) &&
      toolName.startsWith(claudeMcpToolPrefix(directive.source.id)),
  );
}

export function claudeMcpToolPrefix(serverId: string): string {
  return `mcp__${serverId.replace(/[^a-zA-Z0-9_-]/g, '_')}__`;
}

/**
 * Claude flattens punctuation in MCP server ids before exposing tool names.
 * A harness plugin id such as `plugin:foo:bar` therefore aliases a perfectly
 * valid user MCP id such as `plugin_foo_bar`. Once flattened, PreToolUse only
 * receives the tool name and cannot recover which server produced it.
 * The same ambiguity exists when a user registration uses the exact harness
 * id: the SDK registry reports only the id, not its settings/plugin origin.
 *
 * Prefer the known non-harness registration in that ambiguous case. This may
 * narrow a harness guard for the session, but it never silently disables a
 * user/host MCP merely because its valid id collides after normalization.
 */
export function hasClaudeMcpPrefixCollision(
  harnessServerId: string,
  nonHarnessServerIds: ReadonlySet<string>,
): boolean {
  const harnessPrefix = claudeMcpToolPrefix(harnessServerId);
  for (const serverId of nonHarnessServerIds) {
    if (claudeMcpToolPrefix(serverId) === harnessPrefix) return true;
  }
  return false;
}
