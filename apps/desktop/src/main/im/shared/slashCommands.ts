/**
 * main/im/shared/slashCommands.ts
 * ---------------------------------------------------------------------------
 * Recognise + handle bot slash commands (`/help`, `/new`, `/model`, ...)。
 * Returns true when handled (caller skips agent invocation), false otherwise.
 *
 * Slash commands are PARSED here and routed; cardActionHandler is responsible
 * for executing the consequences of /model picks (it sees the button press).
 *
 * 渠道无关(原 im/feishu/slashCommands.ts 工厂化): 渠道差异经 adapter 注入,
 * detach source 标记为 `${channel}-slash`。
 */

import { getDesktopProviderService } from '../../maker-host/createDesktopProviderService';
import { getModelVisibilityOverride } from '../../maker-host/model-visibility-mirror';
import { getSessionProvider } from '../../maker-host/session-provider-store';
import {
  buildProviderSections,
  connectedProvidersForAgent,
  getModel,
  isModelVisible,
} from '@cindy/model-providers';
import { createLogger } from '../../logger';

import { resetSessionToDefaults } from './sessionRepo';
import type { ImSessionRepo } from './sessionRepo';
import type { ImCardBuilders } from './cardBuilders';
import type { ImTurnRunner } from './turnRunner';
import {
  listProjectsForControl,
  listRecentSessionsForPicker,
  readSessionTitle,
} from './controlProjects';
import { startThreadControlFlow } from './controlFlow';
import { enterControl } from './controlState';
import { bindingStore, executeDetach } from '../binding';
import type { IdentityKey } from '@cindy/im';
import type { ImChannelAdapter } from './types';
import {
  permissionModeCommandContext,
  renderTextPermissionModePicker,
  renderTextPermissionModeResult,
  resolvePermissionMode,
} from './permissionModeControl';

const INTERACTIVE_SLASH_COMMANDS = new Set([
  '/model',
  '/permission',
  '/ctr',
  '/session',
  '/project',
]);

/** Quick text-only check; treat anything starting with '/' (no spaces before) as a command. */
export function looksLikeSlashCommand(text: string): boolean {
  return text.startsWith('/');
}

export interface SlashCtx {
  botContextId: string;
  userId: string;
}

export interface ImSlashHandlers {
  /**
   * Try to handle as a slash command. Returns true if handled.
   *
   * Unrecognised commands ALSO return true (we send "unknown command" reply
   * and skip the agent — we don't want every typo'd `/foo` to ping the model).
   */
  handleSlashCommand(text: string, ctx: SlashCtx): Promise<boolean>;
}

