import {
  createAnthropicCompatProxy,
  type ProxyHandle,
  type ProxyLogger,
} from '@cindy/anthropic-compat-proxy';
import type { Logger } from '@cindy/maker-core';
import { HeadlessProviderRouter } from './provider-router.js';

export const CODEX_PROXY_ENV_KEY = 'CINDY_CODEX_PROXY_KEY';
const CODEX_PROXY_PLACEHOLDER_KEY = 'cindy-headless-codex-proxy-placeholder';

/** Loopback-only Responses proxy used by the shared Codex app-server process. */
export class HeadlessCodexProxy {
  private handle: ProxyHandle | null = null;
  private readonly logger: ProxyLogger;

  constructor(private readonly router: HeadlessProviderRouter, logger?: Logger) {
    this.logger = {
      debug: (message, context) => logger?.debug(message, context),
      info: (message, context) => logger?.info(message, context),
      warn: (message, context) => logger?.warn(message, context),
      error: (message, context) => logger?.error(message, context),
    };
  }

  async start(): Promise<string> {
    if (!this.handle) {
      this.handle = await createAnthropicCompatProxy({
        upstream: 'https://chatgpt.com/backend-api/codex',
        maxRequestBodyBytes: 128 * 1024 * 1024,
        logger: this.logger,
        routingTransform: async (_body, context) =>
          this.router.routeCodexRequest(threadIdFromHeaders(context.headers)),
      });
    }
    return this.handle.url;
  }

  async stop(): Promise<void> {
    const handle = this.handle;
    this.handle = null;
    await handle?.dispose();
  }
}

export function buildCodexProxySpawnArgs(endpoint: string, authMode: 'oauth-bearer' | 'provider-oauth'): string[] {
  const id = 'cindy_headless';
  return [
    '-c', `model_provider="${id}"`,
    '-c', `model_providers.${id}.name="Cindy Headless"`,
    '-c', `model_providers.${id}.base_url="${endpoint}"`,
    '-c', `model_providers.${id}.wire_api="responses"`,
    '-c', authMode === 'oauth-bearer'
      ? `model_providers.${id}.requires_openai_auth=true`
      : `model_providers.${id}.env_key="${CODEX_PROXY_ENV_KEY}"`,
    '-c', `model_providers.${id}.supports_websockets=false`,
  ];
}

export function codexProxyAuthEnv(): Record<string, string> {
  return { [CODEX_PROXY_ENV_KEY]: CODEX_PROXY_PLACEHOLDER_KEY };
}

function threadIdFromHeaders(headers: Readonly<Record<string, string>>): string | undefined {
  return headers['thread-id'] || headers['x-client-request-id'];
}
