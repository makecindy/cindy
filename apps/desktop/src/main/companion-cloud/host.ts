/** Local (Electron + SQLite + Bot Home) side of cloud companions; see runtime.ts. */
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { app } from 'electron';
import { and, asc, desc, eq, gt, gte, inArray, isNull, or, sql } from 'drizzle-orm';
import { portableBotAvatarOrFallback, BOT_AVATAR_MAX_BYTES } from '../../shared/botAvatarValue.js';
import type { DeviceLinkDeviceView } from '../../shared/deviceLinkIpc.js';
import { activeOwnerScopeKey, ownerScopedUserDataPath } from '../appSessionState.js';
import { atomicWriteFileSync, readAtomicFileSync } from '../utils/atomicWriteFile.js';
import { fetchPublicImageBytes } from '../im/publicImageFetch.js';
import { getDbClient } from '../localDb/client/current.js';
import { createBotProfile, getBotMemoryService, setBotProfileAvatar, updateBotProfile } from '../localDb/ipc/bots.js';
import { decodeBotAvatarImage } from '../localDb/ipc/botAvatarSelection.js';
import { createMessage } from '../localDb/ipc/messages.js';
import { commitChatImageUrls } from '../cindy-media/chatAttachments.js';
import { botProfileVersions, botProfiles, botSessionLinks, messages } from '../localDb/schema.js';
import { inferBotTemplatePresetId } from '../../shared/botTemplatePreset.js';
import { resolveBotCanonicalSession } from '../maker-ipc/botCanonicalSessionRegistry.js';
import { botProfileDir, botProfileMemoryDir, readBotProfileFolder, writeBotProfileFolder } from '../maker-ipc/botProfileFolder.js';
import { onBotRemoteResourceChanged } from '../maker-ipc/botRemoteResourceInvalidation.js';
import { deleteBotSkillForBot, listBotSkillSourcesForBot, readBotSkillSourceForBot, saveBotSkillSourceForBot } from '../maker-ipc/botSkillService.js';
import { companionTodoStore } from '../maker-ipc/botTodoAccess.js';
import { mergeCompanionWorkbench, readCompanionWorkbench } from '../maker-ipc/botWorkbenchService.js';
import { importCompanionRoutines, listCompanionRoutines, type CompanionRoutineValue } from '../routines/service.js';
import type { TeammateTodo } from '@cindy/maker-shared/teammate-todo';
import { portableTodo, travellingTodos } from './travel.js';
import type { CompanionMaterializeHost } from './materialize.js';
import { companionHomes } from './homes.js';
import type { CompanionMirrorCursor, CompanionMirrorRow } from './mirror.js';
import type { CompanionCloudHost } from './runtime.js';
import { createCompanionCloudState } from './state.js';
import type { CompanionLog } from './types.js';
import {
  COMPANION_MEMORY_PREFIX,
  COMPANION_PROFILE_KEY,
  COMPANION_ROUTINE_PREFIX,
  COMPANION_SKILL_PREFIX,
  COMPANION_TODO_PREFIX,
  COMPANION_WORKBENCH_KEY,
  type CompanionPreferenceValue,
} from './uploader.js';

/** Derived memory files: USER.md travels inside the profile, MEMORY.md is a rebuilt index. */
const SKIPPED_MEMORY_FILES = new Set(['USER.md', 'MEMORY.md']);

function profileTemplateId(capabilitiesJson: string | null, identitySource: string): string | null {
  try {
    const value = (JSON.parse(capabilitiesJson ?? '{}') as { templateId?: unknown }).templateId;
    if (typeof value === 'string' && value) return value;
  } catch { /* fall back to the identity */ }
  return inferBotTemplatePresetId(identitySource);
}

