import { PROVIDER_MODEL_CATALOG } from '@cindy/model-providers';

/** Discovery has its own path and client identity, independent of inference API. */
export function copilotModelsRequest(value: string): { url: string; headers: Record<string, string> } | undefined {
  let url: URL;
  try { url = new URL(value); } catch { return undefined; }
  if (url.protocol !== 'https:' || url.port || url.username || url.password
    || !/^api\.(?:(?:individual|business|enterprise)\.)?githubcopilot\.com$/.test(url.hostname)
    || !/^\/(?:v1\/?|(?:v1\/)?models\/?)?$/.test(url.pathname)) return undefined;
  url.pathname = '/models';
  const headers = Object.fromEntries(Object.entries(
    PROVIDER_MODEL_CATALOG.providers['github-copilot']?.[0]?.execution.pi.headers ?? {},
  ).map(([key, value]) => [key.toLowerCase(), value]));
  return { url: url.toString(), headers };
}

/** Copilot inference tokens assign one of three official account API hosts. */
export function resolveCopilotAccountUrl(value: string, token: string): string {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && url.hostname === 'api.individual.githubcopilot.com') {
      const host = token.match(/(?:^|;)proxy-ep=(proxy\.(?:individual|business|enterprise)\.githubcopilot\.com)(?:;|$)/)?.[1];
      if (host) {
        url.hostname = host.replace(/^proxy\./, 'api.');
        return url.toString().replace(/\/$/, '');
      }
    }
  } catch {
    // Keep invalid endpoints for the caller's existing URL validation/error path.
  }
  return value;
}
