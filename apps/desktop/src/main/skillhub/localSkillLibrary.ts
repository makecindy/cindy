import fs from 'node:fs/promises';
import path from 'node:path';
import type { LiziMcpSessionContext, LocalSkillLibraryCallback, SessionPathAuthorization, SessionPathAuthorizationRequest } from '@cindy/mcps';
import { resolveCanonicalSessionPath } from '@cindy/mcps';
import type { SkillEmbeddingAdapter } from '@cindy/skill-index';
import { helperDiscoverySkill, loadIndex, readConfig, readSkill, syncLibrary, syncLibraryUnlocked, withLibraryWrite, writeJson, type LibraryConfig } from '@cindy/skill-index/library';

interface Registration extends LibraryConfig {
  gatewayPath: string;
  embeddingModel?: string;
  registered: boolean;
}

export interface LocalSkillLibraryDependencies {
  ownerScope: () => string | null;
  storageRoot: () => string;
  homeDir: () => string;
  isCurrentSession: (context: LiziMcpSessionContext) => boolean;
  isOrdinaryTask: (context: LiziMcpSessionContext) => Promise<boolean>;
  authorizePath: (request: SessionPathAuthorizationRequest) => Promise<SessionPathAuthorization>;
  embedding: (model: string) => SkillEmbeddingAdapter | undefined;
}

const fail = (errorCode: string, message: string) => ({ ok: false as const, errorCode, message });

