/** Ordinary task creation, shared by local IPC and authenticated Host clients.
 * Entry adapters validate caller identity; this service owns identical task data,
 * draft lifecycle, directory grants and model admission on every launcher. */
import { isAbsolute } from 'node:path';
import { eq } from 'drizzle-orm';
import { getCurrentDbClientSnapshot } from '../client/current.js';
import { sessions } from '../schema.js';
import { projectForNewTask } from '../../mcp-integrations/projectManagementCore.js';
import { openSession } from '../sessionOpening.js';
import { sessionCreateToRow, sessionToCamel, normalizeRemoteHostId } from '../mapper.js';
import { ensureDialogueWorkspaceDir } from '../dialogueWorkspace.js';
import { resolveBusinessSessionId } from '../../sessionIds.js';
import { normalizeWorkingDirForStorage } from '../../../shared/workingDir.js';
import { isRetainableProjectSession } from '../../../shared/sessionSource.js';
import { requireObject, requireString, throwIpcError } from '../../utils/ipcValidate.js';
import { isDeviceLinkInvoke } from '../../device-link/invoke-context.js';
import { isSharedTaskPeer, parseProviderSharePeer } from '@cindy/device-link';
import { pluginEngineKeyFromProviderId } from '../../../shared/pluginEngines.js';
import { assertRendererSessionSourceAllowed } from './sessionSourceGuard.js';
import { consumeWritableDirectoryPickerGrants, WritableDirectoryPickerGrantError } from '../../maker-ipc/writableDirectoryPickerGrant.js';
import { forgetProvisionalSession, isProvisionalSession, markProvisionalSession } from '../provisionalSessions.js';
import { touchRecentWorkdir } from './recentWorkdirsCore.js';
import { managedWorktreeRoot } from '../../worktree/managedResourcePath.js';
import { withWorktreeResourceLocks } from '../../worktree/resourceLock.js';
import { createLogger } from '../../logger.js';
import { withSessionRouteLock } from '../sessionRouteLock.js';
import type { CreateWorktreeReq, CreateWorktreeResp } from '../../worktree/types.js';

const log = createLogger('local-db-sessions');
export interface UserSessionCreatePorts {
  /** Optional launcher lifecycle guard, also checked immediately before persistence. */
  assertCurrent?: () => void;
  senderId: number;
  userDataDir: string;
  notifyPluginSessionCreated(input: { sessionId: string; workdir?: string }): void;
  localPluginWorktrees?: {
    create(request: CreateWorktreeReq, assertCurrent: () => void): Promise<CreateWorktreeResp>;
    discard(sessionId: string, path: string, canRemove: () => Promise<boolean>): Promise<unknown>;
  };
}

export async function withWorktreeMutation<T>(resources: string[], task: () => Promise<T>): Promise<T> {
  try {
    return await withWorktreeResourceLocks(resources, task);
  } catch (error) {
    const code = (error as { code?: string })?.code;
    if (code && error instanceof Error && error.message.startsWith(`[${code}]`)) throw error;
    log.warn('worktree mutation postponed', { code: code ?? 'unavailable' });
    throwIpcError(
      'PRECONDITION_FAILED',
      'Worktree is busy or its recovery record could not be saved',
    );
  }
}

