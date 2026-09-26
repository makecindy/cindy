import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { app, ipcMain } from 'electron';
import {
  TASK_MIGRATION_CHANNEL,
  TASK_MIGRATION_LOCAL_CHANNEL,
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
import { createSharedTaskJournal } from '../localDb/sharedTasks';
import { withSessionRouteLocks } from '../localDb/sessionRouteLock';
import { withTaskMigrationBoundary } from './writeBoundary';
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
import { bindingStore } from '../im/binding';
import { physicalWorktreeKey, withWorktreeResourceLocks } from '../worktree/resourceLock';
import { getMakerIfReady } from '../maker-host';
import { getDesktopProviderService } from '../maker-host/createDesktopProviderService';
import { pickEnabledFallbackModel } from '../maker-host/model-route-guard';
import { advanceHandoff, canCancelHandoff, type MigrationHandoff } from './handoff';
import {
  assertTaskMigrationWritable,
  migrationScope,
  type MigrationRecord,
  type IncomingMigration,
} from './journal';
import { snapshotWorkspace, restoreWorkspace, type PortableWorkspace } from './workspace';

import { memoryBudget, assertMemoryCapacity, assertDiskCapacity } from './resources';
import { sendParts, receiveParts } from './transferParts';

type MoveProject = (sessionId: string, workingDir: string | null, assertAuthority: () => void) => ReturnType<typeof moveSessionProjectFromHost>;
// Bootstrap supplies the existing business handler; importing maker IPC here creates a cycle.
let moveProjectOnHost: MoveProject | undefined;
let sourceBoundary: { isBusy(sessionId: string): boolean; drain(): Promise<void> } | undefined;
const running = new Set<string>();
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
    if (await fs.stat(row.path).then((stat) => stat.isDirectory(), () => false))
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
  const response = await remoteInvoke(device, TASK_MIGRATION_CHANNEL, [request], {
    preSend: scope.assertCurrent,
  });
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
  return {
    supported: true,
    deviceId: selfId(),
    ...(record
      ? {
          stage: record.stage,
          running: running.has(`${scope.root}:${record.sessionId}`),
          ...(record.kind === 'outgoing'
            ? {
                targetDeviceId: record.targetDeviceId,
                targetSessionId: record.targetSessionId,
                ...(record.error ? { error: record.error } : {}),
              }
            : {}),
        }
      : {}),
  };
}

interface SourceSession {
  id: string;
  workingDir: string;
  remoteHostId: string | null;
  status: string;
  source: string;
  orcaRole: string | null;
  agentKind: 'cc' | 'codex' | 'pi';
}
async function assertSource(
  scope: Scope,
  sessionId: string,
  worker = false,
): Promise<SourceSession> {
  const row = await scope.db.queryOne<SourceSession>(
    'SELECT id, working_dir AS workingDir, remote_host_id AS remoteHostId, status, source, orca_role AS orcaRole, agent_kind AS agentKind FROM sessions WHERE id = ?',
    [sessionId],
  );
  scope.assertCurrent();
  if (
    !row ||
    !(row.status === 'active' || (worker && row.status === 'archived')) ||
    !row.workingDir ||
    row.remoteHostId ||
    (worker ? row.orcaRole !== 'worker' : row.orcaRole === 'worker') ||
    !['desktop', 'shared'].includes(row.source)
  )
    throw new Error('MIGRATION_TASK_UNSUPPORTED');
  if (bindingStore.findByTarget(sessionId)) throw new Error('MIGRATION_TASK_BOUND');
  const bound = await scope.db.queryOne<{ n: number }>(
    `SELECT
    (SELECT count(*) FROM schedules WHERE target_session_id = ?) +
    (SELECT count(*) FROM bot_session_links WHERE session_id = ?) +
    (SELECT count(*) FROM session_goals WHERE session_id = ? AND status != 'complete') AS n`,
    [sessionId, sessionId, sessionId],
  );
  scope.assertCurrent();
  if (bound?.n) throw new Error('MIGRATION_TASK_BOUND');
  const sharing = await createSharedTaskJournal(scope.db).latest();
  scope.assertCurrent();
  if (sharing.some(entry => entry.sessionId === sessionId && !entry.terminal))
    throw new Error('MIGRATION_TASK_BOUND');
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
];

