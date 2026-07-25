/**
 * main/im/index.ts
 * ---------------------------------------------------------------------------
 * Entry point for the main-process IM subsystem. Called once after app ready
 * (after `im.registerIpc()` and before `app.show()`). Wires each channel's
 * host-side business handlers and kicks off `im.init()` if the user has
 * saved bot credentials.
 *
 * Also re-exports `im` and `feishuIm` instances (built in ./host) so external
 * consumers (bootstrap-electron, mcp-providers) import everything IM-related
 * from this single barrel.
 *
 * Lifecycle (audit table — keep in sync with bootstrap-electron):
 *
 *   ┌─────────────────────────────────┬──────────────────────────────────────┐
 *   │ Event                           │ IM action                            │
 *   ├─────────────────────────────────┼──────────────────────────────────────┤
 *   │ App boot                        │ im.registerIpc + startImOrch         │
 *   │                                 │   (orchestrators only — NO connect)  │
 *   │ User login + localDb ready      │ Main localDb onReady →               │
 *   │                                 │   startImConnection() → im.init()    │
 *   │                                 │   (auto-connect if creds)            │
 *   │ Renderer ready compatibility    │ app:ready-for-bot IPC → idempotent   │
 *   │ signal (LocalDbGate)            │   startImConnection() retry          │
 *   │ Logout / account replacement    │ stopImConnection() before DbClient   │
 *   │                                 │   dispose; clear runtime caches      │
 *   │ App quit (before-quit)          │ stopImConnection('quit')             │
 *   │ Save credentials (renderer)     │ feishuBot:save IPC → wsClient.start  │
 *   │ Clear credentials (renderer)    │ feishuBot:clear IPC →                │
 *   │                                 │   wsClient.stop + ownerGuard.clear + │
 *   │                                 │   storage.clearAll                   │
 *   │ First p2p message               │ TOFU: wsClient claims sender as      │
 *   │                                 │   owner (persisted) + sends welcome  │
 *   │ WS disconnect (transient)       │ Lark.WSClient autoReconnect:true     │
 *   │ Conflict (multi-device)         │ wsClient.start verdict 'conflict' →  │
 *   │                                 │   stop + emit 'conflict' to renderer │
 *   └─────────────────────────────────┴──────────────────────────────────────┘
 *
 * Why bot connection is gated on user login + localDb ready:
 *   The bot's "🟢 已上线" announcement and inbound message handling rely on
 *   the user being recognised (auth state) and localDb being open. Connecting
 *   on app.ready alone leads to a window where the bot is "online" in feishu
 *   but the first user reply hits "localDb not ready: call ensureReady(userId)
 *   first" — see chat with 王韬 (group 混(派科夫)) on 2026-05-07.
 *   `startImConnection()` is the explicit gate; it's idempotent and a no-op
 *   when the auto-update service is staging a relaunch (skip + retry on the
 *   next cold boot).
 *
 * Credentials are independent from Cindy auth: the bot uses the user's own
 * channel credentials and keeps them across logout. Runtime connectivity is
 * intentionally account-scoped because orchestration and persistence require
 * the logged-in user's DbClient; a later login reconnects saved credentials.
 */

import { ipcMain, BrowserWindow, type IpcMainEvent } from 'electron';
import { and, eq, like, ne, sql } from 'drizzle-orm';

import { getDbClient } from '../localDb/client/current';
import { sessions } from '../localDb/schema';
import { im, feishuIm, discordIm } from './host';
import { wireFeishuOrchestrator, type FeishuOrchestratorConfig } from './feishu';
import { wireDiscordOrchestrator } from './discord';
import { getImOrchestrator, listImOrchestrators } from './shared/orchestrator';
import { createSerializedConnectionLifecycle } from './connectionLifecycle';
import {
  activateImAccountBoundary,
  captureImAccountGeneration,
  deactivateImAccountBoundary,
  isImAccountGenerationCurrent,
  waitForImAccountGenerationIdle,
} from './accountBoundary';
import { configureImAccountScope } from './accountScopeBridge';
import type { ImOrchestratorConfig } from './shared/types';
import { bindingStore, executeDetach } from './binding';
import { IM_DEFAULT_EFFORT_OVERRIDES, IM_DEFAULT_SETTINGS } from '../../shared/imDefaultSettings';
import { getAuthState } from '../authManager';
import { getUpdateStatus } from '../updateService';

