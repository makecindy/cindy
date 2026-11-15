import { z } from 'zod';
import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { ListSessionsToolDeps } from './list_sessions.js';
import { resolveHistoryScope } from './_history_scope.js';
import { errorPayload, okPayload } from './_payload.js';

export interface ReadSessionAttachmentArgs {
  session_id: string; message_id: string; attachment_index: number;
  offset: number; length: number; attachment_ref?: string; mediaHash?: string;
}

export function registerReadSessionAttachmentTool(registry: XdtHelperToolRegistry, deps: ListSessionsToolDeps): void {
  if (!deps.history.readSessionAttachment) return;
  registry.register({
    name: 'read_session_attachment', category: 'history',
    description: 'Read only Host-authorized local managed media or an existing grant/deposit/handoff reference. Message attachment indexes are zero-based (images first, then files); historical files.path, absolute paths, legacy file URLs and remote attachments return UNSUPPORTED_CAPABILITY. Explicit session_id is required. Returns bounded base64 chunks, name, MIME, size and SHA-256, never a host path. Continue with nextOffset and the returned mediaHash or existing attachment_ref, retaining the same source parameters. Expired refs must be obtained through the existing authorized handoff flow; this tool does not create a file handoff from a historical path. Export history in the plugin from get_chat_history cursor pages; no export endpoint is needed.',
    inputShape: {
      session_id: z.string().min(1), message_id: z.string().min(1), attachment_index: z.number().int().min(0),
      offset: z.number().int().min(0).default(0), length: z.number().int().min(1).max(65536).default(65536),
      attachment_ref: z.string().regex(/^handoff:[0-9a-f-]{36}$/).optional(),
      mediaHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    },
    handler: async args => {
      const split = args.session_id.indexOf('::');
      if (split > 0 && args.session_id.slice(0, split) !== 'local')
        return errorPayload('UNSUPPORTED_CAPABILITY', 'Remote attachment reads are not supported.');
      if (split > 0) args = { ...args, session_id: args.session_id.slice(split + 2) };
      const scope = await resolveHistoryScope(deps.history, deps.getSessionContext, [args.session_id]);
      if (!scope.ok) return errorPayload(scope.errorCode, scope.message);
      if (scope.deniedSessionIds.length) return errorPayload('HISTORY_SCOPE_DENIED', 'Attachment task is outside the current history scope.');
      const result = await deps.history.readSessionAttachment!(args, deps.getSessionContext?.());
      return result.ok ? okPayload(result) : errorPayload(result.errorCode, result.message);
    },
  });
}
