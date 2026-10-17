/**
 * 运行设备侧：承接另一台电脑上协同 Lead 派来的 Worker 任务。
 *
 * 只接受 device-link 同账号调用(来源电脑取 server 盖章的 src)。新建的是一条普通任务，
 * 带 sessions.orca_remote_lead 标记：侧栏照常显示并标注来源，不能再开启协同(见
 * register.ts assertLeadCollabProjectEnabled)、不能复制到其他电脑。派活、停止与回报复用
 * 现有会话通道，本模块不涉及。
 */
import {
  ORCA_REMOTE_WORKER_CAPS_CHANNEL,
  ORCA_REMOTE_WORKER_OPEN_CHANNEL,
  ORCA_REMOTE_WORKER_RELEASE_CHANNEL,
  ORCA_REMOTE_WORKER_VERSION,
  parseOrcaRemoteWorkerOpenRequest,
  parseOrcaRemoteWorkerReleaseRequest,
  type OrcaRemoteWorkerCaps,
  type OrcaRemoteWorkerOpenRequest,
  type OrcaRemoteWorkerOpenResult,
} from '@cindy/device-link';

import type { OrcaRemoteLead } from '../../shared/orcaRemoteWorker.js';
import type { IpcHandlerRegistry } from './ipcHandlerRegistry.js';
import type { OpenedSessionRow, openSession } from '../localDb/sessionOpening.js';

/** 先以同一 INSERT 保存任务和来源，再启动 Agent；启动失败也保留可幂等核对的身份。 */
export function createOrcaRemoteWorkerSessionOpener(deps: {
  openSession: typeof openSession;
  insertSession(row: OpenedSessionRow): Promise<void>;
  bootstrapSession(row: OpenedSessionRow, assertCurrent: () => void): Promise<unknown>;
  broadcastSessionCreated(sessionId: string): void;
}): OrcaRemoteWorkerHostDeps['openSession'] {
  return async (request, lead) => {
    const { row } = await deps.openSession({
      id: request.sessionId,
      body: {
        title: request.title,
        agentKind: request.agentKind === 'claude-code' ? 'cc' : request.agentKind,
        model: request.model,
        providerId: request.providerId,
        effort: request.effort,
        fastMode: request.fastMode,
        permissionMode: request.permissionMode,
        workspaceKind: request.workingDir ? 'project' : 'dialogue',
        workingDir: request.workingDir,
        orcaRemoteLead: lead,
      },
    }, async (opened, assertCurrent) => {
      assertCurrent();
      await deps.insertSession(opened);
      assertCurrent();
      await deps.bootstrapSession(opened, assertCurrent);
    });
    deps.broadcastSessionCreated(row.id);
    const agentKind = row.agentKind === 'cc' ? 'claude-code' : (row.agentKind as 'codex' | 'pi');
    return { workingDir: row.workingDir ?? '', model: row.model, agentKind, effort: row.effort, fastMode: row.fastMode };
  };
}

export interface OrcaRemoteWorkerCaller {
  controllerDeviceId: string;
  controllerName?: string;
  /** 共享任务访客不得使用；dispatch 已按清单拒绝，这里再兜一层。 */
  sharedTask?: unknown;
}

export interface OrcaRemoteWorkerExistingSession {
  status: 'active' | 'archived' | 'deleted';
  orcaRemoteLead: OrcaRemoteLead | null;
  workingDir: string | null;
  model: string;
  agentKind: OrcaRemoteWorkerOpenResult['agentKind'];
  effort?: string;
  fastMode?: boolean;
}

export interface OrcaRemoteWorkerHostDeps {
  getCaller(): OrcaRemoteWorkerCaller | null;
  readSession(sessionId: string): Promise<OrcaRemoteWorkerExistingSession | null>;
  /**
   * 任务与远端 Worker 标记一起落库，再启动 Agent(复用普通开任务与模型准入)并广播。
   * 未给 workingDir 时由本机按自身设置分配任务目录。
   */
  openSession(
    request: OrcaRemoteWorkerOpenRequest,
    lead: OrcaRemoteLead,
  ): Promise<{
    workingDir: string;
    model: string;
    agentKind: OrcaRemoteWorkerOpenResult['agentKind'];
    effort?: string;
    fastMode?: boolean;
  }>;
  writeRemoteLead(sessionId: string, lead: OrcaRemoteLead): Promise<void>;
  /** 同一任务 id 的 open / release 串行。 */
  withSessionLock<T>(sessionId: string, task: () => Promise<T>): Promise<T>;
  now(): number;
}