import { createLogger } from '../logger';

export { im, feishuIm, discordIm } from './host';

const log = createLogger('main:im');

let wired = false;

export interface DesktopCcPrefs {
  model: string;
  providerId?: string | null;
  effort: string;
  permissionMode: string;
  fastMode: boolean;
}

let _desktopCcPrefs: DesktopCcPrefs | null = null;

export function getDesktopCcPrefs(): DesktopCcPrefs | null {
  return _desktopCcPrefs;
}

function broadcastToAllWindows(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send(channel, payload);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`broadcast to window failed: ${msg}`);
    }
  }
}

/**
 * Feishu 普通 IM 会话的产品默认值。
 *
 * 这些默认值属于 IM 编排层，不属于 feishu/ 适配层，也不属于桌面输入框的
 * UserPreferences。feishu/ 只负责渠道收发，不理解 agent、model、permission 的
 * 产品选择；新 IM 会话和 /new 都从这里的共享默认值出发，再叠加用户 override。
 *
 * 当前默认值的依据：
 *   - claude-code：系统默认 IM agent，用户可在 Settings 里覆盖为 Codex。
 *   - claude-opus-4-8：当前 IM 系统默认模型，未自定义用户随版本默认值升级。
 *   - auto：常规工具由 classifier 自动批准，敏感工具仍回落 canUseTool 卡片。
 *   - effortOverrides[claude-opus-4-8] = xhigh：目录 defaultEffort 是应用内默认，
 *     IM 普通会话默认需要更深推理；其它模型回落模型自己的 defaultEffort。
 */
const FEISHU_CONFIG: FeishuOrchestratorConfig = {
  agentKind: IM_DEFAULT_SETTINGS.agentKind,
  defaultModel: IM_DEFAULT_SETTINGS.agents[IM_DEFAULT_SETTINGS.agentKind].model,
  defaultPermissionMode: 'auto',
  effortOverrides: IM_DEFAULT_EFFORT_OVERRIDES,
};

// Discord P1 DM 渠道与 Feishu 共享同一套产品默认值。
const DISCORD_CONFIG: ImOrchestratorConfig = {
  agentKind: IM_DEFAULT_SETTINGS.agentKind,
  defaultModel: IM_DEFAULT_SETTINGS.agents[IM_DEFAULT_SETTINGS.agentKind].model,
  defaultPermissionMode: 'auto',
  effortOverrides: IM_DEFAULT_EFFORT_OVERRIDES,
};