export function createSlashHandlers(
  adapter: ImChannelAdapter,
  repo: ImSessionRepo,
  cards: ImCardBuilders,
  turnRunner: ImTurnRunner,
): ImSlashHandlers {
  const { im, output, ui, channel, threadScoped } = adapter;
  const richIm = output.kind === 'rich-card' ? output.im : null;
  const log = createLogger(`im:${channel}:slash`);
  // threadScoped 渠道的 thread 文案组 — orchestrator 接线期已断言存在
  const threadUi = ui.thread;

  /**
   * 所有 slash 反馈都走 markdown (body-only interactive card), 因为很多文案带
   * **粗体** / `code` / emoji, 渠道原生 text 不渲染 markdown 标记会显示成原文。
   * markdown 同样兼容纯文本: 没标记的字符串显示效果跟 text 一致。
   */
  async function safeSendText(userId: string, text: string): Promise<void> {
    try {
      await im.sendMarkdownText(userId, text);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`safeSendText failed (non-fatal): ${msg}`);
    }
  }

  async function handleSlashCommand(text: string, ctx: SlashCtx): Promise<boolean> {
    const [cmd, ...commandArgs] = text.trim().split(/\s+/);
    log.info(`slash cmd=${cmd} userId=...${ctx.userId.slice(-8)}`);

    const supportsTextPermissionCommand = channel === 'wecom' && cmd === '/permission';
    if (
      adapter.output.kind === 'chunked-text' &&
      INTERACTIVE_SLASH_COMMANDS.has(cmd) &&
      !supportsTextPermissionCommand
    ) {
      await safeSendText(
        ctx.userId,
        ui.slash.interactiveCommandUnsupported?.(cmd) ?? ui.slash.unknownCommand(cmd),
      );
      return true;
    }

    switch (cmd) {
      case '/help':
        await safeSendText(ctx.userId, ui.slash.help);
        return true;

      case '/start': {
        // Telegram 私聊首次交互必发 /start(START 按钮) — 有欢迎语的渠道回
        // 欢迎语, 其它渠道走未知命令提示。
        if (ui.slash.start) {
          await safeSendText(ctx.userId, ui.slash.start);
          return true;
        }
        await safeSendText(ctx.userId, ui.slash.unknownCommand(cmd));
        return true;
      }

      case '/stop': {
        // 官方 Telegram bot 的 /stop 习惯 — 语义与 `!stop` 完全一致
        // (中止当前 turn + 丢弃排队消息, 会话保留)。
        let reply: string;
        try {
          const result = await turnRunner.stopActiveTurn({
            botContextId: ctx.botContextId,
            userId: ctx.userId,
          });
          reply = result.stopped ? ui.agent.stopDone(result.droppedQueued) : ui.agent.stopIdle;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.error(`/stop stopActiveTurn threw: ${msg}`);
          reply = ui.agent.sendInternalError(msg);
        }
        await safeSendText(ctx.userId, reply);
        return true;
      }

      case '/new': {
        // thread = session 模型: 发新顶层消息即新会话, /new 无意义 → 废弃提示。
        if (threadScoped && threadUi) {
          await safeSendText(ctx.userId, threadUi.newDeprecated);
          return true;
        }
        const prepared = await repo.prepareNewSession(ctx.botContextId, ctx.userId);
        const auth = await turnRunner.getAuthStatusForRoute?.(prepared);
        if (auth ? !auth.ok : !(await turnRunner.hasAuthForRoute(prepared))) {
          await safeSendText(
            ctx.userId,
            auth && ui.agent.authMissing
              ? ui.agent.authMissing({
                  ...auth,
                  agentKind: prepared.agentKind,
                  model: prepared.model,
                })
              : ui.agent.apiKeyMissing,
          );
          return true;
        }
        // 找到当前 IM 会话行；没有历史会话时按已通过认证的默认值创建一行。
        const existing = await repo.findActiveSession(ctx.botContextId, ctx.userId);
        const row =
          existing ?? (await repo.createSession(ctx.botContextId, ctx.userId, undefined, prepared));
        if (existing) {
          await resetSessionToDefaults(row.id, adapter.config, prepared, adapter.channel);
        }
        await turnRunner.disposeOneSession(row.id);
        await safeSendText(ctx.userId, ui.slash.new);
        return true;
      }

      case '/model': {
        if (!richIm) {
          await safeSendText(ctx.userId, ui.slash.unknownCommand(cmd));
          return true;
        }
        // thread 模型: slash 命令不携带 thread 上下文(Slack 平台限制), 无法定位
        // 目标 thread/session;不拦的话 resolveRouteTarget 会误建空 scope session。
        if (threadScoped && threadUi) {
          await safeSendText(ctx.userId, threadUi.perThreadConfigUnsupported);
          return true;
        }
        const target = await turnRunner.resolveRouteTarget(ctx.botContextId, ctx.userId);
        if (!target) {
          await safeSendText(ctx.userId, ui.agent.apiKeyMissing);
          return true;
        }
        const { row } = target;
        // 模型清单与应用内模型选择器**走同一个方法**:live providers(含自定义供应商 + 实时连接态)
        // → 仅已连接供应商 → buildProviderSections(每供应商各列其模型、每行 = (供应商, 模型))。
        // 可见性过滤复用 renderer 镜像到 main 的 override(modelVisibilityMirror)+ 目录 defaultEnabled,
        // 保证 IM 列表与应用内逐模型一致。currentProviderId 优先取会话持久化的 providerId。
        const agentKind = row.agentKind;
        const currentProviderId = getSessionProvider(row.id) ?? row.providerId;
        const providers = await getDesktopProviderService().listProviders({ allowSideEffects: true });
        const connected = connectedProvidersForAgent(providers, agentKind);
        const sections = buildProviderSections({
          providers: connected,
          agent: agentKind,
          selectedModelId: row.model,
          selectedProviderId: currentProviderId,
          isVisible: (pid, mid) => {
            const provider = connected.find((p) => p.id === pid);
            const model = provider ? getModel(provider, mid, agentKind) : undefined;
            return isModelVisible(
              getModelVisibilityOverride(agentKind, pid, mid),
              model?.defaultEnabled,
            );
          },
        });
        const spec = cards.buildModelPickerCard({
          sessionId: row.id,
          agentKind,
          sections,
          currentModelId: row.model,
          currentProviderId,
          currentEffort: row.effort,
          defaultEffortByModel: target.attached
            ? Object.fromEntries(
                sections.flatMap((s) => s.models.map((m) => [m.id, m.defaultEffort ?? row.effort])),
              )
            : undefined,
        });
        try {
          await richIm.sendInteractiveCard(ctx.userId, spec);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.error(`/model card send failed: ${msg}`);
        }
        return true;
      }

      case '/exctr':
      case '/exitctr': {
        // thread 模型: 同一用户可能有多个接管 thread, 顶层 slash 不知道指哪个 —
        // 语义定为"全部退出"(单退走 thread root 卡片的退出按钮)。
        if (threadScoped && threadUi) {
          const all = bindingStore.listByIdentity(channel, ctx.botContextId, ctx.userId);
          if (all.length === 0) {
            await safeSendText(ctx.userId, threadUi.exctrNothing);
            return true;
          }
          let detached = 0;
          for (const entry of all) {
            try {
              const r = await executeDetach(entry.identity, `${channel}-slash`);
              if (r.wasAttached) detached += 1;
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              log.error(`${cmd} executeDetach(scope) threw: ${msg}`);
            }
          }
          await safeSendText(ctx.userId, threadUi.exctrAllDone(detached));
          return true;
        }
        // 结束当前 (bot, owner) 的接管, 让后续消息回到渠道默认 session。
        // 不在 controlState lock 期间生效 — 那种状态走 /ctr 卡片的"退出"按钮。
        // attached 期间 lock 是不生效的, 所以这里能正常走到。
        const identity: IdentityKey = {
          channel,
          botContextId: ctx.botContextId,
          userId: ctx.userId,
        };
        try {
          const result = await executeDetach(identity, `${channel}-slash`);
          if (!result.wasAttached) {
            await safeSendText(ctx.userId, ui.slash.notAttached);
          } else {
            await safeSendText(ctx.userId, ui.slash.detachedBySlash);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.error(`${cmd} executeDetach threw: ${msg}`);
          await safeSendText(ctx.userId, `❌ 结束接管失败：${msg}`);
        }
        return true;
      }

      case '/ctr': {
        if (!richIm) {
          await safeSendText(ctx.userId, ui.slash.unknownCommand(cmd));
          return true;
        }
        // ── thread 模型: 整个选择流程在"接管锚点卡"的 thread 里进行 ────────
        // 顶层只发一张锚点卡(未来的接管 thread root), 工作区/会话选择卡发进
        // 它的 thread — 用户从选择那一刻就在 thread 里操作, 接管完成后锚点卡
        // 原地变身"已接管"(带 🚪), 同一 thread 直接续聊。
        if (threadScoped && threadUi && richIm.threadKeyForMessage) {
          await startThreadControlFlow(richIm, adapter, cards, {
            botContextId: ctx.botContextId,
            userId: ctx.userId,
          });
          return true;
        }

        // 接管态下再发 /ctr: 直接发 picker 让用户"换乘", 不再要求先 /exctr —
        // bindingStore.attach 是 last-write-wins 且 emit prevValue, composition
        // root (main/im/index.ts) 看到同 identity 切 target 会自动调对应渠道的
        // detachFromSession 清掉旧 session 的 hook, 直接换是安全的。
        // 卡片 body 顶部带上当前接管的会话名, 用户清楚"选了就换、🚪 退出保持现状"。
        const identity: IdentityKey = {
          channel,
          botContextId: ctx.botContextId,
          userId: ctx.userId,
        };
        const attachedSessionId = bindingStore.get(identity);
        const currentAttachedTitle = attachedSessionId
          ? await readSessionTitle(attachedSessionId)
          : null;

        // 列出 desktop 端所有 active 工作区让用户选一个接管。
        // 卡片发出后立刻 enterControl —— 锁住该 (bot, owner) 的 message 入口,
        // 任何后续输入会被 messageHandler 拦截, 必须走卡片按钮 (back/exit/
        // session-pick) 才能退出该状态。详见 controlState.ts。
        // 注意: 卡片 send 失败就不 enter, 否则用户会被锁死且看不到任何卡片。
        const projects = await listProjectsForControl();
        const spec = cards.buildControlPickerCard({
          botAppId: ctx.botContextId,
          projects,
          currentAttachedTitle,
        });
        try {
          await richIm.sendInteractiveCard(ctx.userId, spec);
          enterControl(ctx.botContextId, ctx.userId);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.error(`/ctr card send failed: ${msg}`);
        }
        return true;
      }

      case '/session': {
        // 跨工作区最近会话直达(官方 bot /session 习惯) — 提供文案组的渠道
        // 才放行; 选中走 control:session-pick 接管路径。
        const recentUi = ui.cards.control.recentSessions;
        if (!richIm || !recentUi) {
          await safeSendText(ctx.userId, ui.slash.unknownCommand(cmd));
          return true;
        }
        const recent = await listRecentSessionsForPicker();
        const spec = cards.buildRecentSessionPickerCard({
          botAppId: ctx.botContextId,
          sessions: recent,
        });
        try {
          await richIm.sendInteractiveCard(ctx.userId, spec);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.error(`/session card send failed: ${msg}`);
        }
        return true;
      }

      case '/project': {
        // 项目切换 — projectSwitching 渠道专属(个人 Telegram);其它渠道当
        // 未知命令处理, 不暴露半成品入口。
        const projectUi = ui.cards.project;
        if (!richIm || !adapter.projectSwitching || !projectUi) {
          await safeSendText(ctx.userId, ui.slash.unknownCommand(cmd));
          return true;
        }
        // /ctr 接管期间语义冲突(消息在被接管的 desktop 会话里跑): 先 /exctr。
        const identity: IdentityKey = {
          channel,
          botContextId: ctx.botContextId,
          userId: ctx.userId,
        };
        if (bindingStore.get(identity)) {
          await safeSendText(ctx.userId, projectUi.attachedUnsupported);
          return true;
        }
        const [projects, current] = await Promise.all([
          listProjectsForControl(),
          repo.findActiveSession(ctx.botContextId, ctx.userId),
        ]);
        const dialogueDir = adapter.sessions.ensureWorkingDir(ctx.botContextId);
        const currentName =
          !current || current.workingDir === dialogueDir
            ? projectUi.dialogueName
            : (current.workingDir.split(/[\\/]/).filter(Boolean).pop() ?? current.workingDir);
        const spec = cards.buildProjectPickerCard({
          botAppId: ctx.botContextId,
          projects,
          currentName,
        });
        try {
          await richIm.sendInteractiveCard(ctx.userId, spec);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.error(`/project card send failed: ${msg}`);
        }
        return true;
      }

      case '/permission': {
        if (threadScoped && threadUi) {
          await safeSendText(ctx.userId, threadUi.perThreadConfigUnsupported);
          return true;
        }
        const target = await turnRunner.resolveRouteTarget(ctx.botContextId, ctx.userId);
        if (!target) {
          await safeSendText(ctx.userId, ui.agent.apiKeyMissing);
          return true;
        }
        const { row } = target;
        const context = permissionModeCommandContext(
          row.id,
          row.permissionMode,
          turnRunner.getPermissionModes(row.agentKind),
        );
        if (!richIm) {
          const requested = commandArgs[0];
          if (!requested) {
            await safeSendText(ctx.userId, renderTextPermissionModePicker(ui, context));
            return true;
          }
          const mode = resolvePermissionMode(context.modes, requested);
          if (!mode) {
            await safeSendText(ctx.userId, renderTextPermissionModePicker(ui, context));
            return true;
          }
          const confirmedFullAccess = ['confirm', '确认'].includes(commandArgs[1]?.toLowerCase());
          const result = await turnRunner.changePermissionMode({
            sessionId: row.id,
            mode: mode.id,
            modes: context.modes,
            confirmedFullAccess,
          });
          await safeSendText(ctx.userId, renderTextPermissionModeResult(ui, result));
          return true;
        }
        const spec = cards.buildPermissionModePickerCard({
          sessionId: row.id,
          agentKind: row.agentKind,
          modes: context.modes,
          currentMode: row.permissionMode,
        });
        try {
          await richIm.sendInteractiveCard(ctx.userId, spec);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.error(`/permission card send failed: ${msg}`);
        }
        return true;
      }

      default:
        await safeSendText(ctx.userId, ui.slash.unknownCommand(cmd));
        return true;
    }
  }

  return { handleSlashCommand };
}
