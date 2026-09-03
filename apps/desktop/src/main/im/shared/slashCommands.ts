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
import type { IdentityKey, InteractiveCardSpec } from '@cindy/im';
import type { ImChannelAdapter } from './types';
import {
  permissionModeCommandContext,
  renderTextPermissionModePicker,
  renderTextPermissionModeResult,
  resolvePermissionMode,
} from './permissionModeControl';
import { isBotCommandAvailableOnChannel, tokenizeBotCommand } from './botCommands';

/** Quick text-only check; treat anything starting with '/' (no spaces before) as a command. */
export function looksLikeSlashCommand(text: string): boolean {
  return text.startsWith('/');
}

export interface SlashCtx {
  botContextId: string;
  userId: string;
  /**
   * 群主流 @ 开话题的首条 slash 时由 messageHandler 注入: slash 的**首个**
   * 回复(文本或卡片)就地消费开场白卡(patch 文本 / 替换卡片)而不是另发 —
   * 「思考中」卡不会卡住, 也不会撤回后拿已删消息当回复锚点。消费过一次
   * 后返回 false, 后续回复正常发送。
   */
  consumePendingOpener?: {
    withMarkdown(userId: string, markdown: string): Promise<boolean>;
    withCard(userId: string, spec: InteractiveCardSpec): Promise<boolean>;
  };
  /**
   * 已确认双投时由 messageHandler 注入: 首个 markdown 终态同步到群主流。
   * 只应消费一次(与 consumePendingOpener 同口径)。卡片回复镜像卡片正文
   * （没有正文时退回标题）；按钮仍只在话题内可点。
   */
  mirrorTerminalReply?: (text: string) => Promise<void>;
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
   *
   * 群主流 @ 开话题的首条 slash: 首个回复经 ctx.consumePendingOpener 就地
   * patch 开场白卡(消费过一次后回落正常发送)。
   */
  async function mirrorFirstSlashReply(ctx: SlashCtx, text: string): Promise<void> {
    const mirror = ctx.mirrorTerminalReply;
    if (!mirror) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    ctx.mirrorTerminalReply = undefined;
    try {
      await mirror(trimmed);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`slash parent-chat mirror failed (non-fatal): ${msg}`);
    }
  }

  function slashCardMirrorText(spec: InteractiveCardSpec | null | undefined): string {
    if (!spec || typeof spec !== 'object') return '';
    const body = typeof spec.body === 'string' ? spec.body.trim() : '';
    const title = typeof spec.title === 'string' ? spec.title.trim() : '';
    return body || title;
  }

  async function safeSendText(ctx: SlashCtx, text: string): Promise<void> {
    try {
      if (ctx.consumePendingOpener) {
        try {
          if (await ctx.consumePendingOpener.withMarkdown(ctx.userId, text)) {
            return;
          }
        } catch (err) {
          // patch 失败不吞回复: 认领已完成(卡不会再被误 patch), 回落正常
          // 发送 — 用户至少收到结果。
          const msg = err instanceof Error ? err.message : String(err);
          log.warn(`consumePendingOpener withMarkdown failed (fallback to normal send): ${msg}`);
        }
      }
      const fallbackOpenerId = richIm?.takeNotedFallbackOpenerId?.(ctx.userId, 'markdown');
      if (fallbackOpenerId) {
        await im.sendMarkdownText(ctx.userId, text, { fallbackOpenerId });
      } else {
        await im.sendMarkdownText(ctx.userId, text);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`safeSendText failed (non-fatal): ${msg}`);
    } finally {
      // Thread send failure must still consume the parent-chat retain; otherwise
      // enqueue retention pins confirmed forever.
      await mirrorFirstSlashReply(ctx, text);
    }
  }

  /**
   * 卡片反馈: 首条经 consumePendingOpener 替换开场白卡, 替换失败回落正常发卡。
   * 返回是否送达(替换成功或发卡成功)— /ctr 等依赖「卡片确实可见」的调用方
   * 据此决定是否进入控制态。
   */
  async function safeSendCard(ctx: SlashCtx, spec: InteractiveCardSpec): Promise<boolean> {
    try {
      if (ctx.consumePendingOpener) {
        try {
          if (await ctx.consumePendingOpener.withCard(ctx.userId, spec)) {
            return true;
          }
        } catch (err) {
          // 替换失败回落正常发卡: 认领已完成, 用户至少拿到一张可用卡片。
          const msg = err instanceof Error ? err.message : String(err);
          log.warn(`consumePendingOpener withCard failed (fallback to normal send): ${msg}`);
        }
      }
      if (!richIm) {
        log.warn('safeSendCard failed: channel has no rich-card output');
        return false;
      }
      const fallbackOpenerId = richIm.takeNotedFallbackOpenerId?.(ctx.userId, 'spec');
      if (fallbackOpenerId) {
        await richIm.sendInteractiveCard(ctx.userId, spec, { fallbackOpenerId });
      } else {
        await richIm.sendInteractiveCard(ctx.userId, spec);
      }
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`safeSendCard failed (non-fatal): ${msg}`);
      return false;
    } finally {
      await mirrorFirstSlashReply(ctx, slashCardMirrorText(spec));
    }
  }

  /**
   * 工作区显示名。
   *
   * 三种情况各有其名: 没有会话行、或目录就是渠道的托管目录时显示「对话」——
   * 内部的 `telegram-<botId>` 是实现细节, 不是项目名; 否则取目录名(两种分隔符
   * 都切, 不用 path.basename: 它只认当前平台的分隔符, 而远程控制下一条 Windows
   * 会话完全可能由 macOS 上的主进程渲染); 目录为空则退回「对话」而不是空串。
   */
  function workspaceDisplayName(
    workingDir: string | null | undefined,
    botContextId: string,
    /**
     * 该会话的归属分组(只读路径带得出来时传)。schema 里它与路径是**解耦**的:
     * 接管一条 desktop 的对话会话时, 目录既不是项目、也不等于本渠道的托管目录
     * (末段常是内部 UUID), 只比对路径判不出来, 会把 UUID 当项目名报出去。
     */
    workspaceKind?: 'project' | 'dialogue' | null,
  ): string {
    // 没有 project 卡文案的渠道(它是可选契约)退回一个中性词, 不硬造。
    const dialogueName = ui.cards.project?.dialogueName ?? '—';
    if (workspaceKind === 'dialogue') return dialogueName;
    if (!workingDir) return dialogueName;
    if (workingDir === adapter.sessions.ensureWorkingDir(botContextId)) return dialogueName;
    // 取不到末段就保留目录本身。两种根目录都会走到这:
    //   - POSIX 根 `/` 按分隔符切完一段不剩;
    //   - Windows 盘符根 `C:/` 只剩 `C:` —— 而 `C:` 在 Windows 里指的是「该盘的
    //     当前目录」, 跟根目录不是一回事, 拿它当项目名会指向另一个地方。
    // listProjectsForControl 并不排除根目录(选择器里就显示成 `/` 或 `C:/`),
    // 回落到「对话」会把一个货真价实的项目报成对话。
    const segments = workingDir.split(/[\\/]/).filter(Boolean);
    const named = segments.filter((seg, i) => !(i === 0 && /^[A-Za-z]:$/.test(seg)));
    return named.pop() ?? workingDir;
  }

  async function handleSlashCommand(text: string, ctx: SlashCtx): Promise<boolean> {
    // 分词只做一次 —— 注册表内部不再重复 split, 命令名与参数不可能对不上。
    const { definition, invocation, args: commandArgs } = tokenizeBotCommand(text);
    const cmd = definition ? `/${definition.command}` : invocation;
    log.info(`slash cmd=${invocation} userId=...${ctx.userId.slice(-8)}`);

    // 渠道能力判据收进注册表(哪些命令要富卡、哪些渠道有文本降级), dispatcher
    // 不再硬编码 `channel === 'wecom' && cmd === '/permission'`。
    if (
      definition &&
      !isBotCommandAvailableOnChannel(
        definition,
        channel,
        adapter.output.kind !== 'chunked-text',
      )
    ) {
      await safeSendText(
        ctx,
        ui.slash.interactiveCommandUnsupported?.(cmd) ?? ui.slash.unknownCommand(cmd),
      );
      return true;
    }

    switch (cmd) {
      case '/help':
        await safeSendText(ctx, ui.slash.help);
        return true;

      case '/start': {
        // Telegram 私聊首次交互必发 /start(START 按钮) — 有欢迎语的渠道回
        // 欢迎语, 其它渠道走未知命令提示。
        if (ui.slash.start) {
          await safeSendText(ctx, ui.slash.start);
          return true;
        }
        await safeSendText(ctx, ui.slash.unknownCommand(cmd));
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
        await safeSendText(ctx, reply);
        return true;
      }

      case '/new': {
        // thread = session 模型: 发新顶层消息即新会话, /new 无意义 → 废弃提示。
        if (threadScoped && threadUi) {
          await safeSendText(ctx, threadUi.newDeprecated);
          return true;
        }
        const prepared = await repo.prepareNewSession(ctx.botContextId, ctx.userId);
        const auth = await turnRunner.getAuthStatusForRoute?.(prepared);
        if (auth ? !auth.ok : !(await turnRunner.hasAuthForRoute(prepared))) {
          await safeSendText(
            ctx,
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
        await safeSendText(ctx, ui.slash.new);
        return true;
      }

      case '/model': {
        if (!richIm) {
          await safeSendText(ctx, ui.slash.unknownCommand(cmd));
          return true;
        }
        // thread 模型: slash 命令不携带 thread 上下文(Slack 平台限制), 无法定位
        // 目标 thread/session;不拦的话 resolveRouteTarget 会误建空 scope session。
        if (threadScoped && threadUi) {
          await safeSendText(ctx, threadUi.perThreadConfigUnsupported);
          return true;
        }
        const target = await turnRunner.resolveRouteTarget(ctx.botContextId, ctx.userId);
        if (!target) {
          await safeSendText(ctx, ui.agent.apiKeyMissing);
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
          await safeSendCard(ctx, spec);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.error(`/model card send failed: ${msg}`);
        }
        return true;
      }

      case '/exctr': {
        // thread 模型: 同一用户可能有多个接管 thread, 顶层 slash 不知道指哪个 —
        // 语义定为"全部退出"(单退走 thread root 卡片的退出按钮)。
        if (threadScoped && threadUi) {
          const all = bindingStore.listByIdentity(channel, ctx.botContextId, ctx.userId);
          if (all.length === 0) {
            await safeSendText(ctx, threadUi.exctrNothing);
            return true;
          }
          let detached = 0;
          for (const entry of all) {
            try {
              const r = await executeDetach(entry.identity, `${channel}-slash`);
              if (r.wasAttached) detached += 1;
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              log.error(`${invocation} executeDetach(scope) threw: ${msg}`);
            }
          }
          await safeSendText(ctx, threadUi.exctrAllDone(detached));
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
            await safeSendText(ctx, ui.slash.notAttached);
          } else {
            await safeSendText(ctx, ui.slash.detachedBySlash);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.error(`${invocation} executeDetach threw: ${msg}`);
          await safeSendText(ctx, `❌ 结束接管失败：${msg}`);
        }
        return true;
      }

      case '/ctr': {
        if (!richIm) {
          await safeSendText(ctx, ui.slash.unknownCommand(cmd));
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
        const sent = await safeSendCard(ctx, spec);
        if (sent) {
          enterControl(ctx.botContextId, ctx.userId);
        } else {
          log.error('/ctr picker card send failed — control NOT entered (avoid locking the user)');
        }
        return true;
      }

      case '/session': {
        // 跨工作区最近会话直达(官方 bot /session 习惯) — 提供文案组的渠道
        // 才放行; 选中走 control:session-pick 接管路径。
        const recentUi = ui.cards.control.recentSessions;
        if (!richIm || !recentUi) {
          await safeSendText(ctx, ui.slash.unknownCommand(cmd));
          return true;
        }
        const recent = await listRecentSessionsForPicker();
        const spec = cards.buildRecentSessionPickerCard({
          botAppId: ctx.botContextId,
          sessions: recent,
        });
        try {
          await safeSendCard(ctx, spec);
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
          await safeSendText(ctx, ui.slash.unknownCommand(cmd));
          return true;
        }
        // /ctr 接管期间语义冲突(消息在被接管的 desktop 会话里跑): 先 /exctr。
        const identity: IdentityKey = {
          channel,
          botContextId: ctx.botContextId,
          userId: ctx.userId,
        };
        if (bindingStore.get(identity)) {
          await safeSendText(ctx, projectUi.attachedUnsupported);
          return true;
        }
        const [projects, current] = await Promise.all([
          listProjectsForControl(),
          repo.findActiveSession(ctx.botContextId, ctx.userId),
        ]);
        const currentName = workspaceDisplayName(
          current?.workingDir,
          ctx.botContextId,
          current?.workspaceKind,
        );
        const spec = cards.buildProjectPickerCard({
          botAppId: ctx.botContextId,
          projects,
          currentName,
        });
        try {
          await safeSendCard(ctx, spec);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.error(`/project card send failed: ${msg}`);
        }
        return true;
      }

      case '/settings': {
        // 只读总览 —— 不改任何配置, 所以不需要富卡, 纯文本渠道也照常可用。
        const render = ui.slash.settings;
        if (!render) {
          await safeSendText(ctx, ui.slash.unknownCommand(cmd));
          return true;
        }
        if (threadScoped && threadUi) {
          await safeSendText(ctx, threadUi.perThreadConfigUnsupported);
          return true;
        }
        // /ctr 接管期间, 下一条消息跑在**被接管的 desktop 会话**里 —— /model、
        // /permission 改的也是那一行。总览无条件读 Telegram 自己的确定性会话行
        // 就会报接管前的项目/模型/权限, 与同一屏里的其它命令自相矛盾。
        //
        // binding 指向的行已失效时回落到渠道自身的会话 —— 与 turnRunner 命中
        // 无效 binding 时的落点一致(它还会顺手 detach, 只读路径不写)。
        const attachedSessionId = bindingStore.get({
          channel,
          botContextId: ctx.botContextId,
          userId: ctx.userId,
        });
        // 只读查询必须走只读路径: resolveRouteTarget 没有现成会话时会**建**一条,
        // 而它内部的 findActiveSession 还会把软删行翻回 active 并广播 —— 问一句
        // 「我现在什么配置」不该凭空造出任务, 更不该把用户已删的会话拉回列表。
        const row =
          (attachedSessionId ? await repo.peekSessionById(attachedSessionId) : null) ??
          (await repo.peekSession(ctx.botContextId, ctx.userId));
        // 还没有会话行时报的必须是**下一条消息真正会用的**那份配置。静态
        // adapter.config 不认用户在设置页改过的新会话默认值, 也不认已下架的模型,
        // 会报出一个用户根本得不到的配置。prepareNewSession 走的正是建会话那条
        // 默认值解析(readImDefaultSettings + 供应商目录 reconcile), 且只算不写。
        const effective = row ?? (await repo.prepareNewSession(ctx.botContextId, ctx.userId));
        // 项目显示成目录名而不是绝对路径: 官方 bot 那边显示的是工作区别名(短名),
        // 两边给出的粒度得一样, 否则同一个项目在两个 bot 里看着像两个东西。
        const workspace = workspaceDisplayName(
          effective.workingDir,
          ctx.botContextId,
          effective.workspaceKind,
        );
        await safeSendText(
          ctx,
          render({
            workspace,
            agent: effective.agentKind,
            model: effective.model,
            effort: effective.effort,
            permission: effective.permissionMode,
          }),
        );
        return true;
      }

      case '/permission': {
        if (threadScoped && threadUi) {
          await safeSendText(ctx, threadUi.perThreadConfigUnsupported);
          return true;
        }
        const target = await turnRunner.resolveRouteTarget(ctx.botContextId, ctx.userId);
        if (!target) {
          await safeSendText(ctx, ui.agent.apiKeyMissing);
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
            await safeSendText(ctx, renderTextPermissionModePicker(ui, context));
            return true;
          }
          const mode = resolvePermissionMode(context.modes, requested);
          if (!mode) {
            await safeSendText(ctx, renderTextPermissionModePicker(ui, context));
            return true;
          }
          const confirmedFullAccess = ['confirm', '确认'].includes(commandArgs[1]?.toLowerCase());
          const result = await turnRunner.changePermissionMode({
            sessionId: row.id,
            mode: mode.id,
            modes: context.modes,
            confirmedFullAccess,
          });
          await safeSendText(ctx, renderTextPermissionModeResult(ui, result));
          return true;
        }
        const spec = cards.buildPermissionModePickerCard({
          sessionId: row.id,
          agentKind: row.agentKind,
          modes: context.modes,
          currentMode: row.permissionMode,
        });
        try {
          await safeSendCard(ctx, spec);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.error(`/permission card send failed: ${msg}`);
        }
        return true;
      }

      default:
        await safeSendText(ctx, ui.slash.unknownCommand(cmd));
        return true;
    }
  }

  return { handleSlashCommand };
}
