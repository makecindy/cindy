import type {
  CapabilityRouteOverride,
  CapabilityRoutingPolicy,
} from '../types/capability-routing.js';
import { isClaudeCapabilityRouteEnforced } from './claude-code/capability-routing.js';
import { isCodexCapabilityRouteEnforced } from './codex/capability-routing.js';

/**
 * Each harness adapter's own enforcement predicate. Pi exposes no
 * harness-owned capability that overlaps Cindy today, so it accepts no routes.
 */
const CAPABILITY_ROUTE_ENFORCERS: Readonly<
  Record<string, (directive: CapabilityRouteOverride) => boolean>
> = {
  'claude-code': isClaudeCapabilityRouteEnforced,
  codex: isCodexCapabilityRouteEnforced,
  pi: () => false,
};

/**
 * Routes that no harness adapter would apply. A host policy must return an
 * empty list; anything else would be silently ignored or fail at startup.
 */
export function findUnenforcedCapabilityRoutes(
  policy: CapabilityRoutingPolicy | undefined,
): CapabilityRouteOverride[] {
  return (policy?.overrides ?? []).filter((directive) => {
    const enforce = directive.source.harness
      ? CAPABILITY_ROUTE_ENFORCERS[directive.source.harness]
      : undefined;
    return !enforce?.(directive);
  });
}
