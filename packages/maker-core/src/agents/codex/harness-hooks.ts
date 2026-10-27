import { createHarnessHookBridge } from '../shared/harness-hooks.js';
import type { HarnessHookRequest } from '../../types/harness-capabilities.js';

type NativeEvent = 'preToolUse' | 'preCompact';
type Receipt = { key: string; threadId: string; turnId: string; event: NativeEvent; claimed: boolean };
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;

/** Codex 0.159.2's native mcp_tool handler, over the existing Cindy MCP connection.
 * No configuration writes or native trust grants occur here.
 */
export function createCodexHarnessHooks(isCurrent: (threadId: string, turnId: string) => boolean) {
  const bridge = createHarnessHookBridge();
  const receipts = new Map<string, Receipt>();
  const waiters = new Set<() => void>();
  const configured = new Set<HarnessHookRequest['name']>();
  let closed = false;
  let transportReady = false;
  return {
    setHandler: bridge.setHandler,
    get names(): HarnessHookRequest['name'][] { return transportReady && !closed ? [...configured] : []; },
    get hasConfiguredHooks() { return configured.size > 0; },
    setTransportReady(ready: boolean) { transportReady = ready; },
    configure(config: unknown, listing: unknown) {
      configured.clear();
      if (record(record(record(config)?.config)?.features)?.hooks !== true) return;
      const data = record(listing)?.data;
      if (!Array.isArray(data)) return;
      for (const group of data) {
        const hooks = record(group)?.hooks;
        if (!Array.isArray(hooks)) continue;
        for (const item of hooks) {
          const hook = record(item);
          if (hook?.handlerType !== 'mcpTool' || hook.server !== 'cindy' ||
              hook.tool !== 'harness_hook' || hook.enabled !== true || hook.trustStatus !== 'trusted') continue;
          if (hook.eventName === 'preToolUse') configured.add('tool.before');
          if (hook.eventName === 'preCompact') configured.add('compaction.before');
        }
      }
    },
    observe(value: unknown, completed: boolean) {
      const params = record(value);
      const run = record(params?.run);
      if (closed || typeof params?.threadId !== 'string' || typeof params.turnId !== 'string' ||
          typeof run?.id !== 'string' || run.handlerType !== 'mcpTool' || run.executionMode !== 'sync' ||
          (run.eventName !== 'preToolUse' && run.eventName !== 'preCompact')) return;
      const key = JSON.stringify([params.threadId, params.turnId, run.id]);
      if (completed) receipts.delete(key);
      else if (run.status === 'running' && isCurrent(params.threadId, params.turnId)) {
        // Retain only live native runs for this concrete root thread/turn.
        for (const [id, receipt] of receipts) {
          if (!isCurrent(receipt.threadId, receipt.turnId)) receipts.delete(id);
        }
        if (receipts.size < 128) receipts.set(key, {
          key, threadId: params.threadId, turnId: params.turnId, event: run.eventName, claimed: false,
        });
      }
      for (const wake of waiters) wake();
    },
    async run(input: unknown, metadata: unknown): Promise<Record<string, unknown>> {
      const args = record(input);
      const meta = record(metadata);
      const event = args?.event === 'PreToolUse' ? 'preToolUse'
        : args?.event === 'PreCompact' ? 'preCompact' : undefined;
      // This is a versioned native adapter: ordinary model tool calls carry
      // callId/itemId/turn metadata and must never impersonate a native Hook.
      if (closed || !event || typeof args?.session !== 'string' || typeof args.turn !== 'string' ||
          meta?.threadId !== args.session ||
          Object.keys(meta).some(key => key !== 'threadId' && key !== 'progressToken') ||
          !isCurrent(args.session, args.turn)) throw new Error('NATIVE_HOOK_UNAVAILABLE');
      const claim = (): Receipt | undefined => {
        for (const receipt of receipts.values()) {
          if (!receipt.claimed && receipt.threadId === args.session && receipt.turnId === args.turn && receipt.event === event) {
            receipt.claimed = true;
            return receipt;
          }
        }
        return undefined;
      };
      let receipt = claim();
      if (!receipt) {
        // MCP and app-server notifications use independent existing transports.
        // Bound the race, without accepting an unattested callback on timeout.
        receipt = await new Promise<Receipt | undefined>(resolve => {
          const finish = (value?: Receipt) => {
            clearTimeout(timer);
            waiters.delete(wake);
            resolve(value);
          };
          const wake = () => {
            const found = claim();
            if (found || closed) finish(found);
          };
          const timer = setTimeout(() => finish(), 100);
          timer.unref?.();
          waiters.add(wake);
          wake();
        });
      }
      if (!receipt || closed || receipts.get(receipt.key) !== receipt ||
          !isCurrent(receipt.threadId, receipt.turnId)) throw new Error('NATIVE_HOOK_UNAVAILABLE');
      // A real callback also attests readiness when native startup was still
      // pending at the initial thread-scoped MCP status read.
      transportReady = true;
      configured.add(event === 'preToolUse' ? 'tool.before' : 'compaction.before');
      const result = await bridge.run({
        name: event === 'preToolUse' ? 'tool.before' : 'compaction.before',
        ...(event === 'preToolUse' && typeof args.tool_name === 'string' ? { toolName: args.tool_name } : {}),
        ...(event === 'preToolUse' && typeof args.tool_use_id === 'string' ? { toolUseId: args.tool_use_id } : {}),
        ...(event === 'preToolUse' ? { input: args.tool_input } : {}),
      });
      if (closed || receipts.get(receipt.key) !== receipt ||
          !isCurrent(receipt.threadId, receipt.turnId)) throw new Error('NATIVE_HOOK_UNAVAILABLE');
      // PreToolUse rejects the common continue/stopReason fields. Its native
      // deny prevents the call without granting permission to any other tool.
      if (event === 'preToolUse') return result.action === 'block' ? {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse', permissionDecision: 'deny',
          permissionDecisionReason: 'Blocked by an approved Cindy plugin hook.',
        },
      } : {};
      return result.action === 'block'
        ? { continue: false, stopReason: 'Blocked by an approved Cindy plugin hook.' }
        : { continue: true };
    },
    invalidate() {
      transportReady = false;
      receipts.clear();
    },
    close() {
      closed = true;
      configured.clear();
      receipts.clear();
      bridge.close();
      for (const wake of waiters) wake();
    },
  };
}
