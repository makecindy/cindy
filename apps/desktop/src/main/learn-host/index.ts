/**
 * learn-host 单例 + 启停 —— 镜像 goal-host/index.ts。
 *
 * 启动时机:与 goal/scheduler 同一就绪点(maker 构造 + maker:* IPC 注册 +
 * localDb ensureReady 之后),由 bootstrap-electron 调 startLearnHost。
 * 启动时 resume:中断的 run 转 failed、超龄/丢 staging 的待审提案转 expired、
 * sweep 孤儿 staging 目录。
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Effort, Maker } from '@cindy/maker-core';
import { isTerminalAgentErrorEvent } from '@cindy/maker-core';

import { emitSessionCreated } from '../localDb/ipc/sessionCreatedBroadcast.js';
import { createLogger } from '../logger.js';
import { getCurrentDataOwnerId } from '../authManager';
import { getResolvedMainLocale } from '../i18n.js';
import { wireSessionToIpc } from '../maker-ipc/register.js';
import { createMessage } from '../localDb/ipc/messages.js';
import { getDbClient } from '../localDb/client/current';
import { and, desc, eq, isNull, inArray } from 'drizzle-orm';
import { messages as messagesTable, sessions as sessionsTable } from '../localDb/schema';
import { getSessionProvider, setSessionProvider } from '../maker-host/session-provider-store.js';
import { resolveLenientSessionRoute } from '../maker-host/model-route-guard-live.js';
import { agentHandoffPending } from '../maker-ipc/agentHandoffPendingSingleton.js';
import { readMemorySettings } from '../maker-host/memory-settings-store.js';
import { visibleMessageTextForConversationSearch } from '../localDb/conversationSearch.pure';
import { searchChatHistoryHybrid } from '../localDb/chatHistorySearch';
import { backfillSessionMeta } from '../scheduler-host/runners/_shared';
import { defaultModelFor } from '../scheduler-host/model-defaults';
import { computeTwoDirDiff } from '../skillhub/snapshot';
import type { LearnEventPayload } from '../../shared/learnTypes';
import { LearnController, type LearnSessionLike } from './controller';
import { computeExcludedOldSideRemovals } from './diff';
import { LearnRunStore } from './runStore';
import { applyProposal, resolveInstalledSkillDir } from './apply';
import { collectUserProfile } from './profile';
import { formatSkillsIndexBlock, listInstalledSkills } from './skillsIndex';
import { CONVERSATION_MESSAGE_LIMIT, formatConversationBlock } from './evidence.pure';
import { redactSensitive } from './redaction';
import {
  cleanupStaging,
  collectProposalFiles,
  computeTargetDirFingerprint,
  createStagingDir,
  freezeProposal,
  renameProposalDir,
  scanStaging,
  stagingDirForRun,
  sweepOrphans,
  unfreezeProposal,
  writeReferenceFiles,
} from './staging';

export interface StartLearnHostDeps {
  maker: Maker;
  /** learn:event 广播到 renderer(bootstrap 注入 broadcastToAllWindows 包装)。 */
  broadcast: (payload: LearnEventPayload) => void;
  beforeDispatchUserTurn?: (sessionId: string) => void | Promise<void>;
  onUndispatchedUserTurn?: (sessionId: string) => void;
  /** hub 源:拉市场 skill 详情 + 可用已发布文件(bootstrap 注入,/learn hub:<slug>
   *  与 skill hub「学习此技能」共用)。未注入时 hub 源请求报 INVALID_PARAMS(兜底)。 */
  fetchHubSkill?: (slug: string, catalogScope?: 'market' | 'team') => Promise<{
    name: string;
    description: string;
    content: string;
    files?: Array<{ path: string; content: string }>;
    omittedFiles?: Array<{ path: string; reason: string }>;
  } | null>;
}

let _controller: LearnController | null = null;
/** maker session:created 订阅的解绑函数(reset 时调,防跨账号监听器堆积)。 */
let _offMakerEvents: (() => void) | null = null;

