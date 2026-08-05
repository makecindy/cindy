const NON_SESSION_CC_AGENT_ROUTES = new Set([
  'boot',
  'files',
  'new',
  'new-dialogue',
  'orca',
  'scheduled',
]);

function routeSessionId(value: string | null): string | null {
  const sessionId = value?.trim() ?? '';
  if (
    !sessionId
    || sessionId.length > 256
    || sessionId.includes('/')
    || NON_SESSION_CC_AGENT_ROUTES.has(sessionId)
  ) return null;
  return sessionId;
}

export function atContextVisibleSessionIdsFromRendererUrl(rendererUrl: string): Set<string> {
  const sessionIds = new Set<string>();
  try {
    const appUrl = new URL(rendererUrl);
    const route = appUrl.hash.startsWith('#') ? appUrl.hash.slice(1) : '';
    if (!route.startsWith('/')) return sessionIds;
    const routeUrl = new URL(route, 'cindy://renderer');
    const segments = routeUrl.pathname.split('/').filter(Boolean);
    if (segments[0] !== 'cc-agent') return sessionIds;

    if (segments.length === 2) {
      const primary = routeSessionId(decodeURIComponent(segments[1] ?? ''));
      if (primary) sessionIds.add(primary);
      const worker = routeSessionId(routeUrl.searchParams.get('worker'));
      if (worker) sessionIds.add(worker);
    } else if (segments.length === 3 && segments[1] === 'orca') {
      const legacyOrcaSession = routeSessionId(decodeURIComponent(segments[2] ?? ''));
      if (legacyOrcaSession) sessionIds.add(legacyOrcaSession);
    }
  } catch {
    // Invalid or transient renderer locations fail closed.
  }
  return sessionIds;
}
