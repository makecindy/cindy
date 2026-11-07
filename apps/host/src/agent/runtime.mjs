/**
 * Agent graph for the host: real maker-core agents over the shared storage.
 *
 * Scope today is the Claude subscription lane, because that is the only lane
 * whose verdict is already shared with the Desktop (`hasClaudeNativeLogin`).
 * API-key and gateway lanes stay with the Desktop adapter until `auth-adapters`
 * itself becomes portable; this adapter intentionally refuses them instead of
 * guessing.
 *
 * TODO(host/auth): replace this adapter with the Desktop one once
 * `maker-host/auth-adapters.ts` reads its profile root and cipher from injected
 * ports; the host must not keep a second credential implementation.
 */

import path from 'node:path';
import { ClaudeCodeAgent } from '@cindy/maker-core/agents/claude-code';
import { CodexAgent } from '@cindy/maker-core/agents/codex';
import { Maker, PiAgent } from '@cindy/maker-core';

import { hasClaudeNativeLogin } from '../../../desktop/src/main/maker-host/claude-native-auth.ts';

export const LOGGER = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => LOGGER,
};

const missingRouteResolver = async () => { throw new Error('Provider credential resolver is unavailable'); };

/**
 * Subscription-only view: state comes from the shared verdict, and the lane
 * injects no credentials because the CLI authenticates itself.
 */
export function createClaudeSubscriptionAuth(gateway, resolveRoute = missingRouteResolver) {
  return {
    async getState(opts) {
      if (opts?.providerId && opts.providerId !== 'xd' && opts.providerId !== 'cindy') {
        try { await resolveRoute(opts.providerId, 'claude-code'); return { authenticated: true, authSource: 'api-key', identity: opts.providerId }; }
        catch { return { authenticated: false, errorReason: 'not_connected' }; }
      }
      return hasClaudeNativeLogin()
        ? { authenticated: true, authSource: 'oauth', identity: 'Claude subscription' }
        : { authenticated: false, errorReason: 'not_connected' };
    },
    async triggerLogin() {
      throw new Error('sign in with the built-in Claude Code CLI: claude auth login --claudeai');
    },
    async logout() {
      throw new Error('sign out with the Claude Code CLI; the host does not manage its credentials');
    },
    async getAuthEnv(opts) {
      const custom = opts?.providerId && !['xd', 'cindy'].includes(opts.providerId) ? await resolveRoute(opts.providerId, 'claude-code') : null;
      if (custom) {
        return {
          ANTHROPIC_BASE_URL: custom.anthropicBaseUrl,
          ANTHROPIC_API_KEY: custom.apiKey ?? 'cindy-keyless-provider',
        };
      }
      return {};
    },
  };
}

/**
 * @param {{binaryPath: string, storage: unknown, makerMemory?: unknown}} options
 */
/** Gateway-key lane: the key is injected as ANTHROPIC_API_KEY for the CLI spawn. */
export function createClaudeGatewayAuth(gateway, resolveRoute = missingRouteResolver) {
  return {
    async getState(opts) {
      if (opts?.providerId && opts.providerId !== 'xd' && opts.providerId !== 'cindy') {
        try { await resolveRoute(opts.providerId, 'claude-code'); return { authenticated: true, authSource: 'api-key', identity: opts.providerId }; }
        catch { return { authenticated: false, errorReason: 'not_connected' }; }
      }
      return { authenticated: true, authSource: 'api-key', identity: 'Cindy gateway' };
    },
    async triggerLogin() {
      throw new Error('the Cindy gateway key is managed by the Desktop settings');
    },
    async logout() {
      throw new Error('the Cindy gateway key is managed by the Desktop settings');
    },
    async getAuthEnv(opts) {
      const custom = opts?.providerId && !['xd', 'cindy'].includes(opts.providerId) ? await resolveRoute(opts.providerId, 'claude-code') : null;
      if (custom) {
        return {
          ANTHROPIC_BASE_URL: custom.anthropicBaseUrl,
          ANTHROPIC_API_KEY: custom.apiKey ?? 'cindy-keyless-provider',
        };
      }
      return gateway?.credential ? { ANTHROPIC_API_KEY: gateway.credential } : {};
    },
  };
}

/**
 * Local Codex CLI login lane: the host sets no credentials and lets the CLI read
 * its own `~/.codex` auth, mirroring the Claude subscription rule. Desktop's
 * adapter additionally covers gateway keys and account switching; converging the
 * two is tracked as host/auth TODO.
 */
export function createCodexLocalCliAuth(gateway, resolveRoute = missingRouteResolver) {
  return {
    async getState(opts) {
      if (opts?.providerId && opts.providerId !== 'xd' && opts.providerId !== 'cindy') {
        try { await resolveRoute(opts.providerId, 'codex'); return { authenticated: true, authSource: 'api-key', identity: opts.providerId }; }
        catch { return { authenticated: false, errorReason: 'not_connected' }; }
      }
      return { authenticated: true, authSource: 'oauth', identity: 'Codex CLI login' };
    },
    async triggerLogin() {
      throw new Error('sign in with the Codex CLI: codex login');
    },
    async logout() {
      throw new Error('sign out with the Codex CLI; the host does not manage its credentials');
    },
    async getAuthEnv(opts) {
      if (opts?.providerId && opts.providerId !== 'xd' && opts.providerId !== 'cindy') {
        const custom = await resolveRoute(opts.providerId, 'codex');
        if (custom) {
          const baseUrl = custom.rawUrl.endsWith('/v1') ? custom.rawUrl : `${custom.rawUrl}/v1`;
          return {
            OPENAI_BASE_URL: baseUrl,
            OPENAI_API_KEY: custom.apiKey ?? 'cindy-keyless-provider',
          };
        }
      }
      return gateway?.credential ? { XDT_CODEX_API_KEY: gateway.credential } : {};
    },
  };
}

