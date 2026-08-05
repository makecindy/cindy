/**
 * hook-control/session-runner.ts
 * ---------------------------------------------------------------------------
 * HookSessionRunner 的生产实现 —— 包 maker 跑 headless turn。实现模式与
 * scheduler-host/runner.ts 的 fire 路径同源(那是 headless 跑 session 的
 * 已验证先例), 取其最小子集:
 *
 *   createSession(复用按 meta 取 resumeSessionId/workDir/model) ->
 *   wireSessionToIpc(renderer 可见, 消息落库链路不缺) ->
 *   observeHookTurn 监听(text 累积 + done 收口, 含后台 subagent 在途时的
 *   延迟定格与静默兜底; 实现抽在 turnObserver.ts, 与 watchContinuation 共用)
 *   -> session.send(onAccepted 落 user 消息)。
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

import type {
  AgentKind,
  PermissionMode,
  UserContentBlock,
  UserMessage,
} from '@cindy/maker-core';
import {
  effectiveSourceIdForModel,
  type ProviderView,
  visibleModelUnion,
} from '@cindy/model-providers';

import { tapWindowBroadcast } from '../device-link/broadcast-tap.js';
import { getMaker } from '../maker-host/index.js';
import { resolveLenientRoute } from '../maker-host/model-route-guard.js';
import { resolveLenientSessionRoute } from '../maker-host/model-route-guard-live.js';
import {
  wireSessionToIpc,
  isSessionInTurn,
  noteSilentStopUserSend,
  onSilentStopSettled,
} from '../maker-ipc/register.js';
import {
  beginInteractionRoute,
  type InteractionHandler,
  type InteractionRouteLease,
  type TurnOrigin as RoutedTurnOrigin,
} from '../maker-ipc/interactionRouter.js';
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
import { getWorkspaceProviderSource } from './workspaceProviderSourceStore.js';
import { getDesktopProviderService } from '../maker-host/createDesktopProviderService.js';
import { beginHeadlessGhostSetupTurn } from '../mcp-integrations/ghostSetupInteractionSurface.js';
import { observeHookTurn } from './turnObserver.js';

import type {
  HookContinuationWatchRequest,
  HookRunOutcome,
  HookSessionRunner,
} from './dispatcher.js';
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
  workspaceCtx?: { alias: string | undefined; teamId: string | null },
): Promise<ResolvedHookSessionConfig> {
  let providers: ProviderView[] | null = null;
  try {
    providers = await getDesktopProviderService().listProviders({ allowSideEffects: true });
  } catch (err) {
    log.warn(
      `hook provider catalog unavailable; falling back to maker capabilities: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const resolved = resolveHookSessionConfig(
    {
      readDefaults: () => readImDefaultSettings(sourceIm === 'slack' ? 'slack' : undefined),
      // 可执行清单按**启用**口径,不叠加「显示 / 隐藏」偏好:隐藏只是陈列过滤
      // (选择器不列),被 IM 显式点名或兜底选中仍然合法;停用的模型与供应商已由
      // visibleModelUnion 内建的准入过滤(model.disabled / suspended)剔除,点名
      // 会走 defaults.ts 的降级 + warn 路径(2026-07 启用/显示双轴拆分)。
      getModels: (agentKind) =>
        providers
          ? visibleModelUnion(providers, agentKind, () => true)
          : getMaker().getCapabilities(agentKind).availableModels,
      getPermissionModes: (agentKind) =>
        getMaker()
          .getCapabilities(agentKind)
          .permissionModes.map((pm) => pm.id),
      log,
    },
    overrides,
  );

  // 目录级来源偏好(纯本地, 用户在工作目录映射行显式选的来源)优先于草稿默认来源。
  const channel =
    sourceIm === 'telegram'
      ? ('telegram' as const)
      : sourceIm === 'slack'
        ? ('slack' as const)
        : null;
  const workdirProviderId =
    channel !== null && workspaceCtx?.alias
      ? getWorkspaceProviderSource(channel, workspaceCtx.teamId, workspaceCtx.alias)
      : null;
  const preferredProviderId = workdirProviderId ?? resolved.providerId;

  // 目录可用时始终把最终模型收敛到一个真实已连接、且确实提供它的来源。
  // 目录读取失败才保留旧行为(**只**透传草稿来源, 不透传目录级来源 —— 后者未经
  // 收窄校验, 降级窗口直接钉给会话会绕过连接态/供给校验; 数据不足不猜, 维持
  // 加目录来源之前的降级语义, codex review)。
  const providerId = providers
    ? effectiveSourceIdForModel(providers, preferredProviderId, resolved.model, resolved.agentKind)
    : resolved.providerId;
  // 停用收口(PR #744 review 第十、十四轮):两条路径都必须经宽松降级裁决 ——
  //   · 目录读取失败:冻结的 availableModels 不带停用标志、saved provider 未经校验,
  //     live 壳的目录故障分支 = override-only 保守裁决(只凭本地 override 文件判);
  //   · 目录读取成功但该 agent 的启用模型集为空:上方 getModels 过滤后
  //     resolveHookSessionConfig 会回退到 raw saved desktop model(未准入),
  //     effectiveSourceIdForModel 解析为 null 后若直接返回,后续 createSession 仍以
  //     停用模型 + 隐式来源直建付费会话。
  // 命中即逐级丢弃;模型判死抛错交给 hook 既有失败路径。
  const lenient = providers
    ? resolveLenientRoute(providers, resolved.agentKind, resolved.model, providerId ?? null)
    : await resolveLenientSessionRoute(resolved.agentKind, resolved.model, providerId ?? null);
  if (!lenient.model) {
    throw new Error('hook session route unavailable: model disabled in settings');
  }
  if (lenient.degraded) {
    log.warn(
      `hook saved route degraded (disabled in settings): model=${resolved.model} providerId=${providerId ?? 'null'} catalog=${providers ? 'ok' : 'outage'}`,
    );
  }
  return { ...resolved, model: lenient.model, providerId: lenient.providerId };
}

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
 * tool_result 全文里的出站图片旁路(run() 与 watchContinuation 共用)。
 *
 * art image_generate 等工具按设计不在文本里嵌 xdt-image markdown, 渠道侧能拿到
 * 图的唯一通路是从 tool_result JSON 里接走 URL。解析失败只 warn, 不拖垮 turn。
 */
