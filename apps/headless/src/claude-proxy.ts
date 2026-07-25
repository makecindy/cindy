import {
  createAnthropicCompatProxy,
  type ProxyHandle,
  type ProxyLogger,
} from '@cindy/anthropic-compat-proxy';
import type { Logger } from '@cindy/maker-core';
import { HeadlessProviderRouter } from './provider-router.js';

/**
 * A loopback-only Claude endpoint.  Agent processes receive only this URL and
 * a placeholder key; the selected provider and its real credential are bound
 * at request time inside the daemon.
 */
export class HeadlessClaudeProxy {
  private handle: ProxyHandle | null = null;

  constructor(
    private readonly router: HeadlessProviderRouter,
    logger?: Logger,
  ) {
    this.logger = {
      debug: (message, context) => logger?.debug(message, context),
      info: (message, context) => logger?.info(message, context),
      warn: (message, context) => logger?.warn(message, context),
      error: (message, context) => logger?.error(message, context),
    };
  }

  private readonly logger: ProxyLogger;

  async start(): Promise<string> {
    if (!this.handle) {
      this.handle = await createAnthropicCompatProxy({
        upstream: 'https://api.anthropic.com',
        logger: this.logger,
        routingTransform: async (_body, context) =>
          this.router.routeClaudeRequest(context.headers['x-claude-code-session-id']),
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