function fail(code: string, message: string): never {
  throw new Error(`[${code}] ${message}`);
}

function requireCaller(deps: OrcaRemoteWorkerHostDeps): OrcaRemoteWorkerCaller {
  const caller = deps.getCaller();
  if (!caller || !caller.controllerDeviceId) {
    fail('PRECONDITION_FAILED', 'remote worker requests must come from another device');
  }
  if (caller.sharedTask) fail('PERMISSION_DENIED', 'shared task guests cannot open remote workers');
  return caller;
}

export function createOrcaRemoteWorkerHost(deps: OrcaRemoteWorkerHostDeps) {
  return {
    caps(): OrcaRemoteWorkerCaps {
      requireCaller(deps);
      return { version: ORCA_REMOTE_WORKER_VERSION };
    },

    async open(raw: unknown): Promise<OrcaRemoteWorkerOpenResult> {
      const caller = requireCaller(deps);
      const request = parseOrcaRemoteWorkerOpenRequest(raw);
      return deps.withSessionLock(request.sessionId, async () => {
        const existing = await deps.readSession(request.sessionId);
        if (existing) {
          const lead = existing.orcaRemoteLead;
          // 幂等：同一来源电脑、同一 Lead 重复 open(例如超时后重试)只返回仍活跃的任务。
          if (
            lead &&
            lead.leadDeviceId === caller.controllerDeviceId &&
            lead.leadSessionId === request.lead.leadSessionId &&
            lead.releasedAt === undefined
          ) {
            if (existing.status !== 'active') {
              fail('PRECONDITION_FAILED', 'remote worker task is no longer active');
            }
            return {
              sessionId: request.sessionId,
              workingDir: existing.workingDir ?? '',
              model: existing.model,
              agentKind: existing.agentKind,
              effort: existing.effort,
              fastMode: existing.fastMode,
            };
          }
          fail('ALREADY_EXISTS', 'a different task already uses this id');
        }
        const lead: OrcaRemoteLead = {
          leadDeviceId: caller.controllerDeviceId,
          leadDeviceName: caller.controllerName ?? '',
          leadSessionId: request.lead.leadSessionId,
          leadTitle: request.lead.leadTitle,
          workerLabel: request.lead.workerLabel,
        };
        const opened = await deps.openSession(request, lead);
        return { sessionId: request.sessionId, ...opened };
      });
    },

    async release(raw: unknown): Promise<{ released: boolean }> {
      const caller = requireCaller(deps);
      const { sessionId } = parseOrcaRemoteWorkerReleaseRequest(raw);
      return deps.withSessionLock(sessionId, async () => {
        const existing = await deps.readSession(sessionId);
        // 任务已被本机用户删除：视为已结束，派活电脑不必再重试。
        if (!existing) return { released: true };
        const lead = existing.orcaRemoteLead;
        if (!lead || lead.leadDeviceId !== caller.controllerDeviceId) {
          fail('NOT_FOUND', 'no remote worker from this device');
        }
        if (lead.releasedAt === undefined) {
          await deps.writeRemoteLead(sessionId, { ...lead, releasedAt: deps.now() });
        }
        return { released: true };
      });
    },
  };
}

export type OrcaRemoteWorkerHost = ReturnType<typeof createOrcaRemoteWorkerHost>;

export function registerOrcaRemoteWorkerHandlers(
  registry: IpcHandlerRegistry,
  host: OrcaRemoteWorkerHost,
): void {
  registry.handle(ORCA_REMOTE_WORKER_CAPS_CHANNEL, () => host.caps());
  registry.handle(ORCA_REMOTE_WORKER_OPEN_CHANNEL, (_event, raw) => host.open(raw));
  registry.handle(ORCA_REMOTE_WORKER_RELEASE_CHANNEL, (_event, raw) => host.release(raw));
}
