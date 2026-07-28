/**
 * Real browser-control runtime.
 *
 * Drives the vendored in-process route dispatcher
 * (`_generated/extension/src/browser/local-dispatch.runtime.ts`) behind the
 * neutral `BrowserControlRuntime` contract. Translates our flat
 * `BrowserControlRequest.action` into the dispatcher's (method, path, query,
 * body) shape — the same control API the upstream HTTP server exposes, but
 * invoked in-process with no socket.
 */
import { dispatchBrowserControlRequest } from './_generated/extension/src/browser/local-dispatch.runtime.js';
import { setBrowserRuntimeConfig } from './shim/runtime-config-snapshot.js';
import { setBrowserRuntimeLogSink, type LogSink } from './shim/logging-core.js';
import { sanitizeNaming, sanitizeNamingString } from './shim/sanitize-naming.js';
import type { OpenClawConfig } from './shim/config-contracts.js';
import type {
  BrowserControlAction,
  BrowserControlRequest,
  BrowserControlResult,
  BrowserControlRuntime,
} from './types.js';

type Method = 'GET' | 'POST' | 'DELETE';
interface DispatchPlan {
  method: Method;
  path: string;
  query?: Record<string, unknown>;
  body?: unknown;
}

/**
 * Runtime-OWNED diagnostic actions: their SUCCESS body is the runtime's own
 * health/identity text (profile driver labels, doctor summary + fix hints), which
 * legitimately carries the vendored brand name. We scrub those on success too.
 * Page/network actions (snapshot/extract/requests/responseBody/navigate/…) are NOT
 * in this set — their success body is the user's page/network content and stays
 * verbatim (scrubbing it would corrupt a page that legitimately mentions the name).
 */
const DIAGNOSTIC_ACTIONS: ReadonlySet<BrowserControlAction> = new Set([
  'status',
  'profiles',
  'doctor',
]);

/** Build the dispatcher (method, path, query, body) for a control request.
 *  Exported (pure) so the param-forwarding can be unit-tested as a regression
 *  net against future vendored re-syncs silently dropping fields. */
export function planDispatch(req: BrowserControlRequest): DispatchPlan {
  const profileQuery = req.profile ? { profile: req.profile } : undefined;
  const withProfile = (q?: Record<string, unknown>): Record<string, unknown> | undefined => {
    const merged = { ...profileQuery, ...q };
    return Object.keys(merged).length > 0 ? merged : undefined;
  };
  const a: BrowserControlAction = req.action;
  switch (a) {
    case 'doctor':
      return { method: 'GET', path: '/doctor', query: withProfile() };
    case 'status':
      return { method: 'GET', path: '/', query: withProfile() };
    case 'profiles':
      return { method: 'GET', path: '/profiles', query: withProfile() };
    case 'start':
      return { method: 'POST', path: '/start', query: withProfile(), body: {} };
    case 'stop':
      return { method: 'POST', path: '/stop', query: withProfile(), body: {} };
    case 'tabs':
      return { method: 'GET', path: '/tabs', query: withProfile() };
    case 'open':
      return {
        method: 'POST',
        path: '/tabs/open',
        query: withProfile(),
        body: { url: req.url ?? req.targetUrl, label: req.label },
      };
    case 'focus':
      return {
        method: 'POST',
        path: '/tabs/focus',
        query: withProfile(),
        body: { targetId: req.targetId, label: req.label },
      };
    case 'close':
      return {
        method: 'DELETE',
        path: `/tabs/${encodeURIComponent(req.targetId ?? '')}`,
        query: withProfile(),
      };
    case 'navigate':
      return {
        method: 'POST',
        path: '/navigate',
        query: withProfile(),
        body: { url: req.url, targetId: req.targetId },
      };
    case 'snapshot':
      return {
        method: 'GET',
        path: '/snapshot',
        query: withProfile({
          targetId: req.targetId,
          format: req.snapshotFormat,
          refs: req.refs,
          interactive: req.interactive,
          compact: req.compact,
          depth: req.depth,
          mode: req.mode,
          selector: req.selector,
          frame: req.frame,
          labels: req.labels,
          urls: req.urls,
          limit: req.limit,
          // The vendored /snapshot route consumes query.maxChars to bound a large
          // snapshot; forward it so `snapshot maxChars:N` isn't silently dropped
          // (otherwise it falls through to the outer 200k result truncation).
          maxChars: req.maxChars,
          // Same: resolveSnapshotPlan reads query.timeoutMs — forward it so a
          // caller's `timeoutMs` for a slow page isn't silently dropped to the
          // default snapshot timeout.
          timeoutMs: req.timeoutMs,
        }),
      };
    case 'screenshot':
      return {
        method: 'POST',
        path: '/screenshot',
        query: withProfile(),
        body: {
          targetId: req.targetId,
          fullPage: req.fullPage,
          ref: req.ref,
          element: req.element,
          type: req.type,
          labels: req.labels,
          timeoutMs: req.timeoutMs,
        },
      };
    case 'console':
      return {
        method: 'GET',
        path: '/console',
        query: withProfile({ targetId: req.targetId, level: req.level }),
      };
    case 'pdf':
      return { method: 'POST', path: '/pdf', query: withProfile(), body: { targetId: req.targetId } };
    case 'upload':
      return {
        method: 'POST',
        path: '/hooks/file-chooser',
        query: withProfile(),
        body: {
          paths: req.paths,
          ref: req.ref,
          inputRef: req.inputRef,
          element: req.element,
          query: req.query,
          targetId: req.targetId,
          timeoutMs: req.timeoutMs,
        },
      };
    case 'dialog':
      return {
        method: 'POST',
        path: '/hooks/dialog',
        query: withProfile(),
        body: {
          accept: req.accept,
          promptText: req.promptText,
          dialogId: req.dialogId,
          targetId: req.targetId,
          timeoutMs: req.timeoutMs,
        },
      };
    case 'act':
      return {
        method: 'POST',
        path: '/act',
        query: withProfile(),
        // The /act normalizer reads body.timeoutMs for click/type/wait/evaluate.
        // Forward the top-level timeoutMs too (extract nests it inside request;
        // a raw `act` call carries it at the top), preferring an explicit nested
        // value if present.
        body: {
          ...req.request,
          targetId: req.request?.targetId ?? req.targetId,
          timeoutMs: req.request?.timeoutMs ?? req.timeoutMs,
        },
      };
    case 'requests':
      // Captured request metadata (method/url/status/...). Buffered per-page by
      // the vendored runtime; `clear` empties the buffer after reading.
      return {
        method: 'GET',
        path: '/requests',
        query: withProfile({ targetId: req.targetId, filter: req.filter, clear: req.clear }),
      };
    case 'responseBody':
      // Bounded response body for a URL pattern (read live via playwright).
      // `url` is required; `maxChars` caps the returned text.
      return {
        method: 'POST',
        path: '/response/body',
        query: withProfile(),
        body: {
          targetId: req.targetId,
          url: req.url,
          timeoutMs: req.timeoutMs,
          maxChars: req.maxChars,
        },
      };
    default: {
      const exhaustive: never = a;
      throw new Error(`unknown browser action: ${String(exhaustive)}`);
    }
  }
}

