/**
 * ghostErrandRunner —— 插件「派活取件(errand)」的主机执行器(maker-ipc 侧)。
 *
 * errandSlot(cindy-brain)只负责资格审/频控/任务表;真正的干活链在这里:
 *
 *   解析用户配置(errandPrefsStore,缺省跟随 New Maker 草稿偏好)
 *     → 确保专属 errand 会话(映射存 prefs;失效/配置关键项变更则重建;
 *        请求带 sessionKey 时按 ghostId+key 分间——同钥匙同间、异钥匙各间)
 *     → 忙检(errand 会话正被占用即 BUSY,不排队——排队会让结果对不上单)
 *     → sendToSessionInternal 统一通路投递(消息落库/进程拉起与用户亲发一致)
 *     → observeHookTurn 收口(与飞书 bot / scheduler 同一套 turn 观察语义)
 *     → 取最终回复文字(观察器累积为主,DB 最新 assistant 消息兜底)
 *
 * 安全不变量(与 errandSlot 头注释同一契约):任务文本只进普通 user 消息;
 * 权限档只认 plan/acceptEdits/auto(存储层与本层双重钳制,bypassPermissions
 * 在协议上不存在);errand 会话侧边栏可见,用户可旁观可随时停;工作目录
 * 用户配置优先,插件转述的目录只认 pick 亲选台账(isUserPickedDir),
 * 台账没有即明拒——插件不能凭空指路。
 *
 * 全部依赖注入(规则 14):register.ts 只做接线,本模块可单测。
 */

import {
  GHOST_ERRAND_PERMISSION_MODES,
  type GhostErrandPermissionMode,
} from '../../shared/ghost.js';
import type {
  GhostErrandRunner,
  GhostErrandRunOutcome,
} from '../cindy-brain/errandSlot.js';
import type { GhostErrandConfig } from '../cindy-brain/errandPrefsStore.js';
import { observeHookTurn, type ObservableSession } from '../hook-control/turnObserver.js';

/** turn 收口的兜底超时(25 分钟:低于管子 30 分钟天花板,给交卷留余量)。 */
const DEFAULT_TURN_TIMEOUT_MS = 25 * 60_000;

/** 收口后读 DB 兜底文本的重试(消息落库与 done 事件之间可能有毫秒级间隙)。 */
const DB_TEXT_RETRIES = 3;
const DB_TEXT_RETRY_DELAY_MS = 400;

/** errand 会话行的关键面(复用判定与结果归因用)。 */
export interface GhostErrandSessionRow {
  status: string;
  agentKind: string;
  model: string;
  permissionMode: string;
  workingDir: string | null;
  workspaceKind: string;
}