export function startLearnHost(deps: StartLearnHostDeps): LearnController {
  if (_controller) return _controller;
  const logger = createLogger('learn-host');
  const store = new LearnRunStore();
  let startupReady: Promise<void> = Promise.resolve();

  const controller = new LearnController({
    createSession: async (opts): Promise<LearnSessionLike> => {
      // 蒸馏用什么模型由用户决定:继承触发会话的 agentKind/model/effort
      // (用户在输入框发 /learn 前可随意切模型)。无触发会话(理论上仅
      // 编程调用)才落到保守兜底。
      const originMeta = opts.originSessionId
        ? await deps.maker.getSessionMeta(opts.originSessionId).catch(() => null)
        : null;
      // 来源(供应商)继承:origin 会话选了自定义 provider 时,蒸馏会话必须走同
      // 一来源,否则同一 model id 落到默认路由可能鉴权失败/打到错误上游。必须在
      // maker.createSession **之前**写入 provider store —— agent 首轮 auth gate
      // 在会话构造期就查路由,事后 set 已经太晚(register.ts 的
      // hydrateProviderIdBeforeSessionStart 同款时序,Codex review ×2)。
      // 读取顺序:内存 store(用户刚切的最新值)→ DB sessions.provider_id。
      let inheritedProviderId: string | null = null;
      if (opts.originSessionId) {
        inheritedProviderId = getSessionProvider(opts.originSessionId);
        if (!inheritedProviderId) {
          try {
            const rows = await getDbClient()
              .drizzle.select({ providerId: sessionsTable.providerId })
              .from(sessionsTable)
              .where(eq(sessionsTable.id, opts.originSessionId))
              .limit(1);
            inheritedProviderId = rows[0]?.providerId ?? null;
          } catch {
            inheritedProviderId = null;
          }
        }
      }
      // 停用轴准入(PR #744 review 第五轮):蒸馏会话是新的付费路由,继承的
      // model/provider 可能已被用户停用 —— 宽松降级(丢弃被停用的来源/模型,
      // 退回默认路由),不让 /learn 因停用整体失败。
      const agentKind = originMeta?.agentKind ?? 'claude-code';
      const desiredModel = originMeta?.model ?? defaultModelFor(agentKind);
      const route = await resolveLenientSessionRoute(
        agentKind,
        desiredModel,
        inheritedProviderId,
        // 保守默认模型同走裁决阶梯:它自己也可能被停用,不能作为未经裁决的兜底
        // (PR #744 review 第六轮);desiredEffort 让换模型时的 effort 按解析出的
        // 模型条目 reconcile(第十一轮)。
        {
          fallbackModel: defaultModelFor(agentKind),
          desiredEffort: originMeta?.effort,
          desiredFastMode: originMeta?.fastMode === true,
        },
      );
      if (route.degraded) {
        logger.warn('learn session inherited route degraded (disabled in settings)', {
          originSessionId: opts.originSessionId,
          model: originMeta?.model,
          providerId: inheritedProviderId,
        });
      }
      // 目录里一个启用的对话模型都没有:失败收口,绝不拿未经裁决的模型直建付费会话。
      const routeModel = route.model;
      if (!routeModel) {
        throw new Error('learn session has no enabled chat model (all models disabled in settings)');
      }
      if (route.providerId) setSessionProvider(opts.id, route.providerId);
      // 换了模型时 effort 用 reconcile 结果(继承档可能超出兜底模型支持集);未换则
      // 保持继承档。route.effort 缺席 = 条目无 effort 概念,不携带交给 agent 默认。
      const routeEffort =
        routeModel === desiredModel ? originMeta?.effort : (route.effort as Effort | undefined);
      const session = await deps.maker.createSession({
        id: opts.id,
        agentKind,
        workingDir: opts.workingDir,
        model: routeModel,
        ...(routeEffort ? { effort: routeEffort } : {}),
        ...((route.fastMode ?? originMeta?.fastMode) != null
          ? { fastMode: route.fastMode ?? originMeta?.fastMode }
          : {}),
        // 权限收敛到工作区(Codex review ×2,安全红线):蒸馏输入含第三方 hub
        // 内容/自由文本,prompt 注入可诱导越权 —— 绝不能静默提到 bypass(Codex
        // 映射 danger-full-access、Claude 全放行)。acceptEdits 下:Claude 自动
        // 接受工作区(= staging)内文件编辑、工作区外与 shell 仍走审批;Codex 映射
        // workspace-write 沙盒 + on-request 审批。蒸馏会话对用户可见(自动跳转),
        // 罕见的越权请求会以权限卡片出现,由用户显式决定。
        permissionMode: 'acceptEdits',
        title: opts.title,
      });
      // 不 wire → 蒸馏过程在 UI 一片空白(scheduler runner.ts 同款教训);幂等。
      wireSessionToIpc(session);
      return session;
    },
    isTerminalErrorEvent: (ev) => isTerminalAgentErrorEvent(ev as Parameters<typeof isTerminalAgentErrorEvent>[0]),
    beforeDispatchUserTurn: deps.beforeDispatchUserTurn,
    onUndispatchedUserTurn: deps.onUndispatchedUserTurn,
    peekPendingHandoff: (sessionId) => agentHandoffPending.peek(sessionId),
    consumePendingHandoff: (sessionId) => agentHandoffPending.consume(sessionId),
    getAppLocale: () => getResolvedMainLocale(),
    getCurrentDataOwnerId,
    waitForStartupSweep: () => startupReady,
    collectProfile: (originWorkdir) =>
      readMemorySettings().maker
        ? collectUserProfile(originWorkdir)
        : Promise.resolve({ block: '', used: false }),
    getSessionWorkdir: async (sessionId) => {
      const meta = await deps.maker.getSessionMeta(sessionId).catch(() => null);
      return meta?.workDir ?? null;
    },
    // 无参 /learn 的素材:代码直读消息表(最近 N 条 user/assistant,排除已
    // rewind 的),提取可见文本 + redact,格式化交给 evidence.pure(规则 9)。
    getConversationBlock: async (sessionId) => {
      const db = getDbClient().drizzle;
      const rows = await db
        .select({
          role: messagesTable.role,
          content: messagesTable.content,
          createdAt: messagesTable.createdAt,
        })
        .from(messagesTable)
        .where(
          and(
            eq(messagesTable.sessionId, sessionId),
            isNull(messagesTable.rewindAt),
            inArray(messagesTable.role, ['user', 'assistant']),
          ),
        )
        .orderBy(desc(messagesTable.createdAt))
        .limit(CONVERSATION_MESSAGE_LIMIT);
      const items: Array<{ role: string; text: string }> = [];
      for (const r of rows.reverse()) {
        const text = visibleMessageTextForConversationSearch(r.role, r.content);
        if (!text) continue;
        items.push({ role: r.role, text: redactSensitive(text).text });
      }
      return formatConversationBlock(items);
    },
    getInstalledSkillsIndex: async () => {
      const { entries, truncatedCount } = await listInstalledSkills();
      return formatSkillsIndexBlock(entries, truncatedCount);
    },
    search: (args) => searchChatHistoryHybrid(args),
    store,
    broadcast: deps.broadcast,
    staging: {
      create: createStagingDir,
      scan: scanStaging,
      cleanup: cleanupStaging,
      renameProposalDir,
      freezeProposal,
      collectProposal: collectProposalFiles,
      unfreezeProposal,
      dirForRun: stagingDirForRun,
      writeReferenceFiles,
    },
    applyProposal,
    computeDiff: computeTwoDirDiff,
    computeExcludedOldSideRemovals,
    // learn 专用全覆盖指纹(非 computeFolderHash:那个按 package ignore 跳过
    // .env 等,而 learn apply 的整目录替换连它们一起删,Codex review)。
    computeTargetFingerprint: computeTargetDirFingerprint,
    resolveInstalledSkillDir,
    // 共享 .agents、Claude 侧、Codex 侧(~/.codex/skills,scanner 认可的 legacy
    // 根)都算用户已装 skill —— 只查前两者会把 Codex-only 同名 skill 当"新建":
    // 无 diff 基线、apply 后 .agents 与 Codex 原目录双副本并存(Codex review P2)。
    resolveInstalledSkillDirs: (name) => [
      resolveInstalledSkillDir(name),
      path.join(os.homedir(), '.claude', 'skills', name),
      path.join(os.homedir(), '.codex', 'skills', name),
    ],
    dirExists: async (dir) => {
      try {
        return (await fs.promises.stat(dir)).isDirectory();
      } catch {
        return false;
      }
    },
    readFileText: async (filePath) => {
      try {
        return await fs.promises.readFile(filePath, 'utf8');
      } catch {
        return null;
      }
    },
    persistUserMessage: async (sessionId, content) => {
      await createMessage(sessionId, { clientId: randomUUID(), role: 'user', content });
    },
    backfillSessionMeta: async (sessionId) => {
      // permissionMode 必须显式传 acceptEdits:helper 默认写 bypassPermissions
      // (scheduler unattended 语义),放任默认会让重启后的 lazy-resume 按 sessions
      // 行重建会话、修订回合逃出降权(Codex review)。
      // providerId 同步落库:createSession 前已把继承的来源写进内存 store,这里
      // 读回并持久化到 sessions.provider_id —— 重启后 hydrate funnel 才能还原
      // 自定义来源路由,否则首轮之后就退回默认上游(Codex review)。
      const inheritedProviderId = getSessionProvider(sessionId);
      await backfillSessionMeta(
        getDbClient().drizzle,
        sessionId,
        {
          source: 'learn',
          workspaceKind: 'dialogue',
          permissionMode: 'acceptEdits',
          ...(inheritedProviderId ? { providerId: inheritedProviderId } : {}),
        },
        logger,
      );
      // 侧边栏刷新:直连 maker.createSession 不经 renderer 建会话 funnel,不广播
      // 的话新蒸馏会话要等无关刷新才出现在侧边栏。统一走 emitSessionCreated;
      // 放在 backfill 之后,renderer 重拉时 source='learn' 已就位,直接落自动化分组。
      emitSessionCreated(sessionId);
    },
    ...(deps.fetchHubSkill ? { fetchHubSkill: deps.fetchHubSkill } : {}),
    logger,
  });

  _controller = controller;
  // 对话即迭代的重挂钩子:app 重启后用户回到蒸馏会话继续说话时,session 由
  // renderer 侧 resume 重建 —— 这里监听 maker 的 session:created 把观察器挂回去。
  // 解绑函数留存:切账号 reset 后旧 controller 不再收事件,否则每次登录都会
  // 多挂一个监听器、把 watcher 重挂到已 dispose 的旧实例上(Codex review)。
  _offMakerEvents = deps.maker.on((event) => {
    if (event.type === 'session:created') controller.notifySessionAlive(event.session);
  });
  logger.info('[learn-host] started');
  // resume 异步收口 + sweep 孤儿 staging;失败非致命。
  startupReady = controller
    .resume()
    .then((keep) => sweepOrphans(keep))
    .catch((err) => {
      logger.warn('[learn-host] resume/sweep failed (non-fatal)', { error: String(err) });
    });
  void startupReady;
  return controller;
}

/** null-safe 取单例 —— startLearnHost 之前调用返回 null(builtins /learn 用)。 */
export function getLearnController(): LearnController | null {
  return _controller;
}

/** 切账号 / 登出时调:释放旧 controller(中止活跃蒸馏、解绑 watcher),下次登录
 *  就绪点由 startLearnHost 用新账号的 deps 重建(bootstrap auth:logout 联动)。 */
export async function resetLearnController(): Promise<void> {
  _offMakerEvents?.();
  _offMakerEvents = null;
  const controller = _controller;
  _controller = null;
  if (controller) await controller.dispose();
}