export async function createUserSession(body: unknown, ports: UserSessionCreatePorts) {
    const owner = getCurrentDbClientSnapshot();
    const assertOwner = () => {
      ports.assertCurrent?.();
      if (!owner || getCurrentDbClientSnapshot() !== owner) throwIpcError('PRECONDITION_FAILED', 'Account changed; create the task again');
    };
    assertOwner();
    const db = owner!.client.drizzle;
    const now = Date.now();
    const bodyObj = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    const id = resolveBusinessSessionId(bodyObj.id);
    // 未发送任务（新建页开始输入时先建出来，见 provisionalSessions.ts）：只给本机普通任务，
    // 延后的创建副作用在第一次发送转正时补做。
    const { provisional: provisionalFlag, localPluginWorktree, ...sessionBody } = bodyObj;
    const provisional = provisionalFlag === true;
    if (provisional && (
      bodyObj.remoteHostId || bodyObj.agentDeviceId || bodyObj.orcaRole || bodyObj.source !== undefined
      || (Array.isArray(bodyObj.writableDirs) && bodyObj.writableDirs.length > 0)
    )) {
      throwIpcError('INVALID_PARAMS', 'only ordinary local tasks can be opened before the first send');
    }
    const createBody = sessionBody as Parameters<typeof sessionCreateToRow>[1];
    // M16: agentKind 白名单校验（防止 renderer 传非法值）
    const ALLOWED_AGENT_KINDS = new Set<string>(['cc', 'codex', 'pi', 'acp']);
    if (bodyObj.agentKind !== undefined && !ALLOWED_AGENT_KINDS.has(bodyObj.agentKind as string)) {
      throwIpcError('INVALID_PARAMS', `invalid agentKind: ${String(bodyObj.agentKind)}`);
    }
    if (bodyObj.agentKind === 'acp') {
      // Plugin engine tasks (docs/plans/acp-plugin-bridge.md): chosen at the computer the task is
      // on, through the plugin harness id. The engine is this computer's, or one that another
      // computer of the same account opened for remote use; never an SSH host or a shared provider.
      if (isDeviceLinkInvoke()) throwIpcError('INVALID_PARAMS', 'plugin engine tasks can only be created on this computer');
      if (!pluginEngineKeyFromProviderId(typeof bodyObj.providerId === 'string' ? bodyObj.providerId : null)) {
        throwIpcError('INVALID_PARAMS', 'a plugin engine task needs providerId acp-plugin:<plugin>:<harness>');
      }
      if (bodyObj.remoteHostId) {
        throwIpcError('INVALID_PARAMS', 'plugin engine tasks do not run in SSH workspaces');
      }
      if (bodyObj.agentDeviceId !== undefined && bodyObj.agentDeviceId !== null
        && (typeof bodyObj.agentDeviceId !== 'string'
          || isSharedTaskPeer(bodyObj.agentDeviceId)
          || Boolean(parseProviderSharePeer(bodyObj.agentDeviceId)))) {
        throwIpcError('INVALID_PARAMS', 'invalid agentDeviceId for plugin engine task');
      }
    }
    if (
      bodyObj.title !== undefined &&
      (typeof bodyObj.title !== 'string' || bodyObj.title.length > 200)
    ) {
      throwIpcError('INVALID_PARAMS', 'title must be a string no longer than 200 characters');
    }
    const ALLOWED_WORKSPACE_KINDS = new Set<string>(['project', 'dialogue']);
    if (
      bodyObj.workspaceKind !== undefined &&
      !ALLOWED_WORKSPACE_KINDS.has(bodyObj.workspaceKind as string)
    ) {
      throwIpcError('INVALID_PARAMS', `invalid workspaceKind: ${String(bodyObj.workspaceKind)}`);
    }
    const ALLOWED_ORCA_ROLES = new Set<string>(['lead', 'worker']);
    if (
      bodyObj.orcaRole !== undefined &&
      bodyObj.orcaRole !== null &&
      !ALLOWED_ORCA_ROLES.has(bodyObj.orcaRole as string)
    ) {
      throwIpcError('INVALID_PARAMS', `invalid orcaRole: ${String(bodyObj.orcaRole)}`);
    }
    // Agent 在同账号另一台电脑运行：只接受设备 id 形态的值(与 maker:create-session 同一规则)。
    if (
      bodyObj.agentDeviceId !== undefined &&
      bodyObj.agentDeviceId !== null &&
      (typeof bodyObj.agentDeviceId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(bodyObj.agentDeviceId))
    ) {
      throwIpcError('INVALID_PARAMS', 'agentDeviceId must be a device id');
    }
    const requestedKind =
      (createBody?.workspaceKind as 'project' | 'dialogue' | undefined) ?? 'project';
    const explicitWorkingDir =
      normalizeWorkingDirForStorage(
        typeof createBody?.workingDir === 'string' ? createBody.workingDir : null,
      ) ?? undefined;
    const worktrees = ports.localPluginWorktrees;
    let worktreeRequest: CreateWorktreeReq | undefined;
    if (localPluginWorktree !== undefined) {
      if (!worktrees || bodyObj.agentKind !== 'acp' || requestedKind !== 'project' ||
        provisional || bodyObj.source !== undefined || bodyObj.orcaRole ||
        !explicitWorkingDir || !isAbsolute(explicitWorkingDir) || explicitWorkingDir.includes('\0') ||
        explicitWorkingDir.length > 4096) {
        throwIpcError('INVALID_PARAMS', 'Worktree creation requires an ordinary local plugin engine project task');
      }
      const request = requireObject(localPluginWorktree, 'localPluginWorktree');
      const name = requireString(request.name, 'worktree.name');
      const sourceBranch = requireString(request.sourceBranch, 'worktree.sourceBranch');
      if (name.length > 20 || sourceBranch.length > 1024 || sourceBranch.startsWith('-') || sourceBranch.includes('\0')) {
        throwIpcError('INVALID_PARAMS', 'Invalid worktree name or source branch');
      }
      worktreeRequest = { sessionId: id, baseRepo: explicitWorkingDir, name, sourceBranch };
    }
    assertRendererSessionSourceAllowed({
      source: bodyObj.source,
      workingDir: explicitWorkingDir,
      remoteHostId: createBody?.remoteHostId,
      userData: ports.userDataDir,
    });
    const membership = requestedKind === 'project' && !createBody?.remoteHostId
      ? await projectForNewTask(explicitWorkingDir, createBody?.projectDir)
      : requestedKind === 'dialogue' ? { projectDir: null, workspaceKind: 'dialogue' as const } : undefined;
    assertOwner();
    const workspaceKind = membership?.workspaceKind ?? requestedKind;
    const workingDir =
      workspaceKind === 'dialogue' && !explicitWorkingDir
        ? ensureDialogueWorkspaceDir(id, now)
        : explicitWorkingDir ?? membership?.projectDir ?? undefined;
    if (workspaceKind === 'dialogue' && !explicitWorkingDir) {
      log.info('[localDb] allocated dialogue workspace', { sessionId: id, workingDir });
    }
    const requestedWritableDirs = createBody?.writableDirs ?? [];
    if (
      !Array.isArray(requestedWritableDirs) ||
      !requestedWritableDirs.every((dir) => typeof dir === 'string')
    ) {
      throwIpcError('INVALID_PARAMS', 'writableDirs must be string[]');
    }
    const requestedRemoteHostId = normalizeRemoteHostId(createBody?.remoteHostId);
    if (requestedRemoteHostId && requestedWritableDirs.length > 0) {
      throwIpcError(
        'PRECONDITION_FAILED',
        'remote writable directories can only be revoked from an existing task',
      );
    }
    if (!requestedRemoteHostId && requestedWritableDirs.length > 0) {
      try {
        await consumeWritableDirectoryPickerGrants({
          scopeId: id,
          senderId: ports.senderId,
          requestedDirs: requestedWritableDirs,
          previousDirs: [],
        });
      } catch (error) {
        throwIpcError(
          error instanceof WritableDirectoryPickerGrantError ? error.code : 'PRECONDITION_FAILED',
          error instanceof Error ? error.message : 'Writable directory authorization failed',
        );
      }
    }
    // 未发送任务在写入之前就登记：行一出现，任务列表 / 控制端 / IM / hook 的过滤就已生效。
    assertOwner();
    const markedProvisional = provisional && !isProvisionalSession(id);
    if (markedProvisional) {
      // Only a dialogue folder allocated here is ours to tidy up if the task is discarded.
      const managedDir = workspaceKind === 'dialogue' && !explicitWorkingDir ? workingDir : undefined;
      markProvisionalSession(id, now, managedDir);
    }
    let insertRow: Awaited<ReturnType<typeof openSession>>['row'];
    let row: typeof sessions.$inferSelect | undefined;
    try {
      ({ row: insertRow } = await openSession({ id, now, assertCurrent: assertOwner,
        body: { ...createBody, ...membership, workspaceKind, workingDir },
        ...(provisional || worktreeRequest ? { deferGitInit: true } : {}),
      }, async (prepared, assertCurrent) => {
        if (worktreeRequest && worktrees) {
          // Do not publish a base-repo task while checkout is still in flight.
          // Model admission is already complete, before the first Git write.
          const request = worktreeRequest;
          await withSessionRouteLock(id, async () => {
            const isUnclaimed = async () => {
              assertCurrent();
              const [existing] = await db.select({ id: sessions.id }).from(sessions)
                .where(eq(sessions.id, id)).limit(1);
              assertCurrent();
              return !existing;
            };
            if (!(await isUnclaimed())) throwIpcError('PRECONDITION_FAILED', 'The task already exists');
            const result = await worktrees.create(request, assertCurrent);
            if (!result.ok) throwIpcError('PRECONDITION_FAILED', 'Could not create the task worktree');
            const worktreePath = normalizeWorkingDirForStorage(result.meta.path)!;
            try {
              await withWorktreeMutation([worktreePath], async () => {
                assertCurrent();
                await db.insert(sessions).values({ ...prepared, workingDir: worktreePath, worktreePath });
              });
            } catch (error) {
              // A committed row or an unavailable owner/DB is never safe to discard.
              await worktrees.discard(id, result.meta.path, isUnclaimed).catch(() => {
                log.warn('Could not discard an unclaimed plugin task worktree', { sessionId: id });
              });
              throw error;
            }
          });
          return;
        }
        const resource = !prepared.remoteHostId && prepared.workingDir
          ? managedWorktreeRoot(prepared.workingDir) : null;
        const insert = async () => { assertCurrent(); await db.insert(sessions).values(prepared); };
        if (resource) await withWorktreeMutation([resource], insert);
        else await insert();
      }));
      [row] = await db.select().from(sessions).where(eq(sessions.id, id));
      assertOwner();
    } catch (error) {
      if (markedProvisional) forgetProvisionalSession(id);
      throw error;
    }
    if (!row) throwIpcError('NOT_FOUND', 'Session 创建后查询失败');
    if (provisional) {
      log.info('provisional session opened', { sessionId: id, workspaceKind: insertRow.workspaceKind });
      return sessionToCamel({ ...row, messageCount: 0 });
    }
    // recent-workdirs: 项目目录走 sidebar 分组,要进"最近"列表;dialogue 目录是
    // app-managed 临时 cwd,跟用户选过的项目目录语义不同,不污染最近列表。
    // 失败仅日志,不阻断创建流程。
    //
    // remote 项目排除:recent_workdirs 表只有 path 主键、无 host 维度,若把 remote
    // 路径写进去,后续 New Maker 项目下拉选中它时会丢失 host、按本机路径创建出一个
    // 错误的本地会话(指向本机不存在的同名目录)。在 host-aware 最近项目(给该表加
    // remote_host_id 列 + picker 区分 local/remote)落地前,remote 项目一律不进最近列表。
    if (
      insertRow.workspaceKind === 'project' &&
      insertRow.workingDir &&
      !insertRow.remoteHostId &&
      isRetainableProjectSession(insertRow)
    ) {
      void touchRecentWorkdir(insertRow.projectDir ?? insertRow.workingDir, now);
    }
    // 订阅槽①旁路通知(fire-and-forget,动态 import 防环):意识旁听会话创建。
    // 资格过滤(用户主会话)与订阅者快路径都在 cindy-brain 内部,这里零判断。
    ports.notifyPluginSessionCreated({ sessionId: id, ...(row.workingDir ? { workdir: row.workingDir } : {}) });
    // 新建 session 必然无 message，直接拼 0，免一次 join。
    return sessionToCamel({ ...row, messageCount: 0 });
}
