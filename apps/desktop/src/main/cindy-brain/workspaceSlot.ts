/**
 * workspaceSlot.ts — 工作区会话槽(workspace,2026-07-25)。
 * ---------------------------------------------------------------------------
 * 插件经管子上行 `{type:'workspace-request', kind:'ensure-session', mode, …}`,
 * 请主机在指定本机项目目录下**确保**存在一个会话入口(侧边栏可见):
 * 目录下已有 active 会话即复用(created:false),没有才创建 plugin 来源的空
 * draft 会话(不拉起 agent 进程)。安全模型:
 *
 * - 资格审:已装、启用、声明 workspace 槽;
 * - 目录授权两条路,决定权都在用户的真实动作上:
 *   · mode:'pick':主机弹系统级选文件夹窗口,用户亲手选中即授权(与 pick
 *     槽同一哲学);绝对路径不回沙箱,结果只带目录 basename;
 *   · mode:'dir':绝对路径 + 当前在途 ghost_call 的 callId(主机铸造、不可
 *     伪造的上下文凭证,反查发起会话)。目录在该会话 workdir 内自动放行,
 *     workdir 外弹确认卡(GrantConfirmBridge lane='workspace')——两档钳制
 *     对齐 attachments/dir 过户的 2026-07-14 政策;
 * - 骚扰钳制:同一插件两次请求最小间隔 GHOST_WORKSPACE_MIN_INTERVAL_MS
 *   (按尝试记账),全局同时只允许一个对话框/确认卡在场(BUSY;dir 模式在
 *   授权 await 之后、弹卡之前同步 check-and-set,防并发双卡);
 * - 判重+创建整段经全局串行链执行:并发 ensure(跨插件/同目录)在无锁下会
 *   "都查无 → 都创建"打破 ensure 语义;流量极低,全局串行即可;
 * - 远程工作区(SSH)v1 不支持:发起会话是远程会话时 mode:'dir' 一律硬拒
 *   (fail closed),引导改用 pick 模式由用户亲选本机目录。
 *
 * 纯逻辑 + 依赖注入(规则 14):Electron dialog / 确认卡桥 / localDb 会话服务
 * 在 cindy-brain/index.ts 与 maker-ipc register 装配时注入,单测喂假 deps 直测。
 */

import path from 'node:path';

import {
  GHOST_WORKSPACE_MIN_INTERVAL_MS,
  GHOST_WORKSPACE_TITLE_MAX_CHARS,
  type GhostPipeWorkspaceResult,
  type InstalledGhost,
} from '../../shared/ghost.js';
import { sanitizeGhostNoticeText } from './notifySlot.js';

/** 会话判重/创建/聚焦服务(maker-ipc 初始化完成后经 setter 注入)。 */
export interface WorkspaceSessionService {
  /**
   * 按目录判重:命中返回已有 active 会话 id(口径 = 侧边栏"同一工作区",
   * 归一化与 worktree 折叠在实现侧),查无返回 null。
   */
  findActiveSessionByWorkdir(dirAbs: string): Promise<string | null>;
  /** 创建 plugin 来源的空 draft 会话(不拉起 agent 进程),返回会话 id。 */
  createDraftSession(params: {
    dirAbs: string;
    title: string | null;
    ghostId: string;
  }): Promise<string>;
  /** focus:true 时跳转聚焦到该会话(deep-link navigate 通道;尽力而为)。 */
  focusSession(sessionId: string): void;
}

