import AsyncStorage from '@react-native-async-storage/async-storage';
import { composerDocumentsEqual, parseStoredComposerDocument, composerDocumentProjectedText, type ComposerDocument } from '@/session/composerDocument';

const STORAGE_KEY_PREFIX = 'xdt.mobileComposerDraft.v1';
const DOCUMENT_STORAGE_KEY_PREFIX = 'xdt.mobileComposerDocument.v1';
const PERSIST_DEBOUNCE_MS = 400;
const drafts = new Map<string, string>();
const clearedDrafts = new Set<string>();
const clearedDocumentDrafts = new Set<string>();
const pendingPersistTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pendingDocumentPersistTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pendingStorageOperations = new Map<string, Promise<void>>();
const documentDrafts = new Map<string, ComposerDocument>();

export function saveComposerDraft(sessionId: string, text: string | null | undefined): void {
  const normalizedSessionId = normalizeSessionId(sessionId);
  if (!normalizedSessionId) return;

  const key = storageKeyForSession(normalizedSessionId);
  const value = text ?? '';
  if (value.length === 0) {
    cancelPendingPersist(normalizedSessionId);
    drafts.delete(normalizedSessionId);
    clearedDrafts.add(normalizedSessionId);
    enqueueStorageOperation(normalizedSessionId, () => AsyncStorage.removeItem(key));
    return;
  }

  drafts.set(normalizedSessionId, value);
  clearedDrafts.delete(normalizedSessionId);
  schedulePersist(normalizedSessionId, key, value);
}

export function saveComposerDocumentDraft(sessionId: string, document: ComposerDocument): void {
  const normalizedSessionId = normalizeSessionId(sessionId);
  if (!normalizedSessionId) return;
  const key = documentStorageKeyForSession(normalizedSessionId);
  if (document.nodes.length === 0) {
    cancelPendingDocumentPersist(normalizedSessionId);
    documentDrafts.delete(normalizedSessionId);
    clearedDocumentDrafts.add(normalizedSessionId);
    enqueueStorageOperation(normalizedSessionId, () => AsyncStorage.removeItem(key));
    return;
  }
  documentDrafts.set(normalizedSessionId, document);
  clearedDocumentDrafts.delete(normalizedSessionId);
  const serialized = JSON.stringify(document);
  scheduleDocumentPersist(normalizedSessionId, key, document, serialized);
}

export function readComposerDocumentDraftSync(sessionId: string): ComposerDocument | null {
  const normalizedSessionId = normalizeSessionId(sessionId);
  if (!normalizedSessionId || clearedDocumentDrafts.has(normalizedSessionId)) return null;
  return documentDrafts.get(normalizedSessionId) ?? null;
}

export async function readComposerDocumentDraft(sessionId: string): Promise<ComposerDocument | null> {
  const normalizedSessionId = normalizeSessionId(sessionId);
  if (!normalizedSessionId) return null;
  const memory = documentDrafts.get(normalizedSessionId);
  if (memory) return memory;
  if (clearedDocumentDrafts.has(normalizedSessionId)) return null;
  const stored = await AsyncStorage.getItem(documentStorageKeyForSession(normalizedSessionId)).catch(() => null);
  const freshMemory = documentDrafts.get(normalizedSessionId);
  if (freshMemory) return freshMemory;
  if (clearedDocumentDrafts.has(normalizedSessionId)) return null;
  if (!stored) return null;
  try {
    const parsed = parseStoredComposerDocument(JSON.parse(stored));
    if (!parsed) return null;
    documentDrafts.set(normalizedSessionId, parsed);
    return parsed;
  } catch {
    return null;
  }
}

export function readComposerDraftSync(sessionId: string): string | null {
  const normalizedSessionId = normalizeSessionId(sessionId);
  if (!normalizedSessionId) return null;
  if (clearedDrafts.has(normalizedSessionId)) return null;
  return drafts.get(normalizedSessionId) ?? null;
}

export async function readComposerDraft(sessionId: string): Promise<string | null> {
  const normalizedSessionId = normalizeSessionId(sessionId);
  if (!normalizedSessionId) return null;

  const memoryDraft = drafts.get(normalizedSessionId);
  if (memoryDraft !== undefined) return memoryDraft;
  if (clearedDrafts.has(normalizedSessionId)) return null;

  const storedDraft = await AsyncStorage.getItem(storageKeyForSession(normalizedSessionId)).catch(() => null);
  const freshMemoryDraft = drafts.get(normalizedSessionId);
  if (freshMemoryDraft !== undefined) return freshMemoryDraft;
  if (clearedDrafts.has(normalizedSessionId)) return null;
  if (!storedDraft) return null;
  drafts.set(normalizedSessionId, storedDraft);
  return storedDraft;
}

