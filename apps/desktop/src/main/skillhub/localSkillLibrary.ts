import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { LiziMcpSessionContext, LocalSkillLibraryCallback } from '@cindy/mcps';
import { resolveCanonicalSessionPath } from '@cindy/mcps';
import type { SkillEmbeddingAdapter, SkillIndex } from '@cindy/skill-index';
import { helperDiscoverySkill, loadIndex, readConfig, readSkill, syncLibraryUnlocked, withLibraryWrite, writeJson, type LibraryConfig } from '@cindy/skill-index/library';

interface Registration extends LibraryConfig {
  generation: string;
  gatewayPath: string;
  embeddingModel?: string;
  registered: boolean;
}

export interface LocalSkillLibraryDependencies {
  coordinator: LocalSkillLibraryCoordinator;
  ownerScope: () => string | null;
  storageRoot: () => string;
  homeDir: () => string;
  isCurrentSession: (context: LiziMcpSessionContext) => boolean;
  isOrdinaryTask: (context: LiziMcpSessionContext) => Promise<boolean>;
  embedding: (model: string, checkCurrent: () => void) => SkillEmbeddingAdapter | undefined;
}

interface LibraryView {
  config: Registration;
  generation: string;
  index: SkillIndex;
  changes?: Awaited<ReturnType<typeof syncLibraryUnlocked>>;
}

interface LibraryWork {
  participants: Set<() => boolean>;
  cancelled: boolean;
}

const fail = (errorCode: string, message: string) => ({ ok: false as const, errorCode, message });

/** One owner-aware coordinator per Maker host, shared by its engine providers. */
export function createLocalSkillLibraryCoordinator() {
  return {
    synchronized: new Map<string, { generation: string; sessions: Set<string> }>(),
    syncing: new Map<string, { generation: string; synchronize: boolean; work: LibraryWork; promise: Promise<LibraryView> }>(),
  };
}
export type LocalSkillLibraryCoordinator = ReturnType<typeof createLocalSkillLibraryCoordinator>;

