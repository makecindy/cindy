import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { app, ipcMain } from 'electron';
import {
  TASK_MIGRATION_CHANNEL,
  TASK_MIGRATION_LOCAL_CHANNEL,
  TASK_MIGRATION_MAX_FILES,
  TASK_MIGRATION_MAX_TRANSCRIPTS,
  TASK_MIGRATION_ESTIMATE_TIMEOUT_MS,
  DeviceLinkError,
  parseTaskMigrationRequest,
  buildAttachmentOssRef,
  parsePeerAttachmentRef,
  isSharedTaskPeer,
  FILE_PEER_MAX_BYTES,
  type MigrationFile,
  type MigrationResources,
  type MigrationFileRef,
  type MigrationFiles,
  type TaskMigrationRequest,
  type TaskMigrationView,
} from '@cindy/device-link';
import { getDbClient, tryGetDbClient } from '../localDb/client/current';
import { dialogueWorkspaceDayKey } from '../localDb/dialogueWorkspace';
import { upsertRecentWorkdir } from '../localDb/ipc/recentWorkdirs';
import { readDialogueWorkspaceSettings } from '../dialogue-workspace-settings';
import { collapseWorktreeDirForGrouping } from '@cindy/maker-shared/worktree-paths';
import { emitSessionCreated } from '../localDb/ipc/sessionCreatedBroadcast';
import { withSessionRouteLocks } from '../localDb/sessionRouteLock';
import { getActiveTeamByLead } from '../localDb/orcaTeamStore';
import { getSelfDeviceId, remoteInvoke } from '../device-link';
import { getDeviceLinkInvokeContext } from '../device-link/invoke-context';
import { readDeviceLinkSettings } from '../device-link/settings-store';
import { withCrossProcessLock } from '../device-link/crossProcessLock';
import { tryUploadPeerAttachment } from '../device-link/filePeer';
import { uploadLocalFile, removeRemote, MAX_MEDIA_BYTES } from '../device-link/mediaTransfer';
import {
  materializeRemoteAttachment,
  parseRemoteAttachmentRef,
} from '../device-link/remoteAttachment';
import { createLogger } from '../logger';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer';
import { throwIpcError } from '../utils/ipcValidate';
import { atomicWriteFileSync, readAtomicFileSync } from '../utils/atomicWriteFile';
import { captureMediaRefCompensationScope } from '../cindy-media/refCompensationJournal';
import { exportSessionShare } from '../session-share/sessionShareExport';
import {
  commitShareImport,
  inspectShareFile,
  cancelShareDraft,
  type ShareImportDraftPrefs,
} from '../session-share/sessionShareImport';
import type { moveSessionProjectFromHost } from '../mcp-integrations/moveSession';
import { physicalWorktreeKey, withWorktreeResourceLocks } from '../worktree/resourceLock';
import { GitExecError } from '../worktree/gitExec';
import { getMakerIfReady } from '../maker-host';
import { getDesktopProviderService } from '../maker-host/createDesktopProviderService';
import { pickEnabledFallbackModel } from '../maker-host/model-route-guard';
import { advanceHandoff, canCancelHandoff, type MigrationHandoff } from './handoff';
import { migrationScope, type MigrationRecord, type IncomingMigration } from './journal';
import {
  snapshotWorkspace,
  restoreWorkspace,
  estimateWorkspace,
  isExcludedFromWorkspace,
  managedWorktreeExclusions,
  MigrationPathError,
  type PortableWorkspace,
} from './workspace';

import {
  memoryBudget,
  memoryBudgetDetail,
  assertMemoryCapacity,
  assertDiskCapacity,
  MigrationSizeError,
} from './resources';
import { sendParts, receiveParts } from './transferParts';
import type { SkippedEntry } from './portableEntries';

const log = createLogger('task-migration');
/** Native transcripts this large travel as separate streamed files, not inside the package. */
const EXTERNAL_TRANSCRIPT_MIN_BYTES = 32 * 1024 * 1024;
/** The finished copy lists this many left-behind entries; the count covers the rest. */
const MAX_REPORTED_SKIPPED = 100;

type MoveProject = (
  sessionId: string,
  workingDir: string | null,
  assertAuthority: () => void,
) => ReturnType<typeof moveSessionProjectFromHost>;
// Bootstrap supplies the existing business handler; importing maker IPC here creates a cycle.
let moveProjectOnHost: MoveProject | undefined;
let sourceBoundary: { isBusy(sessionId: string): boolean; drain(): Promise<void> } | undefined;
interface RunningCopy {
  progress?: TaskMigrationView['progress'];
  /** The target may commit from here on; cancelling would orphan its copy. */
  committing?: boolean;
  cancelRequested?: boolean;
  /** Aborted together with cancelRequested so the file in flight stops, not just the next checkpoint. */
  abort: AbortController;
}
const running = new Map<string, RunningCopy>();
/** The target's cause never crosses the wire (only its code does), so keep it in this log. */
const logTargetFailure =
  (action: 'preflight' | 'receive', copyId: string | null) =>
  (error: unknown): never => {
    log.warn('task copy target step failed', {
      action,
      copyId,
      code: errorCode(error),
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    });
    throw error;
  };
const errorCode = (error: unknown): string => {
  if ((error as NodeJS.ErrnoException)?.code === 'ENOSPC') return 'MIGRATION_NO_SPACE';
  const message = error instanceof Error ? error.message : '';
  return /\bMIGRATION_[A-Z_]+\b/.exec(message)?.[0] ?? 'MIGRATION_FAILED';
};
function selfId(): string {
  const id = getSelfDeviceId();
  if (!id) throw new Error('MIGRATION_NOT_CONNECTED');
  return id;
}
function captureScope() {
  const scope = migrationScope(),
    db = getDbClient();
  const caller = getDeviceLinkInvokeContext();
  const assertCurrent = () => {
    scope.assertCurrent();
    if (db !== tryGetDbClient()) throw new Error('MIGRATION_OWNER_CHANGED');
    if (caller) {
      const settings = readDeviceLinkSettings();
      if (
        caller.sharedTask ||
        isSharedTaskPeer(caller.controllerDeviceId) ||
        !settings.remoteControlEnabled ||
        settings.revokedControllers.includes(caller.controllerDeviceId)
      )
        throw new Error('MIGRATION_ACCESS_REVOKED');
    }
  };
  assertCurrent();
  return { ...scope, db, assertCurrent };
}
type Scope = ReturnType<typeof captureScope>;
async function projects(scope: Scope): Promise<string[]> {
  const rows = await scope.db.query<{ path: string }>(
    'SELECT path FROM recent_workdirs ORDER BY last_used_at DESC LIMIT 100',
    [],
  );
  scope.assertCurrent();
  const available: string[] = [];
  // Recent paths are history, not proof that a mount or directory still exists.
  // Reuse this check for capabilities, preflight and receive-time validation.
  for (const row of rows) {
    if (
      await fs.stat(row.path).then(
        (stat) => stat.isDirectory(),
        () => false,
      )
    )
      available.push(row.path);
  }
  scope.assertCurrent();
  return available;
}
async function invoke(
  device: string,
  request: TaskMigrationRequest,
  scope: Scope,
): Promise<TaskMigrationView> {
  scope.assertCurrent();
  let response: Awaited<ReturnType<typeof remoteInvoke>>;
  try {
    response = await remoteInvoke(device, TASK_MIGRATION_CHANNEL, [request], {
      preSend: scope.assertCurrent,
    });
  } catch (error) {
    // The source may still be working; tell the user it was slow, not that it is offline.
    if (error instanceof DeviceLinkError && error.code === 'INVOKE_TIMEOUT')
      throw new Error('MIGRATION_TIMEOUT');
    throw error;
  }
  scope.assertCurrent();
  if (!response.ok)
    throw new Error(
      response.error.code === 'CHANNEL_NOT_ALLOWED'
        ? 'MIGRATION_UNSUPPORTED'
        : errorCode(new Error(response.error.message)),
    );
  const result = response.result as TaskMigrationView;
  if (result?.supported !== true || result.deviceId !== device)
    throw new Error('MIGRATION_UNSUPPORTED');
  return result;
}
function view(scope: Scope, record: MigrationRecord | null): TaskMigrationView {
  const live = record ? running.get(`${scope.root}:${record.sessionId}`) : undefined;
  return {
    supported: true,
    deviceId: selfId(),
    ...(record
      ? {
          stage: record.stage,
          running: !!live,
          progress: live?.progress,
          ...(live?.cancelRequested
            ? { cancelling: true as const }
            : live && !live.committing && record.kind === 'outgoing'
              ? { cancellable: true as const }
              : {}),
          ...(record.kind === 'outgoing'
            ? {
                targetDeviceId: record.targetDeviceId,
                targetSessionId: record.targetSessionId,
                ...(record.error ? { error: record.error } : {}),
                ...(record.error && record.errorPath ? { errorPath: record.errorPath } : {}),
                ...(record.skipped ? { skipped: record.skipped } : {}),
                ...(record.error &&
                record.errorSize &&
                Number.isSafeInteger(record.errorSize.needed) &&
                Number.isSafeInteger(record.errorSize.limit)
                  ? { errorSize: record.errorSize }
                  : {}),
              }
            : {}),
        }
      : {}),
  };
}