/** Explicit, owner-local libraries. Only their small gateway is mounted by the agent. */
export function createLocalSkillLibraryTools(deps: LocalSkillLibraryDependencies): LocalSkillLibraryCallback {
  const synchronized = new Map<string, Set<string>>();
  const syncing = new Map<string, ReturnType<typeof syncLibrary>>();
  return async (request, context) => {
    if (!context.sessionId || context.remoteHostId || !deps.isCurrentSession(context)) {
      return fail('NO_SESSION_CONTEXT', 'A current local Cindy task is required.');
    }
    const owner = deps.ownerScope();
    if (!owner) return fail('UNAUTHORIZED', 'An active Cindy profile is required.');
    const grants: SessionPathAuthorization[] = [];
    const isCurrent = () => deps.ownerScope() === owner && deps.isCurrentSession(context)
      && grants.every((grant) => grant.allowed && grant.isCurrent?.() !== false);
    const checkCurrent = () => { if (!isCurrent()) throw new Error('The account, task or path authorization changed.'); };
    try {
      if (!await deps.isOrdinaryTask(context)) return fail('UNSUPPORTED_CAPABILITY', 'Personal local libraries are available to ordinary tasks. Teammates use their own Skill library.');
      checkCurrent();
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(request.library_id) || request.library_id.length > 40) {
        return fail('INVALID_ARGS', 'library_id must be a lowercase hyphenated name (max 40 characters).');
      }
      const library = path.join(deps.storageRoot(), request.library_id);
      const sessionKey = JSON.stringify([context.sessionId, context.sessionInstanceId]);
      const libraryKey = JSON.stringify([owner, library]);
      const authorize = async (target: string, operation: 'read' | 'write') => {
        if (!path.isAbsolute(target)) throw new Error('Skill paths must be absolute.');
        const grant = await deps.authorizePath({
          sessionId: context.sessionId!, sessionInstanceId: context.sessionInstanceId,
          workingDir: context.workingDir, path: target,
          toolName: request.action === 'search' ? 'search_local_skills' : request.action === 'read' ? 'read_local_skill' : 'configure_local_skill_library',
          operation,
        });
        if (!grant.allowed) throw new Error(grant.reason);
        grants.push(grant);
        checkCurrent();
      };
      const authorizeSources = async (config: Registration) => {
        for (const source of config.sources) await authorize(await fs.realpath(source.path), 'read');
      };
      const adapter = (config: Registration): SkillEmbeddingAdapter | undefined => {
        const embedding = config.embeddingModel ? deps.embedding(config.embeddingModel) : undefined;
        return embedding && { identity: embedding.identity, embed: async (texts, inputType) => {
          checkCurrent();
          const result = await embedding.embed(texts, inputType);
          checkCurrent();
          return result;
        } };
      };

      if (request.action === 'register') {
        if (!request.sources.length) return fail('INVALID_ARGS', 'Register at least one source directory.');
        const sources = [];
        for (const source of request.sources) {
          if (!path.isAbsolute(source)) throw new Error('Skill source paths must be absolute.');
          const resolved = await fs.realpath(source);
          await authorize(resolved, 'read');
          sources.push({ name: path.basename(resolved), path: resolved });
        }
        const gatewayInput = request.gateway_path ?? path.join(deps.homeDir(), '.agents', 'skills', `cindy-skill-library-${request.library_id}`);
        if (!path.isAbsolute(gatewayInput)) throw new Error('The gateway path must be absolute.');
        const gatewayPath = await resolveCanonicalSessionPath(context.workingDir, gatewayInput);
        await authorize(gatewayPath, 'write');
        for (const source of sources) {
          const relative = path.relative(source.path, gatewayPath);
          const reverse = path.relative(gatewayPath, source.path);
          const contains = (value: string) => value === '' || (!value.startsWith(`..${path.sep}`) && value !== '..' && !path.isAbsolute(value));
          if (contains(relative) || contains(reverse)) {
            return fail('INVALID_ARGS', 'Place the gateway outside the indexed source directories.');
          }
        }
        const config: Registration = { version: 1, sources, gatewayPath, registered: true,
          ...(request.embedding_model ? { embeddingModel: request.embedding_model } : {}) };
        const embedding = adapter(config);
        if (config.embeddingModel && !embedding) return fail('INVALID_ARGS', 'Choose an available Cindy embedding model, or omit embedding_model for keyword search.');
        const result = await withLibraryWrite(library, async () => {
          checkCurrent();
          // An existing gateway can be reused only when it is exactly this library's route.
          const gateway = helperDiscoverySkill(request.library_id, `cindy-skill-library-${request.library_id}`);
          const gatewayFile = path.join(gatewayPath, 'SKILL.md');
          await fs.mkdir(gatewayPath, { recursive: true });
          try { await fs.writeFile(gatewayFile, gateway, { flag: 'wx' }); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || await fs.readFile(gatewayFile, 'utf8') !== gateway) throw error;
          }
          checkCurrent();
          await writeJson(path.join(library, 'library.json'), config);
          synchronized.delete(libraryKey);
          return syncLibraryUnlocked(library, { embedding, rebuild: request.rebuild, authorizePath: (target) => authorize(target, 'read') });
        });
        checkCurrent();
        return { ok: true, library_id: request.library_id, gateway_path: gatewayPath, ...result,
          guidance: 'The gateway is ready. Start a new task to discover it automatically; this task can search_local_skills now. Source Skills stay in their original folders.' };
      }

      const config = await readConfig(library) as Registration;
      if (!config.registered) return fail('NOT_FOUND', 'This local Skill library is not registered.');
      checkCurrent();
      if (request.action === 'remove') {
        await withLibraryWrite(library, async () => {
          const currentConfig = await readConfig(library) as Registration;
          checkCurrent();
          await writeJson(path.join(library, 'library.json'), { ...currentConfig, registered: false });
          synchronized.delete(libraryKey);
        });
        return { ok: true, library_id: request.library_id, gateway_path: config.gatewayPath,
          guidance: 'Registration removed. Source Skills and the gateway are preserved; remove the gateway from its reported folder if no longer needed.' };
      }
      await authorizeSources(config);
      const embedding = adapter(config);
      if (config.embeddingModel && !embedding && request.action !== 'read') {
        return fail('MODEL_UNAVAILABLE', 'The configured embedding model is unavailable. Enable it or register this library again without embedding_model to use keyword search.');
      }
      if (request.action === 'refresh' || (request.action === 'search' && !synchronized.get(libraryKey)?.has(sessionKey))) {
        // Ordinary first-use searches share the same disk publication across tasks.
        let pending = syncing.get(libraryKey);
        if (!pending || request.action === 'refresh') {
          if (pending) await pending;
          checkCurrent();
          pending = syncLibrary(library, { embedding, rebuild: request.action === 'refresh' && request.rebuild,
            authorizePath: (target) => authorize(target, 'read') });
          syncing.set(libraryKey, pending);
        }
        let result: Awaited<ReturnType<typeof syncLibrary>>;
        try { result = await pending; }
        finally { if (syncing.get(libraryKey) === pending) syncing.delete(libraryKey); }
        checkCurrent();
        if (request.action === 'refresh') synchronized.delete(libraryKey);
        const sessions = synchronized.get(libraryKey) ?? new Set<string>();
        sessions.add(sessionKey);
        synchronized.set(libraryKey, sessions);
        if (request.action === 'refresh') return { ok: true, library_id: request.library_id, ...result };
      }
      const index = await loadIndex(library);
      checkCurrent();
      if (request.action === 'read') {
        const entry = index.resolve(request.id);
        if (!entry) return fail('NOT_FOUND', 'Search this library to select a Skill id.');
        await authorize(await fs.realpath(entry.filePath), 'read');
        const result = await readSkill(index, request.id, { offset: request.offset, chars: request.chars, expectedSha256: request.sha256 });
        checkCurrent();
        return { ok: true, ...result };
      }
      if (request.action === 'search') {
        const result = await index.search(request.query, { limit: request.limit, embedding });
        for (const match of result.matches) await authorize(await fs.realpath(match.filePath), 'read');
        checkCurrent();
        return { ok: true, library_id: request.library_id, ...result };
      }
      return fail('INVALID_ARGS', 'Unsupported library action.');
    } catch (error) {
      if (!isCurrent()) return fail('CANCELLED', 'The account, task or path authorization changed.');
      return fail((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'NOT_FOUND' : 'LOCAL_SKILL_LIBRARY_ERROR', error instanceof Error ? error.message : String(error));
    }
  };
}