async function prepare(scope: Scope, record: MigrationHandoff) {
  const members = await sourceGroup(scope, record.sessionId);
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
              (sourceKey) =>
                key === sourceKey ||
                key.startsWith(sourceKey + path.sep) ||
                sourceKey.startsWith(key + path.sep),
            )
          )
            throw new Error('MIGRATION_SHARED_DIRECTORY_BUSY');
        }
      }
      scope.assertCurrent();
      const maker = getMakerIfReady();
      for (const member of members)
        if (maker?.getSession(member.id)) await maker.closeSession(member.id);
      await sourceBoundary!.drain();
      scope.assertCurrent();
      if (members.some((member) => sourceBoundary!.isBusy(member.id)))
        throw new Error('MIGRATION_TASK_RUNNING');
      const result = await exportSessionShare({
        sessionId: record.sessionId,
        targetPath: path.join(directory, 'session.cshare'),
        sizeLimitBytes: memoryBudget(),
        migration: true,
      });
      scope.assertCurrent();
      if (result.status === 'oversize') throw new Error('MIGRATION_NO_MEMORY');
      if (result.status !== 'ok' || result.fidelity !== 'full' || result.mediaMissing)
        throw new Error('MIGRATION_INCOMPLETE_CONTEXT');
      const snapshots: PortableWorkspace[] = [];
      for (const [index, dir] of sourceKeys.entries())
        snapshots.push(
          await snapshotWorkspace(dir, workspaceDirectory(directory, index), record.id),
        );
      const workspace: WorkspaceBundle = {
        ...snapshots[0],
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
): Promise<MigrationFile> {
  const space = await fs.statfs(path.dirname(file));
  const partBytes = Math.floor(
    Math.min(FILE_PEER_MAX_BYTES, MAX_MEDIA_BYTES, (space.bavail * space.bsize) / 4),
  );
  return sendParts(file, partBytes, (part) => sendPart(scope, device, part, artifacts));
}
async function sendPart(
  scope: Scope,
  device: string,
  file: string,
  artifacts: string,
): Promise<MigrationFileRef> {
  scope.assertCurrent();
  const peer = await tryUploadPeerAttachment(
    device,
    file,
    'application/octet-stream',
    (deviceId, channel, args) =>
      remoteInvoke(deviceId, channel, args, { preSend: scope.assertCurrent }),
  );
  scope.assertCurrent();
  if (peer) {
    const result = parsePeerAttachmentRef(peer);
    if (!result) throw new Error('MIGRATION_TRANSFER_FAILED');
    return { ref: peer, size: result.size, sha256: result.sha256 };
  }
  const result = await uploadLocalFile(file, { maxBytes: (await fs.stat(file)).size });
  scope.assertCurrent();
  const keysFile = path.join(artifacts, 'transfer-keys.json');
  const keys = JSON.parse(readAtomicFileSync(keysFile) ?? '[]') as string[];
  atomicWriteFileSync(keysFile, JSON.stringify([...keys, result.key]));
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
  const sizes = await Promise.all(
    [
      'session.cshare',
      'workspace.json',
      ...workspaces(workspace).flatMap((entry, index) => [
        path.join(index ? String(index) : '', entry.archive.file),
        ...(entry.git ? [path.join(index ? String(index) : '', 'repository.bundle')] : []),
      ]),
    ].map(async (name) => (await fs.stat(path.join(directory, name))).size),
  );
  const resources: MigrationResources = {
    transferBytes: sizes.reduce((a, b) => a + b, 0),
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
}
async function checkTargetResources(
  scope: Scope,
  targetProject: string | null,
  resources: MigrationResources,
) {
  if (targetProject && !(await projects(scope)).includes(targetProject))
    throw new Error('MIGRATION_TARGET_UNKNOWN');
  assertMemoryCapacity(resources.contextBytes + resources.manifestBytes);
  await fs.mkdir(scope.root, { recursive: true });
  await assertDiskCapacity([
    { path: scope.root, bytes: resources.transferBytes * 2 + resources.contextBytes * 2 },
    {
      path: targetProject ?? scope.root,
      bytes: resources.unpackedBytes + resources.repositoryBytes * 3 + resources.entries * 4096,
    },
    {
      path: app.getPath('temp'),
      bytes: Math.min(resources.transferBytes, FILE_PEER_MAX_BYTES) * 2,
    },
  ]);
  scope.assertCurrent();
}
async function transfer(scope: Scope, record: MigrationHandoff) {
  const existing = await invoke(
    record.targetDeviceId,
    { action: 'receipt', id: record.id, sourceSessionId: record.sessionId },
    scope,
  );
  if (existing.stage === 'ready' || existing.stage === 'active') return;
  const directory = path.join(scope.root, 'outgoing', record.id);
  const workspace = JSON.parse(
    readAtomicFileSync(path.join(directory, 'workspace.json')) ?? 'null',
  ) as WorkspaceBundle;
  if (!workspace) throw new Error('MIGRATION_SNAPSHOT_MISSING');
  await preflight(scope, record, workspace, directory);
  const files: MigrationFiles = {
    session: await sendFile(scope, record.targetDeviceId, path.join(directory, 'session.cshare')),
    workspace: await sendFile(
      scope,
      record.targetDeviceId,
      path.join(directory, workspace.archive.file),
    ),
    manifest: await sendFile(scope, record.targetDeviceId, path.join(directory, 'workspace.json')),
    ...(workspace.git
      ? {
          repository: await sendFile(
            scope,
            record.targetDeviceId,
            path.join(directory, 'repository.bundle'),
          ),
        }
      : {}),
  };
  if (workspace.additionalWorkspaces?.length) {
    files.additionalWorkspaces = [];
    for (const [index, entry] of workspace.additionalWorkspaces.entries()) {
      const dir = workspaceDirectory(directory, index + 1);
      files.additionalWorkspaces.push({
        workspace: await sendFile(
          scope,
          record.targetDeviceId,
          path.join(dir, entry.archive.file),
          directory,
        ),
        ...(entry.git
          ? {
              repository: await sendFile(
                scope,
                record.targetDeviceId,
                path.join(dir, 'repository.bundle'),
                directory,
              ),
            }
          : {}),
      });
    }
  }
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
  if (result.stage !== 'ready' && result.stage !== 'active')
    throw new Error('MIGRATION_TARGET_NOT_READY');
}

function launch(scope: Scope, record: MigrationHandoff & { kind: 'outgoing' }) {
  const key = `${scope.root}:${record.sessionId}`;
  if (running.has(key)) return;
  running.add(key);
  void withCrossProcessLock(
    path.join(scope.root, `${record.id}.lock`),
    { label: 'task-migration', waitMs: 0 },
    async (lock) => {
      if (!lock.held) return;
      const current = scope.read(record.sessionId);
      if (!current || current.kind !== 'outgoing' || current.id !== record.id) return;
      await advanceHandoff(current, {
        assertCurrent: scope.assertCurrent,
        save: async (next) => scope.save({ ...next, kind: 'outgoing' }),
        prepare: (r) => prepare(scope, r),
        import: (r) => transfer(scope, r),
        activate: async (r) => {
          const result = await invoke(
            r.targetDeviceId,
            { action: 'activate', id: r.id, sourceSessionId: r.sessionId },
            scope,
          );
          if (result.stage !== 'active') throw new Error('MIGRATION_TARGET_NOT_READY');
          // Keep the replayable moved stage until local transfer cleanup succeeds.
          // A restart retries activation idempotently before repeating this cleanup.
          const directory = path.join(scope.root, 'outgoing', r.id);
          const keys = JSON.parse(
            readAtomicFileSync(path.join(directory, 'transfer-keys.json')) ?? '[]',
          ) as string[];
          for (const key of keys) {
            scope.assertCurrent();
            // Existing OSS lifecycle rules backstop best-effort remote deletion.
            await removeRemote(key);
          }
          scope.assertCurrent();
          await fs.rm(directory, { recursive: true, force: true });
        },
      });
    },
  )
    .catch((error) => {
      try {
        scope.assertCurrent();
        const latest = scope.read(record.sessionId);
        if (latest?.kind === 'outgoing' && latest.id === record.id)
          scope.save({ ...latest, error: errorCode(error) });
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
      if (record?.stage === 'ready' || record?.stage === 'active') return view(scope, record);
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
        record = { ...record, stage: 'ready' } as IncomingMigration;
        scope.save(record);
        return view(scope, record);
      }
      const knownProjects = await projects(scope);
      if (request.targetProject && !knownProjects.includes(request.targetProject))
        throw new Error('MIGRATION_TARGET_UNKNOWN');
      const parent = request.targetProject ?? path.join(scope.root, 'projects');
      if (request.targetProject) {
        if (!(await fs.stat(parent)).isDirectory()) throw new Error('MIGRATION_TARGET_UNKNOWN');
      } else await fs.mkdir(parent, { recursive: true, mode: 0o700 });
      scope.assertCurrent();
      // Each failed attempt owns only its new directory. It never replaces a user's existing folder.
      const workingDir = await fs.mkdtemp(path.join(parent, `cindy-${request.id.slice(0, 8)}-`));
      const retainedWorkingDirs = record
        ? [
            ...new Set([
              ...(record.retainedWorkingDirs ?? []),
              record.workingDir,
              ...(record.workers ?? []).map((worker) => worker.workingDir),
            ]),
          ]
        : [];
      record = {
        kind: 'incoming',
        id: request.id,
        sessionId: request.id,
        sourceDeviceId: peer,
        sourceSessionId: request.sourceSessionId,
        stage: 'receiving',
        workingDir,
        ...(retainedWorkingDirs.length ? { retainedWorkingDirs } : {}),
      };
      scope.save(record);
      const directory = await fs.mkdtemp(path.join(scope.root, 'incoming-'));
      try {
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
        await checkTargetResources(scope, request.targetProject, {
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
        for (let index = 1; index < snapshots.length; index++)
          targetDirs.push(await fs.mkdtemp(path.join(parent, `cindy-${request.id.slice(0, 8)}-`)));
        record = {
          ...record,
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
              migration: { sessionId: request.id, workingDir, workers: record.workers, agentPrefs },
            },
          );
          if (result.fidelity !== 'full') throw new Error('MIGRATION_INCOMPLETE_CONTEXT');
        } finally {
          cancelShareDraft(inspected.draftId);
        }
        scope.assertCurrent();
        record = { ...record, stage: 'ready' } as IncomingMigration;
        scope.save(record);
        return view(scope, record);
      } finally {
        // These are transfer artifacts only. Keep project files on all outcomes, including an unknown DB commit.
        await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
      }
    },
  );
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
  if (request.action === 'preflight') {
    await checkTargetResources(scope, request.targetProject, request.resources);
    return view(scope, null);
  }
  if (request.action === 'caps') {
    const providers = await getDesktopProviderService().listProviders({ allowSideEffects: true });
    scope.assertCurrent();
    return {
      ...view(scope, null),
      projects: await projects(scope),
      teamMigration: true,
      agents: (['cc', 'codex', 'pi'] as const).filter(
        (agent) => !!pickEnabledFallbackModel(providers, agent === 'cc' ? 'claude-code' : agent),
      ),
    };
  }
  if (
    request.action === 'receive' ||
    request.action === 'activate' ||
    request.action === 'receipt'
  ) {
    const peer = getDeviceLinkInvokeContext()?.controllerDeviceId;
    if (!peer || isSharedTaskPeer(peer)) throw new Error('MIGRATION_ACCESS_REVOKED');
    if (request.action === 'receive') return receive(scope, request, peer);
    const record = scope.readIncoming(request.id);
    if (request.action === 'receipt') {
      if (
        record &&
        (record.sourceDeviceId !== peer || record.sourceSessionId !== request.sourceSessionId)
      )
        throw new Error('MIGRATION_ID_CONFLICT');
      return view(scope, record);
    }
    if (
      !record ||
      record.kind !== 'incoming' ||
      record.sourceDeviceId !== peer ||
      record.sourceSessionId !== request.sourceSessionId ||
      !['ready', 'active'].includes(record.stage)
    )
      throw new Error('MIGRATION_TARGET_NOT_READY');
    scope.save({ ...record, stage: 'active' });
    return view(scope, { ...record, stage: 'active' });
  }
  if (request.action === 'status') return view(scope, scope.read(request.sessionId));
  await fs.mkdir(scope.root, { recursive: true, mode: 0o700 });
  scope.assertCurrent();
  const initialMembers =
    request.action === 'start' ? await sourceGroup(scope, request.sessionId) : [];
  return withSessionRouteLocks(
    [request.sessionId, ...initialMembers.map((member) => member.id)],
    () =>
      withTaskMigrationBoundary(
        [request.sessionId, ...initialMembers.map((member) => member.id)],
        async () => {
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
            return withCrossProcessLock(
              path.join(scope.root, `${record.id}.lock`),
              { label: 'task-migration', waitMs: 0 },
              async (lock) => {
                const latest = scope.read(request.sessionId);
                if (!lock.held || latest?.kind !== 'outgoing' || !canCancelHandoff(latest))
                  throw new Error('MIGRATION_CANNOT_CANCEL');
                const cancelled = { ...latest, stage: 'cancelled' as const, error: undefined };
                scope.save(cancelled);
                await fs
                  .rm(path.join(scope.root, 'outgoing', latest.id), {
                    recursive: true,
                    force: true,
                  })
                  .catch(() => {});
                return view(scope, cancelled);
              },
            );
          }
          if (request.action === 'start') {
            if (
              record &&
              !(record.kind === 'outgoing' && record.stage === 'cancelled') &&
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
            for (const member of members) assertTaskMigrationWritable(member.id);
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
          launch(scope, record);
          return view(scope, record);
        },
      ),
  );
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
    if (
      request.action === 'receive' ||
      request.action === 'activate' ||
      request.action === 'receipt'
    )
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