interface SourceSession {
  id: string;
  workingDir: string;
  workspaceKind: string;
  remoteHostId: string | null;
  agentDeviceId: string | null;
  status: string;
  source: string;
  orcaRole: string | null;
  agentKind: 'cc' | 'codex' | 'pi';
  updatedAt: number;
}
async function assertSource(
  scope: Scope,
  sessionId: string,
  worker = false,
): Promise<SourceSession> {
  const row = await scope.db.queryOne<SourceSession>(
    'SELECT id, working_dir AS workingDir, workspace_kind AS workspaceKind, remote_host_id AS remoteHostId, agent_device_id AS agentDeviceId, status, source, orca_role AS orcaRole, agent_kind AS agentKind, updated_at AS updatedAt FROM sessions WHERE id = ?',
    [sessionId],
  );
  scope.assertCurrent();
  if (
    !row ||
    !(row.status === 'active' || (worker && row.status === 'archived')) ||
    !row.workingDir ||
    row.remoteHostId ||
    // Agent 在另一台电脑运行的任务：Agent 会话记录在那台，本机无法完整复制。
    row.agentDeviceId ||
    (worker ? row.orcaRole !== 'worker' : row.orcaRole === 'worker') ||
    !['desktop', 'shared', 'feishu'].includes(row.source)
  )
    throw new Error('MIGRATION_TASK_UNSUPPORTED');
  const queued = await scope.db.queryOne<{ payload: string }>(
    'SELECT payload FROM agent_input_queue_snapshots WHERE session_id = ?',
    [sessionId],
  );
  scope.assertCurrent();
  if (queued?.payload) {
    let messages: unknown;
    try {
      messages = JSON.parse(queued.payload);
    } catch {
      throw new Error('MIGRATION_TASK_QUEUED');
    }
    if (!Array.isArray(messages) || messages.length) throw new Error('MIGRATION_TASK_QUEUED');
  }
  const live = getMakerIfReady()?.getSession(sessionId);
  if (!sourceBoundary) throw new Error('MIGRATION_HOST_NOT_READY');
  if (live?.isTurnRunning() || sourceBoundary.isBusy(sessionId))
    throw new Error('MIGRATION_TASK_RUNNING');
  return row;
}

async function sourceGroup(scope: Scope, sessionId: string): Promise<SourceSession[]> {
  const lead = await assertSource(scope, sessionId);
  if (lead.orcaRole !== 'lead') return [lead];
  const team = await getActiveTeamByLead(sessionId);
  scope.assertCurrent();
  if (!team) throw new Error('MIGRATION_TEAM_CHANGED');
  const reservations = await scope.db.queryOne<{ n: number }>(
    'SELECT count(*) AS n FROM orca_worker_creation_reservations WHERE team_id = ? AND expires_at > ?',
    [team.id, Date.now()],
  );
  if (reservations?.n) throw new Error('MIGRATION_TASK_BUSY');
  const rows = await scope.db.query<{ sessionId: string }>(
    'SELECT session_id AS sessionId FROM orca_workers WHERE team_id = ? ORDER BY created_at ASC, id ASC',
    [team.id],
  );
  const members = [lead];
  for (const row of rows) members.push(await assertSource(scope, row.sessionId, true));
  scope.assertCurrent();
  return members;
}