export function startImOrchestrators(): void {
  if (wired) return;
  wired = true;
  // Production bootstrap wires handlers before login/DbClient readiness.
  // Keep the synchronous ingress gate closed until startImConnection reaches
  // the authenticated account's initialized DB boundary.
  deactivateImAccountBoundary();

  ipcMain.on('desktop:cc-prefs-changed', (_e: IpcMainEvent, prefs: unknown) => {
    if (prefs && typeof prefs === 'object') {
      _desktopCcPrefs = prefs as DesktopCcPrefs;
    }
  });

  wireFeishuOrchestrator(feishuIm, FEISHU_CONFIG);
  wireDiscordOrchestrator(discordIm, DISCORD_CONFIG);

  // bindingStore.preload() 故意不在这里跑 —— 它要 DbClient, 而 localDb 在
  // 用户登录后才 ensureReady (worker spawn + db open + smoke 后才 setCurrentDbClient)。
  // orchestrator 注册和 bot 上线是分阶段的: 这一步只挂 in-process listener
  // (无 DB 依赖), 真正读表搬到 startImConnection 里 —— 那时 Main 的 owner
  // DB-ready 回调已经完成, DbClient 必然 ready。

  // Broadcast binding 变更给所有 renderer window — desktop UI 用这个广播
  // 实时渲染 mask + 收回按钮的 attach/detach 状态。payload 形态固定:
  //   { sessionId: string | null /* null = detach */, attached: boolean,
  //     attachedAt: number | null, channel: string | null,
  //     userId: string | null }
  // sessionId=null 表示该 identity 解除接管(用于 renderer 反向 lookup);
  // sessionId 非空时 + attached=true 表示新 attach。
  // ── Composition root: 把 channel-agnostic binding store 跟 channel-specific ──
  // cleanup hook 粘起来。bindingStore 自己不知道 'feishu' 这个 channel name,
  // 这里负责"看到 detach event 就调对应 channel 的 cleanup"。加新 channel
  // (slack/discord) 时只需在这里多挂一个分支, binding.ts 一行不动。
  bindingStore.onChange((event) => {
    const channel = event.identity.channel;
    const userId = event.identity.userId;

    // 1. Channel-specific in-process cleanup (取消 onEvent fanout listener +
    //    还原 desktop interaction listener)。两种情况触发:
    //    a) detach: value=null + prevValue=oldSessionId → 清理 oldSessionId
    //    b) 同 identity 切到不同 target (re-attach to different session):
    //       value=newSessionId + prevValue=oldSessionId, oldSessionId 仍要清
    //    渠道注册表驱动 — 新增渠道无需改这里(orchestrator 自带 detach 清理)。
    if (event.prevValue && event.prevValue !== event.value) {
      try {
        getImOrchestrator(channel)?.detachFromSession(event.prevValue);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`${channel} cleanup hook on detach failed (non-fatal): ${msg}`);
      }
    }

    // 2. 广播给所有 renderer window — desktop UI 用这个广播实时渲染 mask /
    //    收回按钮。渲染 attach 状态的 renderer 不需要知道 prevValue,
    //    它会按 sessionId 自己重拉 binding:resolve-session。
    broadcastToAllWindows('binding:changed', {
      sessionId: event.value, // null = detach
      attached: event.value !== null,
      channel,
      userId,
    });
  });

  // 让 renderer 初次 mount 时能查询某个 sessionId 是否被接管。
  // displayName 直接取 desktop 当前登录用户的姓名 — desktop 跟 feishu 是同一个
  // 人 (owner 模型, /ctr 接管的本质就是"我自己换个端继续操作"), 不需要去飞书
  // 通讯录绕一圈。未登录时 null, mask fallback 到 open_id 末尾。
  ipcMain.handle('binding:resolve-session', async (_e, sessionId: unknown) => {
    if (typeof sessionId !== 'string' || !sessionId) {
      return { attached: false };
    }
    const identity = bindingStore.findByTarget(sessionId);
    if (!identity) return { attached: false, identity: null, displayName: null };
    const displayName = getAuthState().user?.name ?? null;
    return { attached: true, identity, displayName };
  });

  // 一次性快照所有被接管的 sessionId — sidebar mount 时用, 之后跟 binding:changed
  // 增量同步。等价于"全量 resolve",但避免对每行 session item 各发一次 IPC。
  ipcMain.handle('binding:list-attached', async () => {
    return { sessionIds: bindingStore.listAttachedTargets() };
  });

  // Reconnect is account-scoped: serialize it with login/logout so a click
  // racing logout cannot bring the Feishu transport back after the account
  // boundary has closed. Credentials and TOFU owner binding stay untouched.
  ipcMain.handle('feishuBot:reconnect', async () => {
    return connectionLifecycle.runWhileStarted(() => feishuIm.reconnect());
  });

  // 注册 binding:revoke IPC — desktop UI 上"收回"按钮调它结束接管。
  // Reverse-lookup: renderer 只知道 sessionId, 反查 identity 才能 detach +
  // 通知对应的 IM 用户。
  ipcMain.handle('binding:revoke', async (_e, sessionId: unknown) => {
    if (typeof sessionId !== 'string' || !sessionId) {
      throw new Error('sessionId required');
    }
    const identity = bindingStore.findByTarget(sessionId);
    if (!identity) {
      return { ok: true, alreadyDetached: true };
    }
    const detached = await executeDetach(identity, 'desktop-revoke');
    if (!detached.wasAttached) {
      return { ok: true, alreadyDetached: true };
    }
    // 通知对应的 IM 用户 — 渠道注册表驱动, 用各渠道自己的文案包。
    const orchestrator = getImOrchestrator(identity.channel);
    if (orchestrator) {
      try {
        await orchestrator.adapter.im.sendText(
          identity.userId,
          orchestrator.adapter.ui.slash.detachedByRevoke,
          // thread 接管(scopeKey = thread root): 通知发进对应 thread
          { threadTs: identity.scopeKey },
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`binding:revoke ${identity.channel} notify failed (non-fatal): ${msg}`);
      }
    }
    return { ok: true, alreadyDetached: false };
  });

  // Bot connection is intentionally NOT kicked off here — it happens in
  // `startImConnection()` after Main confirms the current owner's localDb is
  // ready. See module header table for full lifecycle.
}