export async function readCompanionValues(botId: string, selfDeviceId: string | null = null): Promise<CompanionPreferenceValue[]> {
  const userDataDir = ownerScopedUserDataPath();
  const [row] = await getDbClient().drizzle
    .select({ displayName: botProfiles.displayName, description: botProfiles.description, capabilities: botProfileVersions.capabilitiesJson })
    .from(botProfiles)
    .leftJoin(botProfileVersions, and(eq(botProfileVersions.botId, botProfiles.id), eq(botProfileVersions.version, botProfiles.currentVersion)))
    .where(eq(botProfiles.id, botId)).limit(1);
  if (!row) return [];
  // Strict: an unreadable SOUL/USER/prompt file aborts the cycle instead of uploading it as empty.
  const folder = await readBotProfileFolder(userDataDir, botId, { strict: true });
  // Which preset it was made from: every computer can then tell the copies of Cindy apart from a
  // teammate that is only named Cindy (the merge never goes by name).
  const templateId = profileTemplateId(row.capabilities, folder.identitySource);
  const values: CompanionPreferenceValue[] = [{ key: COMPANION_PROFILE_KEY, value: {
    name: row.displayName, description: row.description, soul: folder.identitySource,
    systemPrompt: folder.systemPromptOverride, user: folder.userContextSource, ...(templateId ? { templateId } : {}),
  } }];
  const memoryDir = botProfileMemoryDir(userDataDir, botId);
  // Only a missing folder means "no memories"; any other read error aborts this cycle so the
  // uploader never tombstones memories it merely failed to read.
  const entries = await fs.readdir(memoryDir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error?.code === 'ENOENT') return [];
    throw error;
  });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !entry.name.endsWith('.md') || entry.name.startsWith('.') || SKIPPED_MEMORY_FILES.has(entry.name)) continue;
    const content = await fs.readFile(path.join(memoryDir, entry.name), 'utf8');
    values.push({ key: `${COMPANION_MEMORY_PREFIX}${entry.name}`, value: { filename: entry.name, content } });
  }
  // Strict too: a skill that cannot be read must not look deleted (the uploader would tombstone it).
  for (const skill of await listBotSkillSourcesForBot(botId)) {
    values.push({ key: `${COMPANION_SKILL_PREFIX}${skill.slug}`, value: {
      slug: skill.slug, content: skill.source, ...(skill.enabled ? {} : { enabled: false }),
    } });
  }
  // Todos, routines and the workbench move with the companion too (cloud-companions.md §2). A read
  // failure aborts the cycle like the files above, so nothing is tombstoned by mistake.
  // These parts are read separately: one that cannot be read now (e.g. routines before their engine
  // is ready) leaves its cloud values untouched instead of stopping the profile and memories.
  const part = async (prefix: string, read: () => Promise<CompanionPreferenceValue[]>) => {
    try { values.push(...await read()); } catch { values.push({ key: prefix, value: null, unread: true }); }
  };
  await part(COMPANION_TODO_PREFIX, async () => travellingTodos((await companionTodoStore(botId).read()).items)
    .map(item => ({ key: `${COMPANION_TODO_PREFIX}${item.id}`, value: portableTodo(item) })));
  await part(COMPANION_ROUTINE_PREFIX, async () => (await listCompanionRoutines(botId, selfDeviceId))
    .map(routine => ({ key: `${COMPANION_ROUTINE_PREFIX}${routine.id}`, value: routine })));
  if (selfDeviceId) await part(COMPANION_WORKBENCH_KEY, async () => {
    const workbench = await readCompanionWorkbench(userDataDir, botId, selfDeviceId);
    return workbench.directories.length || Object.keys(workbench.tasks).length ? [{ key: COMPANION_WORKBENCH_KEY, value: workbench }] : [];
  });
  return values;
}

/** The SKILL.md as stored, so native frontmatter (tools, invocation, …) moves with the companion. */
async function readSkillContent(botId: string, slug: string): Promise<string | null> {
  return readBotSkillSourceForBot(botId, slug);
}

const AVATAR_FETCH_TIMEOUT_MS = 15_000;

/**
 * The actor's public avatar (https) as bounded image bytes for the normal creation path. Cloud
 * data is untrusted: the shared guarded download checks every hop against private networks and
 * stops reading at the size limit.
 */
async function fetchAvatarBase64(url: string, signal?: AbortSignal): Promise<string | null> {
  try {
    const { buffer } = await fetchPublicImageBytes(url, BOT_AVATAR_MAX_BYTES, undefined, { signal, timeoutMs: AVATAR_FETCH_TIMEOUT_MS });
    return Buffer.from(buffer).toString('base64');
  } catch {
    return null;
  }
}

/**
 * The cloud avatar in a form the local profile holds; no usable cloud avatar means the same
 * default a new profile gets. A downloadable image that cannot be read throws: the take-over
 * must not finish with a stale avatar that the new home would publish.
 */