function collectOutboundImages(
  fullText: string,
  sink: string[],
  log: { warn(msg: string): void },
): void {
  for (const url of extractToolResultImageUrls(fullText)) {
    try {
      const { absPath } = resolveRenderableImageUrl(url);
      sink.push(absPath);
    } catch (err) {
      log.warn(
        `hook resolve tool_result image failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/**
 * 收口时的出站附件收集(run() 与 watchContinuation 共用)。
 *
 * 文本引用 / 旁路图都不存在时不读盘 —— base64 编码只在真需要时发生; 收集失败不
 * 拖垮收口, 附件是回帖增强, 文本永远要发出去。
 */
async function collectOutboundForFinalText(
  assistantText: string,
  extraImageAbsPaths: string[],
  allowedFileRoots: string[],
  log: { warn(msg: string): void },
): Promise<{ finalText: string; attachments?: HookRunOutcome['attachments'] }> {
  if (!hasOutboundRefs(assistantText) && extraImageAbsPaths.length === 0) {
    return { finalText: assistantText };
  }
  try {
    const collected = await collectOutboundAttachments(assistantText, extraImageAbsPaths, {
      resolveImageUrl: resolveRenderableImageUrl,
      allowedFileRoots,
      log,
    });
    if (collected.skipped > 0) {
      log.warn(`hook outbound attachments: ${collected.skipped} skipped (size/read limits)`);
    }
    return {
      finalText: collected.text,
      ...(collected.attachments.length > 0 ? { attachments: collected.attachments } : {}),
    };
  } catch (err) {
    log.warn(
      `hook outbound attachment collection failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { finalText: assistantText };
  }
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
            { alias: req.workspaceAlias, teamId: req.source?.teamId ?? null },
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

      /**
       * 授权判定刻意**只在 dispatcher 侧**做(定位时 + 执行前按当前映射重查),
       * runner 不再参与。曾经尝试过把判定贯穿到这里 —— 比对 meta.workDir、比对
       * live session 的 workDir 并重建、在 send 前回调实时授权 —— 结果是每加一层
       * 都要重新接入锁、代际、会话生命周期、附件与 worktree 清理这些横切关注点,
       * 接不全就是新一轮缺陷(打断桌面会话、清掉在用的临时附件、listener 泄漏)。
       * 那些缺陷比它要防的窗口更严重: 窗口内最多是一条在途消息在"校验它时还合法"
       * 的目录里多跑一轮, 而 agent 的文件边界本就是 allowedFileRoots: [workingDir],
       * 不会越到别处。这个取舍写在 PR #733 的风险段里。
       */

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
      const createOpts: Parameters<ReturnType<typeof getMaker>['createSession']>[0] = {
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
      };
      try {
        session = await maker.createSession(createOpts);
      } catch (err) {
        // session 未建成: 若有预建 worktree 则回收(同 maker-ipc/register.ts
        // 的 shouldRecycleHandoffWorktreeOnFailure 判据), 防孤儿泄漏
        if (req.isNew && worktreeStore.get(req.sessionId)) {
          void WorktreeManager.removeWorktreeForSession(req.sessionId).catch(() => undefined);
        }
        return fail(err instanceof Error ? err.message : String(err));
      }

      /**
       * 拿到的可能是**进程里早就活着的那个实例**: maker.createSession 对已在
       * activeSessions 里的 id 直接返回它, 忽略上面传的 workingDir。侧边栏
       * "移动到项目"只改库里的行, 那个实例的 workDir 仍是它创建时的目录 ——
       * 于是 dispatcher 按库里的新目录过了映射校验, 真正执行却在旧目录。
       *
       * 这不是"校验到执行之间的窗口"(那条已在 PR #733 的风险段里声明接受),
       * 而是**持久错配**: 实例不换, 每次重试都一样, 直到会话自然关闭。所以这里
       * 必须拦 —— 判据是"真正要跑的这个目录此刻还在映射内吗", 由 dispatcher 注入
       * (它才查得到映射)。
       *
       * 刻意只判、不重建: 关掉再建会打断可能正用着它的桌面会话、触发 onClose 的
       * 附件与 worktree 清理, 前几轮实测这些后果比问题本身更重(PR #733 review)。
       * 目录仍在映射内的合法移动(A→B 都在映射里)不受影响: 那时判定通过, 这一轮
       * 继续在 A 跑, 与本 PR 之前的行为一致。
       *
       * **只对复用/接管路径生效**: 新会话的 id 是刚生成的, activeSessions 里不
       * 可能有, createSession 一定按传入的 workingDir 新建 —— 错配根本不存在。
       * 反倒是在这里拦下新会话会留垃圾: 那时 agent 已启动、session 行已插入、
       * 预建的 worktree 还注册着(回收只在 createSession 抛错时跑), 于是留下一个
       * 空会话 + 孤儿 worktree, 而渠道那边显示"没有执行"(同一轮 review 指出)。
       * 新建路径那一小段(execute 的映射收口 -> createSession)属于已声明接受的
       * 窗口, 见 PR #733 的风险段。
       */
      if (!req.isNew && req.isDirAuthorized && !req.isDirAuthorized(session.workDir)) {
        log.warn(
          `hook run aborted: live session ${req.sessionId} runs in a directory that is no longer in the workspace map`,
        );
        return fail(
          '这个对话正在一个已不在工作目录映射里的目录中运行，本条消息没有执行。把该目录加进 设置 → 远程连接 → 工作目录映射，或在桌面端关掉这个对话后重发。',
        );
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

      // hook 是无人值守 turn,交互必须走来源渠道卡片 + 有界超时。Session
      // listener 由中央 InteractionRouter 持有;这里只准备本 turn 的 handler,
      // 真正的 route 在 beforeProviderStart 屏障内登记。
      const ownInteractionIds = new Set<string>();
      let interactionRouteLease: InteractionRouteLease | null = null;
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
      const handleHookInteraction: InteractionHandler = async (ireq) => {
        if (req.onInteraction) {
          const sendCard = req.onInteraction;
          const sendCancel = req.onInteractionCancel;
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
        }
        if (ireq.kind === 'ask_user_question') {
          return { kind: 'ask_user_question', answers: {} };
        }
        if (ireq.kind === 'plan_review') {
          return {
            kind: 'plan_review',
            behavior: 'deny',
            reason: 'headless_interaction_unavailable',
            dismissed: true,
          };
        }
        return {
          kind: 'permission',
          behavior: 'deny',
          reason: 'headless_interaction_unavailable',
        };
      };
      /** turn 收口清扫: 未决交互按默认自决 + 释放中央 route。幂等。 */
      const finalizeInteractions = (): void => {
        headlessTurn.closed = true;
        headlessTurn.release?.();
        headlessTurn.release = null;
        interactionRouteLease?.release('hook_turn_terminal');
        interactionRouteLease = null;
        for (const iid of [...ownInteractionIds]) {
          cancelHookInteraction(iid, '任务已结束, 此交互已失效');
        }
        ownInteractionIds.clear();
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

      // turn 收口监听 —— 语义抽在 turnObserver.ts, 与 watchContinuation 共用
      // 同一份实现(后台任务延迟定格、silent-stop 守卫、非终态 error 的重试
      // 提示、isFinal 的文本累积形态), 刻意不复制第二份: 这些细节改一处漏一处
      // 就会让"续跑接回渠道"那条路径静默落后于本路径。
      // tool_result 旁路收集的出站图片 absPath(收口时随 turn.end 附件外发)
      const extraImageAbsPaths: string[] = [];
      const observer = observeHookTurn(session, {
        // Telegram DM 只流正文(Rich draft 是"部分终稿"动画, 过程区重排会整段
        // 清空重播); 群/topic 与 Slack 同款完整过程卡。
        answerOnlyProgress: req.source?.im === 'telegram' && req.laneKind !== 'group',
        ...(req.onProgress ? { onProgress: req.onProgress } : {}),
        onToolResult: (fullText) => collectOutboundImages(fullText, extraImageAbsPaths, log),
        onSilentStopSettled,
        log,
      });

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
          beforeProviderStart: () => {
            const routeOrigin: RoutedTurnOrigin =
              req.source?.im === 'slack'
                ? { kind: 'im', channel: 'slack' }
                : { kind: 'hook', source: req.source?.im ?? 'unknown' };
            interactionRouteLease = beginInteractionRoute(session, {
              route: {
                sessionId: session.id,
                turnId: randomUUID(),
                origin: routeOrigin,
                interactionSurface: req.onInteraction ? 'channel-card' : 'headless',
              },
              handle: handleHookInteraction,
              onCancel: (requestId) => {
                ownInteractionIds.delete(requestId);
                return cancelHookInteraction(requestId, '任务已结束, 此交互已失效');
              },
            });
          },
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
          observer.stop();
          finalizeInteractions();
          return fail(`send not dispatched: ${outcome.reason}`);
        }
      } catch (err) {
        observer.stop();
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
        await Promise.race([observer.finished, hardTimeout]);
      } catch (err) {
        observer.stop();
        return fail(err instanceof Error ? err.message : String(err));
      } finally {
        if (hardTimer) clearTimeout(hardTimer);
        // 无论正常收口还是超时/错误,未决交互都按默认收口并释放中央 route
        finalizeInteractions();
      }

      // 已知 v1 取舍: 不做 scheduler 4.5.1 的完整 backfillSessionMeta。
      // provider_id 仍按建会话结果补写；Telegram 另补 source，让桌面/移动端
      // 能稳定展示渠道来源，既有 Slack source 兼容行为保持不变。
      // 出站附件: 文本引用 / 旁路图存在时才收集(读盘 + base64 只在需要时
      // 发生); 收集失败不拖垮收口 —— 附件是回帖增强, 文本永远要发出去
      const collected = await collectOutboundForFinalText(
        observer.text(),
        extraImageAbsPaths,
        [workingDir],
        log,
      );
      let finalText = collected.finalText;
      const outAttachments = collected.attachments;
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

    watchContinuation(req) {
      // 归属已由 dispatcher 用 clientId 确认(见 uiContinuationSignal), 且本调用发生在
      // vendor dispatch **之前** —— live session 必然已就绪, 不需要等它出现, 也不需要
      // 靠"首个事件"猜这一轮是不是目标轮。
      const session = getMaker().getSession(req.sessionId);
      if (!session) {
        // 理论上不该发生(马上就要 dispatch)。保守放弃, 让 dispatcher 把记账还回去。
        log.warn(`hook continuation: live session vanished right before dispatch (${req.sessionId})`);
        req.onAbandon();
        return () => undefined;
      }
      return beginContinuationWatch(session, req, log);
    },
  };
}

/**
 * 挂上一次续跑观察(live session 已确定存在)。
 *
 * 与 run() 共用 observeHookTurn, 所以收口语义、文本累积形态、过程区渲染判据都只有
 * 一份实现(见 turnObserver.ts)。
 */
function beginContinuationWatch(
  session: NonNullable<ReturnType<ReturnType<typeof getMaker>['getSession']>>,
  req: HookContinuationWatchRequest,
  log: { info(msg: string): void; warn(msg: string): void },
): () => void {
  // live 实例可能仍跑在搬迁前的旧目录里(与 run() 的同名校验同理, 见 PR #733)。
  // 记账里存的是失败那一轮的持久化目录, 只查它会让"旧目录已被移出映射、新目录仍在"
  // 的会话放行 —— 那样续跑的输出与文件会从一个已撤销的目录回流到渠道。
  if (req.isDirAuthorized && !req.isDirAuthorized(session.workDir)) {
    log.info(
      `hook continuation skipped: the live session runs in a directory that is no longer in the workspace map (${session.id})`,
    );
    req.onAbandon();
    return () => undefined;
  }
    const startedAt = Date.now();
    const extraImageAbsPaths: string[] = [];
    let claimed = false;
    let settled = false;
    let hardTimer: NodeJS.Timeout | undefined;

    const clearTimers = (): void => {
      if (hardTimer) clearTimeout(hardTimer);
      hardTimer = undefined;
    };

    const observer = observeHookTurn(session, {
      // 与 run() 同一判据: Telegram DM 只流正文, 群/topic 走完整过程卡。
      answerOnlyProgress: req.source?.im === 'telegram' && req.laneKind !== 'group',
      onProgress: (text) => {
        // 认领之前不发进度: 那时 server 还没把这条消息挂到新 requestId 上。
        if (claimed) req.onProgress(text);
      },
      onToolResult: (fullText) => collectOutboundImages(fullText, extraImageAbsPaths, log),
      onSilentStopSettled,
      log,
    });

    // **立刻认领**: 归属已由 clientId 确认, 且 dispatch 即将不可逆 —— 不需要再等首个
    // 事件来判断"这一轮到底是不是目标轮"。早先那套(等首个事件)恰恰是误认的来源:
    // 会话级观察器分不清事件属于哪条用户消息, 绕过 coordinator 的 turn 会顶替进来。
    claimed = true;
    req.onClaim();

    /** 收口一次(幂等)。errorMessage 非空 = 这一轮失败。 */
    const settle = (errorMessage: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimers();
      observer.stop();
      // 已停止观察 —— 成功那一路还要 await 收集出站附件, 所以先同步告知一声, 让
      // dispatcher 把这一轮从"在观察"的账上摘掉(见 onSettling 的说明)。
      req.onSettling?.();
      if (!claimed) {
        // 从没认领过 -> server 侧对这条消息一无所知, 静默退场。
        req.onAbandon();
        return;
      }
      if (errorMessage !== null) {
        // 与 run() 的失败收口同形(finalText 空, 错误交给渠道渲染)。
        req.onEnd({
          status: 'error',
          finalText: '',
          errorMessage,
          durationMs: Date.now() - startedAt,
        });
        return;
      }
      void (async () => {
        // workDir 以 live session 为权威(会话可能被移动过), 与 run() 里
        // isDirAuthorized 用 session.workDir 复核同理。
        const collected = await collectOutboundForFinalText(
          observer.text(),
          extraImageAbsPaths,
          [session.workDir],
          log,
        );
        req.onEnd({
          status: 'ok',
          finalText: collected.finalText,
          errorMessage: null,
          durationMs: Date.now() - startedAt,
          ...(collected.attachments !== undefined ? { attachments: collected.attachments } : {}),
        });
      })();
    };

    // 兜底只有硬超时, 与 run() 完全一致 —— 刻意**不**加更短的"空转"超时: 认领之后
    // 这一轮已经在跑, 而一个正常的长 turn 完全可能几分钟不出事件(或只出被本观察器
    // 忽略的账号级事件), 用短超时去判死会把它误杀成 error 并把那条错误写进渠道。
    hardTimer = setTimeout(
      () => settle(`hook continuation hard timeout (${TURN_HARD_TIMEOUT_MS}ms)`),
      TURN_HARD_TIMEOUT_MS,
    );
    hardTimer.unref?.();
    observer.finished.then(
      () => settle(null),
      (err: unknown) => settle(err instanceof Error ? err.message : String(err)),
    );

    return () => {
      // 撤销: 已认领的必须收口(否则渠道消息停在假的"进行中"), 未认领的静默退场。
      settle(claimed ? 'hook continuation cancelled' : null);
    };
}
