import { z } from 'zod';
import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { ControlResult, LiziMcpSessionContext } from '../types.js';
import type { XdtHelperHistoryDeps } from './_history_types.js';
import { resolveHistoryScope } from './_history_scope.js';
import { errorPayload, okPayload } from './_payload.js';

export interface SessionShareCallbacks {
  export(params: { sessionId: string; outputPath?: string; excludeMedia: boolean }, context: LiziMcpSessionContext): Promise<ControlResult<Record<string, unknown>, string>>;
  import(params: { filePath?: string; attachmentRef?: string; workingDir?: string; useWorktree: boolean; overwrite: boolean }, context: LiziMcpSessionContext): Promise<ControlResult<Record<string, unknown>, string>>;
}

export function registerSessionShareTools(registry: XdtHelperToolRegistry, deps: {
  getSessionContext(): LiziMcpSessionContext;
  callbacks: SessionShareCallbacks;
  history?: XdtHelperHistoryDeps;
}): void {
  registry.register({
    name: 'export_session', category: 'history',
    description: 'Export an explicit local task as a native .cshare package with history, available attachments and engine transcripts. Requires per-call approval. Agent output_path must stay inside this task’s working directory, including resolved symlink targets and parents; relative paths resolve from that directory. To place the file elsewhere, move it afterward with native file tools and their existing authorization. Omitting output_path uses the unrestricted native save dialog, including tasks without a working directory. Plugins receive an instance-bound attachment_ref and must not supply output_path. The package is unencrypted. Reports fidelity and missing content; a running task may not include its last turn. Remote tasks are unsupported.',
    inputShape: {
      session_id: z.string().min(1),
      output_path: z.string().min(1).optional(),
      exclude_media: z.boolean().default(false),
    },
    handler: async args => {
      const context = deps.getSessionContext();
      if (!context.sessionId && context.hostCaller?.kind !== 'plugin') return errorPayload('NO_SESSION_CONTEXT', 'No task is bound to this call.');
      if (context.hostCaller && args.output_path !== undefined) return errorPayload('INVALID_ARGS', 'Plugins receive a handoff reference, not a filesystem path.');
      const sessionId = args.session_id.startsWith('local::') ? args.session_id.slice(7) : args.session_id;
      if (!sessionId || sessionId.includes('::')) return errorPayload('UNSUPPORTED_CAPABILITY', 'Only local task export is supported.');
      if (deps.history) {
        const scope = await resolveHistoryScope(deps.history, deps.getSessionContext, [sessionId]);
        if (!scope.ok) return errorPayload(scope.errorCode, scope.message);
        if (scope.deniedSessionIds.length) return errorPayload('HISTORY_SCOPE_DENIED', 'The task is outside the current history scope.');
      }
      const result = await deps.callbacks.export({ sessionId, outputPath: args.output_path, excludeMedia: args.exclude_media }, context);
      return result.ok ? okPayload(result) : errorPayload(result.errorCode, result.message);
    },
  });
  registry.register({
    name: 'import_session', category: 'control',
    description: 'Import a native .cshare or legacy .xdtshare package through Cindy’s existing importer. Requires per-call approval. Agent calls provide file_path (relative to this task) and optionally working_dir for project tasks. Plugins must use an existing attachment_ref belonging to their own instance and cannot supply paths; project selection uses the native import wizard. Encrypted packages also open that wizard for the owner to unlock; no password enters this tool. Default overwrite=false; no source data is changed. status=awaiting_user means the wizard was opened, not that import completed. Local computer only; SSH paths are unsupported.',
    inputShape: {
      file_path: z.string().min(1).optional(),
      attachment_ref: z.string().regex(/^handoff:[0-9a-f-]{36}$/).optional(),
      working_dir: z.string().min(1).optional(),
      use_worktree: z.boolean().default(false),
      overwrite: z.boolean().default(false),
    },
    handler: async args => {
      const context = deps.getSessionContext();
      const plugin = context.hostCaller?.kind === 'plugin';
      if (!context.sessionId && !plugin) return errorPayload('NO_SESSION_CONTEXT', 'No task is bound to this call.');
      if (plugin ? !args.attachment_ref || args.file_path !== undefined || args.working_dir !== undefined
        : !args.file_path || args.attachment_ref !== undefined) return errorPayload('INVALID_ARGS', plugin
        ? 'Plugins must use their own attachment_ref without filesystem paths.' : 'Provide file_path for this task.');
      const result = await deps.callbacks.import({ filePath: args.file_path, attachmentRef: args.attachment_ref,
        workingDir: args.working_dir, useWorktree: args.use_worktree, overwrite: args.overwrite }, context);
      return result.ok ? okPayload(result) : errorPayload(result.errorCode, result.message);
    },
  });
}