async function cloudAvatar(avatar: string | null, signal?: AbortSignal): Promise<{ portable: string } | { imageBase64: string }> {
  if (!avatar?.startsWith('https://')) return { portable: portableBotAvatarOrFallback(avatar) };
  const imageBase64 = await fetchAvatarBase64(avatar, signal);
  if (!imageBase64) throw new Error('AVATAR_UNAVAILABLE');
  return { imageBase64 };
}

type MaterializeLocal = Omit<CompanionMaterializeHost, 'latestRows'>;

function createMaterializer(input: {
  ensureCanonicalSession: (botId: string) => Promise<string>;
  rebuildContext: (sessionId: string) => Promise<'rebuilt' | 'busy'>;
  selfDeviceId?: () => string | null;
}): MaterializeLocal {
  return {
    applyTodos: async (botId, items, remove, fence) => {
      fence.assertCurrent();
      const todos = items.filter((item): item is TeammateTodo => !!item && typeof item === 'object'
        && typeof (item as { id?: unknown }).id === 'string' && (item as { id: string }).id.startsWith('todo:')
        && typeof (item as { title?: unknown }).title === 'string' && Array.isArray((item as { history?: unknown }).history));
      await companionTodoStore(botId).importItems(todos, remove);
    },
    applyRoutines: async (botId, routines, remove, fence) => {
      fence.assertCurrent();
      const valid = routines.filter((routine): routine is CompanionRoutineValue => !!routine && typeof routine === 'object'
        && typeof (routine as { id?: unknown }).id === 'string' && !!(routine as { input?: unknown }).input
        && Array.isArray((routine as { input: { triggers?: unknown } }).input.triggers));
      await importCompanionRoutines(botId, valid, remove, input.selfDeviceId?.() ?? null);
    },
    applyWorkbench: async (botId, value, fence, options) => {
      const self = input.selfDeviceId?.();
      if (!self) throw new Error('DEVICE_UNKNOWN');
      fence.assertCurrent();
      await mergeCompanionWorkbench(ownerScopedUserDataPath(), botId, self, value, options);
    },
    readProfile: async botId => {
      const [row] = await getDbClient().drizzle
        .select({ status: botProfiles.status, displayName: botProfiles.displayName, description: botProfiles.description })
        .from(botProfiles).where(eq(botProfiles.id, botId)).limit(1);
      return row ?? null;
    },
    // Normal creation path: no invitation, no generated persona, the new home's default model.
    createProfile: async ({ id, name, description, identitySource, userContextSource, avatar }, fence) => {
      const restored = await cloudAvatar(avatar, fence.signal);
      fence.assertCurrent();
      await createBotProfile({ id, name: name.slice(0, 200), description, identitySource, userContextSource,
        ...('portable' in restored ? { avatar: restored.portable } : { avatarImageBase64: restored.imageBase64 }) });
    },
    updateProfile: async ({ id, name, description, identitySource, userContextSource, avatar }, fence) => {
      const restored = await cloudAvatar(avatar, fence.signal);
      fence.assertCurrent();
      await updateBotProfile({ id, name: name.slice(0, 200), enabled: true,
        ...(description !== undefined ? { description } : {}),
        ...(identitySource !== undefined ? { identitySource } : {}),
        ...(userContextSource !== undefined ? { userContextSource } : {}),
        ...('portable' in restored ? { avatar: restored.portable } : {}) });
      if ('imageBase64' in restored) {
        const image = decodeBotAvatarImage(restored.imageBase64);
        fence.assertCurrent();
        if (image) await setBotProfileAvatar(id, image);
      }
    },
    writeSystemPrompt: async (botId, text, fence) => {
      const root = ownerScopedUserDataPath();
      fence.assertCurrent();
      await writeBotProfileFolder(root, botId, { systemPromptOverride: text });
    },
    backupHome: async (botId, fence) => {
      const source = botProfileDir(ownerScopedUserDataPath(), botId);
      const target = ownerScopedUserDataPath('companion-cloud-backups', `${path.basename(source)}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
      fence.assertCurrent();
      // Only a missing folder means "nothing to back up"; any other error stops the take-over.
      try { await fs.access(source); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
      // Identity, prompt, user file, memories and skills; the work folder stays where it is.
      await fs.cp(source, target, { recursive: true, filter: from => path.relative(source, from).split(path.sep)[0] !== 'workspace' });
      fence.assertCurrent();
      return target;
    },
    readMemory: async (botId, filename) => {
      if (path.basename(filename) !== filename) return null;
      // Only a missing file is "no memory"; other errors keep the take-over demoted for a retry.
      return fs.readFile(path.join(botProfileMemoryDir(ownerScopedUserDataPath(), botId), filename), 'utf8')
        .catch((error: NodeJS.ErrnoException) => { if (error?.code === 'ENOENT') return null; throw error; });
    },
    restoreMemory: (botId, filename, raw) => getBotMemoryService().restoreRaw(botId, filename, raw),
    removeMemory: (botId, filename) => getBotMemoryService().removeRaw(botId, filename),
    readSkill: readSkillContent,
    saveSkill: async (botId, slug, content, enabled) => { await saveBotSkillSourceForBot(botId, slug, content, { enabled }); },
    removeSkill: async (botId, slug) => { await deleteBotSkillForBot(botId, slug); },
    ensureCanonicalSession: botId => input.ensureCanonicalSession(botId),
    // Rewound and deleted rows are included (`removed`): removed here means never re-imported.
    localMessageTimes: async (sessionId, fromMs) => (await getDbClient().drizzle
      .select({ role: messages.role, createdAt: messages.createdAt, clientId: messages.clientId, rewindAt: messages.rewindAt }).from(messages)
      .where(and(eq(messages.sessionId, sessionId), inArray(messages.role, ['user', 'assistant', 'message_tombstone']), gte(messages.createdAt, fromMs))))
      .map(row => ({ role: row.role, createdAt: row.createdAt, clientId: row.clientId,
        ...(row.rewindAt !== null || row.role === 'message_tombstone' ? { removed: true } : {}) })),
    // Same row shape as ordinary messages; the client id keeps it out of the mirror.
    insertHistory: async (sessionId, row, fence) => {
      fence.assertCurrent();
      // Files brought from the room open like any attachment of the message.
      const files = row.attachments ?? [];
      const images = files.flatMap(file => file.url ? [{ url: file.url, mimeType: file.mimeType, originalName: file.name, size: file.size }] : []);
      const others = files.flatMap(file => !file.url && file.path ? [{ name: file.name, path: file.path }] : []);
      const names = row.role === 'assistant' ? files.map(file => `[附件: ${file.name}]`) : [];
      // The room's image copies were cached only: they belong to this task before the message is
      // written. A failed commit fails the import while the message is still absent, so the retry
      // downloads and commits again instead of treating it as imported with recyclable images.
      if (images.length) {
        const commit = await commitChatImageUrls({ sessionId, urls: images.map(image => image.url) });
        if (commit.failed > 0) throw new Error('HISTORY_IMAGE_COMMIT_FAILED');
        fence.assertCurrent();
      }
      await createMessage(sessionId, { clientId: row.clientId, role: row.role, createdAt: row.createdAt,
        content: row.role === 'user' ? { text: row.text, images, files: others }
          : [{ type: 'text', text: [row.text, ...names].filter(Boolean).join('\n') }] });
    },
    rebuildContext: sessionId => input.rebuildContext(sessionId),
  };
}

const mirrorColumns = {
  id: messages.id, clientId: messages.clientId, role: messages.role, content: messages.content,
  agentMeta: messages.agentMeta, createdAt: messages.createdAt,
};
const visibleRows = (sessionId: string) => and(eq(messages.sessionId, sessionId), isNull(messages.rewindAt),
  inArray(messages.role, ['user', 'assistant']));

export async function readMirrorRowsAfter(sessionId: string, cursor: CompanionMirrorCursor, limit: number): Promise<CompanionMirrorRow[]> {
  return getDbClient().drizzle.select(mirrorColumns).from(messages)
    .where(and(visibleRows(sessionId), or(gt(messages.createdAt, cursor.createdAt),
      and(eq(messages.createdAt, cursor.createdAt), gt(messages.id, cursor.id)))))
    .orderBy(asc(messages.createdAt), asc(messages.id)).limit(limit);
}

export async function readLatestMirrorRows(sessionId: string, limit: number,
  options: { excludeClientIdPrefix?: string } = {}): Promise<CompanionMirrorRow[]> {
  const prefix = options.excludeClientIdPrefix;
  return getDbClient().drizzle.select(mirrorColumns).from(messages)
    .where(prefix ? and(visibleRows(sessionId), or(isNull(messages.clientId), sql`substr(${messages.clientId}, 1, ${prefix.length}) <> ${prefix}`)) : visibleRows(sessionId))
    .orderBy(desc(messages.createdAt), desc(messages.id)).limit(limit);
}

/** One random id per Cindy installation (userData), so two installs on one computer can tell themselves apart. */
export function companionInstallationId(): string {
  const file = path.join(app.getPath('userData'), 'companion-installation-id');
  try {
    const stored = readAtomicFileSync(file)?.trim();
    if (stored && /^[0-9a-f-]{36}$/.test(stored)) return stored;
  } catch { /* regenerate below */ }
  const created = randomUUID();
  atomicWriteFileSync(file, created);
  return created;
}

/** Owner-scoped list of shadowed (demoted) companions, read before the server answers. */
export function companionShadowStore() {
  const file = () => ownerScopedUserDataPath('companion-cloud', 'shadowed.json');
  return {
    read(): string[] {
      try {
        const value = JSON.parse(readAtomicFileSync(file()) ?? '[]');
        return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
      } catch { return []; }
    },
    write(ids: string[]) { atomicWriteFileSync(file(), JSON.stringify([...ids].sort())); },
  };
}

/** Every live task the companion runs in: its main task, group lanes and delegations. */
async function companionSessionIds(botId: string): Promise<string[]> {
  const rows = await getDbClient().drizzle.select({ sessionId: botSessionLinks.sessionId }).from(botSessionLinks)
    .where(and(eq(botSessionLinks.botId, botId), isNull(botSessionLinks.archivedAt)));
  return rows.map(row => row.sessionId);
}

export function createCompanionCloudHost(input: {
  deliverToCanonical: CompanionCloudHost['deliverToCanonical'];
  ensureCanonicalSession: (botId: string) => Promise<string>;
  rebuildContext: (sessionId: string) => Promise<'rebuilt' | 'busy'>;
  /** A turn is running (or queued) in this Session. */
  isTurnActive?: (sessionId: string) => boolean;
  listDevices: () => Promise<DeviceLinkDeviceView[]>;
  probeCompanionCloud?: (deviceId: string) => Promise<boolean>;
  homeLink?: CompanionCloudHost['homeLink'];
  /** This computer's device-link id: names its workbench folders and routine check commands. */
  selfDeviceId?: () => string | null;
  /** Stop the turn running (and the input queued) in this Session, like the user's Stop. */
  stopTurn?: (sessionId: string) => Promise<void>;
  log?: CompanionLog;
}): CompanionCloudHost {
  // Every reader (send guards, routines, lists) sees only the active owner's homes, and that
  // owner's persisted demotion, even before its Chat Server instance has started.
  companionHomes.bindOwner(activeOwnerScopeKey, () => companionShadowStore().read());
  return {
    homes: companionHomes,
    openState: (endpoint, humanActorId, current) => createCompanionCloudState({
      filePath: ownerScopedUserDataPath('companion-cloud',
        `${createHash('sha256').update(`${endpoint}\n${humanActorId}`).digest('hex')}.json`),
      current, log: input.log,
    }),
    readValues: botId => readCompanionValues(botId, input.selfDeviceId?.() ?? null),
    // No main task yet is nothing to sync; conflicting ones are not: syncing, a hand-over and a merge
    // must stop rather than count this computer's history as sent.
    canonicalSession: async botId => {
      const resolved = await resolveBotCanonicalSession(botId);
      if (resolved.status === 'conflict') throw new Error('COMPANION_TASK_CONFLICT');
      return resolved.status === 'resolved' ? resolved.sessionId : null;
    },
    rowsAfter: readMirrorRowsAfter,
    latestRows: readLatestMirrorRows,
    deliverToCanonical: input.deliverToCanonical,
    onLocalChange: onBotRemoteResourceChanged,
    materializer: createMaterializer(input),
    listDevices: input.listDevices,
    ...(input.isTurnActive ? { isBotBusy: async (botId: string) =>
      (await companionSessionIds(botId)).some(sessionId => input.isTurnActive!(sessionId)) } : {}),
    ...(input.isTurnActive && input.stopTurn ? { stopBotTurns: async (botId: string) => {
      const busy = (await companionSessionIds(botId)).filter(sessionId => input.isTurnActive!(sessionId));
      await Promise.all(busy.map(sessionId => input.stopTurn!(sessionId)));
    } } : {}),
    ...(input.probeCompanionCloud ? { probeCompanionCloud: input.probeCompanionCloud } : {}),
    ...(input.homeLink ? { homeLink: input.homeLink } : {}),
    installationId: companionInstallationId,
    shadows: companionShadowStore(),
  };
}