export async function consumeComposerDraft(sessionId: string): Promise<string | null> {
  const value = await readComposerDraft(sessionId);
  clearComposerDraft(sessionId);
  return value;
}

export function clearComposerDraft(sessionId: string): void {
  const normalizedSessionId = normalizeSessionId(sessionId);
  if (!normalizedSessionId) return;
  cancelPendingPersist(normalizedSessionId);
  cancelPendingDocumentPersist(normalizedSessionId);
  drafts.delete(normalizedSessionId);
  clearedDrafts.add(normalizedSessionId);
  documentDrafts.delete(normalizedSessionId);
  clearedDocumentDrafts.add(normalizedSessionId);
  enqueueStorageOperation(normalizedSessionId, () => AsyncStorage.multiRemove([
    storageKeyForSession(normalizedSessionId),
    documentStorageKeyForSession(normalizedSessionId),
  ]));
}

export async function clearComposerDrafts(): Promise<void> {
  cancelAllPendingPersists();
  cancelAllPendingDocumentPersists();
  drafts.clear();
  documentDrafts.clear();
  clearedDrafts.clear();
  clearedDocumentDrafts.clear();
  await drainPendingStorageOperations();
  const keys = await AsyncStorage.getAllKeys().catch(() => [] as readonly string[]);
  const ownedKeys = keys.filter((key) => (
    key.startsWith(`${STORAGE_KEY_PREFIX}.`) || key.startsWith(`${DOCUMENT_STORAGE_KEY_PREFIX}.`)
  ));
  if (ownedKeys.length === 0) return;
  await AsyncStorage.multiRemove(ownedKeys).catch(() => undefined);
}

export async function flushComposerDraftWrites(sessionId?: string): Promise<void> {
  const normalizedSessionId = sessionId === undefined ? undefined : normalizeSessionId(sessionId);
  if (sessionId !== undefined && !normalizedSessionId) return;
  const pending = normalizedSessionId
    ? pendingPersistTimers.has(normalizedSessionId)
      ? [[normalizedSessionId, pendingPersistTimers.get(normalizedSessionId)!] as const]
      : []
    : [...pendingPersistTimers.entries()];
  const pendingDocuments = normalizedSessionId
    ? pendingDocumentPersistTimers.has(normalizedSessionId)
      ? [[normalizedSessionId, pendingDocumentPersistTimers.get(normalizedSessionId)!] as const]
      : []
    : [...pendingDocumentPersistTimers.entries()];

  for (const [pendingSessionId, timer] of pending) {
    clearTimeout(timer);
    pendingPersistTimers.delete(pendingSessionId);
  }
  for (const [pendingSessionId, timer] of pendingDocuments) {
    clearTimeout(timer);
    pendingDocumentPersistTimers.delete(pendingSessionId);
  }

  await Promise.all([
    ...pending.map(([pendingSessionId]) => {
      const value = drafts.get(pendingSessionId);
      if (value === undefined) return Promise.resolve();
      return persistIfCurrent(pendingSessionId, storageKeyForSession(pendingSessionId), value);
    }),
    ...pendingDocuments.map(([pendingSessionId]) => {
      const document = documentDrafts.get(pendingSessionId);
      if (!document) return Promise.resolve();
      return persistDocumentIfCurrent(
        pendingSessionId,
        documentStorageKeyForSession(pendingSessionId),
        document,
        JSON.stringify(document),
      );
    }),
  ]);
  await drainPendingStorageOperations(normalizedSessionId);
}

/** Finish a committed send's draft handoff in the existing per-session write chain.
 * Failures propagate so the outbox keeps its recovery proof. Later user edits win.
 */
export async function reconcileCommittedComposerDraft(
  sessionId: string,
  handoff: { before: ComposerDocument; after: ComposerDocument },
  guard: () => void,
): Promise<void> {
  const id = normalizeSessionId(sessionId);
  guard();
  await flushComposerDraftWrites(id);
  await enqueueStorageOperation(id, async () => {
    guard();
    const documentKey = documentStorageKeyForSession(id);
    const textKey = storageKeyForSession(id);
    const raw = await AsyncStorage.getItem(documentKey);
    const text = await AsyncStorage.getItem(textKey);
    guard();
    const stored = raw ? parseStoredComposerDocument(JSON.parse(raw)) : null;
    if (raw && !stored) throw new Error('COMPOSER_DRAFT_INVALID');
    const memory = documentDrafts.get(id);
    const next = memory && !composerDocumentsEqual(memory, handoff.before)
      ? memory : stored && !composerDocumentsEqual(stored, handoff.before)
        ? stored : handoff.after;
    const replaceDocument = !!stored && composerDocumentsEqual(stored, handoff.before);
    const beforeText = composerDocumentProjectedText(handoff.before);
    const nextText = drafts.get(id);
    const replacementText = nextText !== undefined && nextText !== beforeText
      ? nextText : composerDocumentProjectedText(next);
    if (memory && composerDocumentsEqual(memory, handoff.before)) {
      documentDrafts.set(id, next);
      cancelPendingDocumentPersist(id);
    }
    if (nextText === beforeText) {
      drafts.set(id, replacementText);
      cancelPendingPersist(id);
    }
    if (replaceDocument) {
      await AsyncStorage.setItem(documentKey, JSON.stringify(next));
      guard();
    }
    if (text === beforeText) {
      await AsyncStorage.setItem(textKey, replacementText);
      guard();
    }
  }, true);
}

