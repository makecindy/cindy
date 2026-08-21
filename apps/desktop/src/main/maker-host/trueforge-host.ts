import { TrueForgeAgent, type AuthAdapter, type Logger } from '@cindy/maker-core';

export const TRUEFORGE_ENV = {
  baseUrl: 'CINDY_TRUEFORGE_BASE_URL',
  model: 'CINDY_TRUEFORGE_MODEL',
  displayName: 'CINDY_TRUEFORGE_MODEL_DISPLAY_NAME',
  contextWindow: 'CINDY_TRUEFORGE_CONTEXT_WINDOW',
  idToken: 'CINDY_TRUEFORGE_ID_TOKEN',
} as const;

export interface TrueForgeHostConfig {
  baseUrl: string;
  model: string;
  displayName?: string;
  contextWindow: number;
  idToken?: string;
}

function isLoopback(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

/** Parse an opt-in service config without ever returning/logging the token separately. */
export function readTrueForgeHostConfig(
  env: NodeJS.ProcessEnv = process.env,
): TrueForgeHostConfig | null {
  const rawBaseUrl = env[TRUEFORGE_ENV.baseUrl]?.trim();
  const model = env[TRUEFORGE_ENV.model]?.trim();
  if (!rawBaseUrl && !model) return null;
  if (!rawBaseUrl || !model) {
    throw new Error(
      `${TRUEFORGE_ENV.baseUrl} and ${TRUEFORGE_ENV.model} must be configured together`,
    );
  }

  const url = new URL(rawBaseUrl);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      `${TRUEFORGE_ENV.baseUrl} must not contain credentials, query parameters, or a fragment`,
    );
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname))) {
    throw new Error(
      `${TRUEFORGE_ENV.baseUrl} must use HTTPS, except for an explicit loopback address`,
    );
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new Error(
      `${TRUEFORGE_ENV.baseUrl} must be the TrueForge origin, without /api/v1 or another path`,
    );
  }
  if (!model.includes('/') || model.startsWith('/') || model.endsWith('/')) {
    throw new Error(`${TRUEFORGE_ENV.model} must be a TrueForge provider/model name`);
  }

  const rawContextWindow = env[TRUEFORGE_ENV.contextWindow]?.trim();
  const contextWindow = rawContextWindow ? Number(rawContextWindow) : 128_000;
  if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0) {
    throw new Error(`${TRUEFORGE_ENV.contextWindow} must be a positive integer`);
  }

  const displayName = env[TRUEFORGE_ENV.displayName]?.trim();
  const idToken = env[TRUEFORGE_ENV.idToken]?.trim();
  return {
    baseUrl: url.origin,
    model,
    ...(displayName ? { displayName } : {}),
    contextWindow,
    ...(idToken ? { idToken } : {}),
  };
}

export interface BuildTrueForgeAgentOptions {
  logger: Logger;
  fetch: typeof globalThis.fetch;
  env?: NodeJS.ProcessEnv;
}

/**
 * Register TrueForge only when the user explicitly supplies both endpoint and
 * model. The optional OIDC ID token stays in the main-process SDK closure.
 */
export function buildTrueForgeAgent(options: BuildTrueForgeAgentOptions): TrueForgeAgent | null {
  const config = readTrueForgeHostConfig(options.env);
  if (!config) return null;

  const authState = async () => ({
    authenticated: true as const,
    identity: `TrueForge · ${new URL(config.baseUrl).host}`,
    ...(config.idToken ? { authSource: 'oauth' as const } : {}),
  });
  const auth: AuthAdapter = {
    getState: authState,
    triggerLogin: authState,
    async logout() {
      /* environment-owned configuration cannot be mutated here */
    },
    async getAuthEnv() {
      return {};
    },
  };

  return new TrueForgeAgent(
    {
      auth,
      runtimeConfig: { endpoint: config.baseUrl },
      binaryPath: '',
      runtimeKind: 'service',
      logger: options.logger.child('trueforge'),
    },
    { ...config, fetch: options.fetch },
  );
}
