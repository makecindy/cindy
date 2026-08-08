import { AsyncLocalStorage } from 'node:async_hooks';

import type { LiziMcpSessionContext } from './types.js';

const storage = new AsyncLocalStorage<LiziMcpSessionContext>();

export function runWithLiziMcpSessionContext<T>(
  ctx: LiziMcpSessionContext,
  fn: () => T,
): T {
  return storage.run(ctx, fn);
}

export function getLiziMcpSessionContext(): LiziMcpSessionContext | undefined {
  return storage.getStore();
}

function withoutSessionAttribution<T extends LiziMcpSessionContext>(fallback: T): T {
  return {
    ...fallback,
    workingDir: '',
    sessionId: undefined,
    sessionInstanceId: undefined,
    remoteHostId: undefined,
    vendorOptions: undefined,
  };
}

export function resolveLiziMcpSessionContext<T extends LiziMcpSessionContext>(
  fallback: T,
): T {
  // Host-provided accessors carry the provenance of this MCP server. Claude
  // returns its per-session closure; Codex / Pi resolve the current request.
  // An accessor that cannot resolve a context is authoritative too: returning
  // the captured fallback (or an unrelated ambient ALS store) would silently
  // impersonate another session, so strip all session attribution instead.
  if (fallback.getSessionContext) {
    return (fallback.getSessionContext() as T | undefined) ?? withoutSessionAttribution(fallback);
  }

  // Backward compatibility for direct package consumers that construct bridge
  // servers without the newer explicit accessor. A concrete captured context
  // is still authoritative; only an unmistakably empty bridge placeholder may
  // consult the ambient ALS store.
  if (
    fallback.sessionId ||
    fallback.sessionInstanceId ||
    fallback.workingDir ||
    fallback.remoteHostId ||
    (fallback.vendorOptions && Object.keys(fallback.vendorOptions).length > 0)
  ) {
    return fallback;
  }
  return (storage.getStore() as T | undefined) ?? fallback;
}
