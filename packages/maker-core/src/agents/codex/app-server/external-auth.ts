/**
 * Codex 0.153.4's experimental external ChatGPT authentication contract.
 * Keep this adapter covered by the real-binary contract test before runtime upgrades.
 * Credentials stay in the selected account's managed home; this process only holds
 * access tokens in memory, while CODEX_HOME remains the native history's home.
 */
export interface CodexChatgptTokens {
  accessToken: string;
  chatgptAccountId: string;
  chatgptPlanType?: string;
}

export interface CodexExternalAuth {
  readTokens: (refresh: boolean, staleAccessToken?: string) => Promise<CodexChatgptTokens>;
}

export const CODEX_EXTERNAL_AUTH_REFRESH = 'account/chatgptAuthTokens/refresh';

export async function assertCodexEphemeralAuth(
  request: (method: string, params: unknown) => Promise<unknown>,
): Promise<void> {
  try {
    const config = await request('config/read', { includeLayers: false }) as {
      config?: { cli_auth_credentials_store?: unknown };
    } | null;
    if (config?.config?.cli_auth_credentials_store !== 'ephemeral') throw new Error();
  } catch {
    throw new Error('Codex could not initialize isolated account authentication');
  }
}

/** Must run before spawn: initialize itself can otherwise load the old auth.json. */
export function useCodexHistoryHome(
  env: Record<string, string>,
  historyHome: string,
): Record<string, string> {
  const result: Record<string, string> = { ...env, CODEX_HOME: historyHome };
  for (const key of ['CODEX_ACCESS_TOKEN', 'CODEX_API_KEY', 'OPENAI_API_KEY',
    'OPENAI_FEDERATION_RULE_ID', 'OPENAI_IDENTITY_TOKEN_FILE', 'OPENAI_WORKLOAD_IDENTITY_CONTEXT']) {
    delete result[key];
  }
  return result;
}

/** One identity per host, including reconnects. Never log/echo authentication payloads. */
export class CodexExternalAuthSession {
  private accountId: string | undefined;
  private accessToken: string | undefined;

  constructor(private readonly source: CodexExternalAuth) {}

  async tokens(refresh: boolean, previousAccountId?: unknown): Promise<CodexChatgptTokens> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (refresh && (!this.accountId || previousAccountId !== this.accountId)) throw new Error();
      const staleAccessToken = refresh ? this.accessToken : undefined;
      const tokens = await Promise.race([
        this.source.readTokens(refresh, staleAccessToken),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error()), 10_000);
          timer.unref?.();
        }),
      ]);
      if (!tokens.accessToken || !tokens.chatgptAccountId) throw new Error();
      if (this.accountId && this.accountId !== tokens.chatgptAccountId) throw new Error();
      if (refresh && tokens.accessToken === staleAccessToken) throw new Error();
      this.accountId = tokens.chatgptAccountId;
      this.accessToken = tokens.accessToken;
      return tokens;
    } catch {
      // A source/JSON-RPC error may include credentials. Do not retain its cause.
      throw new Error('Codex account authentication is unavailable or has changed');
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async authenticate(request: (method: string, params: unknown) => Promise<unknown>): Promise<void> {
    const tokens = await this.tokens(false);
    try {
      const result = await request('account/login/start', { type: 'chatgptAuthTokens', ...tokens });
      if (!result || typeof result !== 'object' || !('type' in result) || result.type !== 'chatgptAuthTokens') {
        throw new Error();
      }
    } catch {
      throw new Error('Codex could not initialize isolated account authentication');
    }
  }
}