export interface GhostErrandRunnerDeps {
  readConfig(ghostId: string): GhostErrandConfig;
  /** sessionKey 缺省 = 插件共用间;带钥匙 = 该钥匙专属间(映射按 ghostId+key)。 */
  readSessionId(ghostId: string, sessionKey?: string): string | null;
  writeSessionId(ghostId: string, sessionId: string | null, sessionKey?: string): void;
  getSessionRow(sessionId: string): Promise<GhostErrandSessionRow | null>;
  /** 建 errand 会话 DB 行(不拉 agent);config 已由本层解析合并完毕。 */
  createSession(params: {
    ghostId: string;
    title: string | null;
    agentKind?: 'cc' | 'codex' | 'pi';
    model?: string;
    effort?: string;
    fastMode?: boolean;
    providerId?: string | null;
    permissionMode: GhostErrandPermissionMode;
    workingDir?: string;
  }): Promise<string>;
  /** 该插件的展示名(errand 会话默认标题用)。 */
  getGhostName(ghostId: string): string | null;
  /** 缺省选型来源:New Maker 草稿偏好快照(与 Orca worker 同源)。 */
  getDraftDefaults(vendor: 'claude-code' | 'codex' | 'pi'): {
    model?: string;
    effort?: string;
    fastMode?: boolean;
    providerId?: string | null;
  };
  /**
   * 目录规范化(与 sessions 落库同一实现):配置目录必须先规范化再与 DB 行
   * 比对,否则"带尾斜杠 vs 不带"会让复用判定永远失败、每单都建新会话。
   */
  normalizeWorkingDir(dir: string): string | null;
  /**
   * 插件转述的目录是不是这个插件的用户在 pick 槽里亲手选过的
   * (pickGrantsStore 台账;入参已经过 normalizeWorkingDir)。
   */
  isUserPickedDir(ghostId: string, normalizedDir: string): boolean;
  isSessionBusy(sessionId: string): boolean;
  /** 统一投递通路(sendToSessionInternal 的窄化面)。 */
  dispatch(params: { targetSessionId: string; message: string }): Promise<
    | { ok: true; wakeKind: 'resumed' | 'already-active' | 'created' | 'queued' }
    | { ok: false; errorCode: string; message: string }
  >;
  getObservableSession(sessionId: string): ObservableSession | null;
  onSilentStopSettled(
    sessionId: string,
    cb: (sessionId: string, reason: string) => void,
  ): () => void;
  /** 收口后读该会话 sinceMs 之后最新一条 assistant 正文(兜底;查无 → null)。 */
  readLatestAssistantText(sessionId: string, sinceMs: number): Promise<string | null>;
  log: {
    info(message: string, meta?: Record<string, unknown>): void;
    warn(message: string, meta?: Record<string, unknown>): void;
  };
  now?: () => number;
  turnTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

function failure(
  errorCode: Extract<GhostErrandRunOutcome, { ok: false }>['errorCode'],
  message: string,
): GhostErrandRunOutcome {
  return { ok: false, errorCode, message };
}

/** 权限档钳制:任何来路的值都收敛进白名单,缺省 plan(只读)。 */
export function clampErrandPermissionMode(value: unknown): GhostErrandPermissionMode {
  return typeof value === 'string' &&
    (GHOST_ERRAND_PERMISSION_MODES as readonly string[]).includes(value)
    ? (value as GhostErrandPermissionMode)
    : 'plan';
}

export function createGhostErrandRunner(deps: GhostErrandRunnerDeps): GhostErrandRunner {
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  /** 既有会话还能不能当这单的干活间:关键配置(agent/权限档/目录)变了就换新间。 */
  const sessionMatchesConfig = (
    row: GhostErrandSessionRow,
    cfg: GhostErrandConfig,
    permissionMode: GhostErrandPermissionMode,
    effectiveDir: string | undefined,
  ): boolean => {
    if (row.status !== 'active') return false;
    if (cfg.agentKind && row.agentKind !== cfg.agentKind) return false;
    if (row.permissionMode !== permissionMode) return false;
    // 这单要目录(用户配置或已对账的插件转述):目录不同(或旧间还是
    // dialogue)就换新间;这单不要目录:旧的 project 间不再复用,回到
    // 专属 dialogue 间。
    if (effectiveDir) {
      if (row.workspaceKind !== 'project' || row.workingDir !== effectiveDir) return false;
    } else if (row.workspaceKind !== 'dialogue') {
      return false;
    }
    return true;
  };

  return async (request, hooks) => {
    const cfg = deps.readConfig(request.ghostId);
    const permissionMode = clampErrandPermissionMode(cfg.permissionMode);
    // 与落库同一套规范化再参与比对/创建;规范化失败视为没配(回专属间)。
    const configuredDir = cfg.workingDir
      ? (deps.normalizeWorkingDir(cfg.workingDir) ?? undefined)
      : undefined;
    // 目录取值:用户在「AI 代办」卡里的配置永远优先;没配置时才看插件在
    // 请求里转述的目录,且只认 pick 台账里用户亲手选过的——插件不能凭空
    // 指路,否则等于让它借 Agent 的手读任意文件夹。查不到时明拒,不静默
    // 落回专属对话间:静默降级会建出一间看不到代码的会话,插件还以为成了。
    let effectiveDir = configuredDir;
    if (!effectiveDir && request.workingDir) {
      const requested = deps.normalizeWorkingDir(request.workingDir) ?? undefined;
      if (!requested || !deps.isUserPickedDir(request.ghostId, requested)) {
        return failure(
          'INVALID_REQUEST',
          '这个目录不在用户亲选记录里,不能把 errand 会话建在那里;请引导用户在插件设置里重新选一次该目录(经系统选目录窗口),或在插件详情页「AI 代办」卡里配置工作目录',
        );
      }
      effectiveDir = requested;
    }

    // ── 确保专属 errand 会话(sessionKey 缺省共用间,带钥匙各开各间) ────
    const sessionKey = request.sessionKey;
    let sessionId = deps.readSessionId(request.ghostId, sessionKey);
    if (sessionId) {
      const row = await deps.getSessionRow(sessionId);
      if (!row || !sessionMatchesConfig(row, cfg, permissionMode, effectiveDir)) {
        // 旧间不可用/配置已变:解除映射换新间(旧会话留在侧边栏,历史可查)。
        deps.writeSessionId(request.ghostId, null, sessionKey);
        sessionId = null;
      }
    }
    if (!sessionId) {
      // 缺省选型跟随 New Maker 草稿偏好(与 Orca worker / workspace 槽同源);
      // 配置项逐字段覆盖。model/effort 缺省最终由 mapper 兜底,这里不硬编码。
      const vendor = cfg.agentKind === 'codex' ? 'codex' : cfg.agentKind === 'pi' ? 'pi' : 'claude-code';
      const draft = deps.getDraftDefaults(vendor);
      const ghostName = deps.getGhostName(request.ghostId);
      try {
        sessionId = await deps.createSession({
          ghostId: request.ghostId,
          title: request.title ?? (ghostName ? `${ghostName} · 代办` : null),
          ...(cfg.agentKind ? { agentKind: cfg.agentKind } : {}),
          ...(cfg.model ?? draft.model ? { model: cfg.model ?? draft.model } : {}),
          ...(cfg.effort ?? draft.effort ? { effort: cfg.effort ?? draft.effort } : {}),
          ...((cfg.fastMode ?? draft.fastMode) !== undefined
            ? { fastMode: cfg.fastMode ?? draft.fastMode }
            : {}),
          ...((cfg.providerId ?? draft.providerId) !== undefined
            ? { providerId: cfg.providerId ?? draft.providerId }
            : {}),
          permissionMode,
          ...(effectiveDir ? { workingDir: effectiveDir } : {}),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        deps.log.warn('ghost errand session create failed', { ghostId: request.ghostId, error: message });
        return failure('SESSION_UNAVAILABLE', `errand 会话创建失败:${message}`);
      }
      deps.writeSessionId(request.ghostId, sessionId, sessionKey);
    }
    hooks?.onSession?.(sessionId);

    // ── 忙检 + 投递 ──────────────────────────────────────────────────────
    // 不排队:排队会让"这单的结果"对不上"正在跑的那轮"。errandSlot 已保证
    // 同插件单在途,这里挡的是用户恰好正在这间会话里亲自聊天的情况。
    if (deps.isSessionBusy(sessionId)) {
      return failure('BUSY', 'errand 会话正被占用(可能正被用户使用),请稍后再试');
    }
    const dispatchedAt = now();
    const dispatched = await deps.dispatch({ targetSessionId: sessionId, message: request.message });
    if (!dispatched.ok) {
      if (dispatched.errorCode === 'BUSY') return failure('BUSY', dispatched.message);
      if (
        dispatched.errorCode === 'NOT_FOUND' ||
        dispatched.errorCode === 'ARCHIVED' ||
        dispatched.errorCode === 'DELETED'
      ) {
        // 会话在忙检与投递之间被删/归档:解除映射,让下一单重建。
        deps.writeSessionId(request.ghostId, null, sessionKey);
        return failure('SESSION_UNAVAILABLE', dispatched.message);
      }
      return failure('INTERNAL', dispatched.message);
    }
    if (dispatched.wakeKind === 'queued') {
      // 忙检后的窄竞态窗口:消息已进队(会在当前轮后执行,但结果不取回)。
      // 如实告知并留日志——这是已知边界,不装作没发生。
      deps.log.warn('ghost errand message queued behind a foreign turn', {
        ghostId: request.ghostId,
        sessionId,
      });
      return failure(
        'BUSY',
        'errand 会话恰好正忙,本单任务已排队进该会话但结果不再取回;请稍后查看会话或重新提交',
      );
    }
    // ── 收口:观察这一轮直到 done / 终态错误 / 超时 ─────────────────────
    const session = deps.getObservableSession(sessionId);
    if (!session) {
      return failure('SESSION_UNAVAILABLE', 'errand 会话进程不可用,请稍后再试');
    }
    hooks?.onDispatched?.(sessionId);
    const observer = observeHookTurn(session, {
      // 不传 onProgress: errand 只取终态结果, 不向任何渠道发过程快照。
      onSilentStopSettled: deps.onSilentStopSettled,
      log: { warn: (msg) => deps.log.warn(msg) },
    });
    const timeoutMs = deps.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
    let timer: NodeJS.Timeout | undefined;
    let timedOut = false;
    try {
      await Promise.race([
        observer.finished,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            reject(new Error('errand turn timeout'));
          }, timeoutMs);
          timer.unref?.();
        }),
      ]);
    } catch (err) {
      observer.stop();
      if (timedOut) {
        return failure('TIMEOUT', '派活超时(任务可能仍在会话里继续,可打开 errand 会话查看)');
      }
      const message = err instanceof Error ? err.message : String(err);
      return failure('TURN_FAILED', `派活这一轮失败:${message}`);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }

    // ── 取结果文字:观察器累积为主,DB 最新 assistant 消息兜底 ──────────
    // (create/resumed 分支里观察器晚于 turn 启动挂上,可能漏掉最早的文本
    // 事件;DB 是落库后的权威内容,带 sinceMs 防捞到上一轮的旧答案。)
    let text = observer.text().trim();
    if (!text) {
      for (let i = 0; i < DB_TEXT_RETRIES && !text; i++) {
        if (i > 0) await sleep(DB_TEXT_RETRY_DELAY_MS);
        text = ((await deps.readLatestAssistantText(sessionId, dispatchedAt)) ?? '').trim();
      }
    }
    if (!text) text = '(本轮没有可取回的文字回复)';
    const row = await deps.getSessionRow(sessionId);
    deps.log.info('ghost errand turn finished', {
      ghostId: request.ghostId,
      sessionId,
      chars: text.length,
      elapsedMs: now() - dispatchedAt,
    });
    return {
      ok: true,
      sessionId,
      text,
      ...(row?.agentKind ? { agentKind: row.agentKind } : {}),
      ...(row?.model ? { model: row.model } : {}),
    };
  };
}
