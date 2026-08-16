import { z } from 'zod';

import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { ControlResult, LiziMcpSessionContext } from '../types.js';
import { errorPayload, okPayload } from './_payload.js';

export interface BotDurableNoteCallbacks {
  list(params: { callerSessionId: string; namespace?: string; limit?: number }): Promise<ControlResult<{ notes: unknown[] }, string>>;
  get(params: { callerSessionId: string; namespace?: string; key: string }): Promise<ControlResult<{ note: unknown }, string>>;
  set(params: { callerSessionId: string; namespace?: string; key: string; value: unknown }): Promise<ControlResult<{ note: unknown }, string>>;
  delete(params: { callerSessionId: string; namespace?: string; key: string }): Promise<ControlResult<{ deleted: boolean }, string>>;
}

export interface BotDurableNoteToolDeps {
  getSessionContext: () => LiziMcpSessionContext;
  callbacks: BotDurableNoteCallbacks;
}

function callerSessionId(deps: BotDurableNoteToolDeps): string | null {
  return deps.getSessionContext().sessionId ?? null;
}

function missingSession() {
  return errorPayload('NOT_A_BOT_SESSION', '当前 MCP 调用未绑定 Cindy Bot 任务。');
}

const namespace = z.string().min(1).max(128);
const key = z.string().min(1).max(128);

export function registerBotDurableNoteTools(
  registry: XdtHelperToolRegistry,
  deps: BotDurableNoteToolDeps,
): void {
  registry.register({
    name: 'list_bot_notes',
    category: 'bots',
    description: '列出当前 Bot 的少量持久状态。自动化任务省略 namespace 时使用该自动化绑定的命名空间；普通 Bot 任务省略时列出全部命名空间。',
    inputShape: { namespace: namespace.optional(), limit: z.number().int().min(1).max(200).default(100) },
    handler: async ({ namespace, limit }) => {
      const sessionId = callerSessionId(deps);
      if (!sessionId) return missingSession();
      const result = await deps.callbacks.list({ callerSessionId: sessionId, namespace, limit });
      return result.ok ? okPayload({ notes: result.notes }) : errorPayload(result.errorCode, result.message);
    },
  });
  registry.register({
    name: 'get_bot_note',
    category: 'bots',
    description: '读取当前 Bot 的一条持久状态。自动化任务可省略 namespace 使用绑定命名空间；不能读取其它 Bot。',
    inputShape: { namespace: namespace.optional(), key },
    handler: async ({ namespace, key }) => {
      const sessionId = callerSessionId(deps);
      if (!sessionId) return missingSession();
      const result = await deps.callbacks.get({ callerSessionId: sessionId, namespace, key });
      return result.ok ? okPayload({ note: result.note }) : errorPayload(result.errorCode, result.message);
    },
  });
  registry.register({
    name: 'set_bot_note',
    category: 'bots',
    description: '写入当前 Bot 的一条小型 JSON 持久状态（最大 32 KiB）。自动化任务可省略 namespace 使用绑定命名空间。',
    inputShape: { namespace: namespace.optional(), key, value: z.unknown() },
    handler: async ({ namespace, key, value }) => {
      const sessionId = callerSessionId(deps);
      if (!sessionId) return missingSession();
      const result = await deps.callbacks.set({ callerSessionId: sessionId, namespace, key, value });
      return result.ok ? okPayload({ note: result.note }) : errorPayload(result.errorCode, result.message);
    },
  });
  registry.register({
    name: 'delete_bot_note',
    category: 'bots',
    description: '删除当前 Bot 的一条持久状态。不会删除任务、Memory 或其它 Bot 数据。',
    inputShape: { namespace: namespace.optional(), key },
    handler: async ({ namespace, key }) => {
      const sessionId = callerSessionId(deps);
      if (!sessionId) return missingSession();
      const result = await deps.callbacks.delete({ callerSessionId: sessionId, namespace, key });
      return result.ok ? okPayload({ deleted: result.deleted }) : errorPayload(result.errorCode, result.message);
    },
  });
}