export interface CreateBrowserControlRuntimeOptions {
  /** Effective browser config (profiles, ssrf policy, ports). */
  config?: OpenClawConfig;
  /** Route runtime logs into the host's unified logger. */
  logSink?: LogSink;
}

/** Create a runtime backed by the vendored in-process dispatcher. */
export function createBrowserControlRuntime(
  options: CreateBrowserControlRuntimeOptions = {},
): BrowserControlRuntime {
  if (options.config) setBrowserRuntimeConfig(options.config);
  if (options.logSink) setBrowserRuntimeLogSink(options.logSink);

  return {
    async call(request: BrowserControlRequest): Promise<BrowserControlResult> {
      let plan: DispatchPlan;
      try {
        plan = planDispatch(request);
      } catch (err) {
        return {
          ok: false,
          action: request.action,
          errorCode: 'BROWSER_RUNTIME_INVALID_REQUEST',
          message: err instanceof Error ? err.message : String(err),
        };
      }
      try {
        const res = await dispatchBrowserControlRequest({
          method: plan.method,
          path: plan.path,
          query: plan.query,
          body: plan.body,
        });
        const ok = res.status < 400;
        return {
          ok,
          action: request.action,
          status: res.status,
          // SUCCESS body handling is action-aware:
          //  - Runtime-owned diagnostics (status/profiles/doctor) carry the
          //    vendored brand in driver labels / fix hints, so scrub them.
          //  - Page/network payloads (snapshot/extract/responseBody/…) are the
          //    user's content — return verbatim; scrubbing would corrupt a page
          //    that legitimately mentions the name. Injected page markers (the
          //    overlay attribute) are stripped by the snapshot route already.
          // On ERROR the body is always runtime-owned diagnostic text, so it
          // stays scrubbed regardless of action.
          data:
            ok && !DIAGNOSTIC_ACTIONS.has(request.action) ? res.body : sanitizeNaming(res.body),
          ...(ok
            ? {}
            : {
                errorCode: 'BROWSER_RUNTIME_ACTION_FAILED' as const,
                message: sanitizeNamingString(
                  res.body && typeof res.body === 'object' && 'error' in res.body
                    ? String((res.body as { error?: unknown }).error)
                    : `HTTP ${res.status}`,
                ),
              }),
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const disabled = /browser control disabled/i.test(message);
        return {
          ok: false,
          action: request.action,
          errorCode: disabled ? 'BROWSER_RUNTIME_UNAVAILABLE' : 'BROWSER_RUNTIME_ACTION_FAILED',
          message: sanitizeNamingString(message),
        };
      }
    },
  };
}