async function initializeImConnection(): Promise<void> {
  await reconcileOwnerScopedImWorkingDirs();
  try {
    await bindingStore.preload();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`bindingStore.preload failed (non-fatal): ${msg}`);
  }
  // 存量 feishu 会话行补 workspaceKind='dialogue' —— 2026-07 起 feishu 会话
  // 进侧边栏「对话」分组(sessionSource.ts 白名单 + feishu adapter 声明),
  // 此前落库的行还是默认 'project', 不补会以 im-working-dir/{botAppId}
  // 聚成一个假项目组。幂等一次性 UPDATE; 不 bump updatedAt(避免重排列表)。
  try {
    await getDbClient()
      .drizzle.update(sessions)
      .set({ workspaceKind: 'dialogue' })
      .where(and(eq(sessions.source, 'feishu'), ne(sessions.workspaceKind, 'dialogue')));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`feishu sessions workspaceKind backfill failed (non-fatal): ${msg}`);
  }
  // 存量 feishu 会话的旧默认标题 `飞书 · {后6位}` 迁到新风格 `[飞书·DM] {后6位}`。
  try {
    await getDbClient()
      .drizzle.update(sessions)
      .set({ title: sql`'[飞书·DM] ' || substr(${sessions.title}, 6)` })
      .where(and(eq(sessions.source, 'feishu'), like(sessions.title, '飞书 · %')));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`feishu sessions title backfill failed (non-fatal): ${msg}`);
  }
  activateImAccountBoundary();
  await im.init();
}

/**
 * Rewrite legacy IM session paths after their managed directories move into
 * the active data owner's namespace. Each owner has a separate local DB, so
 * this cannot expose or mutate another owner's session rows.
 */
