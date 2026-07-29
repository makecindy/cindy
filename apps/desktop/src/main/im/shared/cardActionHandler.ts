/**
 * main/im/shared/cardActionHandler.ts
 * ---------------------------------------------------------------------------
 * Subscribe to ChannelIM.onCardAction and dispatch the press to whatever
 * pending InteractionRequest matches `payload.requestId`. Build the
 * InteractionDecision from the buttonId + payload, then resolve the pending
 * promise so the agent's interaction resolver returns.
 *
 * We also patch the card to show "resolved" so the user can see their choice
 * stuck.
 *
 * 渠道无关(原 im/feishu/cardActionHandler.ts 工厂化): 渠道差异经 adapter 注入。
 * payload 里的 `botAppId` key 语义 = IdentityKey.botContextId(历史 key 名,
 * 兼容已发出的旧卡片, 见 cardBuilders 头注释)。
 */

import type { ChannelIM, IMCardActionEvent } from '@cindy/im';
import {
  createSessionPermissionUpdate,
  hasSessionPermissionUpdates,
  type AgentKind,
  type Effort,
  type InteractionDecision,
  type PermissionMode,
} from '@cindy/maker-core';
import { requiresFullAccessConfirmation } from '@cindy/maker-shared/permission-mode';

import { createLogger } from '../../logger';
import { getMaker } from '../../maker-host';
import { resolveLenientSessionRoute } from '../../maker-host/model-route-guard-live';
import {
  getSessionProvider,
  normalizeSessionProviderId,
  setSessionProvider,
} from '../../maker-host/session-provider-store';
import {
  cancelPendingAgentSwitchForSession,
  clearPendingCredentialSwitchForSession,
  getPendingCredentialSwitchTarget,
  isSessionInTurn,
  registerPendingCredentialSwitchForSession,
  withSendToSessionLock,
  wakeSessionInputAfterCredentialSwitch,
} from '../../maker-ipc/register';
import { applyRuntimeSetModelChange } from '../../maker-ipc/runtimeSetModel';
import { getDesktopCcPrefs, type DesktopCcPrefs } from '../index';
import {
  captureImAccountGeneration,
  isImAccountScopeClosedError,
  runInImAccountGeneration,
} from '../accountBoundary';
import { FBOT_DRAFT_TITLE } from './fbotTitle';
import { resolvePending, lookupPending } from './pendingInteractions';
import {
  listProjectsForControl,
  listSessionsForWorkspace,
  readSessionTitle,
  type ControlProject,
  type ControlSession,
} from './controlProjects';
import { exitControl } from './controlState';
import { startThreadControlFlow } from './controlFlow';
import { bindingStore, executeDetach, type BindingAttachResult } from '../binding';
import { generateTakeoverSummary } from './sessionSummary';
import { broadcastSessionCreated } from './sessionBroadcast';
import type { IdentityKey } from '@cindy/im';
import {
  readModelRouteSnapshot,
  readPermissionMode,
  touchUserSent,
  updateModelEffort,
  updatePermissionMode,
} from './sessionRepo';
import type { ImCardBuilders } from './cardBuilders';
import type { ImTurnRunner } from './turnRunner';
import type { ImChannelAdapter } from './types';

/** 从 ui.cards.control.* 数组里随机挑一条文案。 */
function pickRandom<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

const DESKTOP_CC_DEFAULTS: DesktopCcPrefs = {
  model: 'claude-sonnet-4-6',
  providerId: null,
  effort: 'medium',
  permissionMode: 'acceptEdits',
  fastMode: false,
};