export interface WorkspaceSlotDeps {
  getGhost(id: string): InstalledGhost | null;
  /**
   * 弹系统级选文件夹窗口;返回所选绝对路径,取消返回 null。
   * 找不到可挂靠的 Cindy 窗口时应 reject(失败关闭,不弹无主对话框)。
   */
  showDirectoryDialog(params: { ghostName: string; purpose: string | null }): Promise<string | null>;
  /** 在途 ghost_call 反查(cardService.inFlightCallInfoOf):查无/过期返回 null。 */
  resolveCallContext(callId: string): { ghostId: string; sessionId: string | null } | null;
  /** 会话目录快照(localDb);查无会话返回 null。 */
  getSessionDirInfo(
    sessionId: string,
  ): Promise<{ workingDir: string | null; remoteHostId: string | null } | null>;
  /** 目录存在性校验(host 侧 fs.stat)。 */
  statDir(dirAbs: string): Promise<'ok' | 'not-found' | 'not-directory'>;
  /** 目标目录是否位于会话 workdir 内(realpath 归一化,口径同 dirDeposit)。 */
  isInsideWorkdir(dirAbs: string, workdirAbs: string): boolean;
  /** workdir 外目录的确认卡(GrantConfirmBridge lane='workspace')。 */
  confirmDir(params: {
    ghostId: string;
    sessionId: string;
    dirAbs: string;
  }): Promise<{ ok: true } | { ok: false; message: string }>;
  now?(): number;
  log?: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

function fail(
  errorCode: Extract<GhostPipeWorkspaceResult, { ok: false }>['errorCode'],
  message: string,
): GhostPipeWorkspaceResult {
  return { ok: false, errorCode, message };
}

/** 工作区会话槽:资格审 → 载荷校验 → 限速/单发 → 目录授权 → 判重 → 创建。 */
export class GhostWorkspaceSlot {
  /** 意识 id → 上次尝试时刻(按尝试记账;体量 = 已装意识数,无需清理)。 */
  private readonly lastAttemptAt = new Map<string, number>();
  /** 全局在场标记(系统对话框/确认卡一次一个,不排队——排队就是骚扰队列)。 */
  private consentInFlight = false;
  /**
   * 判重+创建的全局串行链:并发 ensure 在"查无 → 创建"之间没有原子性,
   * 两个请求会各建一个空会话、都报 created:true。按目录分键收益有限
   * (还得处理归一化),流量极低直接全局串行。链上错误已被消化,不会把
   * 上一单的失败漏给下一单。
   */
  private ensureChain: Promise<unknown> = Promise.resolve();
  private sessionService: WorkspaceSessionService | null = null;

  constructor(private readonly deps: WorkspaceSlotDeps) {}

  /** maker-ipc 初始化完成后注入真实会话服务;传 null 用于退出清理。 */
  setSessionService(service: WorkspaceSessionService | null): void {
    this.sessionService = service;
  }

