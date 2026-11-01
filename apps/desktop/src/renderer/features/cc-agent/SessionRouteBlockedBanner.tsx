import { useCallback, useEffect, useState } from 'react';
import {
  assessRoute,
  resolveTaskRoute,
  type ProbeLike,
  type ProviderFileEntry,
  type RouteAlternative,
  type RouteHealth,
  type RouteResolution,
  type RoutingFile,
} from '@cindy/model-providers';

import { Button } from '@/components/ui/button';
import { ErrorNotice } from '@/components/ui/error-notice';
import { WINDOW_NO_DRAG_STYLE } from '@/components/layout/windowDrag';
import * as sessionService from '@/lib/sessionService';

export function formatRouteAlternativeLabel(alt: RouteAlternative): string {
  const suffix = alt.paid ? ' (paid)' : ' (local)';
  return `Use ${alt.routeName} (${alt.provider}/${alt.model})${suffix} instead`;
}

/**
 * Resolve and assess the active session's harness route (ROADMAP 2.4b).
 *
 * Returns `null` when `routing.yaml` has no routes/rules configured or when a
 * custom session model does not map to a configured `routing.yaml` route.
 * Never auto-substitutes an alternative route.
 */
export function assessSessionRouteHealth(params: {
  sessionModel?: string | null;
  routing: RoutingFile;
  providers: ProviderFileEntry[];
  probes: ProbeLike[];
}): RouteHealth | null {
  const { sessionModel, routing, providers, probes } = params;
  if (!routing || !routing.routes || Object.keys(routing.routes).length === 0) {
    return null;
  }

  const trimmedModel = sessionModel?.trim();
  if (trimmedModel && trimmedModel !== 'hermes-default') {
    const matchedEntry = Object.entries(routing.routes).find(
      ([routeName, target]) => routeName === trimmedModel || target.model === trimmedModel,
    );
    if (!matchedEntry) {
      return null;
    }
    const [routeName, target] = matchedEntry;
    const resolution: RouteResolution = {
      ok: true,
      taskClass: 'chat.session',
      routeName,
      target,
    };
    return assessRoute(resolution, routing, providers, probes);
  }

  if (!('chat.default' in (routing.rules ?? {}))) {
    return null;
  }
  const resolution = resolveTaskRoute(routing, 'chat.default');
  return assessRoute(resolution, routing, providers, probes);
}

/**
 * Pure presentation component for a blocked session route with one-click
 * "Use X instead" buttons (ROADMAP 2.4b).
 *
 * Local alternatives appear before paid ones (`assessRoute` order), and paid
 * alternatives are explicitly labelled `(paid)`. Nothing is ever auto-selected.
 */
export function SessionRouteBlockedBannerView({
  health,
  switchingRoute,
  onSelectAlternative,
  onDismiss,
}: {
  health: RouteHealth | null;
  switchingRoute?: string | null;
  onSelectAlternative: (alt: RouteAlternative) => void;
  onDismiss?: () => void;
}) {
  if (!health || health.ok) return null;

  return (
    <div
      data-testid="session-route-blocked-banner"
      className="mx-1 shrink-0"
      style={WINDOW_NO_DRAG_STYLE}
    >
      <ErrorNotice
        message={health.message}
        description="Automatic fallback is disabled (no silent fallback to another or paid provider)."
        onDismiss={onDismiss}
        actions={
          health.alternatives.length > 0 ? (
            <div
              data-testid="session-route-alternatives"
              className="flex flex-wrap items-center gap-1.5"
            >
              {health.alternatives.map((alt) => (
                <Button
                  key={alt.routeName}
                  type="button"
                  size="sm"
                  compact
                  variant="secondary"
                  disabled={switchingRoute != null}
                  data-testid={`use-route-alternative-${alt.routeName}`}
                  data-route-paid={alt.paid ? 'true' : 'false'}
                  onClick={() => onSelectAlternative(alt)}
                >
                  {formatRouteAlternativeLabel(alt)}
                </Button>
              ))}
            </div>
          ) : (
            <span
              data-testid="session-route-no-alternatives"
              className="text-12 text-[var(--text-tertiary)]"
            >
              No healthy alternative routes available in routing.yaml.
            </span>
          )
        }
      />
    </div>
  );
}

export function SessionRouteBlockedBanner({
  sessionId,
  agentKind,
  sessionModel,
}: {
  sessionId: string;
  agentKind: string;
  sessionModel?: string | null;
}) {
  const [health, setHealth] = useState<RouteHealth | null>(null);
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  const [switchingRoute, setSwitchingRoute] = useState<string | null>(null);

  const evaluate = useCallback(async () => {
    if (agentKind !== 'hermes') {
      setHealth(null);
      return;
    }
    const api = window.electronAPI?.maker?.providers;
    if (!api?.list || !api?.discover || !api?.getRouting) return;
    try {
      const [providersRes, routingRes, probes] = await Promise.all([
        api.list(),
        api.getRouting(),
        api.discover(),
      ]);
      const next = assessSessionRouteHealth({
        sessionModel,
        routing: routingRes,
        providers: providersRes.providers ?? [],
        probes: probes ?? [],
      });
      setHealth(next);
    } catch {
      setHealth(null);
    }
  }, [agentKind, sessionModel]);

  useEffect(() => {
    void evaluate();
  }, [evaluate]);

  const handleSelectAlternative = useCallback(
    async (alt: RouteAlternative) => {
      setSwitchingRoute(alt.routeName);
      try {
        await window.electronAPI?.maker?.setModel?.(sessionId, alt.model, alt.provider);
        await sessionService.update(sessionId, {
          model: alt.model,
          providerId: alt.provider,
        });
        await evaluate();
      } finally {
        setSwitchingRoute(null);
      }
    },
    [evaluate, sessionId],
  );

  if (agentKind !== 'hermes' || !health || health.ok) return null;
  const currentKey = `${sessionId}:${sessionModel ?? ''}:${health.reason}:${health.message}`;
  if (dismissedKey === currentKey) return null;

  return (
    <SessionRouteBlockedBannerView
      health={health}
      switchingRoute={switchingRoute}
      onSelectAlternative={(alt) => void handleSelectAlternative(alt)}
      onDismiss={() => setDismissedKey(currentKey)}
    />
  );
}
