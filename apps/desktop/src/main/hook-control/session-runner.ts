/**
 * hook-control/session-runner.ts
 * ---------------------------------------------------------------------------
 * HookSessionRunner 的生产实现 —— 包 maker 跑 headless turn。实现模式与
 * scheduler-host/runner.ts 的 fire 路径同源(那是 headless 跑 session 的
 * 已验证先例), 取其最小子集:
 *
 *   createSession(复用按 meta 取 resumeSessionId/workDir/model) ->
 *   wireSessionToIpc(renderer 可见, 消息落库链路不缺) ->
 *   turnFinished 监听(text 累积 + done 收口, 含后台 subagent 在途时的
 *   延迟定格与静默兜底) -> session.send(onAccepted 落 user 消息)。
 *
 * 进度快照(turn.progress): text/tool_use 事件驱动 turnActivity(与 IM 流式卡
 * 同一套过程区纯逻辑), 节流合成 markdown 快照经 req.onProgress 回调发射;
 * server 侧以占位消息 + chat.update 呈现"正在干什么"。
 *
 * permissionMode: 新建会话按「当前 IM provider 的目录偏好(显式且该 agent 支持) >
 * bypassPermissions」合成(见 defaults.ts); 复用/接管以 session meta 为权威。
 * 非 bypass 会话的权限请求经 interactions.ts 出渠道交互卡(允许一次/本会话
 * 总是允许/拒绝), 超时安全默认拒绝 —— scheduler 仍固定 bypass(它没有
 * 交互回流通道), hook 因具备 interaction.request 往返而例外。
 * origin 用 kind:'scheduler' + scheduleName
 * 标注 hook 来源: SendOrigin.kind 是 maker-core 闭合联合('user'|'scheduler'|
 * 'goal'), 新增 'hook' kind 属 maker-core 改动(规则 10 需评估实测), v1 刻意
 * 不动 —— hook 任务本质就是无人值守自动 turn, IM 转播/UI 按自动任务显示语义
 * 正确。后续要精确区分时再与 maker-core 一起演进。
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { app, BrowserWindow } from 'electron';

import { isTerminalAgentErrorEvent } from '@cindy/maker-core';
import type {
  AgentEvent,
  AgentKind,
  PermissionMode,
  UserContentBlock,
  UserMessage,
} from '@cindy/maker-core';
import {
  effectiveSourceIdForModel,
  isModelVisible,
  type ProviderView,
  visibleModelUnion,
} from '@cindy/model-providers';

import { tapWindowBroadcast } from '../device-link/broadcast-tap.js';
import { getMaker } from '../maker-host/index.js';
import {
  wireSessionToIpc,
  isSessionInTurn,
  installDesktopInteractionListener,
  noteSilentStopUserSend,
  onSilentStopSettled,
} from '../maker-ipc/register.js';
import { prependHandoffToUserMessage } from '../maker-ipc/agentHandoff.js';
import { agentHandoffPending } from '../maker-ipc/agentHandoffPendingSingleton.js';
import { toDesktopSessionDispatchOutcome } from '../maker-host/send-outcome.js';
import { createMessage } from '../localDb/ipc/messages.js';
import {
  getSessionRowSnapshot,
  setSessionProviderIdInDb,
  setSessionSourceInDb,
  setWorktreePathInDb,
  touchUserSendInDb,
} from '../localDb/ipc/sessions.js';
import {
  hydrateSessionProvider,
  setSessionProvider,
} from '../maker-host/session-provider-store.js';

import { resolveSafe as resolveXdtImage } from '../imageCacheStore.js';
import { resolveSafe as resolveCindyMediaUrl } from '../cindy-media/blobStore.js';
import { ingestMedia, supportedMime as isCindyMediaMime } from '../cindy-media/ingest.js';
import { worktreeStore, WorktreeManager } from '../worktree/index.js';
import { readImDefaultSettings } from '../im/defaultSettingsStore.js';
import { getDesktopProviderService } from '../maker-host/createDesktopProviderService.js';
import { getModelVisibilityOverride } from '../maker-host/model-visibility-mirror.js';
import {
  createTurnActivity,
  markActivityWriting,
  pushThinkingStep,
  pushToolStep,
  renderActivity,
} from '../im/shared/turnActivity.js';
import { beginHeadlessGhostSetupTurn } from '../mcp-integrations/ghostSetupInteractionSurface.js';

import type { HookRunOutcome, HookSessionRunner } from './dispatcher.js';
import { resolveHookSessionConfig, type ResolvedHookSessionConfig } from './defaults.js';
import { decodeAttachments, sanitizeAttachmentName } from './attachments.js';
import {
  cancelHookInteraction,
  composeInteractionCard,
  registerHookInteraction,
} from './interactions.js';
import { collectOutboundAttachments, buildHookPromptNote, hasOutboundRefs } from './outbound.js';

/**
 * 新会话 agent/model/effort/permissionMode/providerId 合成: IM provider 按目录偏好
 * (dispatch options)优先, 缺省落桌面端 IM 新会话默认值(草稿, 建 session 那
 * 一刻实时读; 权限无草稿概念, 缺省 bypassPermissions; 来源无 override 通道,
 * 草稿默认仅作优先值, 最终收敛到已连接来源)—— 与桌面端/IM 新开会话同一
 * 数据源, 取代旧版的硬编码兜底模型。
 */