function normalizeSessionId(sessionId: string): string {
  return sessionId.trim();
}

function storageKeyForSession(normalizedSessionId: string): string {
  return `${STORAGE_KEY_PREFIX}.${encodeURIComponent(normalizedSessionId)}`;
}

function documentStorageKeyForSession(normalizedSessionId: string): string {
  return `${DOCUMENT_STORAGE_KEY_PREFIX}.${encodeURIComponent(normalizedSessionId)}`;
}

function schedulePersist(normalizedSessionId: string, key: string, value: string): void {
  cancelPendingPersist(normalizedSessionId);
  const timer = setTimeout(() => {
    pendingPersistTimers.delete(normalizedSessionId);
    void persistIfCurrent(normalizedSessionId, key, value);
  }, PERSIST_DEBOUNCE_MS);
  pendingPersistTimers.set(normalizedSessionId, timer);
}

function scheduleDocumentPersist(
  normalizedSessionId: string,
  key: string,
  document: ComposerDocument,
  serialized: string,
): void {
  cancelPendingDocumentPersist(normalizedSessionId);
  const timer = setTimeout(() => {
    pendingDocumentPersistTimers.delete(normalizedSessionId);
    void persistDocumentIfCurrent(normalizedSessionId, key, document, serialized);
  }, PERSIST_DEBOUNCE_MS);
  pendingDocumentPersistTimers.set(normalizedSessionId, timer);
}

function cancelPendingPersist(normalizedSessionId: string): void {
  const timer = pendingPersistTimers.get(normalizedSessionId);
  if (!timer) return;
  clearTimeout(timer);
  pendingPersistTimers.delete(normalizedSessionId);
}

function cancelPendingDocumentPersist(normalizedSessionId: string): void {
  const timer = pendingDocumentPersistTimers.get(normalizedSessionId);
  if (!timer) return;
  clearTimeout(timer);
  pendingDocumentPersistTimers.delete(normalizedSessionId);
}

function cancelAllPendingPersists(): void {
  for (const timer of pendingPersistTimers.values()) clearTimeout(timer);
  pendingPersistTimers.clear();
}

function cancelAllPendingDocumentPersists(): void {
  for (const timer of pendingDocumentPersistTimers.values()) clearTimeout(timer);
  pendingDocumentPersistTimers.clear();
}

async function persistIfCurrent(normalizedSessionId: string, key: string, value: string): Promise<void> {
  if (clearedDrafts.has(normalizedSessionId)) return;
  if (drafts.get(normalizedSessionId) !== value) return;
  await enqueueStorageOperation(normalizedSessionId, () => AsyncStorage.setItem(key, value));
}

async function persistDocumentIfCurrent(
  normalizedSessionId: string,
  key: string,
  document: ComposerDocument,
  serialized: string,
): Promise<void> {
  if (clearedDocumentDrafts.has(normalizedSessionId)) return;
  if (documentDrafts.get(normalizedSessionId) !== document) return;
  await enqueueStorageOperation(normalizedSessionId, () => AsyncStorage.setItem(key, serialized));
}

function enqueueStorageOperation(
  normalizedSessionId: string,
  operation: () => Promise<void>,
  propagateError = false,
): Promise<void> {
  const previous = pendingStorageOperations.get(normalizedSessionId) ?? Promise.resolve();
  const result = previous
    .catch(() => undefined)
    .then(operation);
  const next = result.catch(() => undefined);
  pendingStorageOperations.set(normalizedSessionId, next);
  void next.finally(() => {
    if (pendingStorageOperations.get(normalizedSessionId) === next) {
      pendingStorageOperations.delete(normalizedSessionId);
    }
  });
  return propagateError ? result : next;
}

async function drainPendingStorageOperations(normalizedSessionId?: string): Promise<void> {
  const pending = normalizedSessionId
    ? pendingStorageOperations.has(normalizedSessionId)
      ? [pendingStorageOperations.get(normalizedSessionId)!]
      : []
    : [...pendingStorageOperations.values()];
  await Promise.all(pending);
}

export const __testing = {
  documentStorageKeyForSession,
  persistDebounceMs: PERSIST_DEBOUNCE_MS,
  storageKeyForSession,
  storageKeyPrefix: STORAGE_KEY_PREFIX,
};
