import { z } from 'zod';
import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { ControlResult, LiziMcpSessionContext } from '../types.js';
import { errorPayload, okPayload } from './_payload.js';
import { stringArrayParam } from './_array-param.js';

export type LocalSkillLibraryRequest =
  | { action: 'search'; library_id: string; query: string; limit?: number }
  | { action: 'read'; library_id: string; id: string; offset?: number; sha256?: string; chars?: number }
  | { action: 'register'; library_id: string; sources: string[]; gateway_path?: string; embedding_model?: string; rebuild?: boolean }
  | { action: 'refresh'; library_id: string; rebuild?: boolean }
  | { action: 'remove'; library_id: string };

export type LocalSkillLibraryCallback = (
  request: LocalSkillLibraryRequest,
  context: LiziMcpSessionContext,
  signal?: AbortSignal,
) => Promise<ControlResult<Record<string, unknown>, string>>;

const libraryId = z.string().trim().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(40);
const localPath = z.string().trim().min(1).max(4096);

/** A fixed discovery surface: library entries appear only in search results, never tool schemas. */
export function registerLocalSkillLibraryTools(registry: XdtHelperToolRegistry, deps: {
  getSessionContext: () => LiziMcpSessionContext;
  execute: LocalSkillLibraryCallback;
}): void {
  const execute = async (request: LocalSkillLibraryRequest, signal?: AbortSignal) => {
    const context = deps.getSessionContext();
    if (!context.sessionId) return errorPayload('NO_SESSION_CONTEXT', 'No Cindy task is bound to this call.');
    if (context.remoteHostId) return errorPayload('UNSUPPORTED_CAPABILITY', 'Local Skill libraries are available in tasks running on this Cindy computer.');
    const result = await deps.execute(request, context, signal);
    return result.ok ? okPayload(result) : errorPayload(result.errorCode, result.message);
  };

  registry.register({
    name: 'search_local_skills', category: 'skills',
    description: 'Search a registered local Skill library for the current task. Use the library_id from its short discovery Skill and describe the work in query. Returns a few matching descriptions and ids; read the relevant originals with read_local_skill. This searches local sources, not the SkillHub marketplace.',
    inputShape: {
      library_id: libraryId,
      query: z.string().trim().min(1).max(4096),
      limit: z.number().int().min(1).max(50).optional(),
    },
    handler: (input, signal) => execute({ action: 'search', ...input }, signal),
  });
  registry.register({
    name: 'read_local_skill', category: 'skills',
    description: 'Read the original SKILL.md selected from a local library search. Follow nextOffset as offset and the returned sha256 until eof is true. Resolve referenced scripts, assets and documents from resourceRoot. If the source changes, restart at offset 0.',
    inputShape: {
      library_id: libraryId,
      id: z.string().trim().min(1).max(256),
      offset: z.number().int().min(0).optional(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
      chars: z.number().int().min(1).max(24000).optional(),
    },
    handler: (input, signal) => execute({ action: 'read', ...input }, signal),
  });
  registry.register({
    name: 'configure_local_skill_library', category: 'skills',
    description: 'Register, refresh or remove a local Skill library on this computer. register replaces its source list and writes one short discovery Skill; source files stay in place. Supply sources; gateway_path optionally chooses a separate discovery Skill folder, otherwise Cindy uses its shared Skills directory. embedding_model optionally selects a configured Cindy embedding catalog model; omitting it selects keyword search. To change sources or model, register again. refresh updates the index; rebuild requests a full rebuild. remove only cancels registration and keeps source files and the discovery folder, whose path is returned for user management.',
    inputShape: {
      library_id: libraryId,
      action: z.enum(['register', 'refresh', 'remove']),
      sources: stringArrayParam(z.array(localPath).min(1)).optional(),
      gateway_path: localPath.optional(),
      embedding_model: z.string().trim().min(1).max(256).optional(),
      rebuild: z.boolean().optional(),
    },
    handler: async (input, signal) => {
      if (input.action === 'register') {
        if (!input.sources) return errorPayload('INVALID_ARGS', 'Register requires the complete sources list.');
        return execute({ ...input, action: 'register', sources: input.sources }, signal);
      }
      if (input.sources !== undefined || input.gateway_path !== undefined || input.embedding_model !== undefined) {
        return errorPayload('INVALID_ARGS', 'Use register to change library sources, discovery folder or embedding model.');
      }
      if (input.action === 'remove') {
        if (input.rebuild !== undefined) return errorPayload('INVALID_ARGS', 'remove does not rebuild the library.');
        return execute({ action: 'remove', library_id: input.library_id }, signal);
      }
      return execute({ action: 'refresh', library_id: input.library_id, rebuild: input.rebuild }, signal);
    },
  });
}
