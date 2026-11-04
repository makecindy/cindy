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

import { ClaudeCodeAgent } from '@cindy/maker-core/agents/claude-code';
import { CodexAgent } from '@cindy/maker-core/agents/codex';
import { Maker } from '@cindy/maker-core/maker';

import { hasClaudeNativeLogin } from '../../../desktop/src/main/maker-host/claude-native-auth.ts';

const LOGGER = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => LOGGER,
};

/**
 * Subscription-only view: state comes from the shared verdict, and the lane
 * injects no credentials because the CLI authenticates itself.
 */
export function createClaudeSubscriptionAuth() {
  return {
    async getState() {
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
    async getAuthEnv() {
      return {};
    },
  };
}

/**
 * @param {{binaryPath: string, storage: unknown, makerMemory?: unknown}} options
 */
/** Gateway-key lane: the key is injected as ANTHROPIC_API_KEY for the CLI spawn. */
export function createClaudeGatewayAuth(gateway) {
  return {
    async getState() {
      return { authenticated: true, authSource: 'api-key', identity: 'Cindy gateway' };
    },
    async triggerLogin() {
      throw new Error('the Cindy gateway key is managed by the Desktop settings');
    },
    async logout() {
      throw new Error('the Cindy gateway key is managed by the Desktop settings');
    },
    async getAuthEnv() {
      return { ANTHROPIC_API_KEY: gateway.credential };
    },
  };
}

/**
 * Local Codex CLI login lane: the host sets no credentials and lets the CLI read
 * its own `~/.codex` auth, mirroring the Claude subscription rule. Desktop's
 * adapter additionally covers gateway keys and account switching; converging the
 * two is tracked as host/auth TODO.
 */
export function createCodexLocalCliAuth(gateway) {
  return {
    async getState() {
      return { authenticated: true, authSource: 'oauth', identity: 'Codex CLI login' };
    },
    async triggerLogin() {
      throw new Error('sign in with the Codex CLI: codex login');
    },
    async logout() {
      throw new Error('sign out with the Codex CLI; the host does not manage its credentials');
    },
    async getAuthEnv() {
      return gateway?.credential ? { XDT_CODEX_API_KEY: gateway.credential } : {};
    },
  };
}

export function createHostAgentGraph(options) {
  const agent = new ClaudeCodeAgent({
    auth: options.gateway ? createClaudeGatewayAuth(options.gateway) : createClaudeSubscriptionAuth(),
    runtimeConfig: options.gateway ? { endpoint: options.gateway.endpoint } : {},
    binaryPath: options.binaryPath,
    logger: LOGGER,
  });
  const codex = options.codexBinaryPath
    ? new CodexAgent({
        auth: createCodexLocalCliAuth(options.gateway),
        runtimeConfig: {},
        binaryPath: options.codexBinaryPath,
        logger: LOGGER,
      })
    : null;
  const agents = { 'claude-code': agent, ...(codex ? { codex } : {}) };
  const capabilitiesByAgent = Object.fromEntries(
    Object.entries(agents).map(([kind, instance]) => [kind, instance.capabilities]),
  );
  const maker = new Maker({
    agents,
    storage: options.storage,
    logger: LOGGER,
    ...(options.makerMemory ? { makerMemory: options.makerMemory } : {}),
  });
  return { maker, agent, codex, capabilitiesByAgent, instances: agents, agents: Object.keys(agents) };
}