/** Explicit, owner-local libraries. Only their small gateway is mounted by the agent. */
export function createLocalSkillLibraryTools(deps: LocalSkillLibraryDependencies): LocalSkillLibraryCallback {
  const { synchronized, syncing } = deps.coordinator;
  return async (request, context) => {
    if (!context.sessionId || context.remoteHostId || !deps.isCurrentSession(context)) {
      return fail('NO_SESSION_CONTEXT', 'A current local Cindy task is required.');
    }
    const owner = deps.ownerScope();
    if (!owner) return fail('UNAUTHORIZED', 'An active Cindy profile is required.');
    const isCurrent = () => deps.ownerScope() === owner && deps.isCurrentSession(context);
    const checkCurrent = () => { if (!isCurrent()) throw new Error('The account or task changed.'); };
    try {
      if (!await deps.isOrdinaryTask(context)) return fail('UNSUPPORTED_CAPABILITY', 'Personal local libraries are available to ordinary tasks. Teammates use their own Skill library.');
      checkCurrent();
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(request.library_id) || request.library_id.length > 40) {
        return fail('INVALID_ARGS', 'library_id must be a lowercase hyphenated name (max 40 characters).');
      }
      const library = path.join(deps.storageRoot(), request.library_id);
      const sessionKey = JSON.stringify([context.sessionId, context.sessionInstanceId]);
      const libraryKey = JSON.stringify([owner, library]);
      const adapter = (config: Registration, check = checkCurrent): SkillEmbeddingAdapter | undefined => {
        const embedding = config.embeddingModel ? deps.embedding(config.embeddingModel, check) : undefined;
        return embedding && { identity: embedding.identity, embed: async (texts, inputType) => {
          check();
          const result = await embedding.embed(texts, inputType);
          check();
          return result;
        } };
      };

      if (request.action === 'register') {
        if (!request.sources.length) return fail('INVALID_ARGS', 'Register at least one source directory.');
        const sources = [];
        for (const source of request.sources) {
          if (!path.isAbsolute(source)) throw new Error('Skill source paths must be absolute.');
          const resolved = await fs.realpath(source);
          sources.push({ name: path.basename(resolved), path: resolved });
        }
        const gatewayInput = request.gateway_path ?? path.join(deps.homeDir(), '.agents', 'skills', `cindy-skill-library-${request.library_id}`);
        if (!path.isAbsolute(gatewayInput)) throw new Error('The gateway path must be absolute.');
        const gatewayPath = await resolveCanonicalSessionPath(context.workingDir, gatewayInput);
        for (const source of sources) {
          const relative = path.relative(source.path, gatewayPath);
          const reverse = path.relative(gatewayPath, source.path);
          const contains = (value: string) => value === '' || (!value.startsWith(`..${path.sep}`) && value !== '..' && !path.isAbsolute(value));
          if (contains(relative) || contains(reverse)) {
            return fail('INVALID_ARGS', 'Place the gateway outside the indexed source directories.');
          }
        }
        const config: Registration = { version: 1, generation: randomUUID(), sources, gatewayPath, registered: true,
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
          return syncLibraryUnlocked(library, { embedding, rebuild: request.rebuild });
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
      // The outer read selects a shared operation only. Configuration, adapter and index
      // are paired again under the writer lock, including when registration changed meanwhile.
      const requestedGeneration = JSON.stringify(config);
      const capture = (work: LibraryWork) => {
        const checkWork = () => {
          if (![...work.participants].some(current => current())) {
            work.cancelled = true;
            throw new Error('All tasks waiting for this library operation ended.');
          }
        };
        checkWork();
        return withLibraryWrite(library, async (): Promise<LibraryView> => {
          const currentConfig = await readConfig(library) as Registration;
          checkWork();
          if (!currentConfig.registered) throw new Error('This local Skill library is not registered.');
          const generation = JSON.stringify(currentConfig);
          const embedding = request.action === 'read' ? undefined : adapter(currentConfig, checkWork);
          if (currentConfig.embeddingModel && !embedding && request.action !== 'read') {
            throw Object.assign(new Error('The configured embedding model is unavailable. Enable it or register without embedding_model.'), { code: 'MODEL_UNAVAILABLE' });
          }
          let seen = synchronized.get(libraryKey);
          const needsSync = request.action === 'refresh' || (request.action === 'search'
            && (seen?.generation !== generation || !seen.sessions.has(sessionKey)));
          const changes = needsSync ? await syncLibraryUnlocked(library, {
            embedding, rebuild: request.action === 'refresh' && request.rebuild,
          }) : undefined;
          const index = await loadIndex(library);
          checkWork();
          if (needsSync) {
            if (request.action === 'refresh' || seen?.generation !== generation) seen = { generation, sessions: new Set() };
            synchronized.set(libraryKey, seen!);
          }
          return { config: currentConfig, generation, index, changes };
        });
      };
      let pending = syncing.get(libraryKey);
      if (request.action !== 'search' || !pending?.synchronize || pending.work.cancelled || pending.generation !== requestedGeneration) {
        checkCurrent();
        const seen = synchronized.get(libraryKey);
        const synchronize = request.action === 'refresh' || (request.action === 'search'
          && (seen?.generation !== requestedGeneration || !seen.sessions.has(sessionKey)));
        const work: LibraryWork = { participants: new Set([isCurrent]), cancelled: false };
        const previous = pending;
        // A new operation may follow an abandoned one; API failures are never retried.
        const promise = previous ? previous.promise.then(() => capture(work), (error) => {
          if (previous.work.cancelled) return capture(work);
          throw error;
        }) : capture(work);
        pending = { generation: requestedGeneration, synchronize, work, promise };
        syncing.set(libraryKey, pending);
      }
      pending!.work.participants.add(isCurrent);
      let view: LibraryView;
      try { view = await pending!.promise; }
      finally {
        pending!.work.participants.delete(isCurrent);
        if (syncing.get(libraryKey) === pending) syncing.delete(libraryKey);
      }
      checkCurrent();
      const seen = synchronized.get(libraryKey);
      if (request.action !== 'read' && seen?.generation === view.generation) seen.sessions.add(sessionKey);
      if (request.action === 'refresh') return { ok: true, library_id: request.library_id, ...view.changes };
      const index = view.index;
      if (request.action === 'read') {
        const entry = index.resolve(request.id);
        if (!entry) return fail('NOT_FOUND', 'Search this library to select a Skill id.');
        const result = await readSkill(index, request.id, { offset: request.offset, chars: request.chars, expectedSha256: request.sha256 });
        checkCurrent();
        return { ok: true, ...result };
      }
      if (request.action === 'search') {
        const result = await index.search(request.query, { limit: request.limit, embedding: adapter(view.config) });
        checkCurrent();
        return { ok: true, library_id: request.library_id, ...result };
      }
      return fail('INVALID_ARGS', 'Unsupported library action.');
    } catch (error) {
      if (!isCurrent()) return fail('CANCELLED', 'The account or task changed.');
      const code = (error as NodeJS.ErrnoException).code;
      return fail(code === 'ENOENT' ? 'NOT_FOUND' : code === 'MODEL_UNAVAILABLE' ? code : 'LOCAL_SKILL_LIBRARY_ERROR', error instanceof Error ? error.message : String(error));
    }
  };
}