export function createPiAuthAdapter(gateway) {
  return {
    async getState() {
      return { authenticated: true, authSource: 'api-key', identity: 'Pi' };
    },
    async triggerLogin() {
      return { authenticated: true };
    },
    async logout() {},
    async getAuthEnv() {
      return gateway?.credential ? { CINDY_PI_API_KEY: gateway.credential } : {};
    },
  };
}

export function createHostAgentGraph(options) {
  const mcpProviders = options.mcpProviders ?? [];
  const agent = options.binaryPath ? new ClaudeCodeAgent({
    auth: options.gateway ? createClaudeGatewayAuth(options.gateway, options.resolveProviderRoute) : createClaudeSubscriptionAuth(options.gateway, options.resolveProviderRoute),
    runtimeConfig: {
      ...(options.gateway ? { endpoint: options.gateway.endpoint } : {}),
      // The session flag gates whether cindy_memory is registered at all.
      ...(options.makerMemory ? { makerMemoryEnabled: options.makerMemory.isEnabled() } : {}),
    },
    binaryPath: options.binaryPath,
    logger: LOGGER,
    ...(mcpProviders.length > 0 ? { mcpProviders } : {}),
    ...(options.makerMemory ? { makerMemory: options.makerMemory } : {}),
  }) : null;
  const codex = options.codexBinaryPath
    ? new CodexAgent({
        auth: createCodexLocalCliAuth(options.gateway, options.resolveProviderRoute),
        runtimeConfig: {},
        binaryPath: options.codexBinaryPath,
        logger: LOGGER,
        ...(options.makerMemory ? { makerMemory: options.makerMemory } : {}),
      })
    : null;
  const pi = options.piBinaryPath
    ? new PiAgent({
        auth: createPiAuthAdapter(options.gateway),
        runtimeConfig: {
          ...(options.gateway ? { endpoint: options.gateway.endpoint } : {}),
        },
        binaryPath: options.piBinaryPath,
        logger: LOGGER,
        resolvePiAgentHome: () => path.join(options.userDataDir ?? process.cwd(), 'pi-agent-home'),
        resolvePiNativeProviders: async () => {
          try {
            const { listProviders } = await import('./providers.mjs');
            const catalog = await listProviders(options.gateway ? { gateway: options.gateway } : {});
            const providers = [];
            const env = {};
            for (const p of catalog.providers ?? []) {
              if (p.id === 'xd' || p.id === 'cindy' || !p.routing?.pi) continue;
              const route = await options.resolveProviderRoute(p.id, 'pi');
              const envKey = `CINDY_PROVIDER_${providers.length}_KEY`;
              if (route.apiKey) env[envKey] = route.apiKey;
              const seenModelIds = new Set();
              const allRawModels = [
                ...(Array.isArray(p.models) ? p.models : []),
                ...(p.models?.pi ?? []),
                ...(p.models?.['claude-code'] ?? []),
                ...(p.models?.codex ?? []),
              ];
              const piModels = [];
              for (const m of allRawModels) {
                if (m && m.id && !seenModelIds.has(m.id)) {
                  seenModelIds.add(m.id);
                  piModels.push({
                    id: m.id,
                    name: m.name ?? m.id,
                    wireId: m.id,
                    contextWindow: m.contextWindow ?? 1048576,
                    maxOutputTokens: m.maxOutput ?? 128000,
                    efforts: m.efforts ?? [],
                    defaultEffort: m.defaultEffort ?? null,
                  });
                }
              }
              const baseUrl = route.rawUrl;
              providers.push({
                id: p.id,
                sourceProviderId: p.id,
                name: p.name,
                baseUrl,
                api: { 'anthropic-messages': 'anthropic-messages', 'openai-chat': 'openai-completions', 'openai-responses': 'openai-responses', 'google-generative-ai': 'google-generative-ai' }[route.protocol],
                models: piModels,
                ...(route.apiKey ? { apiKeyEnvVar: envKey } : {}),
              });
            }
            return {
              providers,
              env,
            };
          } catch (err) {
            console.error('[resolvePiNativeProviders] failed:', err);
            throw err;
          }
        },
        ...(options.makerMemory ? { makerMemory: options.makerMemory } : {}),
      })
    : null;
  const agents = {
    ...(agent ? { 'claude-code': agent } : {}),
    ...(codex ? { codex } : {}),
    ...(pi ? { pi } : {}),
  };
  const capabilitiesByAgent = Object.fromEntries(
    Object.entries(agents).map(([kind, instance]) => [kind, instance.capabilities]),
  );
  const maker = new Maker({
    agents,
    storage: options.storage,
    logger: LOGGER,
    ...(options.makerMemory ? { makerMemory: options.makerMemory } : {}),
  });
  return { maker, agent, codex, pi, capabilitiesByAgent, instances: agents, agents: Object.keys(agents) };
}
