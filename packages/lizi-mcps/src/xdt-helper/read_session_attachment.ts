import { z } from 'zod';
import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { ListSessionsToolDeps } from './list_sessions.js';
import { resolveHistoryScope } from './_history_scope.js';
import { errorPayload, okPayload } from './_payload.js';

export interface ReadSessionAttachmentArgs {
  session_id: string; message_id: string; attachment_index: number;
  offset: number; length: number; attachment_ref?: string;
}

export function registerReadSessionAttachmentTool(registry: XdtHelperToolRegistry, deps: ListSessionsToolDeps): void {
  if (!deps.history.readSessionAttachment) return;
  registry.register({
    name: 'read_session_attachment', category: 'history',
    description: 'Read an attachment actually registered on a message, by zero-based index (images first, then files). Explicit session_id is required; deviceId::sessionId reads the source computer through the existing file channel. Returns bounded base64 chunks, name, MIME, size and SHA-256, never a host path. Continue with nextOffset and the returned attachment_ref, retaining the same source parameters. Plugins receive media grants or existing handoff receipts; expired refs must be obtained again. Export history in the plugin from get_chat_history cursor pages; no export endpoint is needed.',
    inputShape: {
      session_id: z.string().min(1), message_id: z.string().min(1), attachment_index: z.number().int().min(0),
      offset: z.number().int().min(0).default(0), length: z.number().int().min(1).max(65536).default(65536),
      attachment_ref: z.string().regex(/^handoff:[0-9a-f-]{36}$/).optional(),
    },
    handler: async args => {
      const scope = await resolveHistoryScope(deps.history, deps.getSessionContext, [args.session_id]);
      if (!scope.ok) return errorPayload(scope.errorCode, scope.message);
      if (scope.deniedSessionIds.length) return errorPayload('HISTORY_SCOPE_DENIED', 'Attachment task is outside the current history scope.');
      const result = await deps.history.readSessionAttachment!(args, deps.getSessionContext?.());
      return result.ok ? okPayload(result) : errorPayload(result.errorCode, result.message);
    },
  });
}
