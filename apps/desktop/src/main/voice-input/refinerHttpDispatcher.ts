import { Agent, type Dispatcher } from 'undici';

import { createLogger } from '../logger.js';
import { resolveOutboundDispatcher } from '../maker-host/outbound-fetch.js';

const log = createLogger('voice-input:refine-dispatcher');

const DEFAULT_KEEPALIVE_MS = 60_000;
// Node's happy-eyeballs (`autoSelectFamily`) default gives each address only
// 250ms to complete its TCP handshake before moving on. On high-RTT or
// VPN-routed networks a legitimate handshake can take longer than that (we
// measured ~300ms to the Codex/Cloudflare edge), so every attempt gets
// aborted and undici surfaces the aggregate as `fetch failed`/ETIMEDOUT even
// though plain curl connects fine. 2500ms tolerates slow-but-working paths
// while still falling over to the next address family well inside the 4s
// refine header watchdog (broken candidates like a refused IPv6 route fail
// fast and do not consume the full attempt budget).
const DEFAULT_CONNECT_ATTEMPT_TIMEOUT_MS = 2_500;

export type RefinerHttpDispatcherOptions = {
  keepAliveMs: number;
  connectAttemptTimeoutMs: number;
};

/**
 * Resolves the shared HTTP pool tuning for refiner transports from env, with
 * defaults suitable for the stop -> refine critical path. Split from the
 * factory so tests can assert the env handling without touching sockets.
 */
export function resolveRefinerHttpDispatcherOptions(
  env: Record<string, string | undefined> = process.env,
): RefinerHttpDispatcherOptions {
  return {
    keepAliveMs: readPositiveIntegerEnv(env, 'XDT_VOICE_INPUT_REFINER_KEEPALIVE_MS', DEFAULT_KEEPALIVE_MS),
    connectAttemptTimeoutMs: readPositiveIntegerEnv(
      env,
      'XDT_VOICE_INPUT_REFINER_CONNECT_ATTEMPT_TIMEOUT_MS',
      DEFAULT_CONNECT_ATTEMPT_TIMEOUT_MS,
    ),
  };
}

/**
 * Builds one keepalive HTTP/1.1 connection pool for a refiner transport.
 *
 * Each transport (Codex responses, LiteLLM chat completions) keeps its own
 * pool so cross-host connections never mix, but they share the same tuning:
 * - keepalive past Node's ~4s default keeps the TLS handshake out of the
 *   critical path of repeated voice refinements during a typical session;
 * - the happy-eyeballs attempt timeout above keeps high-RTT networks from
 *   being misclassified as unreachable.
 */
export function createRefinerHttpDispatcher(): Agent {
  return new Agent(refinerAgentOptions(resolveRefinerHttpDispatcherOptions()));
}

/** 上面两种池共用的 undici Agent 配置(直连池与代理池同调优)。 */
function refinerAgentOptions(options: RefinerHttpDispatcherOptions): Agent.Options {
  return {
    keepAliveTimeout: options.keepAliveMs,
    keepAliveMaxTimeout: 600_000,
    connections: 4,
    connect: {
      autoSelectFamilyAttemptTimeout: options.connectAttemptTimeoutMs,
    },
  };
}

/**
 * 取本次请求该用的池:系统代理生效时给一个同调优的代理池(见
 * `maker-host/outbound-fetch.ts` —— 裸 undici 不吃系统代理,`chatgpt.com` 这类境外
 * refiner 上游在「系统代理」模式下会直连失败),否则原样用调用方的直连池。
 */
export async function resolveRefinerDispatcher(url: string, direct: Agent): Promise<Dispatcher> {
  const resolved = await resolveOutboundDispatcher(url, {
    fallback: direct,
    agentOptions: refinerAgentOptions(resolveRefinerHttpDispatcherOptions()),
  });
  return resolved ?? direct;
}

function readPositiveIntegerEnv(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    log.debug('invalid numeric env, using fallback', { name, value: raw, fallback });
    return fallback;
  }
  return parsed;
}
