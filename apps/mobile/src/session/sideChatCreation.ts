import AsyncStorage from '@react-native-async-storage/async-storage';
import { getMobileAuthOwner, isMobileAuthOwnerCurrent, type MobileAuthOwnerGeneration } from '@/auth/authOwnerGeneration';
import type { MobileMakerTransport } from '@/device-link/mobileMakerTransport';
import { createNewSessionId } from './newSessionCreation';
import { remoteSessionStore } from './remoteSessionStore';
import type { RemoteSession } from './types';

type Device = { deviceId: string; deviceName: string };
type Maker = Pick<MobileMakerTransport, 'createSideChat'>;
type SavedChild = { id: string; createdAt: string };
const writes = new Map<string, Promise<void>>();
const running = new Set<string>();

function storageKey(owner: MobileAuthOwnerGeneration, deviceId: string, parentId: string) {
  return 'cindy.sideChatCreation.v1.' + JSON.stringify([owner.accountKey, deviceId, parentId]);
}

async function readSaved(key: string): Promise<SavedChild[]> {
  const raw = await AsyncStorage.getItem(key);
  if (!raw) return [];
  let rows: unknown;
  try { rows = JSON.parse(raw); } catch { return []; }
  return Array.isArray(rows) ? rows.filter((row): row is SavedChild =>
    typeof row?.id === 'string' && typeof row.createdAt === 'string') : [];
}

// Serialize only mutations to this parent's list. The editor and network fork
// each have their own lifetime. Store identities only; normal composer/outbox
// storage owns the user's text and attachment bytes.
function updateSaved(key: string, update: (rows: SavedChild[]) => SavedChild[]): Promise<void> {
  const next = (writes.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {
    const rows = update(await readSaved(key));
    if (rows.length) await AsyncStorage.setItem(key, JSON.stringify(rows));
    else await AsyncStorage.removeItem(key);
  });
  writes.set(key, next);
  return next.finally(() => { if (writes.get(key) === next) writes.delete(key); });
}

function preview(parent: RemoteSession, saved: SavedChild): RemoteSession {
  return {
    ...saved, parentSessionId: parent.id, source: 'side-chat', status: 'active',
    title: parent.title, userId: parent.userId, agentKind: parent.agentKind,
    model: parent.model, providerId: parent.providerId, permissionMode: parent.permissionMode,
    effort: parent.effort, fastMode: parent.fastMode, workspaceKind: parent.workspaceKind,
    workingDir: parent.workingDir, agentDeviceId: parent.agentDeviceId, extraDirs: parent.extraDirs,
    updatedAt: saved.createdAt, userSendAt: null, pendingLocalCreation: true,
  };
}

export function sideChatErrorKey(error: unknown) {
  if (/CHANNEL_NOT_ALLOWED|UNSUPPORTED_CAPABILITY|No handler/.test(String(error))) return 'session.sideChat.unsupported';
  if (/NO_PRIOR_ASSISTANT/.test(String(error))) return 'session.sideChat.waitForReply';
  return 'session.sideChat.createFailed';
}

export function startSideChatCreation(parent: RemoteSession, device: Device, maker: Maker): RemoteSession {
  const child = preview(parent, { id: createNewSessionId(), createdAt: new Date().toISOString() });
  void runSideChatCreation(child, device, maker);
  return child;
}

export async function runSideChatCreation(child: RemoteSession, device: Device, maker: Maker): Promise<void> {
  if (!child.pendingLocalCreation || child.source !== 'side-chat' || !child.parentSessionId) return;
  const parentId = child.parentSessionId;
  const owner = getMobileAuthOwner();
  const { deviceId, deviceName } = device;
  const key = storageKey(owner, deviceId, parentId);
  const operation = JSON.stringify([key, owner.generation, child.id]);
  if (running.has(operation)) return;
  running.add(operation);
  const pending = { ...child, sideChatCreationError: undefined };
  remoteSessionStore.upsertDeviceSession(deviceId, deviceName, pending);
  try {
    await updateSaved(key, rows => rows.some(row => row.id === child.id) ? rows : [
      ...rows, { id: child.id, createdAt: child.createdAt },
    ]);
    if (!isMobileAuthOwnerCurrent(owner)) return;
    const ready = await maker.createSideChat(parentId, child.id);
    if (!isMobileAuthOwnerCurrent(owner)) return;
    if (ready.id !== child.id || ready.source !== 'side-chat' || ready.parentSessionId !== parentId) {
      throw new Error('Unexpected side chat identity');
    }
    remoteSessionStore.upsertDeviceSession(deviceId, deviceName, ready);
  } catch (error) {
    if (!isMobileAuthOwnerCurrent(owner)) return;
    // The host list may already have confirmed this child while its creation reply was in transit.
    const mirrored = remoteSessionStore.getSessions().find(row => row.id === child.id && row.deviceLinkDeviceId === deviceId);
    if (!mirrored || mirrored.pendingLocalCreation) {
      remoteSessionStore.upsertDeviceSession(deviceId, deviceName, { ...pending, sideChatCreationError: sideChatErrorKey(error) });
      return;
    }
  } finally {
    running.delete(operation);
  }
  // A missed cleanup is reconciled against the host list when the picker opens.
  await updateSaved(key, rows => rows.filter(row => row.id !== child.id)).catch(() => {});
}

/** Restore unfinished drafts to the picker, including after an app restart.
 * Merely looking at the list must never start another fork. */
export async function readPendingSideChats(parent: RemoteSession, deviceId: string, hostIds: ReadonlySet<string>): Promise<RemoteSession[]> {
  const owner = getMobileAuthOwner();
  const key = storageKey(owner, deviceId, parent.id);
  await writes.get(key)?.catch(() => {});
  const saved = await readSaved(key).catch((): SavedChild[] => []);
  if (!isMobileAuthOwnerCurrent(owner)) return [];
  if (saved.some(row => hostIds.has(row.id))) {
    void updateSaved(key, rows => rows.filter(row => !hostIds.has(row.id))).catch(() => {});
  }
  const children = new Map<string, RemoteSession>();
  for (const row of saved) {
    if (!hostIds.has(row.id)) children.set(row.id, { ...preview(parent, row), sideChatCreationError: 'session.sideChat.createFailed' });
  }
  for (const row of remoteSessionStore.getSessions()) {
    if (row.deviceLinkDeviceId === deviceId && row.parentSessionId === parent.id
      && row.source === 'side-chat' && row.pendingLocalCreation && !hostIds.has(row.id)) children.set(row.id, row);
  }
  return [...children.values()];
}
