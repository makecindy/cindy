import { randomUUID } from 'node:crypto';
import { sessionCreateToRow } from './mapper.js';
import { getDbClient, getCurrentDbClientSnapshot } from './client/current.js';
import { sessions } from './schema.js';
import { ensureDialogueWorkspaceDir } from './dialogueWorkspace.js';
import { ensureProjectGitInitialized } from '../git-snapshot/projectGitBootstrap.js';
import { readGitSafetySettings } from '../maker-host/git-safety-settings-store.js';
import { normalizeWorkingDirForStorage } from '../../shared/workingDir.js';

export type SessionOpenBody = NonNullable<Parameters<typeof sessionCreateToRow>[1]>;
export type OpenedSessionRow = ReturnType<typeof sessionCreateToRow> & { model: string };
type ModelAdmission = (body: SessionOpenBody) => Promise<SessionOpenBody>;
let admitModel: ModelAdmission | null = null;

/** Host installs its ordinary model catalog once; UI, tools, companions and plugins share it. */
export function setSessionOpeningModelAdmission(admission: ModelAdmission): void {
  admitModel = admission;
}

/**
 * Open a normal Cindy Session. No messages are sent and no callback Agent is started.
 * Entry adapters authorize the caller/directory. A companion may atomically commit
 * its own receipt with the Session, while its timeline and completion signal remain outside.
 */
export async function openSession<T = void>(input: {
  id?: string;
  now?: number;
  body: SessionOpenBody;
  source?: OpenedSessionRow['source'];
  assertCurrent?: () => void;
  /** Sample effective authority after async preparation, directly before committing. */
  finalize?: () => Pick<SessionOpenBody, 'permissionMode' | 'parentSessionId'>;
  onPersistenceStarted?: () => void;
}, commit?: (row: OpenedSessionRow, assertCurrent: () => void) => Promise<T>): Promise<{ row: OpenedSessionRow; value: T }> {
  const owner = getCurrentDbClientSnapshot();
  const assertCurrent = () => {
    if (!owner || getCurrentDbClientSnapshot() !== owner) throw new Error('账号已变化，请重新新建任务');
    input.assertCurrent?.();
  };
  assertCurrent();
  const db = getDbClient().drizzle;
  const id = input.id ?? randomUUID();
  const now = input.now ?? Date.now();
  if (!admitModel) throw new Error('任务模型服务尚未就绪，请稍后重试');
  // Remote model admission belongs to the execution host. Preserve the existing remote path.
  const selected = input.body.remoteHostId ? input.body : await admitModel({ ...input.body });
  assertCurrent();
  const workspaceKind = selected.workspaceKind ?? 'project';
  const explicitDir = normalizeWorkingDirForStorage(selected.workingDir) ?? undefined;
  const workingDir = workspaceKind === 'dialogue' && !explicitDir
    ? ensureDialogueWorkspaceDir(id, now) : explicitDir;
  const prepared = { ...selected, workspaceKind, workingDir };
  const safety = readGitSafetySettings();
  await ensureProjectGitInitialized({ workingDir, workspaceKind, remoteHostId: prepared.remoteHostId ?? null,
    sessionId: id, autoSnapshotEnabled: safety.autoSnapshotEnabled,
    autoInitProjectGit: safety.autoInitProjectGit, source: 'session-open' });
  assertCurrent();
  const mapped = sessionCreateToRow(id, { ...prepared, ...input.finalize?.() }, now);
  if (!mapped.model) throw new Error('任务模型不可用，请重新选择');
  const row = { ...mapped, model: mapped.model, ...(input.source ? { source: input.source } : {}) };
  input.onPersistenceStarted?.();
  let value: T;
  if (commit) value = await commit(row, assertCurrent);
  else { await db.insert(sessions).values(row).run(); value = undefined as T; }
  assertCurrent();
  return { row, value };
}
