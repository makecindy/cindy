/**
 * claude-env — assemble the subset of xdt-maker's local Claude Code env
 * that should be ferried to the remote when running Claude there.
 *
 * Why a curated subset (not the full `buildClaudeEnv`)?
 *   - cleanProcessEnv leaks the host machine's whole env — useless on remote.
 *   - CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST is the SDK's local-spawn anti-
 *     override token; not relevant when remote Claude reads its own settings.
 *   - The loopback compat-proxy URL is `127.0.0.1:<port>`; sending it to
 *     a remote is useless (and a footgun if the remote ever tried to dial).
 *
 * What we DO ferry — every var here is something that materially changes
 * how the remote `claude --print` talks to the backend:
 *   1. ANTHROPIC_API_KEY                 — auth (from safeStorage)
 *   2. ANTHROPIC_BASE_URL                — upstream endpoint (company gateway)
 *   3. CLAUDE_CODE_SKIP_FAST_MODE_NETWORK_ERRORS  } behavior flags that
 *   4. CLAUDE_AUTOCOMPACT_PCT_OVERRIDE             } the local app sets,
 *   5. CLAUDE_CODE_ATTRIBUTION_HEADER              } matching the same
 *   6. ENABLE_TOOL_SEARCH                          } proxy behaviour
 *   7. DISABLE_TELEMETRY                 } silence telemetry that would
 *   8. DISABLE_ERROR_REPORTING           } 401 against company proxy
 *   9. OTEL_SDK_DISABLED                 }
 *
 * Security: every value here is potentially secret (esp. the API key).
 * Callers MUST inject via stdin (never via cmd line) so values don't leak
 * into `ps` / timeout / error / log paths. See oneShotCommand for the
 * stdin-wrapper protocol.
 */

import { readClaudeApiKey } from '../maker-host/auth-adapters.js';
import { claudeUpstreamEndpoint } from '../maker-host/runtime-configs.js';

/**
 * Return env vars to inject when running `claude --print` on a remote.
 * Returns null if no API key is configured locally — caller should surface
 * a "connect XD Gateway in xdt-maker first" error rather than running
 * a doomed remote command.
 *
 * Keys mirror `buildClaudeEnv` for parity with local Claude behaviour, minus
 * local-only bits (loopback URL, MANAGED_BY_HOST). Bump alongside any new
 * behaviour flag added in `claude-behavior-flags.ts` (runtime-configs 的
 * behaviorFlags 来源)。
 *
 * Claude 'oauth' (subscription) mode is intentionally NOT honored on remote:
 * the per-model OAuth↔gateway split lives in the LOCAL loopback proxy, which a
 * remote machine can't reach. So remote Claude always uses the gateway key +
 * gateway endpoint regardless of the local auth-mode toggle, and the user's
 * Claude.ai subscription token is NEVER ferried to a remote host. (Mirrors the
 * existing remote + compat-mode restriction.) Reads the gateway key directly,
 * not desktopClaudeAuthAdapter.getAuthEnv() — the latter returns the OAuth token
 * (no ANTHROPIC_API_KEY) in oauth mode, which would be wrong here.
 */
export function getRemoteClaudeEnv(): Record<string, string> | null {
  const apiKey = readClaudeApiKey();
  if (!apiKey) return null;
  // Endpoint pairs with the key (model-access issued; empty = gateway not
  // ready / legacy manual key). An empty ANTHROPIC_BASE_URL would make the
  // remote CLI fall back to api.anthropic.com and send the gateway key there
  // — misleading 401. Treat it the same as "no key": caller surfaces the
  // "connect XD Gateway in xdt-maker first" error.
  const baseUrl = claudeUpstreamEndpoint().trim();
  if (!baseUrl) return null;
  return {
    // Auth — same key as local.
    ANTHROPIC_API_KEY: apiKey,
    // Always the upstream (company internal gateway), never local loopback.
    ANTHROPIC_BASE_URL: baseUrl,
    // Behaviour flags — must match local so remote talks to the same proxy
    // the same way. Especially ENABLE_TOOL_SEARCH: without it CC sends full
    // tool defs on every request to non-first-party hosts (big bandwidth hit).
    CLAUDE_CODE_SKIP_FAST_MODE_NETWORK_ERRORS: '1',
    CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '75',
    // 远端恒为 gateway-spawn(订阅 token 不上远端,见上方 doc),归因块只降网关缓存
    // 命中率,保持禁用 —— 本地按 spawn 形态条件化的逻辑(claude-behavior-flags.ts,
    // issue #758)不适用于这里。
    CLAUDE_CODE_ATTRIBUTION_HEADER: '0',
    ENABLE_TOOL_SEARCH: 'auto',
    // Telemetry off — endpoints would 401 against the company proxy
    // (telemetry hits real api.anthropic.com which doesn't accept our token),
    // creating log noise without value.
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
    OTEL_SDK_DISABLED: 'true',
  };
}