  async handleRequest(ghostId: string, payload: unknown): Promise<GhostPipeWorkspaceResult> {
    const ghost = this.deps.getGhost(ghostId);
    if (!ghost?.enabled || !ghost.manifest.slots.includes('workspace')) {
      return fail('PERMISSION_DENIED', '插件未申请工作区会话权限(workspace 槽),或当前未启用');
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return fail('INVALID_REQUEST', 'workspace-request 载荷必须是对象');
    }
    const request = payload as Record<string, unknown>;
    if (request.kind !== 'ensure-session') {
      return fail('INVALID_REQUEST', 'kind 目前只支持 "ensure-session"');
    }
    if (request.mode !== 'pick' && request.mode !== 'dir') {
      return fail('INVALID_REQUEST', 'mode 必须是 "pick" 或 "dir"');
    }
    if (request.title !== undefined && typeof request.title !== 'string') {
      return fail('INVALID_REQUEST', 'title 必须是字符串');
    }
    if (request.focus !== undefined && typeof request.focus !== 'boolean') {
      return fail('INVALID_REQUEST', 'focus 必须是布尔值');
    }
    const service = this.sessionService;
    if (!service) {
      return fail('HOST_NOT_READY', '会话服务尚未准备好,请稍后再试');
    }

    // 骚扰钳制:限速按尝试记账(spam 顺延窗口),再看全局在场标记。
    const now = this.deps.now?.() ?? Date.now();
    const last = this.lastAttemptAt.get(ghostId);
    this.lastAttemptAt.set(ghostId, now);
    if (last !== undefined && now - last < GHOST_WORKSPACE_MIN_INTERVAL_MS) {
      return fail('RATE_LIMITED', '工作区会话请求太频繁,稍后再试');
    }
    if (this.consentInFlight) {
      return fail('BUSY', '已有一个选择窗口或确认卡在等用户操作');
    }

    const titleRaw = typeof request.title === 'string' ? sanitizeGhostNoticeText(request.title) : '';
    const title = titleRaw ? titleRaw.slice(0, GHOST_WORKSPACE_TITLE_MAX_CHARS) : null;

    // ── 目录授权 ────────────────────────────────────────────────────────
    let dirAbs: string;
    if (request.mode === 'pick') {
      this.consentInFlight = true;
      let picked: string | null;
      try {
        picked = await this.deps.showDirectoryDialog({
          ghostName: ghost.manifest.name,
          purpose: title,
        });
      } catch (error) {
        this.deps.log?.warn('ghost workspace pick dialog failed', {
          ghostId,
          err: error instanceof Error ? error.message : String(error),
        });
        return fail('INTERNAL', '选择窗口无法打开');
      } finally {
        this.consentInFlight = false;
      }
      if (picked === null) {
        return fail('CANCELLED', '用户取消了选择');
      }
      dirAbs = picked;
    } else {
      if (typeof request.dir !== 'string' || request.dir.length === 0 || request.dir.length > 1024) {
        return fail('INVALID_REQUEST', 'mode:"dir" 必须携带 1–1024 字符的 dir 绝对路径');
      }
      if (typeof request.callId !== 'string' || request.callId.length === 0 || request.callId.length > 128) {
        return fail('INVALID_REQUEST', 'mode:"dir" 必须携带当前在途 ghost_call 的 callId');
      }
      if (!path.isAbsolute(request.dir)) {
        return fail('INVALID_REQUEST', 'dir 必须是绝对路径');
      }
      // callId 是主机铸造的上下文凭证:反查归属与发起会话,冒名/过期直接拒。
      const ctx = this.deps.resolveCallContext(request.callId);
      if (!ctx || ctx.ghostId !== ghostId) {
        return fail('PERMISSION_DENIED', 'callId 无效或不属于这个插件(只能在处理 ghost_call 期间使用)');
      }
      if (!ctx.sessionId) {
        return fail(
          'INVALID_REQUEST',
          '本次调用没有会话语境,无法向用户弹确认卡;请改用 mode:"pick" 让用户亲自选目录',
        );
      }
      const stat = await this.deps.statDir(request.dir);
      if (stat === 'not-found') return fail('DIR_NOT_FOUND', '目录不存在(只支持本机已存在的目录)');
      if (stat === 'not-directory') return fail('NOT_DIRECTORY', '该路径不是目录');
      const dirInfo = await this.deps.getSessionDirInfo(ctx.sessionId);
      // fail closed:快照读不到(查无会话/读失败)或远程(SSH)会话一律硬拒
      // ——证明不了"本机工作区语境"就连确认卡也不发,防快照失败把远程会话
      // 漏进确认卡路径(与管子契约"远程一律拒"一致)。
      if (dirInfo === null || dirInfo.remoteHostId !== null) {
        return fail(
          'INVALID_REQUEST',
          '无法确认发起会话的本机工作区语境(远程 SSH 会话或会话信息不可用),workspace v1 不支持;请改用 mode:"pick" 让用户亲自选本机目录',
        );
      }
      // 两档钳制:目录在发起会话的 workdir 内 → 自动放行;workdir 外一律
      // 确认卡,证明不了"在内"就弹卡。
      const insideWorkdir =
        dirInfo.workingDir !== null && this.deps.isInsideWorkdir(request.dir, dirInfo.workingDir);
      if (!insideWorkdir) {
        // 前面的 statDir/getSessionDirInfo await 期间可能有并发请求闯进来,
        // 弹卡前同步 check-and-set,保证确认卡全局一次一张。
        if (this.consentInFlight) {
          return fail('BUSY', '已有一个选择窗口或确认卡在等用户操作');
        }
        this.consentInFlight = true;
        let confirmed: { ok: true } | { ok: false; message: string };
        try {
          confirmed = await this.deps.confirmDir({
            ghostId,
            sessionId: ctx.sessionId,
            dirAbs: request.dir,
          });
        } catch (error) {
          // 桥未就绪/renderer 通道异常等 reject 折叠成结构化 INTERNAL,
          // 不把裸异常漏给沙箱(与 pick 对话框同纪律)。
          this.deps.log?.warn('ghost workspace confirm failed', {
            ghostId,
            err: error instanceof Error ? error.message : String(error),
          });
          return fail('INTERNAL', '确认通道异常,请稍后再试');
        } finally {
          this.consentInFlight = false;
        }
        if (!confirmed.ok) {
          return fail('CANCELLED', confirmed.message);
        }
      }
      dirAbs = request.dir;
    }

    // ── 判重 → 创建(ensure 语义,授权后统一走这段;全局串行防双建)──────
    const name = path.basename(dirAbs) || dirAbs;
    const ensure = async (): Promise<GhostPipeWorkspaceResult> => {
      try {
        const existing = await service.findActiveSessionByWorkdir(dirAbs);
        if (existing) {
          if (request.focus === true) service.focusSession(existing);
          this.deps.log?.info('ghost workspace ensured (reused)', { ghostId, sessionId: existing });
          return { ok: true, sessionId: existing, created: false, name };
        }
        const sessionId = await service.createDraftSession({ dirAbs, title, ghostId });
        if (request.focus === true) service.focusSession(sessionId);
        this.deps.log?.info('ghost workspace ensured (created)', { ghostId, sessionId });
        return { ok: true, sessionId, created: true, name };
      } catch (error) {
        this.deps.log?.warn('ghost workspace ensure failed', {
          ghostId,
          err: error instanceof Error ? error.message : String(error),
        });
        return fail('INTERNAL', '会话创建失败,请稍后再试');
      }
    };
    // ensure 自身把异常折叠成 INTERNAL,链尾兜底只为极端情况下不断链。
    const resultPromise = this.ensureChain.then(ensure, ensure);
    this.ensureChain = resultPromise.catch(() => undefined);
    return resultPromise;
  }
}
