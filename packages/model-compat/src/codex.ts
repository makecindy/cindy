import { resolveProviderCompatibilityProfile, type CompatibilityRoute } from './profiles';
import { routeUsesContentChannelReasoning } from './upstream/server/responses-reasoning-summary-rewrite';
import type { ResponsesItemIdRepairConfig } from './upstream/types/provider';
import { isPlainObject } from './object';
import { createResponsesCustomToolFunctionAdapter } from './cindy/custom-tool-function-adapter';
import { chainResponseTransforms } from './cindy/responses-null-array-repair';
import { createResponsesCompatibilityAdapter } from './responses';

/** Codex's code-mode contract includes Cindy's helper names and collision-safe aliases.
 * Keep that conversion ahead of upstream generic custom/namespace/tool-search lowering,
 * and restore in reverse order. This adapter is selected only for Responses routes whose
 * actual routing descriptor declares that Codex custom tools are unsupported.
 */
export function createCodexResponsesCompatibilityAdapter() {
  const codeMode = createResponsesCustomToolFunctionAdapter(['exec']);
  const makeUpstream = (lowerNamespaces: boolean) => createResponsesCompatibilityAdapter({
    customTools: 'preserve-apply-patch',
    namespaceTools: lowerNamespaces ? 'functions' : 'native',
    toolSearch: 'function',
    repairFunctionArguments: true,
  });
  const generic = makeUpstream(false);
  const lowered = makeUpstream(true);
  const selected = new Map<number, { adapter: typeof generic; at: number }>();
  return {
    adaptRequest(body: unknown, requestId: number, route?: CompatibilityRoute, lowerNamespaces = false): unknown | null {
      // The host supplies namespace support from the effective route, independently of
      // custom-tool support. A familiar model name is not a routing capability.
      codeMode.releaseResponse(requestId);
      selected.get(requestId)?.adapter.releaseResponse(requestId);
      selected.delete(requestId);
      const now = Date.now();
      for (const [id, entry] of selected) {
        if (now - entry.at < 15 * 60_000) continue;
        codeMode.releaseResponse(id);
        entry.adapter.releaseResponse(id);
        selected.delete(id);
      }
      if (!selected.has(requestId) && selected.size >= 256) throw new Error('too many in-flight compatibility requests');
      const upstream = lowerNamespaces ? lowered : generic;
      selected.set(requestId, { adapter: upstream, at: now });
      try {
        const code = codeMode.adaptRequest(body, requestId) ?? body;
        const profile = route ? resolveProviderCompatibilityProfile(route) : null;
        const overrides = profile ? {
          ...(profile.supportsResponsesCustomTools === false ? { customTools: 'functions' as const } : {}),
          ...(isPlainObject(profile.responsesItemIdRepair) ? { itemIdRepair: profile.responsesItemIdRepair as ResponsesItemIdRepairConfig } : {}),
          contentChannelReasoning: routeUsesContentChannelReasoning({
            statelessResponses: profile.statelessResponses === true,
            preserveReasoningContentModels: Array.isArray(profile.preserveReasoningContentModels) ? profile.preserveReasoningContentModels.filter((value): value is string => typeof value === 'string') : undefined,
          }, route!.model),
        } : {};
        const tools = upstream.adaptRequest(code, requestId, overrides) ?? code;
        return tools === body ? null : tools;
      } catch (error) {
        codeMode.releaseResponse(requestId);
        upstream.releaseResponse(requestId);
        selected.delete(requestId);
        throw error;
      }
    },
    releaseResponse(requestId: number): void {
      codeMode.releaseResponse(requestId);
      generic.releaseResponse(requestId);
      lowered.releaseResponse(requestId);
      selected.delete(requestId);
    },
    createResponseTransform(requestId: number, response: { contentType: string; contentEncoding: string }) {
      const upstream = selected.get(requestId)?.adapter;
      selected.delete(requestId);
      let first: ReturnType<typeof generic.createResponseTransform> = null;
      try {
        first = upstream?.createResponseTransform(requestId, response) ?? null;
        return chainResponseTransforms(first, codeMode.createResponseTransform(requestId, response));
      } catch (error) {
        first?.destroy();
        codeMode.releaseResponse(requestId);
        upstream?.releaseResponse(requestId);
        throw error;
      }
    },
  };
}