export function createCardActionHandler(
  adapter: ImChannelAdapter,
  cards: ImCardBuilders,
  turnRunner: ImTurnRunner,
): (im: ChannelIM) => () => void {
  const { ui, channel, threadScoped } = adapter;
  const log = createLogger(`im:${channel}:card`);
  const threadUi = ui.thread;

  function requireThreadUi() {
    if (!threadUi)
      throw new Error(`${channel} thread UI is required for thread-scoped control cards`);
    return threadUi;
  }

  /** thread root 卡上的退出接管按钮(payload 只带 botAppId, scope 用卡自身 ts 反查)。 */
  function takeoverExitButton(botContextId: string) {
    return {
      id: 'control:thread-exit',
      label: requireThreadUi().btnExitTakeover,
      payload: { botAppId: botContextId },
    };
  }

  /** "发起远程控制"按钮 — 已取消/已退出收口卡上的免打字重入口。 */
  function startControlButton(botContextId: string) {
    return {
      id: 'control:start',
      label: requireThreadUi().btnStartControl,
      payload: { botAppId: botContextId },
    };
  }

  /**
   * 锚点流程(主路径): /ctr 时已发出顶层锚点卡并在其 thread 里完成选择 —
   * scopeKey 即锚点 ts。attach(identity+scope) 后把锚点卡原地变身"已接管"
   * (带 🚪 按钮)。attach 失败时锚点卡 patch 为失败文案, 返回 false。
   */
  async function bindTakeoverToAnchor(
    im: ChannelIM,
    args: {
      botContextId: string;
      userId: string;
      sessionId: string;
      anchorMessageId: string;
      scopeKey: string;
      card: { title: string; body: string };
    },
  ): Promise<BindingAttachResult | null> {
    let attachResult: BindingAttachResult;
    try {
      attachResult = await bindingStore.attachWithResult(
        {
          channel,
          botContextId: args.botContextId,
          userId: args.userId,
          scopeKey: args.scopeKey,
        },
        args.sessionId,
        { attachedViaCardMessageId: args.anchorMessageId },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`anchor takeover attach failed: ${msg}`);
      try {
        await im.updateInteractiveCard(
          args.anchorMessageId,
          cards.buildResolvedCard(ui.cards.control.attachFailed(msg)),
        );
      } catch {
        /* swallow */
      }
      return null;
    }
    try {
      await im.updateInteractiveCard(args.anchorMessageId, {
        title: args.card.title,
        body: args.card.body,
        buttons: [takeoverExitButton(args.botContextId)],
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`anchor card morph failed (non-fatal): ${msg}`);
    }
    return attachResult;
  }

  /**
   * 旧卡兜底: payload 无 anchorMessageId(锚点流程上线前发出的 picker 卡)时,
   * 发顶层"已接管"root 卡(带退出按钮)→ 该卡的 ts 即新接管 thread 的
   * scopeKey → attach(identity+scope)。
   * 返回 scopeKey;任何一步失败返回 null(caller 负责给用户报错)。
   */
  async function establishThreadTakeover(
    im: ChannelIM,
    args: {
      botContextId: string;
      userId: string;
      sessionId: string;
      card: { title: string; body: string };
    },
  ): Promise<{
    scopeKey: string;
    rootMessageId: string;
    displaced: BindingAttachResult['displaced'];
  } | null> {
    if (!threadUi || !im.threadKeyForMessage) return null;
    let rootMessageId: string;
    try {
      const r = await im.sendInteractiveCard(args.userId, {
        title: args.card.title,
        body: args.card.body,
        buttons: [
          {
            id: 'control:thread-exit',
            label: threadUi.btnExitTakeover,
            payload: { botAppId: args.botContextId },
          },
        ],
      });
      rootMessageId = r.messageId;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`thread takeover root card send failed: ${msg}`);
      return null;
    }
    const scopeKey = im.threadKeyForMessage(rootMessageId);
    let attachResult: BindingAttachResult;
    try {
      attachResult = await bindingStore.attachWithResult(
        { channel, botContextId: args.botContextId, userId: args.userId, scopeKey },
        args.sessionId,
        { attachedViaCardMessageId: rootMessageId },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`thread takeover attach failed: ${msg}`);
      // root 卡已发出但 attach 失败 — patch 成失败文案, 不留"假接管"卡
      try {
        await im.updateInteractiveCard(
          rootMessageId,
          cards.buildResolvedCard(ui.cards.control.attachFailed(msg)),
        );
      } catch {
        /* swallow */
      }
      return null;
    }
    return { scopeKey, rootMessageId, displaced: attachResult.displaced };
  }

  async function handleModelPick(im: ChannelIM, event: IMCardActionEvent): Promise<void> {
    const sessionId = String(event.payload.sessionId ?? '');
    const modelId = String(event.payload.modelId ?? '');
    const modelLabel = String(event.payload.modelLabel ?? modelId);
    const effort = (event.payload.effort ?? null) as Effort | null;
    // providerId:新卡片携带(供应商/模型名 picker);老卡片(升级前发出的)没有 → undefined,
    // 此时保持旧行为(只切 model/effort,不动会话的供应商选择)。
    const providerId = normalizeSessionProviderId(
      typeof event.payload.providerId === 'string' ? event.payload.providerId : undefined,
    );

    if (!sessionId || !modelId) {
      log.warn('model:pick missing sessionId/modelId — ignoring');
      return;
    }

    const patchModelPickFailed = async (reason: string): Promise<void> => {
      try {
        await im.updateInteractiveCard(
          event.messageId,
          cards.buildResolvedCard(ui.cards.model.failed(reason)),
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`model:pick failure card patch failed (non-fatal): ${msg}`);
      }
    };

    const failureReason = await withSendToSessionLock(sessionId, async () => {
      let previousRoute: Awaited<ReturnType<typeof readModelRouteSnapshot>> = null;
      try {
        previousRoute = await readModelRouteSnapshot(sessionId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`model:pick route snapshot failed (non-fatal): ${msg}`);
      }
      const previousProviderId = previousRoute
        ? previousRoute.providerId
        : getSessionProvider(sessionId);
      const restorePersistentRoute = async (reason: string): Promise<void> => {
        if (!previousRoute) return;
        try {
          await updateModelEffort(
            sessionId,
            previousRoute.model,
            previousRoute.effort,
            providerId !== undefined ? previousRoute.providerId : undefined,
          );
        } catch (restoreErr) {
          const restoreMsg = restoreErr instanceof Error ? restoreErr.message : String(restoreErr);
          log.warn(`model:pick DB rollback after ${reason} failed (non-fatal): ${restoreMsg}`);
        }
      };
      const rollbackRuntimeChange = async (reason: string): Promise<void> => {
        if (providerId !== undefined) {
          setSessionProvider(sessionId, previousProviderId);
        }
        const liveForRollback = turnRunner.getMakerSessionById(sessionId);
        if (!liveForRollback || !previousRoute) return;
        try {
          await liveForRollback.setModel(previousRoute.model);
          if (effort) {
            await liveForRollback.setEffort(previousRoute.effort);
          }
        } catch (rollbackErr) {
          const rollbackMsg =
            rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
          log.warn(`model:pick live rollback after ${reason} failed (non-fatal): ${rollbackMsg}`);
        }
      };

      // 持久化与运行态切换必须和 send / agent switch 共用 session 锁，保证后选覆盖先选。
      try {
        await updateModelEffort(sessionId, modelId, effort ?? 'high', providerId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(`model:pick DB update failed: ${msg}`);
        return msg;
      }

      try {
        const runtimeChange = await applyRuntimeSetModelChange({
          maker: getMaker(),
          sessionId,
          model: modelId,
          providerId,
          isSessionInTurn,
          registerPendingCredentialSwitch: registerPendingCredentialSwitchForSession,
          clearPendingCredentialSwitch: clearPendingCredentialSwitchForSession,
          wakeSessionInputQueue: wakeSessionInputAfterCredentialSwitch,
          getPendingCredentialSwitch: getPendingCredentialSwitchTarget,
          logger: log,
        });

        const liveAfterModel = turnRunner.getMakerSessionById(sessionId);
        if (runtimeChange.status !== 'deferred' && liveAfterModel && effort) {
          try {
            await liveAfterModel.setEffort(effort);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log.warn(`model:pick live setEffort failed: ${msg}`);
            await restorePersistentRoute('setEffort');
            await rollbackRuntimeChange('setEffort');
            return msg;
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`model:pick runtime setModel failed: ${msg}`);
        await restorePersistentRoute('runtime setModel');
        return msg;
      }

      const liveAfterModel = turnRunner.getMakerSessionById(sessionId);
      if (!liveAfterModel) {
        log.info(`model:pick: no live session for ${sessionId.slice(-8)} — DB updated only`);
      }
      // 这次 IM 选择晚于 renderer 登记的跨引擎 intent；只有整条 route 更新成功后
      // 才取消旧 intent，失败回滚时仍保留它供下一次发送重试。
      cancelPendingAgentSwitchForSession(sessionId);
      return null;
    });

    if (failureReason !== null) {
      await patchModelPickFailed(failureReason);
      return;
    }

    try {
      await im.updateInteractiveCard(
        event.messageId,
        cards.buildResolvedCard(ui.cards.model.resolved(modelLabel, effort)),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`model:pick card patch failed (non-fatal): ${msg}`);
    }
  }

  async function handlePermissionModePick(im: ChannelIM, event: IMCardActionEvent): Promise<void> {
    const sessionId = String(event.payload.sessionId ?? '');
    const mode = String(event.payload.mode ?? '') as PermissionMode;
    const modeLabel = String(event.payload.modeLabel ?? mode);
    const agentKind: AgentKind =
      event.payload.agentKind === 'codex' ? 'codex' : adapter.config.agentKind;

    if (event.buttonId === 'permmode:confirm-full-access' && mode !== 'bypassPermissions') {
      log.warn(`permmode:confirm-full-access received non-full mode=${mode} — ignoring`);
      return;
    }

    // Validate against the bound agent's actual capabilities — single source of
    // truth is the agent module (e.g. claude-code/index.ts CLAUDE_PERMISSION_MODES).
    const supportedIds = getMaker()
      .getCapabilities(agentKind)
      .permissionModes.map((m) => m.id);
    if (!sessionId || !supportedIds.includes(mode)) {
      log.warn(`permmode:pick missing/invalid sessionId=${sessionId} mode=${mode} — ignoring`);
      return;
    }

    const previousMode = await readPermissionMode(sessionId);
    if (!previousMode) {
      log.warn(`permmode:pick session not found sessionId=${sessionId} — ignoring`);
      return;
    }

    if (
      event.buttonId === 'permmode:pick'
      && requiresFullAccessConfirmation(previousMode, mode)
    ) {
      try {
        await im.updateInteractiveCard(event.messageId, {
          title: ui.cards.permissionMode.fullAccessConfirmTitle,
          body: ui.cards.permissionMode.fullAccessConfirmBody,
          buttons: [
            {
              id: 'permmode:confirm-full-access',
              label: ui.cards.permissionMode.btnConfirmFullAccess,
              type: 'danger',
              payload: { sessionId, mode, modeLabel, agentKind },
            },
            {
              id: 'permmode:cancel-full-access',
              label: ui.cards.permissionMode.btnCancelFullAccess,
              type: 'default',
              payload: { sessionId },
            },
          ],
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`permmode:pick confirmation card patch failed: ${msg}`);
      }
      return;
    }

    const live = turnRunner.getMakerSessionById(sessionId);
    let runtimeChanged = false;
    try {
      if (live) {
        await live.setPermissionMode(mode);
        runtimeChanged = true;
      }
      await updatePermissionMode(sessionId, mode);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`permmode:pick update failed: ${msg}`);
      if (runtimeChanged && live) {
        try {
          await live.setPermissionMode(previousMode);
        } catch (rollbackErr) {
          log.warn(`permmode:pick runtime rollback failed: ${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}`);
        }
      }
      try {
        await im.updateInteractiveCard(
          event.messageId,
          cards.buildResolvedCard(ui.cards.permissionMode.failed(msg)),
        );
      } catch {
        /* non-fatal: update failure is already logged */
      }
      return;
    }

    if (!live) {
      log.info(`permmode:pick: no live session for ${sessionId.slice(-8)} — DB updated only`);
    }
    try {
      await im.updateInteractiveCard(
        event.messageId,
        cards.buildResolvedCard(ui.cards.permissionMode.resolved(modeLabel)),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`permmode:pick card patch failed (non-fatal): ${msg}`);
    }
  }

  async function handlePermissionModeCancel(
    im: ChannelIM,
    event: IMCardActionEvent,
  ): Promise<void> {
    try {
      await im.updateInteractiveCard(
        event.messageId,
        cards.buildResolvedCard(ui.cards.permissionMode.fullAccessCancelled),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`permmode:cancel card patch failed (non-fatal): ${msg}`);
    }
  }

  async function handleControlPick(im: ChannelIM, event: IMCardActionEvent): Promise<void> {
    const botContextId = String(event.payload.botAppId ?? '');
    const workingDir = String(event.payload.workingDir ?? '');
    const displayName = String(event.payload.displayName ?? workingDir);
    if (!workingDir || !botContextId) {
      log.warn('control:pick missing workingDir/botAppId — ignoring');
      return;
    }
    log.info(`control:pick workingDir=${workingDir} displayName=${displayName}`);

    let sessions: ControlSession[];
    try {
      sessions = await listSessionsForWorkspace(workingDir);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`control:pick listSessions failed: ${msg}`);
      sessions = [];
    }

    try {
      await im.updateInteractiveCard(
        event.messageId,
        cards.buildControlSessionPickerCard({
          botAppId: botContextId,
          workingDir,
          displayName,
          sessions,
          anchorMessageId: String(event.payload.anchorMessageId ?? '') || undefined,
        }),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`control:pick card update failed (non-fatal): ${msg}`);
    }
  }

  async function handleControlBack(im: ChannelIM, event: IMCardActionEvent): Promise<void> {
    const botContextId = String(event.payload.botAppId ?? '');
    if (!botContextId) {
      log.warn('control:back missing botAppId — ignoring');
      return;
    }
    log.info(`control:back (sender=...${event.senderId.slice(-8)})`);
    let projects: ControlProject[];
    try {
      projects = await listProjectsForControl();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`control:back listProjects failed: ${msg}`);
      projects = [];
    }
    // 接管态下走到这里 (接管中重发 /ctr → 进 session picker → 后退) 时, 重建的
    // workspace picker 也要带上"当前接管中"提示 — 跟 slash 入口的卡片保持一致。
    // threadScoped 渠道 binding 按 (identity, scopeKey) 维度存 — 带上事件的
    // scopeKey 才能查到本 thread 的 binding(feishu 无 scopeKey, 行为不变)
    const attachedSessionId = bindingStore.get({
      channel,
      botContextId,
      userId: event.senderId,
      ...(event.scopeKey ? { scopeKey: event.scopeKey } : {}),
    });
    const currentAttachedTitle = attachedSessionId
      ? await readSessionTitle(attachedSessionId)
      : null;
    try {
      await im.updateInteractiveCard(
        event.messageId,
        cards.buildControlPickerCard({
          botAppId: botContextId,
          projects,
          currentAttachedTitle,
          anchorMessageId: String(event.payload.anchorMessageId ?? '') || undefined,
        }),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`control:back card update failed (non-fatal): ${msg}`);
    }
  }

  async function handleControlSessionPick(im: ChannelIM, event: IMCardActionEvent): Promise<void> {
    // Terminal: 把 binding 写入, 之后该 (bot, owner) 在渠道发的消息会被 turnRunner
    // 入口的 binding.resolve 路由到这个 desktop sessionId。无论 attach 成败都解锁
    // controlState (失败时用户至少能继续别的操作)。
    //
    // 历史: 这里曾有 isSessionInTurn guard 拒绝接管 in-turn session, 怕跟正在跑的
    // desktop turn 抢 setInteractionListener / 写库。后来 wireSessionInternal
    // attached 路径加了 takePendingInteractionsForSession 把 desktop pending 卡片
    // 原地搬到渠道, in-turn 接管已经不会"丢失卡片", guard 拿掉了。事件 fan-out
    // 是 multi-listener (desktop + IM 并存), 写库 main 端串行, 不存在抢资源问题。
    const botContextId = String(event.payload.botAppId ?? '');
    const sessionId = String(event.payload.sessionId ?? '');
    const sessionTitle = String(event.payload.sessionTitle ?? sessionId);
    const displayName = String(event.payload.displayName ?? '');
    if (!sessionId || !botContextId) {
      log.warn('control:session-pick missing sessionId/botAppId — ignoring');
      return;
    }
    log.info(`control:session-pick sessionId=...${sessionId.slice(-8)} displayName=${displayName}`);

    // ── threadScoped(thread = session)接管分支 ─────────────────────────────
    // 顶层发"已接管"root 卡 → 卡 ts 即 scopeKey → attach(identity+scope) →
    // brief 总结发进该 thread → picker 卡 patch 为 resolved。
    if (threadScoped && threadUi) {
      try {
        await im.patchMarkdownCard(
          event.messageId,
          pickRandom(ui.cards.control.takeoverLoadingPrompts)(sessionTitle),
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`session-pick loading patch failed (non-fatal): ${msg}`);
      }

      const anchorMessageId = String(event.payload.anchorMessageId ?? '');
      let established: {
        scopeKey: string;
        displaced: BindingAttachResult['displaced'];
      } | null = null;
      if (anchorMessageId && event.scopeKey) {
        // 锚点流程: 选择卡就在锚点 thread 里, scopeKey = 锚点 ts
        const attachResult = await bindTakeoverToAnchor(im, {
          botContextId,
          userId: event.senderId,
          sessionId,
          anchorMessageId,
          scopeKey: event.scopeKey,
          card: threadUi.takeoverCard(sessionTitle, displayName),
        });
        established = attachResult
          ? { scopeKey: event.scopeKey, displaced: attachResult.displaced }
          : null;
      } else {
        established = await establishThreadTakeover(im, {
          botContextId,
          userId: event.senderId,
          sessionId,
          card: threadUi.takeoverCard(sessionTitle, displayName),
        });
      }
      exitControl(botContextId, event.senderId);
      if (!established) {
        try {
          await im.updateInteractiveCard(
            event.messageId,
            cards.buildResolvedCard(ui.cards.control.attachFailed('takeover failed')),
          );
        } catch {
          /* swallow */
        }
        return;
      }

      // New binding is committed now. Only after that point may the old root
      // card claim its takeover was replaced. Cross-channel cards cannot be
      // patched through this adapter, and the current anchor is morphed below.
      const anchorIdInPayload = String(event.payload.anchorMessageId ?? '');
      const displacedAnchorId = established.displaced?.attachedViaCardMessageId;
      if (
        established.displaced &&
        displacedAnchorId &&
        established.displaced.identity.channel === channel &&
        displacedAnchorId !== anchorIdInPayload
      ) {
        try {
          await im.updateInteractiveCard(
            displacedAnchorId,
            cards.buildResolvedCard(threadUi.takeoverReplaced(sessionTitle)),
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.warn(`session-pick replace: old anchor patch failed (non-fatal): ${msg}`);
        }
      }

      // picker 卡收口(顶层) — root 卡才是这次接管的"家"
      try {
        await im.updateInteractiveCard(
          event.messageId,
          cards.buildResolvedCard(ui.cards.control.resolvedSessionPick(sessionTitle, displayName)),
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`session-pick picker resolve patch failed (non-fatal): ${msg}`);
      }

      // brief 总结发进新 thread — 失败 fallback 提示, 不阻塞
      let summary: string | null = null;
      try {
        summary = await generateTakeoverSummary(sessionId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`generateTakeoverSummary threw (non-fatal): ${msg}`);
      }
      try {
        await im.sendMarkdownText(
          event.senderId,
          summary ?? '_(回顾失败了, 在这个 thread 里直接发消息接着聊就行)_',
          { threadTs: established.scopeKey },
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`session-pick thread brief send failed (non-fatal): ${msg}`);
      }

      // prewire(带 scope): 切 interaction listener + 迁移 desktop pending 卡片
      try {
        await turnRunner.prewireAttachedSession(botContextId, event.senderId, established.scopeKey);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`session-pick prewire failed (non-fatal): ${msg}`);
      }
      return;
    }

    // 立刻 patch loading 卡 — 抢在 attach 之前,目的有两个:
    //    a) buildResolvedCard 把按钮全清, 用户没法重复点同一个 session 按钮 (旧
    //       picker 卡片在 attach 几十~几百 ms 期间按钮还在, 是个真实的重复点击窗口)
    //    b) 给个有温度的等待文案 — attach + 回顾合计数秒, 没占位用户会以为 bot 卡了
    // patch 失败也继续往下走 (网络抖动不该挡住核心 attach 流程)。
    try {
      await im.patchMarkdownCard(
        event.messageId,
        pickRandom(ui.cards.control.takeoverLoadingPrompts)(sessionTitle),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`control:session-pick loading patch failed (non-fatal): ${msg}`);
    }

    // Attach binding
    const identity: IdentityKey = {
      channel,
      botContextId,
      userId: event.senderId,
    };
    let attachErr: string | null = null;
    try {
      await bindingStore.attach(identity, sessionId, {
        attachedViaCardMessageId: event.messageId,
      });
    } catch (err) {
      attachErr = err instanceof Error ? err.message : String(err);
      log.error(`control:session-pick bindingStore.attach failed: ${attachErr}`);
    }

    // attach 失败: 走快速路径 — patch 卡片报错 + 立刻 exitControl, 没总结要等。
    if (attachErr) {
      exitControl(botContextId, event.senderId);
      try {
        await im.updateInteractiveCard(
          event.messageId,
          cards.buildResolvedCard(ui.cards.control.attachFailed(attachErr)),
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`control:session-pick card patch failed (non-fatal): ${msg}`);
      }
      return;
    }

    // attach 成功路径: loading 卡已在前面 patch 上, 现在取该 session 最后一条
    // assistant 消息当"接力 brief"。done 后 patch picker card 为最终视图 +
    // exitControl。/ctr 的"原子流程"到这里才结束 — 期间用户在渠道发消息会被
    // controlInProgress 文案吞掉, 避免 SDK 还没切到这个 session 就被打断。
    const headerText = ui.cards.control.resolvedSessionPick(sessionTitle, displayName);
    let summary: string | null = null;
    try {
      summary = await generateTakeoverSummary(sessionId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`generateTakeoverSummary threw (non-fatal): ${msg}`);
    }

    // 总结失败时 fallback — 用户至少看到"已接管 + 直接发消息接着聊"。
    const summaryBody = summary
      ? `${headerText}\n\n${summary}`
      : `${headerText}\n\n_(回顾失败了, 直接发消息接着聊就行)_`;
    try {
      await im.patchMarkdownCard(event.messageId, summaryBody);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`control:session-pick final patch failed (non-fatal): ${msg}`);
    }

    // 总结卡片 patch 完之后立刻 prewire — 把 setInteractionListener 切到本渠道
    // 并把 desktop 那边正在等的 pending 卡片 (permission / ask / plan) 原地搬过来,
    // 用户能直接答。不在 patch 之前做, 是为了让渠道时间线先出 "已接管 + brief",
    // 再出迁移过来的卡片(顺序更自然: 先看接管成功, 再看待处理)。
    // await: 确保迁移完成后 /ctr 流程才结束(exitControl 解锁). 这样用户在迁移
    // 卡片到达之前发消息会被 controlInProgress 文案吞掉, 避免乱序。
    // 失败 swallow — 接管已完成, 迁移失败最多用户得自己再发条消息触发 lazy wire。
    try {
      await turnRunner.prewireAttachedSession(botContextId, event.senderId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`control:session-pick prewire failed (non-fatal): ${msg}`);
    }

    exitControl(botContextId, event.senderId);
  }

  async function handleControlNewSession(im: ChannelIM, event: IMCardActionEvent): Promise<void> {
    // Terminal: 在指定 workingDir 下用 desktop 默认参数新建一个 session,
    // 然后 attach binding 把后续渠道消息路由到这个新 session。
    // session 创建参数:
    //   - agentKind = 'claude-code' (跟 desktop 默认一致)
    //   - model/effort/permissionMode/fastMode 用 desktop 当前偏好, 缺省走
    //     DESKTOP_CC_DEFAULTS — 这是"用 desktop 默认"的承诺
    //   - 不传 vendorOptions, 跟 desktop renderer spawn 时一致 (没有
    //     send_file_to_user MCP, 接管期间该工具不可用 — 方案 A 取舍)
    const botContextId = String(event.payload.botAppId ?? '');
    const workingDir = String(event.payload.workingDir ?? '');
    const displayName = String(event.payload.displayName ?? workingDir);
    if (!botContextId || !workingDir) {
      log.warn('control:new missing botAppId/workingDir — ignoring');
      return;
    }
    log.info(
      `control:new workingDir=${workingDir} displayName=${displayName} sender=...${event.senderId.slice(-8)}`,
    );

    const desktopPrefs = getDesktopCcPrefs() ?? DESKTOP_CC_DEFAULTS;
    // 停用轴准入(PR #744 review 第五轮):IM 新建会话是新的付费路由,desktop 偏好里
    // 保存的 model/provider 可能已被用户停用 —— 宽松降级:被停用的显式来源/模型逐级
    // 丢弃(退回 agent 默认路由),隐式默认被停用时显式落替代来源;不因停用让 IM
    // 新建流程整体失败。
    const route = await resolveLenientSessionRoute(
      'claude-code',
      desktopPrefs.model,
      desktopPrefs.providerId ?? null,
      // 入口默认模型同走裁决阶梯:它自己也可能被停用,不能作为未经裁决的兜底
      // (PR #744 review 第六轮);desiredEffort 让换模型时的 effort 按解析出的
      // 模型条目 reconcile(第十一轮)。
      {
        fallbackModel: DESKTOP_CC_DEFAULTS.model,
        desiredEffort: desktopPrefs.effort,
        desiredFastMode: desktopPrefs.fastMode === true,
      },
    );
    // 换了模型时 effort 用 reconcile 结果(保存档可能超出兜底模型的支持集,原样透传
    // 会被上游拒);模型未换则保持用户保存档。route.effort 缺席 = 条目无 effort 概念,
    // 不携带交给 agent 默认。
    // Fast 同理:路由被改动时按落地拷贝 reconcile(不支持 ⇒ false),原样保持保存值。
    const routeFastMode = route.fastMode ?? desktopPrefs.fastMode;
    const routeEffort: Effort | undefined =
      route.model === desktopPrefs.model
        ? (desktopPrefs.effort as Effort)
        : (route.effort as Effort | undefined);
    if (route.degraded) {
      log.warn(
        `control:new saved route degraded (disabled in settings): model=${desktopPrefs.model} providerId=${desktopPrefs.providerId ?? 'null'}`,
      );
    }
    // route.model 缺席 = 目录里一个启用的对话模型都没有:失败收口,绝不拿未经
    // 裁决的模型直建付费会话。
    const requireRouteModel = (): string => {
      if (!route.model) {
        throw new Error('control:new has no enabled chat model (all models disabled in settings)');
      }
      return route.model;
    };
    const closeCreatedSessionAfterSetupFailure = async (sessionId: string): Promise<void> => {
      try {
        await getMaker().closeSession(sessionId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`control:new cleanup created session failed: ${msg}`);
      }
    };
    const persistCreatedSessionProvider = async (session: {
      id: string;
      model: string;
    }): Promise<void> => {
      await updateModelEffort(
        session.id,
        route.model ?? session.model,
        routeEffort ?? ('medium' as Effort),
        route.providerId,
      );
      setSessionProvider(session.id, route.providerId);
    };

    // ── threadScoped: 新建 + 接管 → 顶层 root 卡 + thread ────────────────────
    if (threadScoped && threadUi) {
      let created: string | null = null;
      let createErr: string | null = null;
      try {
        const newSession = await getMaker().createSession({
          agentKind: 'claude-code',
          workingDir,
          model: requireRouteModel(),
          providerId: route.providerId ?? undefined,
          ...(routeEffort ? { effort: routeEffort } : {}),
          permissionMode: desktopPrefs.permissionMode as PermissionMode,
          fastMode: routeFastMode,
          title: FBOT_DRAFT_TITLE,
        });
        created = newSession.id;
        await persistCreatedSessionProvider(newSession);
        await touchUserSent(newSession.id);
        broadcastSessionCreated(newSession.id);
      } catch (err) {
        createErr = err instanceof Error ? err.message : String(err);
        log.error(`control:new(thread) setup failed: ${createErr}`);
        if (created) {
          await closeCreatedSessionAfterSetupFailure(created);
          created = null;
        }
      }

      const anchorMessageId = String(event.payload.anchorMessageId ?? '');
      let established: { scopeKey: string } | null = null;
      if (created && !createErr) {
        if (anchorMessageId && event.scopeKey) {
          const ok = await bindTakeoverToAnchor(im, {
            botContextId,
            userId: event.senderId,
            sessionId: created,
            anchorMessageId,
            scopeKey: event.scopeKey,
            card: threadUi.takeoverNewSessionCard(displayName),
          });
          established = ok ? { scopeKey: event.scopeKey } : null;
        } else {
          established = await establishThreadTakeover(im, {
            botContextId,
            userId: event.senderId,
            sessionId: created,
            card: threadUi.takeoverNewSessionCard(displayName),
          });
        }
      }
      exitControl(botContextId, event.senderId);
      try {
        await im.updateInteractiveCard(
          event.messageId,
          cards.buildResolvedCard(
            createErr || !established
              ? ui.cards.control.attachFailed(createErr ?? 'takeover failed')
              : ui.cards.control.resolvedNewSession(displayName),
          ),
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`control:new(thread) picker patch failed (non-fatal): ${msg}`);
      }
      if (established) {
        try {
          await turnRunner.prewireAttachedSession(
            botContextId,
            event.senderId,
            established.scopeKey,
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.warn(`control:new(thread) prewire failed (non-fatal): ${msg}`);
        }
      }
      return;
    }

    let newSessionId: string | null = null;
    let attachErr: string | null = null;
    try {
      // title 用 FBOT_DRAFT_TITLE ('FBot · New') 草稿占位, 跟 desktop 'New Maker'
      // 同语义。等用户在渠道发出第一条消息, turnRunner 会用消息文本调 oneshot
      // 生成正式 title 'FBot · {gen}' (对齐 desktop makerChatStore 的 generateTitle
      // 逻辑)。这里不立刻用 displayName 跑 oneshot — 用户名作为 seed 没有任何
      // 对话上下文意义。
      const newSession = await getMaker().createSession({
        agentKind: 'claude-code',
        workingDir,
        model: requireRouteModel(),
        providerId: route.providerId ?? undefined,
        ...(routeEffort ? { effort: routeEffort } : {}),
        permissionMode: desktopPrefs.permissionMode as PermissionMode,
        fastMode: routeFastMode,
        title: FBOT_DRAFT_TITLE,
      });
      newSessionId = newSession.id;
      await persistCreatedSessionProvider(newSession);
      // bump userSendAt = now, 让 sidebar 直接把这条 session 落到 workingDir
      // 对应的 Project group 下, 而不是判定成"草稿"挂在 Projects 这一级根。
      // 草稿规则 (projectGrouping.ts): workingDir 缺失 OR (userSendAt == null
      // AND _count.messages === 0)。新建 session workingDir 有但 userSendAt
      // 默认 null + messages 表 0 row, 命中草稿条件; 这里主动 bump 等价于
      // fork.ts:170 的处理 — fork 路径同样 set userSendAt = now 让新 session
      // 立刻进 Project group。
      await touchUserSent(newSession.id);
      // 通知所有 renderer window: 这条 session 是 main 端创建的, 不走 renderer 的
      // sessionService.create -> sessionsBus 路径; 不主动 broadcast 的话 sidebar
      // useCCSessions 完全不知道有新 session, sidebar Projects 列表不会刷新。
      broadcastSessionCreated(newSession.id);
    } catch (err) {
      attachErr = err instanceof Error ? err.message : String(err);
      log.error(`control:new setup failed: ${attachErr}`);
      if (newSessionId) {
        await closeCreatedSessionAfterSetupFailure(newSessionId);
        newSessionId = null;
      }
    }

    if (newSessionId && !attachErr) {
      const identity: IdentityKey = {
        channel,
        botContextId,
        userId: event.senderId,
      };
      try {
        await bindingStore.attach(identity, newSessionId, {
          attachedViaCardMessageId: event.messageId,
        });
      } catch (err) {
        attachErr = err instanceof Error ? err.message : String(err);
        log.error(`control:new bindingStore.attach failed: ${attachErr}`);
      }
    }

    exitControl(botContextId, event.senderId);
    try {
      await im.updateInteractiveCard(
        event.messageId,
        cards.buildResolvedCard(
          attachErr
            ? ui.cards.control.attachFailed(attachErr)
            : pickRandom(ui.cards.control.newSessionWelcomePrompts)(displayName),
        ),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`control:new card patch failed (non-fatal): ${msg}`);
    }
  }

  /**
   * thread root 卡上的"退出接管"按钮 — 解除该 thread(scopeKey = 卡自身 ts)
   * 的 binding, root 卡 patch 为已退出。幂等: 已退出时也 patch(双击安全)。
   */
  async function handleControlThreadExit(im: ChannelIM, event: IMCardActionEvent): Promise<void> {
    const botContextId = String(event.payload.botAppId ?? '');
    const scopeKey = event.scopeKey;
    if (!botContextId || !scopeKey || !threadUi) {
      log.warn('control:thread-exit missing botAppId/scopeKey — ignoring');
      return;
    }
    log.info(`control:thread-exit scope=${scopeKey} sender=...${event.senderId.slice(-8)}`);
    let exitedSessionId: string | null = null;
    try {
      const r = await executeDetach(
        { channel, botContextId, userId: event.senderId, scopeKey },
        `${channel}-slash`,
      );
      exitedSessionId = r.targetSessionId;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`control:thread-exit executeDetach threw: ${msg}`);
    }
    // 收口卡标题保留曾控制的 session 名(顶层可追溯), 带"发起远程控制"按钮
    // (常驻 — 按下不收口, 见 handleControlStart)
    let exitedTitle: string | null = null;
    if (exitedSessionId) {
      try {
        exitedTitle = await readSessionTitle(exitedSessionId);
      } catch {
        /* title 查不到就省略, 不阻塞收口 */
      }
    }
    try {
      const card = threadUi.takeoverExited(exitedTitle);
      await im.updateInteractiveCard(event.messageId, {
        ...card,
        buttons: [startControlButton(botContextId)],
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`control:thread-exit card patch failed (non-fatal): ${msg}`);
    }
  }

  /**
   * "发起远程控制"按钮 — 等价于 /xdmaker ctr 的 thread 流程。所有带这个按钮
   * 的卡(已退出/已取消收口卡、server 欢迎卡)都是**常驻入口**:按下不收口、
   * 不改卡, 按钮可反复用 — 反馈就是下方新出现的控制卡。
   */
  async function handleControlStart(im: ChannelIM, event: IMCardActionEvent): Promise<void> {
    const botContextId = String(event.payload.botAppId ?? '');
    if (!botContextId || !threadUi) {
      log.warn('control:start missing botAppId — ignoring');
      return;
    }
    log.info(`control:start (sender=...${event.senderId.slice(-8)})`);
    await startThreadControlFlow(im, adapter, cards, {
      botContextId,
      userId: event.senderId,
    });
  }

  async function handleControlExit(im: ChannelIM, event: IMCardActionEvent): Promise<void> {
    // Terminal: 解锁 controlState。同 session-pick: card patch 失败也解锁。
    const botContextId = String(event.payload.botAppId ?? '');
    if (!botContextId) {
      log.warn('control:exit missing botAppId — ignoring');
      return;
    }
    log.info(`control:exit (sender=...${event.senderId.slice(-8)})`);
    exitControl(botContextId, event.senderId);
    try {
      await im.updateInteractiveCard(
        event.messageId,
        cards.buildResolvedCard(ui.cards.control.resolvedExit),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`control:exit card patch failed (non-fatal): ${msg}`);
    }
    // thread 模型: 顶层锚点卡也收口成"已取消", 不留一张悬空的"接管对话"卡
    const anchorMessageId = String(event.payload.anchorMessageId ?? '');
    if (threadScoped && threadUi && anchorMessageId) {
      try {
        // 收口卡带"发起远程控制"按钮 — 想重来不用再打 /xdmaker ctr
        await im.updateInteractiveCard(anchorMessageId, {
          body: threadUi.controlCancelled,
          buttons: [startControlButton(botContextId)],
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`control:exit anchor patch failed (non-fatal): ${msg}`);
      }
    }
  }

  // ── press → decision ──────────────────────────────────────────────────────

  function decisionFromPress(event: IMCardActionEvent): InteractionDecision | null {
    const p = event.payload;
    const requestId = String(p.requestId ?? '');
    switch (event.buttonId) {
      case 'permission:allow:once':
        return { kind: 'permission', behavior: 'allow' };
      case 'permission:allow:always': {
        // "Allow always for this session": ask the SDK to add a session-scoped
        // allow rule for the same toolName so subsequent calls of the same tool
        // skip the canUseTool callback. toolName comes from the original
        // InteractionRequest (stashed in pendingInteractions at register time).
        const entry = requestId ? lookupPending(requestId) : null;
        const toolName = entry?.toolName;
        if (!toolName) {
          // No toolName recoverable — degrade to plain allow (one-shot). User
          // sees the same outcome as "allow once" for this single call.
          return { kind: 'permission', behavior: 'allow' };
        }
        return {
          kind: 'permission',
          behavior: 'allow',
          permissionUpdates: [
            createSessionPermissionUpdate({
              type: 'addRules',
              rules: [{ toolName }],
              behavior: 'allow',
            }),
          ],
        };
      }
      case 'permission:deny':
        return { kind: 'permission', behavior: 'deny', reason: 'user_denied' };
      case 'plan:approve':
        return { kind: 'plan_review', behavior: 'allow' };
      case 'plan:reject':
        return { kind: 'plan_review', behavior: 'deny', reason: 'user_rejected', dismissed: true };
      case 'ask:pick':
      case 'ask:noop': {
        // answers 的 key 必须是 question.question 全文 — SDK 用全文匹配
        // (cc-code QuestionView.tsx:167: questionText = question.question)。
        // questionHeader 只是卡片标题 chip, 用它做 key 会让模型在 answers 里
        // 找不到自己的问题, 误判"用户没选答案"。questionHeader 兜底仅为兼容
        // 历史 payload, 新卡片(cardBuilders.ts)总是带 questionText。
        const qKey = String(p.questionText ?? p.questionHeader ?? 'q');
        const label = String(p.optionLabel ?? '');
        return { kind: 'ask_user_question', answers: { [qKey]: label } };
      }
      default:
        return null;
    }
  }

  function describeDecision(d: InteractionDecision): string {
    switch (d.kind) {
      case 'permission':
        if (d.behavior === 'deny') return ui.cards.permission.resolvedDeny;
        return hasSessionPermissionUpdates(d)
          ? ui.cards.permission.resolvedAllowAlways
          : ui.cards.permission.resolvedAllowOnce;
      case 'plan_review':
        return d.behavior === 'allow'
          ? ui.cards.plan.resolvedApproved
          : ui.cards.plan.resolvedRejected;
      case 'ask_user_question': {
        const first = Object.values(d.answers)[0];
        return first ? ui.cards.ask.resolved(String(first)) : '✅ 已选择：继续';
      }
    }
  }

  return function attachCardActionHandler(im: ChannelIM): () => void {
    return im.onCardAction(async (event: IMCardActionEvent) => {
      const accountGeneration = captureImAccountGeneration();
      if (accountGeneration === null) {
        log.info(`drop card action after account boundary closed channel=${channel}`);
        return;
      }
      try {
        await runInImAccountGeneration(accountGeneration, async () => {
          log.info(
            `card action sender=...${event.senderId.slice(-8)} button=${event.buttonId} payload=${JSON.stringify(event.payload).slice(0, 200)}`,
          );

          // model:pick is NOT an InteractionRequest reply — it's a direct command
          // triggered by the /model slash command's picker card. Handle it
          // separately: update DB + live session, patch card to "已切换".
          if (event.buttonId === 'model:pick') {
            await handleModelPick(im, event);
            return;
          }

          // Same shape as model:pick — direct command from /permission picker card.
          if (
            event.buttonId === 'permmode:pick'
            || event.buttonId === 'permmode:confirm-full-access'
          ) {
            await handlePermissionModePick(im, event);
            return;
          }
          if (event.buttonId === 'permmode:cancel-full-access') {
            await handlePermissionModeCancel(im, event);
            return;
          }

          // /ctr picker —
          //   pick (workspace) → 替换为 session picker
          //   back            → 替换回 workspace picker
          //   session-pick    → attach binding + 接力 brief
          //   new             → 新建 session + attach
          //   exit            → patch 为 resolved 卡片, 不动 session
          if (event.buttonId === 'control:pick') {
            await handleControlPick(im, event);
            return;
          }
          if (event.buttonId === 'control:back') {
            await handleControlBack(im, event);
            return;
          }
          if (event.buttonId === 'control:session-pick') {
            await handleControlSessionPick(im, event);
            return;
          }
          if (event.buttonId === 'control:new') {
            await handleControlNewSession(im, event);
            return;
          }
          if (event.buttonId === 'control:exit') {
            await handleControlExit(im, event);
            return;
          }
          if (event.buttonId === 'control:thread-exit') {
            await handleControlThreadExit(im, event);
            return;
          }
          if (event.buttonId === 'control:start') {
            await handleControlStart(im, event);
            return;
          }

          const decision = decisionFromPress(event);
          if (!decision) {
            log.warn(`unknown buttonId=${event.buttonId} — ignoring`);
            return;
          }

          const requestId = String(event.payload.requestId ?? '');
          if (!requestId) {
            log.warn('no requestId in payload — ignoring');
            return;
          }

          const resolved = resolvePending(requestId, decision);
          if (!resolved) {
            log.warn(
              `no pending interaction for requestId=...${requestId.slice(-8)} (already resolved? user double-tapped?)`,
            );
            return;
          }

          // Patch the card to a resolved state so the user sees their choice took.
          const resolvedLabel = describeDecision(decision);
          try {
            await im.updateInteractiveCard(event.messageId, cards.buildResolvedCard(resolvedLabel));
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log.warn(`updateInteractiveCard failed (non-fatal): ${msg}`);
          }
        });
      } catch (err) {
        if (isImAccountScopeClosedError(err)) {
          log.info(`drop card action from stale account generation channel=${channel}`);
          return;
        }
        throw err;
      }
    });
  };
}
