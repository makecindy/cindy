import { eq } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';
import type { MakerSessionCreateOpts as CreateOpts } from './sessionRequest.js';
import { getDbClient } from '../localDb/client/current.js';
import { sessions } from '../localDb/schema.js';
import { dbToMakerAgentKind } from '../../shared/agentKindConversion.js';
import { getActiveCatalog } from '../maker-host/active-catalog.js';
import { setThinkingEnabledInMemory } from '../maker-host/newMakerDefaultsCache.js';
import { MAKER_PUSH } from './channels.js';
import { lookupVerifiedContextWindow } from './contextOverflowRollover.js';
import type { MakerSessionAgentSwitchHandlerDeps } from './sessionAgentSwitchHandler.js';

type SwitchDeps = MakerSessionAgentSwitchHandlerDeps;
// model-context-settings.ts loads the desktop's auth adapters (Electron), so the window lookup is passed in.
type ResolveConfiguredContextWindow = typeof import('../maker-host/model-context-settings.js').resolveConfiguredContextWindow;

/** The task row an engine switch reads (the desktop's agentSwitchDeps.getSessionRow). */
export const readAgentSwitchSessionRow: SwitchDeps['getSessionRow'] = async (sessionId) => {
    const db = getDbClient().drizzle;
    const [row] = await db
      .select({
        id: sessions.id,
        agentKind: sessions.agentKind,
        model: sessions.model,
        providerId: sessions.providerId,
        status: sessions.status,
        remoteHostId: sessions.remoteHostId,
        orcaRole: sessions.orcaRole,
        orcaRemoteLead: sessions.orcaRemoteLead,
        sdkSessionId: sessions.sdkSessionId,
        workingDir: sessions.workingDir,
        source: sessions.source,
        agentDeviceId: sessions.agentDeviceId,
      })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);
    return row ?? null;
};

/** The engine switch's row commit, with the target route's verified window (agentSwitchDeps.applyAgentSwitchToDb). */
export function createAgentSwitchDbApply(
  applyAgentSwitchToSessionRow: (sessionId: string, patch: Parameters<SwitchDeps['applyAgentSwitchToDb']>[1] & { contextWindow?: number | null }) => Promise<void>,
  resolveConfiguredContextWindow: ResolveConfiguredContextWindow,
): SwitchDeps['applyAgentSwitchToDb'] {
  return async (sessionId, patch) => {
      // 把 Agent 挪到另一台电脑时那台的目录才算数，不拿本机目录的窗口写进去。
      const movingToOtherDevice = typeof patch.agentDeviceId === 'string';
      const verifiedWindow = movingToOtherDevice ? undefined : lookupVerifiedContextWindow(
        (agentKind, modelId, pid) =>
          resolveConfiguredContextWindow(
            getActiveCatalog(),
            dbToMakerAgentKind(agentKind || patch.agentKind),
            pid,
            modelId,
          ),
        patch.model,
        patch.providerId ?? null,
        dbToMakerAgentKind(patch.agentKind),
      );
      await applyAgentSwitchToSessionRow(sessionId, {
        ...patch,
        ...(verifiedWindow ? { contextWindow: verifiedWindow } : {}),
      });
  };
}

/** The switch's boundary row (agentSwitchDeps.insertBoundaryMessage). */
export function createAgentSwitchBoundaryInsert(
  createDbMessage: (sessionId: string, body: { clientId: string; role: 'agent_switch'; content: Parameters<SwitchDeps['insertBoundaryMessage']>[1] }) => Promise<unknown>,
): SwitchDeps['insertBoundaryMessage'] {
  return async (sessionId, content) => {
      const clientId = `agent-switch:${createId()}`;
      await createDbMessage(sessionId, { clientId, role: 'agent_switch', content });
      return clientId;
  };
}

/** What rebuilding the switched task's live session needs (the desktop: register.ts). */
export interface SwitchedSessionBootstrapPorts {
  getActiveAppSession(): { generation: number };
  buildCreateOptsWithStderr(opts: CreateOpts): CreateOpts;
  resolveSwitchedSessionVendorOptions(sessionId: string): Record<string, unknown> | undefined;
  synthesizeOrcaVendorOptionsFromDb(sessionId: string, opts: CreateOpts): Promise<unknown>;
  readSessionExtraDirsFromDb(sessionId: string): Promise<string[]>;
  directoryGrantsForRuntime(dirs: readonly string[]): Partial<CreateOpts>;
  readSessionWritableDirsFromDb(sessionId: string): Promise<string[]>;
  ensureRemoteReadyForSessionStart(params: { createOpts?: unknown }): Promise<unknown>;
  bootstrapSession(opts: CreateOpts, assertAccess?: () => void, nativeHistoryResume?: boolean): Promise<unknown>;
  broadcastSessionCreated(sessionId: string): void;
  log: { warn(message: string, meta?: Record<string, unknown>): void };
}

