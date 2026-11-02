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