async function reconcileOwnerScopedImWorkingDirs(): Promise<void> {
  const db = getDbClient().drizzle;
  const feishuAdapter = getImOrchestrator('feishu')?.adapter;
  const discordAdapter = getImOrchestrator('discord')?.adapter;

  try {
    if (feishuAdapter) {
      const rows = await db
        .select({
          id: sessions.id,
          workingDir: sessions.workingDir,
          botContextId: sessions.feishuBotAppId,
        })
        .from(sessions)
        .where(eq(sessions.source, 'feishu'));
      for (const row of rows) {
        if (!row.botContextId) continue;
        const scoped = feishuAdapter.sessions.ensureWorkingDir(row.botContextId);
        if (row.workingDir === scoped) continue;
        await db.update(sessions).set({ workingDir: scoped }).where(eq(sessions.id, row.id));
      }
    }

    if (discordAdapter) {
      const rows = await db
        .select({
          id: sessions.id,
          workingDir: sessions.workingDir,
          botContextId: sessions.imBotContextId,
        })
        .from(sessions)
        .where(eq(sessions.source, 'discord'));
      for (const row of rows) {
        if (!row.botContextId) continue;
        const scoped = discordAdapter.sessions.ensureWorkingDir(row.botContextId);
        if (row.workingDir === scoped) continue;
        await db.update(sessions).set({ workingDir: scoped }).where(eq(sessions.id, row.id));
      }
    }
  } catch (err) {
    log.warn('IM owner-scoped working-dir reconciliation failed (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

const connectionLifecycle = createSerializedConnectionLifecycle({
  startConnection: initializeImConnection,
  stopConnection: async () => {
    // Transports stop first so no new message can enter while account-scoped
    // orchestrator and binding caches are being discarded.
    try {
      await im.dispose();
    } finally {
      for (const orchestrator of listImOrchestrators()) {
        try {
          await orchestrator.disposeAllSessions();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.warn(`disposeAllSessions channel=${orchestrator.channel} failed: ${msg}`);
        }
      }
      bindingStore.resetRuntime();
    }
  },
  onStartError: (err) => {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`IM connection start failed: ${msg}`);
  },
});

configureImAccountScope({
  capture: captureImAccountGeneration,
  isCurrent: (token) => typeof token === 'number' && isImAccountGenerationCurrent(token),
  run: (token, operation) => {
    if (typeof token !== 'number') {
      return Promise.reject(new Error('[IM_NOT_READY] Invalid IM account generation'));
    }
    return connectionLifecycle.runWhileStarted(async () => {
      if (!isImAccountGenerationCurrent(token)) {
        throw new Error('[IM_NOT_READY] IM account changed before operation ran');
      }
      return operation();
    });
  },
});

/**
 * Bring the FeishuBot WS connection online. Idempotent — safe to call multiple
 * times (e.g. renderer remount, signal duplication); only the first call has
 * effect. FeishuIM.init() is a no-op when no credentials are saved, so the bot
 * stays idle until the user pastes appId / appSecret in Settings.
 *
 * Skips when an update is downloading or staged for relaunch — bringing the
 * bot up just to tear it down within seconds would spam the owner with
 * online/offline notifications. The next cold boot (after the update) will
 * connect normally.
 */
export function startImConnection(): void {
  if (connectionLifecycle.isStarted()) {
    log.info('startImConnection: already started, skip');
    return;
  }

  const updateStatus = getUpdateStatus();
  if (updateStatus === 'downloading' || updateStatus === 'ready') {
    log.info(
      `startImConnection: skip (updateService status=${updateStatus}); will connect on next cold boot`,
    );
    return;
  }

  log.info('startImConnection: kicking off im.init()');
  // 先 preload binding 表, 再 init bot WS。preload 必须在 init 之前完成 ——
  // bot 上线后第一个进来的消息会经 runAgentTurn 同步查 bindingStore.get(),
  // 此时 forward map 必须已经填好, 否则会被当成"没接管"误路由到默认 session。
  // 放这里(而不是 startImOrchestrators)是因为 DbClient 要求 localDb 已
  // ensureReady (worker takeover 完成 + setCurrentDbClient 已写入 currentRef),
  // 而本函数只会在 Main 的 localDb onReady 权威时点，或 renderer 随后的
  // 'app:ready-for-bot' 兼容信号中调用，时序保证 OK。
  connectionLifecycle.start();
}

/**
 * Stop account-scoped IM activity before its DbClient is disposed. The
 * lifecycle remains restartable so the next successful login can reconnect
 * saved channel credentials without duplicating listeners.
 */
export async function stopImConnection(reason: string): Promise<void> {
  log.info(`stopImConnection: reason=${reason}`);
  // This is intentionally synchronous and happens before the serialized
  // transport stop: queued/late SDK callbacks are dropped immediately.
  const closingGeneration = captureImAccountGeneration();
  deactivateImAccountBoundary();
  if (closingGeneration !== null) {
    // Handlers that passed ingress may still be awaiting DB/session work.
    // Drain their complete account scope before runtime caches and DbClient
    // are released, so old-account work cannot resume against a new account.
    await waitForImAccountGenerationIdle(closingGeneration);
  }
  await connectionLifecycle.stop();
}