/** Rebuilds the switched task's live session from its committed row (agentSwitchDeps.bootstrapSwitchedSession). */
export function createSwitchedSessionBootstrap({
  getActiveAppSession, buildCreateOptsWithStderr, resolveSwitchedSessionVendorOptions,
  synthesizeOrcaVendorOptionsFromDb, readSessionExtraDirsFromDb, directoryGrantsForRuntime,
  readSessionWritableDirsFromDb, ensureRemoteReadyForSessionStart, bootstrapSession, broadcastSessionCreated, log,
}: SwitchedSessionBootstrapPorts): SwitchDeps['bootstrapSwitchedSession'] {
  return async (sessionId, opts) => {
      const ownerGeneration = getActiveAppSession().generation;
      const assertOwner = () => {
        if (getActiveAppSession().generation !== ownerGeneration) throw new Error('REMOTE_AGENT_ACCOUNT_CHANGED');
      };
      // 切换已提交,从 DB 行(新引擎值)重建 live session。resumeSessionId 直接取
      // 行上的 sdk_session_id:切换事务在有停泊绑定时已把它落成停泊 id(Phase 2
      // 切回续接),否则为 null = 全新原生会话,上下文由交接注入承接——与
      // lazy-create(reconcileCreateOptsAgainstDb)同一条 resume 口径。
      const db = getDbClient().drizzle;
      const [row] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
      if (!row) throw new Error(`session ${sessionId} row missing after agent switch`);
      if (!row.workingDir) {
        // 无 workingDir(理论上只有从未 send 过的草稿,不可能有可切换的历史):
        // 抛错走 engineReady=false 降级,下一条消息的 lazy-create 用其现有错误呈现。
        throw new Error(`session ${sessionId} has no workingDir; cannot bootstrap switched engine`);
      }
      const co = buildCreateOptsWithStderr({
        id: sessionId,
        agentKind: dbToMakerAgentKind(row.agentKind),
        workingDir: row.workingDir,
        model: row.model ?? undefined,
        providerId: row.providerId,
        effort: (row.effort ?? undefined) as CreateOpts['effort'],
        fastMode: (row.fastMode ?? false),
        permissionMode: (row.permissionMode ?? 'ask') as CreateOpts['permissionMode'],
        planMode: false,
        // 跨引擎意图期内改的思考开关必须显式带入：否则 createSession 只能读被控端
        // 镜像/默认值，与用户刚选的不一致（device-link 远程场景）。
        ...(opts?.thinkingEnabled !== undefined
          ? { thinkingEnabled: opts.thinkingEnabled }
          : {}),
        title: row.title ?? undefined,
        resumeSessionId: row.sdkSessionId ?? undefined,
        // 远端会话切换引擎后仍是远端:带回 remoteHostId 并走 ensure (SSH
        // 重连 / agent 安装 / codex daemon MCP 注入), 否则会以远端
        // workingDir 在本机 spawn。
        remoteHostId: row.remoteHostId ?? undefined,
        vendorOptions: resolveSwitchedSessionVendorOptions(sessionId),
      });
      // 协同的 Lead / Worker(只有供应商组换电脑会走到这里)：按任务记录带回协同身份、提示词与协同工具，
      // 换过去的那台照常是团队成员，不等下一次发送再重启一次。
      if (row.orcaRole) await synthesizeOrcaVendorOptionsFromDb(sessionId, co);
      if (co.extraDirs === undefined) {
        try {
          const extraDirs = await readSessionExtraDirsFromDb(sessionId);
          if (extraDirs.length > 0) Object.assign(co, directoryGrantsForRuntime(extraDirs));
        } catch (err) {
          log.warn('agent-switch bootstrap: read extra_dirs from DB failed (non-fatal)', {
            sessionId,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }
      if (co.writableDirs === undefined) {
        const writableDirs = await readSessionWritableDirsFromDb(sessionId).catch(() => []);
        if (writableDirs.length > 0) co.writableDirs = writableDirs;
      }
      assertOwner();
      await ensureRemoteReadyForSessionStart({ createOpts: co });
      await bootstrapSession(co, assertOwner, opts?.nativeHistoryResume);
      broadcastSessionCreated(sessionId);
  };
}

/** register.ts's rememberThinkingIntent of the agent switch deps (a committed switch's thinking choice). */
export function createRememberThinkingIntent(ports: {
  broadcastToAllWindows: (channel: string, payload: unknown) => void;
}): NonNullable<SwitchDeps['rememberThinkingIntent']> {
  const { broadcastToAllWindows } = ports;
  return ({ agentKind, providerId, model, thinking }) => {
    setThinkingEnabledInMemory(agentKind, providerId, model, thinking);
    // 同步本机 renderer 的记忆：主进程写的只是镜像，renderer 才是 providerModelMemory
    // 的真相源。不写回这一笔，renderer 的全量快照会一直「尚未包含该选择」，提交时写入
    // 的钉子也就撤不掉，反而会长期压住用户在被控端后来的显式改动（Greptile P1）。
    broadcastToAllWindows(MAKER_PUSH.DRAFT_PREF_APPLY, {
      agent: agentKind,
      providerId: providerId ?? '',
      modelId: model,
      active: false,
      thinking,
    });
  };
}
