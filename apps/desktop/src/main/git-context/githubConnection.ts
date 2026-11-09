import type { GithubConnectionState } from '../../shared/githubSetup.js';

/** Verify the effective credential without returning credentials or remote error bodies. */
export async function githubConnection(deps: {
  readGh(): Promise<string | null>;
  readFallback(): string | null;
  fetch: typeof fetch;
}): Promise<GithubConnectionState> {
  let source: 'gh-cli' | 'token' = 'gh-cli';
  try {
    let token = await deps.readGh();
    if (!token) {
      source = 'token';
      token = deps.readFallback();
    }
    if (!token) return { status: 'missing' };
    const response = await deps.fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return {
        status:
          response.status === 401 ? 'auth' : response.status === 403 ? 'forbidden' : 'network',
        source,
      };
    }
    const data = (await response.json()) as { login?: unknown };
    return typeof data.login === 'string' && /^[a-zA-Z0-9-]{1,39}$/.test(data.login)
      ? { status: 'connected', login: data.login, source }
      : { status: 'network', source };
  } catch {
    return { status: 'network', source };
  }
}

/**
 * connect_account for a plugin that signs in through this computer's GitHub login (`gh-cli` secrets,
 * such as the GitHub plugin). Ready when the sign-in works; otherwise Cindy opens its own GitHub
 * sign-in dialog and the task waits for the user there. Never returns or asks for credentials.
 */
export async function connectGithubSignInResult(
  ghostId: string,
  reauthorize: boolean,
  deps: { readConnection(): Promise<GithubConnectionState>; openSignIn(): boolean },
): Promise<Record<string, unknown>> {
  const connection = await deps.readConnection();
  if (connection.status === 'connected' && !reauthorize) {
    return {
      ok: true, status: 'ready', ghostId, login: connection.login,
      message: 'GitHub is signed in on this computer. No plugin business operation was executed; platform permissions are verified only by the requested operation.',
    };
  }
  const opened = deps.openSignIn();
  return {
    ok: false, errorCode: 'GITHUB_SIGN_IN_REQUIRED', ghostId, signInOpened: opened,
    ...(connection.status === 'connected' ? {} : { connection: connection.status }),
    message: opened
      ? 'Cindy opened its GitHub sign-in on this computer. Tell the user to finish it there, then continue the original task. Do not request tokens in chat or retry this call in a loop.'
      : 'Ask the user to sign in to GitHub in Cindy (the GitHub plugin\'s page, or the PR status next to the task title). Do not request tokens in chat.',
  };
}
