/** Copilot's catalog endpoints only answer the editor client headers; a bare Bearer is
 * rejected, which made account model discovery fail silently (#8701). */
export function copilotRequestHeaders(): Record<string, string> {
  return {
    'User-Agent': 'GitHubCopilotChat/0.35.0',
    'Editor-Version': 'vscode/1.107.0',
    'Editor-Plugin-Version': 'copilot-chat/0.35.0',
    'Copilot-Integration-Id': 'vscode-chat',
  };
}

/** Only the official account hosts get Copilot headers, never a user-supplied proxy. */
export function isCopilotEndpoint(value: string): boolean {
  try {
    return new URL(value).hostname.endsWith('.githubcopilot.com');
  } catch {
    return false;
  }
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