interface WorkspaceBundle extends PortableWorkspace {
  additionalWorkspaces?: PortableWorkspace[];
  workers?: Array<{ sourceSessionId: string; sessionId: string; workspace: number }>;
  /**
   * Native transcripts sent beside the package (`files.transcripts`, same order): `path` is the
   * transcript ref they stand for, `file` the staged name in the outgoing directory.
   */
  transcripts?: Array<{ path: string; file: string; bytes: number }>;
  /**
   * Where a copy lands when no target project is chosen: the dialogue workspace, or a new project
   * at the source folder's path under the home directory. Older sources omit it.
   */
  destination?: { kind: 'dialogue' } | { kind: 'project'; path: string[] };
}
function copyDestination(lead: SourceSession): NonNullable<WorkspaceBundle['destination']> {
  if (lead.workspaceKind === 'dialogue') return { kind: 'dialogue' };
  // A task in a worktree belongs to the project the sidebar groups it under.
  const project = collapseWorktreeDirForGrouping(lead.workingDir);
  const relative = path.relative(app.getPath('home'), project);
  const segments = relative ? relative.split(path.sep) : [];
  return {
    kind: 'project',
    path:
      segments.length && segments[0] !== '..' && !path.isAbsolute(relative)
        ? segments
        : [path.basename(project)],
  };
}
const folderName = (name: unknown): name is string =>
  typeof name === 'string' &&
  name.length > 0 &&
  name.length <= 255 &&
  name !== '.' &&
  name !== '..' &&
  !/[\\/\0]/.test(name) &&
  (process.platform !== 'win32' || !/[<>:"|?*\x00-\x1f]|[. ]$/.test(name));
interface Placement {
  parent: string;
  name: string;
  project?: true;
  /** Makes `parent` usable; rejects when this place cannot hold the copy. */
  prepare(): Promise<unknown>;
}
/**
 * Places a copy may land, in order. A chosen project or the dialogue workspace is the only place.
 * A new project mirrors the source path under home, then tries the source folder name alone,
 * then an app-managed folder, which is also where copies from older sources land.
 */
function placements(
  scope: Scope,
  request: { id: string; targetProject: string | null },
  destination: WorkspaceBundle['destination'],
): Placement[] {
  const managedName = `cindy-${request.id.slice(0, 8)}-${randomUUID()}`;
  if (request.targetProject)
    return [{ parent: request.targetProject, name: managedName, prepare: async () => {} }];
  if (destination?.kind === 'dialogue') {
    const { directory, isCustomized } = readDialogueWorkspaceSettings();
    const parent = path.join(directory, dialogueWorkspaceDayKey(Date.now()));
    return [
      {
        parent,
        name: request.id,
        // A custom root is never recreated: an unmounted volume may leave a writable mount point.
        prepare: () =>
          fs
            .mkdir(parent, { recursive: !isCustomized })
            .catch(async (error: NodeJS.ErrnoException) => {
              if (error.code !== 'EEXIST' || !(await fs.stat(parent)).isDirectory()) throw error;
            }),
      },
    ];
  }
  const managed = path.join(scope.root, 'projects');
  const fallback: Placement = {
    parent: managed,
    name: managedName,
    prepare: () => fs.mkdir(managed, { recursive: true, mode: 0o700 }),
  };
  if (destination?.kind !== 'project' || !Array.isArray(destination.path)) return [fallback];
  const segments = destination.path;
  return [
    ...[segments.length <= 32 ? segments : [], segments.slice(-1)]
      .filter((candidate) => candidate.length && candidate.every(folderName))
      .map((candidate): Placement => {
        const parent = path.join(app.getPath('home'), ...candidate.slice(0, -1));
        return {
          parent,
          name: candidate[candidate.length - 1],
          project: true,
          prepare: () => fs.mkdir(parent, { recursive: true }),
        };
      }),
    fallback,
  ];
}
/**
 * Creates the copy folder at the first place that accepts it. `mkdir` is the reservation: an
 * existing entry is never reused (`name`, then `name 2`…), so concurrent copies cannot share one.
 * Any other failure, such as a parent that is a file or a name the file system rejects, moves on.
 */
async function createWorkingDir(places: Placement[]): Promise<{ dir: string; place: Placement }> {
  let failure: unknown = new Error('MIGRATION_TARGET_UNKNOWN');
  for (const place of places) {
    try {
      await place.prepare();
      // Each EEXIST is another existing entry, so numbering ends within the folder's entries.
      for (let n = 1; ; n++) {
        const dir = path.join(place.parent, n === 1 ? place.name : `${place.name} ${n}`);
        try {
          await fs.mkdir(dir);
          return { dir, place };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
      }
    } catch (error) {
      failure = error;
    }
  }
  throw failure;
}
const workspaces = (workspace: WorkspaceBundle) => [
  workspace,
  ...(workspace.additionalWorkspaces ?? []),
];
const workspaceDirectory = (root: string, index: number) =>
  index ? path.join(root, String(index)) : root;
const transferFiles = (files: MigrationFiles) => [
  files.session,
  files.manifest,
  files.workspace,
  ...(files.repository ? [files.repository] : []),
  ...(files.additionalWorkspaces ?? []).flatMap((entry) => [
    entry.workspace,
    ...(entry.repository ? [entry.repository] : []),
  ]),
  ...(files.transcripts ?? []),
];

async function prepare(scope: Scope, record: MigrationHandoff) {
  const members = await sourceGroup(scope, record.sessionId);
  const sourceRevision = JSON.stringify(members);
  const expected = [
    { sessionId: record.sessionId, workingDir: record.workingDir },
    ...(record.workers ?? []),
  ];
  if (
    members.length !== expected.length ||
    (record.workers !== undefined) !== (members[0].orcaRole === 'lead') ||
    members.some(
      (member, index) =>
        member.id !== expected[index].sessionId || member.workingDir !== expected[index].workingDir,
    )
  )
    throw new Error('MIGRATION_TEAM_CHANGED');
  const directory = path.join(scope.root, 'outgoing', record.id);
  // Preparing owns no published transfer references. Replace only its staging copy.
  await fs.rm(directory, { recursive: true, force: true });
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await withWorktreeResourceLocks(
    members.map((member) => member.workingDir),
    async () => {
      scope.assertCurrent();
      // Fork siblings can share cwd. Never snapshot while any known task is writing that tree.
      const sourceKeys = [
        ...new Set(
          await Promise.all(members.map((member) => physicalWorktreeKey(member.workingDir))),
        ),
      ];
      // A task inside another managed worktree under a copied root does not touch copied files.
      const excluded = await Promise.all(sourceKeys.map(managedWorktreeExclusions));
      for (const session of getMakerIfReady()?.listActiveSessions() ?? []) {
        if (!session.isTurnRunning() && !sourceBoundary!.isBusy(session.id)) continue;
        const row = await scope.db.queryOne<{
          workingDir: string | null;
          remoteHostId: string | null;
        }>(
          'SELECT working_dir AS workingDir, remote_host_id AS remoteHostId FROM sessions WHERE id = ?',
          [session.id],
        );
        if (row?.workingDir && !row.remoteHostId) {
          const key = await physicalWorktreeKey(row.workingDir);
          if (
            sourceKeys.some(
              (sourceKey, index) =>
                key === sourceKey ||
                (key.startsWith(sourceKey + path.sep) &&
                  !isExcludedFromWorkspace(sourceKey, key, excluded[index])) ||
                sourceKey.startsWith(key + path.sep),
            )
          )
            throw new Error('MIGRATION_SHARED_DIRECTORY_BUSY');
        }
      }
      scope.assertCurrent();
      await sourceBoundary!.drain();
      scope.assertCurrent();
      if (members.some((member) => sourceBoundary!.isBusy(member.id)))
        throw new Error('MIGRATION_TASK_RUNNING');
      // Decided per preparation (not at start), so retrying after updating the target uses it.
      const external =
        (await invoke(record.targetDeviceId, { action: 'caps' }, scope)).externalTranscripts ===
        true;
      const result = await exportSessionShare({
        sessionId: record.sessionId,
        targetPath: path.join(directory, 'session.cshare'),
        sizeLimitBytes: memoryBudget(),
        migration: true,
        ...(external
          ? {
              externalTranscripts: { dir: directory, minBytes: EXTERNAL_TRANSCRIPT_MIN_BYTES },
            }
          : {}),
      });
      scope.assertCurrent();
      if (result.status === 'oversize') {
        const { status: _status, ...sizes } = result;
        log.warn('task copy package exceeds the memory budget', {
          copyId: record.id,
          externalTranscripts: external,
          ...sizes,
          budget: memoryBudgetDetail(),
        });
        // An older target needs transcripts inside the package. Ask to update it only when the
        // transcripts an updated target would move out actually bring the package within budget.
        const movable = (result.transcriptFileBytes ?? [])
          .filter((bytes) => bytes >= EXTERNAL_TRANSCRIPT_MIN_BYTES)
          .reduce((sum, bytes) => sum + bytes, 0);
        if (!external && movable > 0 && result.totalBytes - movable <= result.limitBytes)
          throw new Error('MIGRATION_UNSUPPORTED');
        throw new MigrationSizeError('MIGRATION_NO_MEMORY', result.totalBytes, result.limitBytes);
      }
      if (result.status !== 'ok' || result.fidelity !== 'full' || result.mediaDropped)
        throw new Error('MIGRATION_INCOMPLETE_CONTEXT');
      // The target rejects more transcripts than the protocol allows; stop before uploading them.
      if ((result.externalTranscripts?.length ?? 0) > TASK_MIGRATION_MAX_TRANSCRIPTS)
        throw new Error('MIGRATION_NO_MEMORY');
      const snapshots: PortableWorkspace[] = [];
      const skipped: SkippedEntry[] = [];
      for (const [index, dir] of sourceKeys.entries()) {
        const { skipped: left, ...snapshot } = await snapshotWorkspace(
          dir,
          workspaceDirectory(directory, index),
          record.id,
        );
        snapshots.push(snapshot);
        // Other members' worktrees are named by folder; the task's own paths stay project-relative.
        for (const entry of left)
          skipped.push(index ? { ...entry, path: `${path.basename(dir)}/${entry.path}` } : entry);
      }
      if (skipped.length)
        log.warn('task copy leaves entries behind', {
          copyId: record.id,
          count: skipped.length,
        });
      record.skipped = skipped.length
        ? { total: skipped.length, entries: skipped.slice(0, MAX_REPORTED_SKIPPED) }
        : undefined;
      // Copy does not freeze input. Discard preparation if the task or team changed
      // while capturing conversation and files, including a turn that already finished.
      await sourceBoundary!.drain();
      if (JSON.stringify(await sourceGroup(scope, record.sessionId)) !== sourceRevision)
        throw new Error('MIGRATION_SOURCE_CHANGED');
      const workspace: WorkspaceBundle = {
        ...snapshots[0],
        destination: copyDestination(members[0]),
        ...(result.externalTranscripts?.length
          ? {
              transcripts: result.externalTranscripts.map(({ path: ref, file, bytes }) => ({
                path: ref,
                file,
                bytes,
              })),
            }
          : {}),
        ...(record.workers
          ? {
              additionalWorkspaces: snapshots.slice(1),
              workers: await Promise.all(
                record.workers.map(async (worker) => ({
                  sourceSessionId: worker.sessionId,
                  sessionId: worker.targetSessionId,
                  workspace: sourceKeys.indexOf(await physicalWorktreeKey(worker.workingDir)),
                })),
              ),
            }
          : {}),
      };
      scope.assertCurrent();
      workspace.contextBytes =
        result.unpackedBytes ?? (await fs.stat(path.join(directory, 'session.cshare'))).size;
      atomicWriteFileSync(path.join(directory, 'workspace.json'), JSON.stringify(workspace));
      await preflight(scope, record, workspace, directory);
    },
  );
}

async function sendFile(
  scope: Scope,
  device: string,
  file: string,
  artifacts = path.dirname(file),
  onProgress?: (bytes: number) => void,
  signal?: AbortSignal,
): Promise<MigrationFile> {
  const space = await fs.statfs(path.dirname(file));
  const partBytes = Math.floor(
    Math.min(FILE_PEER_MAX_BYTES, MAX_MEDIA_BYTES, (space.bavail * space.bsize) / 4),
  );
  let completed = 0;
  return sendParts(
    file,
    partBytes,
    async (part) => {
      const result = await sendPart(
        scope,
        device,
        part,
        artifacts,
        (bytes) => onProgress?.(completed + bytes),
        signal,
      );
      completed += result.size;
      onProgress?.(completed);
      return result;
    },
    signal,
  );
}
async function sendPart(
  scope: Scope,
  device: string,
  file: string,
  artifacts: string,
  onProgress?: (bytes: number) => void,
  signal?: AbortSignal,
): Promise<MigrationFileRef> {
  scope.assertCurrent();
  const peer = await tryUploadPeerAttachment(
    device,
    file,
    'application/octet-stream',
    (deviceId, channel, args) =>
      remoteInvoke(deviceId, channel, args, { preSend: scope.assertCurrent }),
    onProgress,
    signal,
  );
  scope.assertCurrent();
  if (peer) {
    const result = parsePeerAttachmentRef(peer);
    if (!result) throw new Error('MIGRATION_TRANSFER_FAILED');
    return { ref: peer, size: result.size, sha256: result.sha256 };
  }
  onProgress?.(0); // OSS fallback starts this part again, not a second completed part.
  const result = await uploadLocalFile(file, {
    maxBytes: (await fs.stat(file)).size,
    onProgress,
    signal,
  });
  // Record the upload before the checkpoint so a cancelled copy still deletes it.
  const keysFile = path.join(artifacts, 'transfer-keys.json');
  const keys = JSON.parse(readAtomicFileSync(keysFile) ?? '[]') as string[];
  atomicWriteFileSync(keysFile, JSON.stringify([...keys, result.key]));
  scope.assertCurrent();
  return {
    ref: buildAttachmentOssRef({ ossKey: result.key, size: result.size, sha256: result.sha256 }),
    size: result.size,
    sha256: result.sha256,
  };
}
async function preflight(
  scope: Scope,
  record: MigrationHandoff,
  workspace: WorkspaceBundle,
  directory: string,
) {
  const statSize = async (name: string) => (await fs.stat(path.join(directory, name))).size;
  const sizes = await Promise.all(
    [
      'session.cshare',
      'workspace.json',
      ...workspaces(workspace).flatMap((entry, index) => [
        path.join(index ? String(index) : '', entry.archive.file),
        ...(entry.git ? [path.join(index ? String(index) : '', 'repository.bundle')] : []),
      ]),
    ].map(statSize),
  );
  const transcriptSizes = await Promise.all(
    (workspace.transcripts ?? []).map((transcript) => statSize(transcript.file)),
  );
  const transcriptBytes = transcriptSizes.reduce((a, b) => a + b, 0);
  const resources: MigrationResources = {
    ...(transcriptSizes.length ? { transcriptBytes } : {}),
    transferBytes: sizes.reduce((a, b) => a + b, 0) + transcriptBytes,
    unpackedBytes: workspaces(workspace).reduce((sum, entry) => sum + entry.unpackedBytes, 0),
    contextBytes: Math.max(workspace.contextBytes ?? sizes[0], sizes[0]),
    manifestBytes: sizes[1],
    repositoryBytes: (
      await Promise.all(
        workspaces(workspace).map(async (entry, index) =>
          entry.git
            ? (await fs.stat(path.join(workspaceDirectory(directory, index), 'repository.bundle')))
                .size
            : 0,
        ),
      )
    ).reduce((a, b) => a + b, 0),
    entries: workspaces(workspace).reduce(
      (sum, entry) => sum + Object.keys(entry.archive.files ?? {}).length,
      0,
    ),
  };
  await invoke(
    record.targetDeviceId,
    { action: 'preflight', targetProject: record.targetProject, resources },
    scope,
  );
  return resources;
}
async function checkTargetResources(
  scope: Scope,
  targetProject: string | null,
  /** Where the files land; null before the target knows (the receive step checks it again). */
  destination: string | null,
  resources: MigrationResources,
) {
  if (targetProject && !(await projects(scope)).includes(targetProject))
    throw new Error('MIGRATION_TARGET_UNKNOWN');
  assertMemoryCapacity(resources.contextBytes + resources.manifestBytes);
  await fs.mkdir(scope.root, { recursive: true });
  await assertDiskCapacity([
    { path: scope.root, bytes: resources.transferBytes * 2 + resources.contextBytes * 2 },
    ...(destination
      ? [
          {
            path: destination,
            bytes:
              resources.unpackedBytes + resources.repositoryBytes * 3 + resources.entries * 4096,
          },
        ]
      : []),
    {
      path: app.getPath('temp'),
      bytes: Math.min(resources.transferBytes, FILE_PEER_MAX_BYTES) * 2,
    },
    // Restored native transcripts land under the user's agent homes (codex-home, ~/.claude, Pi).
    ...(resources.transcriptBytes
      ? [{ path: app.getPath('home'), bytes: resources.transcriptBytes }]
      : []),
  ]);
  scope.assertCurrent();
}
async function transfer(scope: Scope, record: MigrationHandoff) {
  const live = running.get(`${scope.root}:${record.sessionId}`)!;
  // A retried transfer may follow a lost receive reply; until the target proves it has
  // no receipt for this copy, it may be importing or already committed.
  live.committing = true;
  const existing = await invoke(
    record.targetDeviceId,
    { action: 'receipt', id: record.id, sourceSessionId: record.sessionId },
    scope,
  );
  if (existing.stage === 'active') return;
  if (!existing.stage) live.committing = false;
  const directory = path.join(scope.root, 'outgoing', record.id);
  const workspace = JSON.parse(
    readAtomicFileSync(path.join(directory, 'workspace.json')) ?? 'null',
  ) as WorkspaceBundle;
  if (!workspace) throw new Error('MIGRATION_SNAPSHOT_MISSING');
  // startBackground holds this handoff's existing cross-process lock. A crash
  // skips sendParts' finally; reclaim only its temporary directories, including
  // separate Worker workspaces, before disk budgets or uploads are retried.
  for (const [index] of workspaces(workspace).entries()) {
    const artifacts = workspaceDirectory(directory, index);
    for (const entry of await fs.readdir(artifacts, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^parts-[A-Za-z0-9]{6}$/.test(entry.name)) continue;
      scope.assertCurrent();
      await fs.rm(path.join(artifacts, entry.name), { recursive: true, force: true });
    }
  }
  scope.assertCurrent();
  const resources = await preflight(scope, record, workspace, directory);
  const startedAt = Date.now();
  let completed = 0;
  live.progress = {
    phase: 'sending',
    sentBytes: 0,
    totalBytes: resources.transferBytes,
    bytesPerSecond: 0,
  };
  const send = async (file: string, artifacts = path.dirname(file)) => {
    const result = await sendFile(
      scope,
      record.targetDeviceId,
      file,
      artifacts,
      (bytes) => {
        const sentBytes = Math.min(resources.transferBytes, completed + bytes);
        live.progress = {
          phase: 'sending',
          sentBytes,
          totalBytes: resources.transferBytes,
          bytesPerSecond: (sentBytes * 1000) / Math.max(1, Date.now() - startedAt),
        };
      },
      live.abort.signal,
    );
    completed += result.size;
    return result;
  };
  const files: MigrationFiles = {
    session: await send(path.join(directory, 'session.cshare')),
    workspace: await send(path.join(directory, workspace.archive.file)),
    manifest: await send(path.join(directory, 'workspace.json')),
    ...(workspace.git
      ? {
          repository: await send(path.join(directory, 'repository.bundle')),
        }
      : {}),
  };
  if (workspace.additionalWorkspaces?.length) {
    files.additionalWorkspaces = [];
    for (const [index, entry] of workspace.additionalWorkspaces.entries()) {
      const dir = workspaceDirectory(directory, index + 1);
      files.additionalWorkspaces.push({
        workspace: await send(path.join(dir, entry.archive.file), directory),
        ...(entry.git
          ? {
              repository: await send(path.join(dir, 'repository.bundle'), directory),
            }
          : {}),
      });
    }
  }
  if (workspace.transcripts?.length) {
    files.transcripts = [];
    for (const transcript of workspace.transcripts)
      files.transcripts.push(await send(path.join(directory, transcript.file)));
  }
  live.progress = { ...live.progress!, phase: 'finishing', bytesPerSecond: 0 };
  // A cancel accepted before this point still aborts in invoke's preSend check.
  live.committing = true;
  const result = await invoke(
    record.targetDeviceId,
    {
      action: 'receive',
      id: record.id,
      sourceSessionId: record.sessionId,
      targetProject: record.targetProject,
      files,
    },
    scope,
  );
  if (result.stage !== 'active') throw new Error('MIGRATION_TARGET_NOT_READY');
}

async function cleanupOutgoing(scope: Scope, record: MigrationHandoff) {
  const directory = path.join(scope.root, 'outgoing', record.id);
  const keys = JSON.parse(
    readAtomicFileSync(path.join(directory, 'transfer-keys.json')) ?? '[]',
  ) as string[];
  for (const key of keys) {
    scope.assertCurrent();
    // Reuse the existing best-effort deletion and OSS lifecycle backstop.
    await removeRemote(key);
  }
  scope.assertCurrent();
  await fs.rm(directory, { recursive: true, force: true });
}

function launch(scope: Scope, record: MigrationHandoff & { kind: 'outgoing' }) {
  const key = `${scope.root}:${record.sessionId}`;
  if (running.has(key)) return;
  // See transfer(): a resumed transfer stays non-cancellable until its receipt is checked.
  const live: RunningCopy = {
    committing: record.stage !== 'preparing',
    abort: new AbortController(),
  };
  running.set(key, live);
  // Every existing checkpoint doubles as a cancellation point for this copy.
  const copyScope: Scope = {
    ...scope,
    assertCurrent: () => {
      scope.assertCurrent();
      if (live.cancelRequested) throw new Error('MIGRATION_CANCELLED');
    },
  };
  void withCrossProcessLock(
    path.join(scope.root, `source-${record.sessionId}.lock`),
    { label: 'task-migration', waitMs: 0 },
    async (lock) => {
      if (!lock.held) return;
      const current = scope.read(record.sessionId);
      if (!current || current.kind !== 'outgoing' || current.id !== record.id) return;
      try {
        await advanceHandoff(current, {
          assertCurrent: copyScope.assertCurrent,
          save: async (next) => scope.save({ ...next, kind: 'outgoing' }),
          prepare: (r) => prepare(copyScope, r),
          import: (r) => transfer(copyScope, r),
          cleanup: (r) => cleanupOutgoing(copyScope, r),
        });
      } catch (error) {
        if (!live.cancelRequested) throw error;
        // Same cleanup as cancelling a stopped copy, still under this copy's lock.
        scope.assertCurrent();
        const latest = scope.read(record.sessionId);
        if (latest?.kind !== 'outgoing' || latest.id !== record.id) return;
        await cleanupOutgoing(scope, latest);
        scope.assertCurrent();
        scope.save({
          ...latest,
          stage: 'cancelled',
          error: undefined,
          errorPath: undefined,
          errorSize: undefined,
        });
      }
    },
  )
    .catch((error) => {
      // The journal keeps the code and any blamed entry; the cause (git stderr, fs errno) exists only here.
      log.warn('task copy failed', {
        copyId: record.id,
        code: errorCode(error),
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        ...(error instanceof GitExecError
          ? { gitArgs: error.args.slice(0, 2).join(' '), stderr: error.stderr.slice(0, 2000) }
          : {}),
      });
      try {
        scope.assertCurrent();
        const latest = scope.read(record.sessionId);
        if (latest?.kind === 'outgoing' && latest.id === record.id)
          scope.save({
            ...latest,
            error: errorCode(error),
            // A name can be up to 4096 characters; the start is enough to find it.
            errorPath:
              error instanceof MigrationPathError ? error.relPath.slice(0, 1024) : undefined,
            errorSize:
              error instanceof MigrationSizeError
                ? { needed: error.neededBytes, limit: error.limitBytes }
                : undefined,
          });
      } catch {
        /* Preserve the old-owner journal; never write under a replacement account. */
      }
    })
    .finally(() => running.delete(key));
}

async function receiveFile(scope: Scope, file: MigrationFile, destination: string) {
  await assertDiskCapacity([{ path: path.dirname(destination), bytes: file.size * 2 }]);
  return receiveParts(file, destination, (part, target) => receivePart(scope, part, target));
}
async function receivePart(scope: Scope, file: MigrationFileRef, destination: string) {
  const ref = parseRemoteAttachmentRef(file.ref);
  if (!ref || ref.size !== file.size || ref.sha256 !== file.sha256)
    throw new Error('MIGRATION_INVALID_FILE');
  scope.assertCurrent();
  await materializeRemoteAttachment(ref, destination, { size: file.size, sha256: file.sha256 });
  scope.assertCurrent();
}
async function receive(
  scope: Scope,
  request: Extract<TaskMigrationRequest, { action: 'receive' }>,
  peer: string,
) {
  await fs.mkdir(scope.root, { recursive: true, mode: 0o700 });
  scope.assertCurrent();
  return withCrossProcessLock(
    path.join(scope.root, `${request.id}.lock`),
    { label: 'task-migration', waitMs: 0 },
    async (lock) => {
      if (!lock.held) throw new Error('MIGRATION_TARGET_BUSY');
      let record = scope.readIncoming(request.id);
      if (
        record &&
        (record.kind !== 'incoming' ||
          record.sourceDeviceId !== peer ||
          record.sourceSessionId !== request.sourceSessionId)
      )
        throw new Error('MIGRATION_ID_CONFLICT');
      // The existing receipt lock owns one staging path across attempts. Reclaim an
      // interrupted receive before either reimporting or adopting an already committed task.
      const directory = path.join(scope.root, 'incoming', request.id);
      await fs.rm(directory, { recursive: true, force: true });
      scope.assertCurrent();
      if (record?.stage === 'active') return view(scope, record);
      const existing = await scope.db.queryOne<{ workingDir: string }>(
        'SELECT working_dir AS workingDir FROM sessions WHERE id = ?',
        [request.id],
      );
      scope.assertCurrent();
      // Lost final DB acknowledgement: adopt only the row identified by our persisted incoming intent.
      if (existing) {
        if (!record || existing.workingDir !== record.workingDir)
          throw new Error('MIGRATION_ID_CONFLICT');
        for (const worker of record.workers ?? []) {
          const row = await scope.db.queryOne<{ workingDir: string }>(
            'SELECT working_dir AS workingDir FROM sessions WHERE id = ?',
            [worker.sessionId],
          );
          if (row?.workingDir !== worker.workingDir) throw new Error('MIGRATION_ID_CONFLICT');
        }
        return activate(scope, record);
      }
      const knownProjects = await projects(scope);
      if (request.targetProject && !knownProjects.includes(request.targetProject))
        throw new Error('MIGRATION_TARGET_UNKNOWN');
      if (request.targetProject && !(await fs.stat(request.targetProject)).isDirectory())
        throw new Error('MIGRATION_TARGET_UNKNOWN');
      scope.assertCurrent();
      const previous = record;
      try {
        await fs.mkdir(directory, { recursive: true, mode: 0o700 });
        assertMemoryCapacity(request.files.manifest.size);
        await receiveFile(scope, request.files.manifest, path.join(directory, 'workspace.json'));
        const workspace = JSON.parse(
          await fs.readFile(path.join(directory, 'workspace.json'), 'utf8'),
        ) as WorkspaceBundle;
        if (
          !workspace ||
          (workspace.additionalWorkspaces !== undefined &&
            !Array.isArray(workspace.additionalWorkspaces)) ||
          (workspace.workers !== undefined && !Array.isArray(workspace.workers))
        )
          throw new Error('MIGRATION_INVALID_MANIFEST');
        const snapshots = workspaces(workspace);
        if (
          snapshots.some(
            (entry) =>
              !/^[a-f0-9-]+\.tar\.gz\.enc$/.test(entry?.archive?.file ?? '') ||
              !Number.isSafeInteger(entry.unpackedBytes) ||
              entry.unpackedBytes < 0,
          ) ||
          snapshots.length !== 1 + (request.files.additionalWorkspaces?.length ?? 0)
        )
          throw new Error('MIGRATION_INVALID_MANIFEST');
        const memberIds = new Set([request.id]);
        const sourceIds = new Set([request.sourceSessionId]);
        for (const worker of workspace.workers ?? []) {
          if (
            !worker ||
            !/^[a-f0-9-]{36}$/.test(worker.sessionId) ||
            !/^[a-zA-Z0-9_-]{1,128}$/.test(worker.sourceSessionId) ||
            memberIds.has(worker.sessionId) ||
            sourceIds.has(worker.sourceSessionId) ||
            !Number.isInteger(worker.workspace) ||
            worker.workspace < 0 ||
            worker.workspace >= snapshots.length
          )
            throw new Error('MIGRATION_INVALID_MANIFEST');
          memberIds.add(worker.sessionId);
          sourceIds.add(worker.sourceSessionId);
          if (await scope.db.queryOne('SELECT id FROM sessions WHERE id = ?', [worker.sessionId]))
            throw new Error('MIGRATION_ID_CONFLICT');
        }
        if (
          snapshots.some(
            (_entry, index) =>
              index > 0 && !workspace.workers?.some((worker) => worker.workspace === index),
          )
        )
          throw new Error('MIGRATION_INVALID_MANIFEST');
        // Each delivered transcript is listed once, in order, with its transcript ref path.
        const transcripts = workspace.transcripts ?? [];
        const transcriptFiles = request.files.transcripts ?? [];
        if (
          !Array.isArray(transcripts) ||
          transcripts.length !== transcriptFiles.length ||
          new Set(transcripts.map((transcript) => transcript?.path)).size !== transcripts.length ||
          transcripts.some(
            (transcript, index) =>
              !transcript ||
              typeof transcript.path !== 'string' ||
              !transcript.path ||
              transcript.path.length > 1024 ||
              transcript.bytes !== transcriptFiles[index].size,
          )
        )
          throw new Error('MIGRATION_INVALID_MANIFEST');
        // Each failed attempt owns only its new directory. It never replaces a user's existing folder.
        // The record names a folder only after this copy created it, so a retry may reuse its own
        // still-empty folder rather than leaving `name 2` behind. (A process exit between creating
        // and recording leaves at most one empty folder.)
        const places = placements(scope, request, workspace.destination);
        const own = previous
          ? places.find((place) => place.parent === path.dirname(previous.workingDir))
          : undefined;
        const reused =
          own &&
          previous &&
          (await fs.readdir(previous.workingDir).then(
            (entries) => entries.length === 0,
            () => false,
          ))
            ? { dir: previous.workingDir, place: own }
            : null;
        const { dir: workingDir, place } = reused ?? (await createWorkingDir(places));
        scope.assertCurrent();
        const retainedWorkingDirs = previous
          ? [
              ...new Set([
                ...(previous.retainedWorkingDirs ?? []),
                previous.workingDir,
                ...(previous.workers ?? []).map((worker) => worker.workingDir),
              ]),
            ].filter((dir) => dir !== workingDir)
          : [];
        record = {
          kind: 'incoming',
          id: request.id,
          sessionId: request.id,
          sourceDeviceId: peer,
          sourceSessionId: request.sourceSessionId,
          stage: 'receiving',
          workingDir,
          ...(place.project ? { newProject: true } : {}),
          ...(retainedWorkingDirs.length ? { retainedWorkingDirs } : {}),
        };
        scope.save(record);
        await checkTargetResources(scope, request.targetProject, path.dirname(workingDir), {
          ...(transcriptFiles.length
            ? { transcriptBytes: transcriptFiles.reduce((sum, file) => sum + file.size, 0) }
            : {}),
          transferBytes: transferFiles(request.files).reduce((sum, file) => sum + file.size, 0),
          unpackedBytes: snapshots.reduce((sum, entry) => sum + entry.unpackedBytes, 0),
          contextBytes: Math.max(
            workspace.contextBytes ?? request.files.session.size,
            request.files.session.size,
          ),
          manifestBytes: request.files.manifest.size,
          repositoryBytes: [request.files, ...(request.files.additionalWorkspaces ?? [])].reduce(
            (sum, entry) => sum + (entry.repository?.size ?? 0),
            0,
          ),
          entries: snapshots.reduce(
            (sum, entry) => sum + Object.keys(entry.archive.files ?? {}).length,
            0,
          ),
        });
        const targetDirs = [workingDir];
        // Worker folders stay app-managed unless the user chose a project for the copy.
        const workerParent = request.targetProject ?? path.join(scope.root, 'projects');
        if (snapshots.length > 1) await fs.mkdir(workerParent, { recursive: true, mode: 0o700 });
        for (let index = 1; index < snapshots.length; index++) {
          const dir = path.join(workerParent, `cindy-${request.id.slice(0, 8)}-${randomUUID()}`);
          // Persist intent before allocation: even a process exit cannot orphan a directory.
          record = {
            ...record,
            retainedWorkingDirs: [...(record.retainedWorkingDirs ?? []), dir],
          };
          scope.save(record);
          await fs.mkdir(dir);
          targetDirs.push(dir);
        }
        record = {
          ...record,
          retainedWorkingDirs: record.retainedWorkingDirs?.filter(
            (dir) => !targetDirs.includes(dir),
          ),
          workers: workspace.workers?.map((worker) => ({
            sourceSessionId: worker.sourceSessionId,
            sessionId: worker.sessionId,
            workingDir: targetDirs[worker.workspace],
          })),
        };
        scope.save(record);
        for (const [index, entry] of snapshots.entries()) {
          const dir = workspaceDirectory(directory, index);
          await fs.mkdir(dir, { recursive: true });
          const files = index ? request.files.additionalWorkspaces![index - 1] : request.files;
          await receiveFile(scope, files.workspace, path.join(dir, entry.archive.file));
          if (entry.git) {
            if (!files.repository) throw new Error('MIGRATION_INVALID_MANIFEST');
            await receiveFile(scope, files.repository, path.join(dir, 'repository.bundle'));
          }
          await restoreWorkspace(entry, dir, targetDirs[index]);
        }
        await receiveFile(scope, request.files.session, path.join(directory, 'session.cshare'));
        // Names come from the index, never from the source-supplied ref paths.
        const externalTranscripts = new Map<string, string>();
        for (const [index, transcript] of transcripts.entries()) {
          const file = path.join(directory, `transcript-${index}.jsonl`);
          await receiveFile(scope, transcriptFiles[index], file);
          externalTranscripts.set(transcript.path, file);
        }
        scope.assertCurrent();
        const inspected = await inspectShareFile(path.join(directory, 'session.cshare'), {
          resourceBudgetBytes: memoryBudget(),
        });
        try {
          if (
            inspected.encrypted ||
            inspected.preview.fidelity !== 'full' ||
            inspected.preview.orcaWorkerCount !== (record.workers?.length ?? 0)
          )
            throw new Error('MIGRATION_INCOMPLETE_CONTEXT');
          const agentKind =
            inspected.preview.agentKind === 'cc' ? 'claude-code' : inspected.preview.agentKind;
          const providers = await getDesktopProviderService().listProviders({
            allowSideEffects: true,
          });
          scope.assertCurrent();
          const route = pickEnabledFallbackModel(providers, agentKind);
          if (!route) throw new Error('MIGRATION_TARGET_MODEL_UNAVAILABLE');
          const effort =
            getMakerIfReady()
              ?.getCapabilities(agentKind)
              .availableModels.find((m) => m.id === route.model)?.defaultEffort ?? 'high';
          const agentPrefs: Partial<Record<'cc' | 'codex' | 'pi', ShareImportDraftPrefs>> = {};
          for (const agent of ['cc', 'codex', 'pi'] as const) {
            const kind = agent === 'cc' ? 'claude-code' : agent;
            const selected = pickEnabledFallbackModel(providers, kind);
            if (selected)
              agentPrefs[agent] = {
                ...selected,
                effort:
                  getMakerIfReady()
                    ?.getCapabilities(kind)
                    .availableModels.find((m) => m.id === selected.model)?.defaultEffort ?? 'high',
                permissionMode: agent === 'cc' ? 'default' : 'ask',
                planMode: false,
                fastMode: false,
              };
          }
          const result = await commitShareImport(
            {
              draftId: inspected.draftId,
              workingDir,
              draftPrefs: {
                ...route,
                effort,
                permissionMode: agentKind === 'claude-code' ? 'default' : 'ask',
                planMode: false,
                fastMode: false,
              },
            },
            {
              dbClient: scope.db,
              assertStillValid: scope.assertCurrent,
              refCompensationScope: captureMediaRefCompensationScope(),
              migration: {
                sessionId: request.id,
                workingDir,
                workers: record.workers,
                agentPrefs,
                externalTranscripts,
              },
            },
          );
          if (result.fidelity !== 'full') throw new Error('MIGRATION_INCOMPLETE_CONTEXT');
        } finally {
          cancelShareDraft(inspected.draftId);
        }
      } finally {
        // These are transfer artifacts only. Keep project files on all outcomes, including an unknown DB commit.
        // Confirm the active copy only after cleanup: the source can query the receipt after a lost reply.
        await fs.rm(directory, { recursive: true, force: true });
      }
      scope.assertCurrent();
      return activate(scope, record);
    },
  );
}
/** Publishes an imported copy, including one adopted after its acknowledgement was lost. */
async function activate(scope: Scope, record: IncomingMigration) {
  // A new project joins the recent projects, like a task started in a chosen folder.
  if (record.newProject)
    await upsertRecentWorkdir(record.workingDir, Date.now(), undefined, scope.db);
  scope.assertCurrent();
  const active: IncomingMigration = { ...record, stage: 'active' };
  scope.save(active);
  for (const id of [active.sessionId, ...(active.workers ?? []).map((w) => w.sessionId)])
    emitSessionCreated(id);
  return view(scope, active);
}

export async function requestTaskMigration(raw: unknown): Promise<TaskMigrationView> {
  const request = parseTaskMigrationRequest(raw),
    scope = captureScope();
  if (request.action === 'move-project') {
    if (!moveProjectOnHost) throw new Error('MIGRATION_HOST_NOT_READY');
    const result = await moveProjectOnHost(
      request.sessionId,
      request.workingDir,
      scope.assertCurrent,
    );
    scope.assertCurrent();
    if (!result.ok) throw new Error(`MIGRATION_PROJECT_${result.errorCode}`);
    return {
      ...view(scope, null),
      projectMove: {
        sessionId: result.sessionId,
        workingDir: result.workingDir,
        workspaceKind: result.workspaceKind,
      },
    };
  }
  if (request.action === 'estimate') {
    const members = await sourceGroup(scope, request.sessionId);
    const roots = new Set(
      await Promise.all(members.map((member) => physicalWorktreeKey(member.workingDir))),
    );
    const estimate = { fileCount: 0, bytes: 0 };
    // Same budget as the remote wait, enforced here so a local or orphaned scan also stops.
    const deadline = Date.now() + TASK_MIGRATION_ESTIMATE_TIMEOUT_MS;
    const check = () => {
      scope.assertCurrent();
      if (Date.now() > deadline) throw new Error('MIGRATION_TIMEOUT');
    };
    for (const root of roots) {
      // The cap covers every copied directory together.
      const next = await estimateWorkspace(
        root,
        check,
        TASK_MIGRATION_MAX_FILES - estimate.fileCount,
      );
      estimate.fileCount += next.fileCount;
      estimate.bytes += next.bytes;
    }
    scope.assertCurrent();
    return { ...view(scope, null), estimate };
  }
  if (request.action === 'preflight') {
    await checkTargetResources(
      scope,
      request.targetProject,
      // Without a chosen project the landing folder depends on the task the manifest describes.
      request.targetProject,
      request.resources,
    ).catch(logTargetFailure('preflight', null));
    return view(scope, null);
  }
  if (request.action === 'caps') {
    const providers = await getDesktopProviderService().listProviders({ allowSideEffects: true });
    scope.assertCurrent();
    return {
      ...view(scope, null),
      projects: await projects(scope),
      teamMigration: true,
      externalTranscripts: true,
      copyEstimate: true,
      agents: (['cc', 'codex', 'pi'] as const).filter(
        (agent) => !!pickEnabledFallbackModel(providers, agent === 'cc' ? 'claude-code' : agent),
      ),
    };
  }
  if (request.action === 'receive' || request.action === 'receipt') {
    const peer = getDeviceLinkInvokeContext()?.controllerDeviceId;
    if (!peer || isSharedTaskPeer(peer)) throw new Error('MIGRATION_ACCESS_REVOKED');
    if (request.action === 'receive')
      return receive(scope, request, peer).catch(logTargetFailure('receive', request.id));
    const record = scope.readIncoming(request.id);
    if (request.action === 'receipt') {
      if (
        record &&
        (record.sourceDeviceId !== peer || record.sourceSessionId !== request.sourceSessionId)
      )
        throw new Error('MIGRATION_ID_CONFLICT');
      return view(scope, record);
    }
    throw new Error('MIGRATION_INVALID_REQUEST');
  }
  if (request.action === 'status') return view(scope, scope.read(request.sessionId));
  if (request.action === 'cancel') {
    // A running copy holds the source lock; signal it instead of waiting for the lock.
    const live = running.get(`${scope.root}:${request.sessionId}`);
    if (live) {
      if (live.committing) throw new Error('MIGRATION_CANNOT_CANCEL');
      live.cancelRequested = true;
      live.abort.abort();
      return view(scope, scope.read(request.sessionId));
    }
  }
  await fs.mkdir(scope.root, { recursive: true, mode: 0o700 });
  scope.assertCurrent();
  const initialMembers =
    request.action === 'start' ? await sourceGroup(scope, request.sessionId) : [];
  let nextCopy: (MigrationHandoff & { kind: 'outgoing' }) | undefined;
  const result = await withSessionRouteLocks(
    [request.sessionId, ...initialMembers.map((member) => member.id)],
    () =>
      withCrossProcessLock(
        path.join(scope.root, `source-${request.sessionId}.lock`),
        { label: 'task-copy', waitMs: 0 },
        async (lock) => {
          if (!lock.held) throw new Error('MIGRATION_TASK_BUSY');
          scope.assertCurrent();
          let record = scope.read(request.sessionId);
          if (request.action === 'cancel') {
            if (
              !record ||
              record.kind !== 'outgoing' ||
              !canCancelHandoff(record) ||
              running.has(`${scope.root}:${record.sessionId}`)
            )
              throw new Error('MIGRATION_CANNOT_CANCEL');
            // Closing a failed copy cancels it; keep its error code as the only trace of why.
            const cancelled = { ...record, stage: 'cancelled' as const };
            // Keep the journal retryable until its staging data is gone.
            await cleanupOutgoing(scope, record);
            scope.assertCurrent();
            scope.save(cancelled);
            return view(scope, cancelled);
          }

          if (request.action === 'start') {
            if (
              record &&
              !(record.kind === 'outgoing' && ['cancelled', 'complete'].includes(record.stage)) &&
              !(record.kind === 'incoming' && record.stage === 'active')
            )
              throw new Error('MIGRATION_ALREADY_STARTED');
            if (request.targetDeviceId === selfId() || isSharedTaskPeer(request.targetDeviceId))
              throw new Error('MIGRATION_TARGET_INVALID');
            const target = await invoke(request.targetDeviceId, { action: 'caps' }, scope);
            if (request.targetProject && !target.projects?.includes(request.targetProject))
              throw new Error('MIGRATION_TARGET_UNKNOWN');
            const members = await sourceGroup(scope, request.sessionId);
            if (
              members.length !== initialMembers.length ||
              members.some((member, index) => member.id !== initialMembers[index].id)
            )
              throw new Error('MIGRATION_TEAM_CHANGED');
            const source = members[0];
            if (source.orcaRole === 'lead' && target.teamMigration !== true)
              throw new Error('MIGRATION_UNSUPPORTED');
            if (members.some((member) => !target.agents?.includes(member.agentKind)))
              throw new Error('MIGRATION_TARGET_MODEL_UNAVAILABLE');
            const id = randomUUID();
            record = {
              kind: 'outgoing',
              id,
              sessionId: request.sessionId,
              sourceDeviceId: selfId(),
              targetDeviceId: request.targetDeviceId,
              targetSessionId: id,
              targetProject: request.targetProject ?? null,
              workingDir: source.workingDir,
              ...(source.orcaRole === 'lead'
                ? {
                    workers: members.slice(1).map((member) => ({
                      sessionId: member.id,
                      targetSessionId: randomUUID(),
                      workingDir: member.workingDir,
                    })),
                  }
                : {}),
              stage: 'preparing',
            };
            scope.save(record);
          }
          if (!record || record.kind !== 'outgoing') throw new Error('MIGRATION_NOT_FOUND');
          nextCopy = record;
          return view(scope, record);
        },
      ),
  );
  // Release admission before starting the background operation on the same lock.
  if (nextCopy) {
    launch(scope, nextCopy);
    // Start/retry acknowledgements must include the operation just registered by launch.
    return view(scope, nextCopy);
  }
  return result;
}

export function registerTaskMigrationIpc(
  moveProject: MoveProject,
  boundary: { isBusy(sessionId: string): boolean; drain(): Promise<void> },
) {
  moveProjectOnHost = moveProject;
  sourceBoundary = boundary;
  ipcMain.handle(TASK_MIGRATION_LOCAL_CHANNEL, async (event, device: unknown, raw: unknown) => {
    assertTrustedAppRendererEvent(event);
    const request = parseTaskMigrationRequest(raw);
    if (request.action === 'receive' || request.action === 'receipt')
      throwIpcError('PERMISSION_DENIED', 'MIGRATION_ACCESS_REVOKED');
    try {
      if (device == null || device === getSelfDeviceId())
        return await requestTaskMigration(request);
      if (
        typeof device !== 'string' ||
        !/^[a-zA-Z0-9_-]{1,128}$/.test(device) ||
        isSharedTaskPeer(device)
      )
        throw new Error('MIGRATION_TARGET_INVALID');
      return await invoke(device, request, captureScope());
    } catch (error) {
      throwIpcError('PRECONDITION_FAILED', errorCode(error));
    }
  });
}