async function resolveNewSessionConfig(
  overrides: {
    agentKind: string | null;
    model: string | null;
    effort: string | null;
    permissionMode: string | null;
  },
  log: { warn(msg: string): void },
  sourceIm?: string | null,
): Promise<ResolvedHookSessionConfig> {
  let providers: ProviderView[] | null = null;
  try {
    providers = await getDesktopProviderService().listProviders();
  } catch (err) {
    log.warn(
      `hook provider catalog unavailable; falling back to maker capabilities: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const resolved = resolveHookSessionConfig(
    {
      readDefaults: () => readImDefaultSettings(sourceIm === 'slack' ? 'slack' : undefined),
      getModels: (agentKind) =>
        providers
          ? visibleModelUnion(providers, agentKind, (providerId, model) =>
              isModelVisible(
                getModelVisibilityOverride(agentKind, providerId, model.id),
                model.defaultEnabled,
              ),
            )
          : getMaker().getCapabilities(agentKind).availableModels,
      getPermissionModes: (agentKind) =>
        getMaker()
          .getCapabilities(agentKind)
          .permissionModes.map((pm) => pm.id),
      log,
    },
    overrides,
  );

  // 目录可用时始终把最终模型收敛到一个真实已连接、且确实提供它的来源。
  // 目录读取失败才保留旧行为(草稿来源原样透传),避免临时目录故障阻断 hook。
  const providerId = providers
    ? effectiveSourceIdForModel(providers, resolved.providerId, resolved.model, resolved.agentKind)
    : resolved.providerId;
  return { ...resolved, providerId };
}

/** 后台 subagent 事件静默兜底(同 scheduler BG_TASK_IDLE_FALLBACK_MS 语义)。 */
const BG_TASK_IDLE_FALLBACK_MS = 10 * 60_000;

/**
 * 广播「新会话已建」给所有窗口 + device-link tap —— renderer sessionsStore
 * 收到即重拉列表, 新 hook 会话实时出现在侧边栏(不广播的话要等手动刷新)。
 * 与 fork.ts / cardActionHandler.ts / learn-host 同款(各模块本地副本是既有惯例)。
 */
function broadcastSessionCreated(sessionId: string): void {
  tapWindowBroadcast('local-db:sessions:created', { sessionId });
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send('local-db:sessions:created', { sessionId });
    } catch {
      // best-effort UI refresh
    }
  }
}

/**
 * 整 turn 硬超时。scheduler 有 ctx.signal 可 abort, hook v1 无 task.cancel ——
 * SDK 卡死一个事件都不发时, 没有这条兜底该 session 的 hook 队列会永久饿死。
 * 上限取宽(正常长任务 10-30min 量级), 触发即按 error 收口。
 */
const TURN_HARD_TIMEOUT_MS = 60 * 60_000;

/**
 * 从 tool_result 全文抽出可外发的 xdt-image URL —— 与 IM turnRunner 的
 * extractRenderableXdtImageUrls 同语义精简副本(含 `_xdt_render_image: false`
 * sentinel: read_by_url 读文档注图但不希望刷屏的场景必须尊重, 否则"总结这篇
 * 文档"会往 Slack 刷一堆插图)。视频本期不外发, 直接忽略。
 */
/** 双协议:老 xdt-image(历史/未迁移工具)+ 新 cindy-media(媒体总仓,mivo /
 *  art 等生成图迁移后均为此形态)。与 IM turnRunner 同判据——只认老协议会让
 *  hook Slack 拿不到任何生成图(2026-07-16 实踩)。 */
function isRenderableImageUrl(u: string): boolean {
  return u.startsWith('xdt-image://') || u.startsWith('cindy-media://');
}

/** 兜底账本条目是否图片(hook 本期只外发图片):cindy-media 地址按扩展名判。 */
const PRODUCED_IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp)$/i;

/** 导出仅供单测(纯函数,不碰 electron)。 */
export function extractToolResultImageUrls(toolResultText: string): string[] {
  if (!toolResultText.includes('xdt_image_url') && !toolResultText.includes('xdt_media_produced')) {
    return [];
  }
  let parsed: {
    xdt_image_url?: unknown;
    xdt_image_urls?: unknown;
    xdt_media_produced?: unknown;
    _xdt_render_image?: unknown;
  };
  try {
    parsed = JSON.parse(toolResultText);
  } catch {
    return [];
  }
  if (parsed._xdt_render_image === false) return [];
  const urls: string[] = [];
  if (typeof parsed.xdt_image_url === 'string' && isRenderableImageUrl(parsed.xdt_image_url)) {
    urls.push(parsed.xdt_image_url);
  }
  if (Array.isArray(parsed.xdt_image_urls)) {
    for (const u of parsed.xdt_image_urls) {
      if (typeof u === 'string' && isRenderableImageUrl(u)) urls.push(u);
    }
  }
  // 兜底账本(xdt_media_produced,ghost_call 层在意识未声明媒体字段时注入,
  // 主机记账、意识删不掉):可能混有视频/音频/3D,这里只接走图片。
  if (Array.isArray(parsed.xdt_media_produced)) {
    for (const u of parsed.xdt_media_produced) {
      if (typeof u === 'string' && isRenderableImageUrl(u) && PRODUCED_IMAGE_EXT_RE.test(u)) {
        urls.push(u);
      }
    }
  }
  return Array.from(new Set(urls));
}

/** 按协议解出图片 absPath(与 IM turnRunner 同语义)。 */
function resolveRenderableImageUrl(url: string): { absPath: string } {
  return url.startsWith('cindy-media://') ? resolveCindyMediaUrl(url) : resolveXdtImage(url);
}

/**
 * 进度快照节流(trailing-edge): 事件密集时最多每 1.5s 发一帧, 与 IM 流式卡的
 * chat.update 节流(1300ms)同量级 —— server 侧每帧一次 chat.update(Tier 3
 * ~50/min/频道), 这个间隔留有安全余量。
 */
const PROGRESS_THROTTLE_MS = 1500;
/** 无新事件时的低频刷新(过程区耗时行"第 N 步 · 42s"不冻结)。 */
const PROGRESS_TICK_MS = 5000;
/** 单帧快照长度上限: 头部截断 —— server 侧占位消息本就 3900 上限, 中间帧
 *  开头(过程区 + 正文起始)信息量最大, 收口后 turn.end 会带完整文本。 */
const PROGRESS_SNAPSHOT_MAX_CHARS = 3800;

/**
 * 进度快照发射器: 合成「过程区时间线 + 部分正文」并按 trailing-edge 节流回调。
 * 纯定时器逻辑, 不做 IO —— 真正的发送(turn.progress 帧)由 dispatcher 注入的
 * onProgress 承担。stop() 后不再发射(收口后的迟到事件被丢弃)。
 */
function createProgressEmitter(
  emit: (text: string) => void,
  compose: () => string,
): { schedule: () => void; ensureTicker: () => void; stop: () => void } {
  let lastEmitAt = 0;
  let lastEmittedText = '';
  let pending: NodeJS.Timeout | null = null;
  let ticker: NodeJS.Timeout | null = null;
  let stopped = false;

  const fire = (): void => {
    if (stopped) return;
    const text = compose();
    if (text.length === 0) return;
    const snapshot =
      text.length > PROGRESS_SNAPSHOT_MAX_CHARS
        ? `${text.slice(0, PROGRESS_SNAPSHOT_MAX_CHARS - 1)}…`
        : text;
    // The low-frequency activity ticker can fire while the user-visible
    // answer is unchanged. Do not spend provider API calls on identical
    // full snapshots (and, for Telegram, do not re-animate the same draft).
    if (snapshot === lastEmittedText) return;
    lastEmitAt = Date.now();
    lastEmittedText = snapshot;
    emit(snapshot);
  };
  const schedule = (): void => {
    if (stopped || pending !== null) return;
    const wait = Math.max(0, lastEmitAt + PROGRESS_THROTTLE_MS - Date.now());
    pending = setTimeout(() => {
      pending = null;
      fire();
    }, wait);
    pending.unref?.();
  };
  return {
    schedule,
    ensureTicker(): void {
      if (stopped || ticker !== null) return;
      ticker = setInterval(schedule, PROGRESS_TICK_MS);
      ticker.unref?.();
    },
    stop(): void {
      stopped = true;
      if (pending !== null) clearTimeout(pending);
      if (ticker !== null) clearInterval(ticker);
      pending = null;
      ticker = null;
    },
  };
}

export function createMakerHookSessionRunner(deps: {
  log: { info(msg: string): void; warn(msg: string): void };
}): HookSessionRunner {
  const { log } = deps;

  return {
    isBusy: (sessionId) => isSessionInTurn(sessionId),

    async inspect(sessionId) {
      const [meta, row] = await Promise.all([
        getMaker()
          .getSessionMeta(sessionId)
          .catch(() => null),
        getSessionRowSnapshot(sessionId),
      ]);
      if (!meta && !row) return null;
      const usable =
        !!row &&
        row.status !== 'archived' &&
        row.status !== 'deleted' &&
        row.remoteHostId == null &&
        row.orcaRole !== 'worker';
      // workDir 以 maker meta 为权威(scheduler 同做法), row 兜底
      const workingDir = meta?.workDir ?? row?.workingDir ?? null;
      return { workingDir, usable };
    },

    async run(req) {
      const startedAt = Date.now();
      const maker = getMaker();

      // 新建: 按「偏好 > 草稿默认」合成; 复用/接管: session meta 权威, 下方覆盖
      const resolved = req.isNew
        ? await resolveNewSessionConfig(
            {
              agentKind: req.agentKind,
              model: req.model,
              effort: req.effort,
              permissionMode: req.permissionMode,
            },
            log,
            req.source?.im,
          )
        : null;
      let workingDir = req.workingDir;
      let model: string | undefined = resolved?.model;
      let effort = resolved?.effort;
      let resumeSessionId: string | undefined;
      let effectiveAgentKind: AgentKind = resolved?.agentKind ?? 'claude-code';
      // 新建路径 resolved 必有值(capabilities 校验过); 复用路径由下方 meta 覆盖
      let permissionMode: PermissionMode = (resolved?.permissionMode ??
        'bypassPermissions') as PermissionMode;

      // 复用/接管路径的持久化来源(sessions.provider_id, 用户在聊天里切过的
      // 来源以它为权威); 新建路径恒 null, 由下方草稿默认解析
      let rowProviderId: string | null = null;
      if (!req.isNew) {
        // 复用/接管: session 自己的 meta 是权威(workDir/model/agentKind/
        // permissionMode), sdkSessionId 用于冷 resume; effort 不覆盖、权限档
        // 不覆盖(进行中的会话不受偏好影响; meta 没记录时按历史默认 bypass)
        const [meta, row] = await Promise.all([
          maker.getSessionMeta(req.sessionId).catch(() => null),
          getSessionRowSnapshot(req.sessionId),
        ]);
        if (meta) {
          workingDir = meta.workDir;
          model = meta.model;
          resumeSessionId = meta.sdkSessionId;
          effectiveAgentKind = meta.agentKind;
        }
        effort = undefined;
        permissionMode = meta?.permissionMode ?? 'bypassPermissions';
        rowProviderId = row?.providerId ?? null;
      }

      const fail = (msg: string): HookRunOutcome => ({
        status: 'error',
        finalText: '',
        errorMessage: msg,
        durationMs: Date.now() - startedAt,
      });

      // resolved 路径必有 model; 复用路径 meta 缺失时兜底草稿默认
      const effectiveModel = model?.trim()
        ? model
        : (
            await resolveNewSessionConfig(
              { agentKind: effectiveAgentKind, model: null, effort: null, permissionMode: null },
              log,
              req.source?.im,
            )
          ).model;

      // 来源(供应商)贯通(issue #854: hook 会话只继承模型 id 不继承来源):
      //   - 新建: 上方 resolved 已用同一份实时供应商目录同时选定模型与具体来源;
      //   - 复用/接管: sessions.provider_id 权威(冷 resume 时内存 store 为空,
      //     不带上它 agent 首轮凭证形态会按默认 fallback 判断)。
      const providerId = req.isNew ? (resolved?.providerId ?? null) : rowProviderId;

      let session: Awaited<ReturnType<ReturnType<typeof getMaker>['createSession']>>;
      try {
        session = await maker.createSession({
          id: req.sessionId,
          agentKind: effectiveAgentKind,
          workingDir,
          model: effectiveModel,
          ...(providerId !== null ? { providerId } : {}),
          ...(effort !== undefined ? { effort } : {}),
          permissionMode,
          // chat 伪目录新会话: 标记 dialogue, 落侧边栏「对话」分组而非按
          // dialogues/<日期>/<id> 目录名聚成项目节点
          ...(req.isNew && req.workspaceKind !== undefined
            ? { workspaceKind: req.workspaceKind }
            : {}),
          title: req.isNew ? (req.title ?? undefined) : undefined,
          // 渠道标记(仅 hook 亲生新会话): cindy_feishu_bot 据此在构建期给
          // 工具描述注入渠道路由提示。两个刻意限定:
          //   - 不用 'slack'(那是已退役的 organic SlackIM relay 渠道的历史
          //     标记,留给存量会话的侧边栏显示,新会话不再产生);
          //   - 复用/接管路径(isNew=false,可能是桌面端创建的会话)不传,
          //     否则冷 resume 时会把桌面会话打上 Slack 渠道描述并存续整个
          //     进程生命周期(对齐 im/turnRunner「attached 不传 vendorOptions」
          //     的裁决)。hook turn 本身的渠道说明由逐 turn 的
          //     provider-aware hook prompt note 全覆盖,不依赖这里。
          ...(req.isNew
            ? {
                vendorOptions: {
                  source: req.source?.im === 'telegram' ? 'telegram' : 'slack-hook',
                },
              }
            : {}),
          resumeSessionId,
        });
      } catch (err) {
        // session 未建成: 若有预建 worktree 则回收(同 maker-ipc/register.ts
        // 的 shouldRecycleHandoffWorktreeOnFailure 判据), 防孤儿泄漏
        if (req.isNew && worktreeStore.get(req.sessionId)) {
          void WorktreeManager.removeWorktreeForSession(req.sessionId).catch(() => undefined);
        }
        return fail(err instanceof Error ? err.message : String(err));
      }

      // 运行时来源注入(路由层经 session-provider-store 决定上游与钥匙):
      // 新建显式 set(与 scheduler 4.4.2 的显式 providerId 分支同款); 复用走
      // hydrate —— 仅内存无条目时写入, 不覆盖运行中会话刚在聊天里切的更新值。
      if (req.isNew) {
        if (providerId) setSessionProvider(session.id, providerId);
      } else {
        hydrateSessionProvider(session.id, rowProviderId);
      }

      // renderer 可见性: 不 wire 则消息不落库、UI 空白(scheduler Phase 6 老坑)
      wireSessionToIpc(session);

      // 交互卡链路: 覆盖 wireSessionToIpc 装上的桌面版 interaction listener。
      // hook 是无人值守 turn, 交互必须走来源渠道卡片 + 有界超时 —— 旧行为里
      // 模型调 AskUserQuestion 会把请求发给桌面 renderer 无限死等, 直到
      // 60min 整 turn 硬超时才以 error 收口。turn 结束后归还桌面版 listener
      // (用户在桌面端继续用该会话时交互仍走桌面弹窗)。
      const ownInteractionIds = new Set<string>();
      const hookInteractionsInstalled = req.onInteraction !== undefined;
      const headlessTurn = {
        closed: false,
        release: null as (() => void) | null,
      };
      const markHeadlessTurnDispatched = (): void => {
        // A failed/cancelled send may still report a late accept. Never
        // acquire a marker after the hook run has already finalized.
        if (headlessTurn.closed || headlessTurn.release) return;
        headlessTurn.release = beginHeadlessGhostSetupTurn(session.id);
      };
      if (req.onInteraction) {
        const sendCard = req.onInteraction;
        const sendCancel = req.onInteractionCancel;
        session.setInteractionListener(async (ireq) => {
          // permission 与问答/计划卡同走 compose -> Slack 卡 -> 决策回流:
          // 非 bypass 会话(用户在 Slack 显式选了收紧档)的权限请求出三按钮卡,
          // 超时/收口安全默认拒绝(compose 的 defaultDecision)
          const composed = composeInteractionCard(ireq);
          if (!composed) {
            // 空问题等不可渲染的请求: 按 kind 安全默认就地自决
            if (ireq.kind === 'plan_review') {
              return {
                kind: 'plan_review',
                behavior: 'deny',
                reason: 'not_renderable',
                dismissed: true,
              };
            }
            if (ireq.kind === 'permission') {
              // 纯防御: compose 对 permission 恒出卡, 走到这里说明未来有人改了
              // compose —— 用户选了收紧档, 安全默认只能是拒绝
              return { kind: 'permission', behavior: 'deny', reason: 'not_renderable' };
            }
            return { kind: 'ask_user_question', answers: {} };
          }
          ownInteractionIds.add(ireq.requestId);
          sendCard({ interactionId: ireq.requestId, ...composed.card });
          const decision = await registerHookInteraction({
            interactionId: ireq.requestId,
            composed,
            onFallback: (reason) => sendCancel?.(ireq.requestId, reason),
          });
          ownInteractionIds.delete(ireq.requestId);
          return decision;
        });
      }
      /** turn 收口清扫: 未决交互按默认自决 + 归还桌面版 listener。幂等。 */
      const finalizeInteractions = (): void => {
        headlessTurn.closed = true;
        headlessTurn.release?.();
        headlessTurn.release = null;
        if (!hookInteractionsInstalled) return;
        for (const iid of [...ownInteractionIds]) {
          cancelHookInteraction(iid, '任务已结束, 此交互已失效');
        }
        ownInteractionIds.clear();
        installDesktopInteractionListener(session);
      };
      // 新建会话广播 -> 侧边栏实时出现(复用/接管的会话本来就在列表里, 不用发)
      if (req.isNew) {
        // hook 会话由用户消息(Slack / Telegram DM、群组或 topic)触发创建,
        // 与 IM 同语义(53b999601):
        // 广播前先落 userSendAt, 否则 renderer 重拉到 userSendAt=null && 0 消息的行
        // 会被 projectGrouping 草稿规则误判进「未分类」, 且之后没有事件再触发重归组。
        // 失败不阻断(onAccepted 还会 bump 一次兜底)。
        await touchUserSendInDb(session.id).catch((err) => {
          log.warn(
            `hook touchUserSend failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
        // 来源落库也在广播前: DesktopSessionStorage.create 不写 provider_id,
        // 不补的话 renderer 重拉 / 冷 resume 的 hydrate funnel 读到的来源恒空
        // (issue #854)。失败仅 warn(helper 内部吞错), 运行时路由不受影响。
        if (providerId) {
          await setSessionProviderIdInDb(session.id, providerId);
        }
        if (req.source?.im === 'telegram') {
          await setSessionSourceInDb(session.id, 'telegram');
        }
        broadcastSessionCreated(session.id);
      }
      // worktree 场景补写 sessions.worktree_path(同 send_to_session 做法):
      // prepareHandoffWorktree 时 session 行不存在, worktreeStore.set 的 DB
      // 同步落空; session 行建好后补一次, 失败非致命(store 是 source of truth)。
      if (req.isNew) {
        const wtMeta = worktreeStore.get(session.id);
        if (wtMeta) {
          void setWorktreePathInDb(session.id, wtMeta.path);
        }
      }

      // turn 收口监听 —— 语义与 scheduler runner 第 5 步同源:
      // text isFinal 替换 / delta 追加; done 时若有在途后台任务则延迟定格,
      // 事件静默超时兜底; terminal error 即失败。
      let assistantText = '';
      // tool_result 旁路收集的出站图片 absPath(收口时随 turn.end 附件外发)
      const extraImageAbsPaths: string[] = [];
      // 进度快照(turn.progress 链路): 过程区时间线与 IM 流式卡同一套纯逻辑
      // (turnActivity), 合成规则同 composeStreamingView —— 有正文时过程区在
      // 上正文在下, done/error 后 stop, 不再发射。
      const activity = createTurnActivity(Date.now());
      const isTelegram = req.source?.im === 'telegram';
      const progress = req.onProgress
        ? createProgressEmitter(req.onProgress, () => {
            // Telegram Rich Message drafts are the partial final answer, not
            // an editable process card. turnActivity can reorder/fold as
            // thinking and tool events arrive, which makes Telegram animate
            // repeated full clears. Keep Slack's established process card,
            // while Telegram streams only the monotonically growing answer.
            if (isTelegram) return assistantText;
            const act = renderActivity(activity, Date.now());
            if (!act) return assistantText;
            return assistantText ? `${act}\n\n${assistantText}` : act;
          })
        : null;
      let stopListening: (() => void) | undefined;
      const turnFinished = new Promise<void>((resolve, reject) => {
        const runningBgTasks = new Set<string>();
        let waitingForBgTasks = false;
        let bgFallbackTimer: NodeJS.Timeout | undefined;
        let pendingSettleUnsub: (() => void) | undefined;
        const clearBgTimer = (): void => {
          if (bgFallbackTimer) {
            clearTimeout(bgFallbackTimer);
            bgFallbackTimer = undefined;
          }
        };
        const finish = (): void => {
          clearBgTimer();
          pendingSettleUnsub?.();
          pendingSettleUnsub = undefined;
          progress?.stop();
          off();
          stopListening = undefined;
          resolve();
        };
        const armBgTimer = (): void => {
          clearBgTimer();
          bgFallbackTimer = setTimeout(() => {
            log.warn(`[hook-runner] bg task events silent, finalizing: ${session.id}`);
            finish();
          }, BG_TASK_IDLE_FALLBACK_MS);
          bgFallbackTimer.unref?.();
        };
        const off = session.onEvent((ev: AgentEvent) => {
          if (waitingForBgTasks) armBgTimer();
          if (ev.type === 'agent_task_update') {
            const data = ev.data as { taskId?: string; status?: string } | null;
            if (data && typeof data.taskId === 'string') {
              if (data.status === 'running') runningBgTasks.add(data.taskId);
              else runningBgTasks.delete(data.taskId);
            }
            return;
          }
          if (ev.type === 'text') {
            const data = ev.data as { text?: string; isFinal?: boolean } | null;
            if (data && typeof data.text === 'string') {
              if (data.isFinal) assistantText = data.text;
              else assistantText += data.text;
              markActivityWriting(activity);
              progress?.schedule();
            }
            return;
          }
          if (ev.type === 'thinking') {
            if (pushThinkingStep(activity, ev.data)) {
              progress?.ensureTicker();
              progress?.schedule();
            }
            return;
          }
          if (ev.type === 'tool_use') {
            // 过程展示: 与 IM 流式卡同款滚动时间线(turnActivity), 让 Slack 侧
            // 在长 agentic turn 里看到"正在干什么", 而不是盯着 👀 表情干等
            const data = ev.data as {
              toolName?: unknown;
              toolUseId?: unknown;
              input?: unknown;
            } | null;
            if (data && typeof data.toolName === 'string') {
              pushToolStep(
                activity,
                data.toolName,
                data.input,
                typeof data.toolUseId === 'string' ? data.toolUseId : undefined,
              );
              progress?.ensureTicker();
              progress?.schedule();
            }
            return;
          }
          if (ev.type === 'tool_result_full') {
            // 出站图片旁路(与 IM handleToolResultFullEvent 同语义): art
            // image_generate 等工具按设计不在文本里嵌 xdt-image markdown,
            // Slack 侧能拿到图的唯一通路是从 tool_result JSON 里接走 URL
            const data = ev.data as { fullText?: unknown } | null;
            if (data && typeof data.fullText === 'string') {
              for (const url of extractToolResultImageUrls(data.fullText)) {
                try {
                  const { absPath } = resolveRenderableImageUrl(url);
                  extraImageAbsPaths.push(absPath);
                } catch (err) {
                  log.warn(
                    `hook resolve tool_result image failed: ${err instanceof Error ? err.message : String(err)}`,
                  );
                }
              }
            }
            return;
          }
          if (ev.type === 'done') {
            if ((ev.data as { silentStop?: boolean } | null | undefined)?.silentStop === true) {
              pendingSettleUnsub?.();
              pendingSettleUnsub = onSilentStopSettled(session.id, (_sid, reason) => {
                pendingSettleUnsub?.();
                pendingSettleUnsub = undefined;
                if (reason === 'exhausted') {
                  clearBgTimer();
                  progress?.stop();
                  off();
                  stopListening = undefined;
                  reject(new Error('silent-stop auto-resume exhausted'));
                } else {
                  finish();
                }
              });
              return;
            }
            if (runningBgTasks.size > 0) {
              waitingForBgTasks = true;
              armBgTimer();
              return;
            }
            finish();
          } else if (isTerminalAgentErrorEvent(ev)) {
            clearBgTimer();
            progress?.stop();
            off();
            stopListening = undefined;
            const data = ev.data as { message?: string } | null;
            reject(new Error(data?.message ?? 'agent terminal error'));
          }
        });
        stopListening = (): void => {
          clearBgTimer();
          pendingSettleUnsub?.();
          pendingSettleUnsub = undefined;
          progress?.stop();
          off();
        };
      });
      void turnFinished.catch(() => undefined);

      // origin 标注见文件头注释(闭合联合下的 v1 取舍)。scheduleId 用稳定的
      // hook 连接标识 —— renderer/IM 只拿它做展示与分组, 不回查 schedule 表。
      const origin = {
        kind: 'scheduler',
        scheduleId: `hook:${req.origin.connectionId}`,
        scheduleName: `Hook · ${req.origin.connectionName}`,
      } as const;

      // 入站附件: 解码后图片/文件分流(server 2026-07 起全 MIME 转发) ->
      //   - 图片写入 cindy-media 媒体总仓(规则 25;不再通过 imageCacheStore
      //     切换): sendContent 用本地绝对 path 的 image block(maker 要 path
      //     而非 base64 / URL), 落库用 cindy-media:// URL(parseUserContent 只认
      //     {text,images:ImageRef[]} 形态, 裸 path 的 image block 会被忽略);
      //   - 其它受支持媒体(视频/音频/模型)同样写 cindy-media；agent 仍拿
      //     blob 的绝对路径，消息持久化只保存 cindy-media:// 地址；
      //   - 真正的非媒体文件写 hook 附件目录(userData/hook-attachments/<sessionId>/,
      //     文件名消毒 + 随机前缀防碰撞): sendContent 用 file block(cc/codex
      //     adapter 原生支持, 能否消费交给 agent), 落库 files:[{name,path}]
      //     让聊天记录渲染文件 chip。删会话时 sessions.ts 随 removeSessionRefs
      //     一起 rm -rf 该 sessionId 子目录。
      // 入站图没有草稿期,ingest 时直接挂 session-attachment 引用(等价老
      // lifecycle committed),删会话时随 removeSessionRefs 回收。
      const decoded =
        req.attachments && req.attachments.length > 0
          ? decodeAttachments(req.attachments, log)
          : { images: [], files: [], skipped: 0 };
      let inboundAttachmentFailures = decoded.skipped;
      const imageBlocks: UserContentBlock[] = [];
      const imageRefs: Array<{ url: string; mimeType: string; originalName: string }> = [];
      for (const img of decoded.images) {
        try {
          const { url } = await ingestMedia({
            buffer: img.bytes,
            mimeType: img.mimeType,
            refs: [
              {
                refKind: 'session-attachment',
                refId: session.id,
                originSessionId: session.id,
                originKind: 'user',
              },
            ],
          });
          const { absPath } = resolveCindyMediaUrl(url);
          imageBlocks.push({ type: 'image', path: absPath, mimeType: img.mimeType });
          imageRefs.push({
            url,
            mimeType: img.mimeType,
            originalName: sanitizeAttachmentName(img.name ?? 'image'),
          });
        } catch (err) {
          inboundAttachmentFailures += 1;
          log.warn(`hook image ingest failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      const fileBlocks: UserContentBlock[] = [];
      const fileRefs: Array<{ name: string; path: string; mimeType?: string }> = [];
      const plainFiles: typeof decoded.files = [];
      for (const file of decoded.files) {
        const mimeType = file.mimeType.trim().toLowerCase().split(';', 1)[0] ?? '';
        if (!isCindyMediaMime(mimeType)) {
          if (/^(?:image|audio|video|model)\//.test(mimeType)) {
            // Recognizable media may only be persisted through cindy-media.
            // Unsupported formats must fail explicitly, never fall through to
            // the feature-specific plain-file attachment directory.
            inboundAttachmentFailures += 1;
            log.warn(`hook media attachment skipped (unsupported cindy-media MIME ${mimeType})`);
          } else {
            plainFiles.push(file);
          }
          continue;
        }
        try {
          const { url } = await ingestMedia({
            buffer: file.bytes,
            mimeType,
            refs: [
              {
                refKind: 'session-attachment',
                refId: session.id,
                originSessionId: session.id,
                originKind: 'user',
              },
            ],
          });
          const { absPath } = resolveCindyMediaUrl(url);
          fileBlocks.push({ type: 'file', path: absPath, mimeType });
          const safeName = sanitizeAttachmentName(file.name);
          fileRefs.push({ name: safeName, path: url, mimeType });
        } catch (err) {
          inboundAttachmentFailures += 1;
          // Media must never fall back to a feature-specific cache (rule 25).
          log.warn(`hook media ingest failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (plainFiles.length > 0) {
        const attachRoot = path.join(app.getPath('userData'), 'hook-attachments');
        const attachDir = path.join(attachRoot, session.id);
        if (!attachDir.startsWith(attachRoot + path.sep)) {
          inboundAttachmentFailures += plainFiles.length;
          log.warn(
            `hook attachment dir escapes root (sessionId=${session.id}), skipping file attachments`,
          );
        } else
          try {
            await fs.mkdir(attachDir, { recursive: true });
            for (const file of plainFiles) {
              const safeName = sanitizeAttachmentName(file.name);
              const absPath = path.join(attachDir, `${randomUUID().slice(0, 8)}-${safeName}`);
              try {
                await fs.writeFile(absPath, file.bytes);
                fileBlocks.push({ type: 'file', path: absPath, mimeType: file.mimeType });
                fileRefs.push({ name: safeName, path: absPath, mimeType: file.mimeType });
              } catch (err) {
                inboundAttachmentFailures += 1;
                log.warn(
                  `hook file attachment write failed (${safeName}): ${err instanceof Error ? err.message : String(err)}`,
                );
              }
            }
          } catch (err) {
            inboundAttachmentFailures += plainFiles.length;
            log.warn(
              `hook attachment dir create failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
      }
      // 渠道说明只进喂给 agent 的内容,不进落库的 userMessageContent ——
      // 渲染层展示的用户消息保持来源 IM 原话。逐 turn 追加固定文本,教模型
      // 用 xdt-file 引用回传文件而非误用 cindy_feishu_bot(规则 9,实踩背景
      // 见 outbound.ts 的常量注释)。
      const promptWithNote = `${req.prompt}\n\n${buildHookPromptNote(req.source?.im)}`;
      const sendContent =
        imageBlocks.length > 0 || fileBlocks.length > 0
          ? [{ type: 'text' as const, text: promptWithNote }, ...imageBlocks, ...fileBlocks]
          : promptWithNote;
      // 落库形态: 有附件用 {text, images, files} 对象(createMessage safeStringify
      // 存 JSON, 读回 parseUserContent 提取 images/files); 无附件纯文本 string。
      const userMessageContent =
        imageRefs.length > 0 || fileRefs.length > 0
          ? { text: req.prompt, images: imageRefs, files: fileRefs }
          : req.prompt;

      try {
        const pendingHandoff = await agentHandoffPending.peek(session.id);
        const outgoingMessage: UserMessage = pendingHandoff
          ? (prependHandoffToUserMessage(
              { type: 'user', content: sendContent },
              pendingHandoff,
            ) as UserMessage)
          : { type: 'user', content: sendContent };
        const sendResult = await session.send(outgoingMessage, {
          origin,
          planMode: false,
          onAccepted: async () => {
            // Admission may wait behind a user-driven Desktop turn. Only this
            // accepted hook turn is headless; preparation and queue wait are
            // still part of the unrelated interactive turn.
            markHeadlessTurnDispatched();
            // send 被接受才落 user 消息(与 scheduler 同序: 不让 agent 在
            // "消息没存下"的情况下空跑); 失败即整体失败
            // agentMeta 形状受 CcMeta 约束, 只放 origin(scheduleId 已携带
            // hook 连接标识); lane key 含 IM 用户/聊天标识，不写日志
            // content 落 {text, images} 形态: 有图时 images 为 xdt-image:// URL
            // (桌面端聊天记录据此渲染出图片; parseUserContent 只认这种形态,
            // 裸 path 的 image block 会被忽略), 无图为纯文本 string。
            noteSilentStopUserSend(session.id);
            await createMessage(session.id, {
              clientId: randomUUID(),
              role: 'user',
              content: userMessageContent,
              agentMeta: { origin, ...(req.source ? { hookSource: req.source } : {}) },
            });
            // 每次被接受的 IM 消息都是一次用户发送: bump userSendAt 让排序
            // 时间轴与桌面端 sendMessage 口径一致, sessions:patched 广播顺带把
            // 复用/接管会话即时重排序(新建路径已在广播前落过, 这里更新为实际
            // 发送时刻)。失败不影响 turn 本身。
            void touchUserSendInDb(session.id).catch(() => undefined);
          },
        });
        if (pendingHandoff && sendResult.accepted) {
          agentHandoffPending.consume(session.id);
        }
        const outcome = toDesktopSessionDispatchOutcome(sendResult, {
          source: 'hook-dispatcher',
          context: `hook:${req.origin.connectionId}`,
        });
        if (!outcome.dispatched) {
          stopListening?.();
          finalizeInteractions();
          return fail(`send not dispatched: ${outcome.reason}`);
        }
      } catch (err) {
        stopListening?.();
        finalizeInteractions();
        return fail(err instanceof Error ? err.message : String(err));
      }

      // 硬超时兜底(见常量注释); 超时后摘监听, 迟到的 done 不再有消费方
      let hardTimer: NodeJS.Timeout | undefined;
      const hardTimeout = new Promise<never>((_, rejectTimeout) => {
        hardTimer = setTimeout(
          () => rejectTimeout(new Error(`hook turn hard timeout (${TURN_HARD_TIMEOUT_MS}ms)`)),
          TURN_HARD_TIMEOUT_MS,
        );
        hardTimer.unref?.();
      });
      try {
        await Promise.race([turnFinished, hardTimeout]);
      } catch (err) {
        stopListening?.();
        return fail(err instanceof Error ? err.message : String(err));
      } finally {
        if (hardTimer) clearTimeout(hardTimer);
        // 无论正常收口还是超时/错误, 未决交互都按默认收口并归还桌面 listener
        finalizeInteractions();
      }

      // 已知 v1 取舍: 不做 scheduler 4.5.1 的完整 backfillSessionMeta。
      // provider_id 仍按建会话结果补写；Telegram 另补 source，让桌面/移动端
      // 能稳定展示渠道来源，既有 Slack source 兼容行为保持不变。
      // 出站附件: 文本引用 / 旁路图存在时才收集(读盘 + base64 只在需要时
      // 发生); 收集失败不拖垮收口 —— 附件是回帖增强, 文本永远要发出去
      let finalText = assistantText;
      let outAttachments: HookRunOutcome['attachments'];
      if (hasOutboundRefs(assistantText) || extraImageAbsPaths.length > 0) {
        try {
          const collected = await collectOutboundAttachments(assistantText, extraImageAbsPaths, {
            resolveImageUrl: resolveRenderableImageUrl,
            allowedFileRoots: [workingDir],
            log,
          });
          finalText = collected.text;
          if (collected.attachments.length > 0) outAttachments = collected.attachments;
          if (collected.skipped > 0) {
            log.warn(`hook outbound attachments: ${collected.skipped} skipped (size/read limits)`);
          }
        } catch (err) {
          log.warn(
            `hook outbound attachment collection failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      if (inboundAttachmentFailures > 0) {
        const warning =
          `⚠️ Incoming attachment processing incomplete: ${inboundAttachmentFailures} ` +
          `item${inboundAttachmentFailures === 1 ? '' : 's'} could not be prepared.`;
        finalText = `${finalText.trimEnd()}${finalText.trim().length > 0 ? '\n\n' : ''}${warning}`;
      }
      return {
        status: 'ok',
        finalText,
        errorMessage: null,
        durationMs: Date.now() - startedAt,
        ...(outAttachments !== undefined ? { attachments: outAttachments } : {}),
      };
    },
  };
}
