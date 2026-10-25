import path from 'node:path';
import type { DbLogger } from '@cindy/runtime-db/logging';
import { openStandaloneNodeDatabase } from '../database.js';
import { TerminalTaskMedia } from '../tasks/media.js';
import { TerminalTaskStorage } from '../tasks/storage.js';
import { openTerminalConversations } from '../tasks/conversations.js';
import {createSessionOpening} from '@cindy/app-runtime/sessionOpening';
import {createDialogueWorkspace} from '@cindy/app-runtime/dialogueWorkspace';
import {createDialogueWorkspaceSettings} from '@cindy/app-runtime/dialogueWorkspaceSettings';
import {createTerminalGitSnapshots} from '../tasks/git-snapshots.js';

const cleanups: Array<() => Promise<void>> = [];
const logger: DbLogger = { debug() {}, info() {}, warn() {}, error() {} };

/** The same SQLite worker, schema and owner services as the running Node host. */
export async function taskStorageFixture(directory: string, ownerDatabase?: Awaited<ReturnType<typeof openStandaloneNodeDatabase>>) {
  const root = path.dirname(directory);
  const database = ownerDatabase ?? await openStandaloneNodeDatabase(root, logger);
  let current = true;
  const media = new TerminalTaskMedia(root, { database, logger, isCurrent: () => current });
  const storage = new TerminalTaskStorage(directory);
  const conversations = openTerminalConversations({
    database, media, profileDir: root, logger, region: 'global', isCurrent: () => current,
    isSessionRunning: () => false, isParentPiSessionLive: () => false,
    emit() {}, emitLocal() {}, emitRemote() {}, historyChanged() {}, getSessionProvider: id => storage.peekProvider(id),
    removeTurnChangeSetsForSession: async () => { throw new Error('No turn change service in storage fixture'); },
    materializeSshRemoteMedia: async () => { throw new Error('No SSH transport in storage fixture'); },
  });
  storage.configurePersistence(Promise.resolve(database), conversations);
  const dialogue=createDialogueWorkspace(createDialogueWorkspaceSettings({activeOwnerScopeKey:()=>root,
    ownerScopedUserDataPath:(...parts)=>path.join(root,...parts),createLogger:()=>logger}));
  const git=createTerminalGitSnapshots({dataRoot:root,database,
    logger:{...logger,trace(){},fatal(){},child(){return this;}},
    assertCurrent:()=>{if(!current)throw new Error('Fixture owner closed');},
    maker:{getSessionMeta:id=>storage.get(id),oneShot:async()=>{throw new Error('No model transport in storage fixture');}},
    isAgentOneShotRouteDisabled:async()=>true,
  });
  const opening=createSessionOpening({...database,...(await conversations).rowMapper,...dialogue,...git});
  opening.setSessionOpeningModelAdmission(async body=>body);
  storage.configureOpening(opening);
  cleanups.push(async () => {
    try { await git.close(); await storage.flush(); await (await conversations).persistence.drainPersistQueue(); await media.close(); }
    finally { current = false; if (!ownerDatabase) await database.close(); }
  });
  await storage.open();
  return storage;
}

export async function closeTaskStorageFixtures() {
  for (const close of cleanups.splice(0).reverse()) await close();
}
