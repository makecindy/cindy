import { join as pathJoin } from 'node:path';

import {
  createLiziMcpProviders,
  resolveLiziMcpSessionContext,
  type IOSSimulatorMcpAccessDecision,
  type LiziMcpProvider,
  type LiziMcpSessionContext,
  type LspServerPool,
} from '@cindy/mcps';
import type { OrcaMcpDeps } from '@cindy/mcps';
import { createCindyGhostsMcpServer } from 'cindy-tools';
import type { MakerMemoryManager } from '@cindy/maker-core';
import { getCindyGhostsMcpDeps, type GhostGrantLiveSessionState } from './ghost.js';
import { createGroupHistoryMcpServer } from './groupHistoryMcpServer.js';
import { getAndroidMcpDeps } from './android.js';
import { getIOSSimulatorMcpDeps } from './ios-simulator.js';
import { getBrowserMcpDeps } from './browser.js';
import { getComputerMcpDeps } from './computer.js';
import { feishuIm, wechatIm } from '../im';
import { getSlackToolBridge } from '../hook-control/slackToolBridge.js';
import { createLogger } from '../logger.js';
import { getScheduler } from '../scheduler-host/index.js';
import { stabilizeHookCommand } from '../scheduler-host/hook-script-generator.js';
import { searchSessionsFn } from '../maker-host/session-search.js';
import { readLspModeSettings } from '../maker-host/lsp-mode-store.js';
import { tryGetOrcaCollabService } from '../maker-ipc/register.js';
import { submitGithubIssueForSession } from '../github-issue/index.js';
import {
  listWorkdirsForHistory,
  listSessionsForHistory,
  getMessagesForHistory,
} from '../localDb/chatHistoryReader.js';
import { tryGetDbClient } from '../localDb/client/current.js';
import { searchChatHistoryHybrid } from '../localDb/chatHistorySearch.js';
import {
  patchSessionMetaInDb,
  renameSessionTitlesInDb,
  setSessionsStatusInDb,
} from '../localDb/ipc/sessions.js';
import { isIpcError } from '../../shared/ipc-errors.js';
import type { PluginRegistry } from '../maker-host/plugins/plugin-registry.js';
import { getDesktopContactsManager } from '../maker-host/maker-contacts-host.js';
import { broadcastContactsChanged } from '../maker-host/contacts-change-broadcast.js';
import { readContactsSettings } from '../maker-host/contacts-settings-store.js';
import { readSystemContacts, writeSystemContacts } from '../maker-host/system-contacts.js';
import { BUILTIN_LIZI_MCP_IDS, pluginIdForProviderName } from '../maker-host/plugins/builtin-plugins.js';
import { GLOBAL_PLUGIN_IDS } from '../maker-host/plugins/types.js';
import {
  readChatHistoryMessages,
  type ChatHistoryReaderDeps,
} from './remoteChatHistory.js';

export interface DesktopMcpProvidersDeps {
  getMakerMemoryManager: () => MakerMemoryManager;
  lspPool: LspServerPool;
  /** 按会话控制启用状态的 plugin registry。 */
  pluginRegistry: PluginRegistry;
  /** Live installed/enabled plugin gate; evaluated again for every tool call. */
  resolveIOSSimulatorAccess: (
    context?: { workingDir?: string },
  ) => IOSSimulatorMcpAccessDecision;
  /** Device-link transport stays host-injected so provider tests do not load Electron runtime services. */
  invokeRemote: ChatHistoryReaderDeps['invokeRemote'];
  /** 插件文件交接只认活跃 Session 的实时权限；缺失时由 ghost.ts fail closed。 */
  getLiveSessionGrantState?: (
    sessionId: string,
    sessionInstanceId: string,
  ) => GhostGrantLiveSessionState | null;
}

export function createDesktopMcpProviders(deps: DesktopMcpProvidersDeps): LiziMcpProvider[] {
  const { pluginRegistry } = deps;

  // 辅助桥接 OrcaCollabService → OrcaMcpDeps / sendToSession，
  // 并在边界捕获 HOST_NOT_READY / INTERNAL。
  function wrap<Args extends unknown[], R>(fn: (svc: NonNullable<ReturnType<typeof tryGetOrcaCollabService>>, ...args: Args) => Promise<R>): (...args: Args) => Promise<R> {
    return async (...args) => {
      const s = tryGetOrcaCollabService();
      if (!s) return { ok: false, errorCode: 'HOST_NOT_READY' as const, message: 'orca collab service not initialized' } as R;
      try { return await fn(s, ...args); }
      catch (err) { return { ok: false, errorCode: 'INTERNAL' as const, message: err instanceof Error ? err.message : String(err) } as R; }
    };
  }

  const providers = createLiziMcpProviders({
    // 先传完整内置列表；按会话启停由下面的 isEnabled 包装处理。
    enabled: BUILTIN_LIZI_MCP_IDS,
    android: getAndroidMcpDeps({
      isAndroidAutomationEnabled: (context) =>
        // Codex provider presence is the bridge-creation enablement snapshot.
        // Keep that snapshot for a busy turn when a disable refresh is deferred;
        // a successfully rebuilt bridge omits this provider via the outer gate.
        context?.agentKind === 'codex' || pluginRegistry.isEnabled('android'),
    }),
    iosSimulator: getIOSSimulatorMcpDeps({
      resolveAccess: deps.resolveIOSSimulatorAccess,
    }),
    browser: getBrowserMcpDeps(),
    computer: getComputerMcpDeps({
      isComputerUseEnabled: (context) =>
        context?.agentKind === 'codex' || pluginRegistry.isEnabled('computer'),
    }),
    // lizi_feishu 已于 2026-07-16 摘壳:飞书能力(44 精品 + 123 只读直通)迁入
    // 内置意识 xd-feishu;2026-07-17 起授权切到意识 OAuth broker
    // (tokenBroker:'feishu'),主机 token 刷新链(mcp-integrations/feishu.ts)
    // 与 scheduler registry 直调一并退役(scheduler 飞书方法走 ghost pipe)。
    // mivo 已于 2026-07-13 退役:整体迁入内置意识 xd-mivo(见 xd-mivo/ghost.json)。
    // slack 官方 MCP 已于 2026-07-15 退役(迁入内置意识 cindy-slack,授权走
    // oauth-broker 的 slack provider;老账号由 slackAccountsMigration 无感搬入)。
    // lizi_jira / lizi_confluence 已于 2026-07-14 退役(迁入内置意识 xd-atlassian,
    // 授权走 XDT server broker;历史附件的 xdt-image 冻结读取见 imageCacheStore)。
    // lizi_github 已于 2026-07-14 退役(迁入内置意识 cindy-github;老 PAT 由
    // githubAccountsMigration 无感搬进意识保险库)。
    // lizi_gitlab 已于 2026-07-14 退役(迁入内置意识 cindy-gitlab;老 PAT +
    // 实例地址由 gitlabAccountsMigration 无感搬进意识多连接声明)。
    feishuBot: {
      // Fallback receiver for send_message_to_user / send_file_to_user when
      // the current session isn't a feishu one — semantically "notify the
      // bot's human owner". Same TOFU accessor scheduler completion
      // notifications use; returns null before the user has DM'd the bot.
      getOwnerOpenId: () => feishuIm.getOwnerOpenId(),
      sendFile: async (chatId: string, absPath: string, displayName?: string) => {
        try {
          return await feishuIm.sendFile(chatId, absPath, displayName);
        } catch (err) {
          createLogger('mcp/cindy_feishu_bot').warn(
            'sendFile failed target=...%s detail=%s',
            chatId.slice(-8),
            err instanceof Error ? err.message : String(err),
          );
          return { ok: false, reason: 'SEND_FAIL' };
        }
      },
      // sendMarkdownText throws on any SDK/network failure — wrap it into the
      // {ok, reason} shape the MCP tool handler expects so the handler stays
      // branch-free. Feishu returns 400 with structured `response.data.code/msg`
      // for business errors (rate-limit, invalid text, …); those get folded
      // into `reason` for logging without leaking axios internals to the tool.
      sendMessage: async (chatId, markdown) => {
        try {
          const { messageId } = await feishuIm.sendMarkdownText(chatId, markdown);
          return { ok: true, messageId };
        } catch (err) {
          const r = (err as { response?: { data?: { code?: number; msg?: string }; status?: number } }).response;
          const detail = r
            ? `status=${r.status ?? 'n/a'} code=${r.data?.code ?? '?'} msg=${r.data?.msg ?? '?'}`
            : err instanceof Error
              ? err.message
              : String(err);
          createLogger('mcp/cindy_feishu_bot').warn(
            'sendMessage failed target=...%s detail=%s',
            chatId.slice(-8),
            detail,
          );
          return { ok: false, reason: 'SEND_FAIL' };
        }
      },
      logger: createLogger('mcp/cindy_feishu_bot'),
    },
    wechatBot: {
      getActivePeerIdForSession: (sessionId) =>
        wechatIm.getActivePeerIdForSession(sessionId),
      getMostRecentPeerId: () => wechatIm.getMostRecentPeerId(),
      sendMessage: async (peerId, text) => {
        try {
          const { messageId } = await wechatIm.sendText(peerId, text);
          return { ok: true, messageId };
        } catch (error) {
          createLogger('mcp/cindy_wechat').warn(
            'sendMessage failed target=...%s detail=%s',
            peerId.slice(-8),
            error instanceof Error ? error.message : String(error),
          );
          return { ok: false, reason: 'SEND_FAIL' };
        }
      },
      sendFile: async (peerId, absPath, displayName) => {
        const result = await wechatIm.sendFile(peerId, absPath, displayName);
        if (!result.ok) {
          createLogger('mcp/cindy_wechat').warn(
            'sendFile failed target=...%s reason=%s',
            peerId.slice(-8),
            result.reason ?? 'unknown',
          );
        }
        return result;
      },
      logger: createLogger('mcp/cindy_wechat'),
    },
    // cindy_slack(2026-07-19): Slack 网关工具。桥经 hook-control 的零依赖
    // 注册表取用(静态 import ipc.ts 会与 maker-host 闭环, 见 slackToolBridge
    // 模块头); 未注册 = null, provider isEnabled fail-closed。
    slackHook: {
      getBridge: () => getSlackToolBridge(),
      logger: createLogger('mcp/cindy_slack'),
    },
    scheduler: {
      getScheduler: () => getScheduler(),
      // 前置检查脚本统一安装服务:落盘路径/协议/自测与 UI「AI 生成」共用同一实现
      // (hook-script-generator)。lazy import:该链上有 electron app 依赖,且 maker
      // 仅 description 生成模式需要,tool-call 时才解引用。
      hookScript: {
        // 绑定会话(heartbeat)任务安装 hook 时解析会话真实工作目录 —— schedule
        // 行上的 workingDir 为空/过期,落盘与自测必须用会话 meta.workDir。
        resolveSessionWorkDir: async (sessionId) => {
          try {
            const { getMaker } = await import('../maker-host/index.js');
            const meta = await getMaker().getSessionMeta(sessionId);
            return meta?.workDir?.trim() ? meta.workDir : undefined;
          } catch {
            return undefined;
          }
        },
        stabilizeCommand: async ({ command, workingDir }) =>
          stabilizeHookCommand(command, workingDir),
        install: async (input) => {
          const [{ installHookScript }, { getMaker }, { app }] = await Promise.all([
            import('../scheduler-host/hook-script-generator.js'),
            import('../maker-host/index.js'),
            import('electron'),
          ]);
          // maker 仅 description 生成模式需要;未就绪时传 null,script 模式照常工作,
          // description 模式由生成器报"maker not ready"。
          let maker = null;
          try {
            maker = getMaker();
          } catch {
            maker = null;
          }
          return installHookScript(
            {
              maker,
              fallbackDir: pathJoin(app.getPath('userData'), 'schedule-hooks'),
              logger: createLogger('mcp/cindy_scheduler:hook-script'),
            },
            input,
          );
        },
      },
      logger: createLogger('mcp/cindy_scheduler'),
    },
    // cindy_ssh: agent 直接在已配置 SSH 主机上执行命令(远端零安装)。
    // ⚠️ 必须 lazy await import():静态 import remote-ssh 会形成
    // mcp-providers → remote-ssh/index.ts(imports maker-host) →
    // maker-host/index.ts(imports createDesktopMcpProviders) → mcp-providers 环
    // (同上方 scheduler hookScript 的先例)。
    ssh: {
      // hydrated accessor:冷启动时 pool 是空的(hydrate 只在用户访问设置或
      // connect 路径触发),ssh_list_hosts / resolveHost 读 pool.list() 前必须
      // 先从 ~/.ssh/config hydrate,否则已配置主机全部 HOST_NOT_FOUND。
      getPool: async () => (await import('../remote-ssh/index.js')).getRemoteSshPoolHydrated(),
      ensureReady: async (id: string) =>
        (await import('../remote-ssh/index.js')).ensureRemoteHostReady(id),
      // 普通工具策略在 Claude runtime / Codex thread 创建时冻结。不要在 tool-call
      // 时重新读取 registry，否则运行中的工具清单与执行权限会随 Settings 分叉。
      logger: createLogger('mcp/cindy_ssh'),
    },
    memory: {
      getManager: deps.getMakerMemoryManager,
      searchSessions: searchSessionsFn,
      logger: createLogger('mcp/cindy_memory'),
    },
    // 智能通讯录: 全局单库 manager 懒加载单例; 开关现读 settings store —
    // 每次 session start 时 provider isEnabled 评估, 关着时 server 整个不注册。
    contacts: {
      getManager: getDesktopContactsManager,
      isEnabled: () => readContactsSettings().enabled,
      // 系统通讯录读取仅 macOS 注入(JXA); 缺省时 contacts_import_system 工具不注册。
      // 静态 import(动态 import 的 vite chunk 副作用会二次注册 IPC handler)
      ...(process.platform === 'darwin' ? { readSystemContacts, writeSystemContacts } : {}),
      // agent 经 MCP 直写 store 不经 IPC 层, 变更靠这个回调广播给 renderer
      // (设置页统计/待确认角标/管理浮层的实时刷新)
      onMutated: broadcastContactsChanged,
      logger: createLogger('mcp/cindy_contacts'),
    },
    lsp: {
      pool: deps.lspPool,
      logger: createLogger('mcp/cindy_lsp'),
      isUserEnabled: () => readLspModeSettings().enabled,
    },
    // xdt-helper: 自省 + history + send_to_session (essential 常开)。
    // send_to_session 是 skill(issue-bot 等)的会话路由原语, 放 essential 常开不断。
    // tryGetOrcaCollabService() 是延迟查找：createDesktopMcpProviders 在 app
    // 启动早期跑, 那时 registerMakerIpc 还没执行, holder 是 null; 回调真正被调时
    // (LLM 调工具时) registerMakerIpc 早已执行完毕, holder 已 ready。
    xdtHelper: {
      logger: createLogger('mcp/cindy_helper'),
      setCurrentSessionTitle: async ({ sessionId, title }) => {
        if (!tryGetDbClient()) {
          return { ok: false, errorCode: 'HOST_NOT_READY', message: 'localDb not ready' };
        }
        try {
          const updated = await patchSessionMetaInDb(sessionId, { title });
          return { ok: true, sessionId: updated.id, title: updated.title ?? title };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (isIpcError(err) && err.code === 'NOT_FOUND') {
            return { ok: false, errorCode: err.code, message };
          }
          return { ok: false, errorCode: 'INTERNAL', message };
        }
      },
      renameSessions: async ({ changes, dryRun }) => {
        if (!tryGetDbClient()) {
          return { ok: false, errorCode: 'HOST_NOT_READY', message: 'localDb not ready' };
        }
        try {
          const renamed = await renameSessionTitlesInDb(changes, dryRun);
          return { ok: true, changes: renamed };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (isIpcError(err)) {
            if (err.code === 'NOT_FOUND' || err.code === 'PRECONDITION_FAILED') {
              return { ok: false, errorCode: err.code, message };
            }
            if (err.code === 'INVALID_PARAMS') {
              return { ok: false, errorCode: 'INVALID_ARGS', message };
            }
          }
          return { ok: false, errorCode: 'INTERNAL', message };
        }
      },
      setSessionsStatus: async ({ sessionIds, status }) => {
        if (!tryGetDbClient()) {
          return { ok: false, errorCode: 'HOST_NOT_READY', message: 'localDb not ready' };
        }
        try {
          const changed = await setSessionsStatusInDb(sessionIds, status);
          return { ok: true, changed };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (isIpcError(err)) {
            if (err.code === 'NOT_FOUND' || err.code === 'PRECONDITION_FAILED') {
              return { ok: false, errorCode: err.code, message };
            }
          }
          return { ok: false, errorCode: 'INTERNAL', message };
        }
      },
      sendToSession: async ({
        targetSessionId,
        message,
        dispatcherSessionId,
        title,
        useWorktree,
        workingDir,
        agentKind,
        model,
        effort,
        fast,
      }) => {
        const svc = tryGetOrcaCollabService();
        if (!svc) {
          return { ok: false, errorCode: 'HOST_NOT_READY', message: 'orca collab service not initialized' };
        }
        try {
          const hasExecutionOverrides =
            agentKind !== undefined
            || model !== undefined
            || effort !== undefined
            || fast !== undefined;
          return await svc.sendToSession({
            targetSessionId,
            message,
            dispatcherSessionId,
            title,
            useWorktree,
            workingDir,
            ...(hasExecutionOverrides
              ? {
                  execution: {
                    agentKind,
                    model,
                    effort,
                    fastMode: fast,
                  },
                }
              : {}),
          });
        } catch (err) {
          return { ok: false, errorCode: 'INTERNAL', message: err instanceof Error ? err.message : String(err) };
        }
      },
      history: {
        listWorkdirs: async (args) => {
          try { const page = await listWorkdirsForHistory(args); return { ok: true, page }; }
          catch (err) { const msg = err instanceof Error ? err.message : String(err); const errorCode = /localDb not ready/i.test(msg) ? 'HOST_NOT_READY' : 'INTERNAL'; return { ok: false, errorCode, message: msg }; }
        },
        listSessions: async (args) => {
          try { const page = await listSessionsForHistory(args); return { ok: true, page }; }
          catch (err) { const msg = err instanceof Error ? err.message : String(err); const errorCode = /localDb not ready/i.test(msg) ? 'HOST_NOT_READY' : 'INTERNAL'; return { ok: false, errorCode, message: msg }; }
        },
        getMessages: async (args) => {
          return readChatHistoryMessages(args, {
            readLocal: getMessagesForHistory,
            invokeRemote: deps.invokeRemote,
          });
        },
        searchChatHistory: async (args) => {
          try { const result = await searchChatHistoryHybrid(args); return { ok: true, result }; }
          catch (err) { const msg = err instanceof Error ? err.message : String(err); const errorCode = /localDb not ready/i.test(msg) ? 'HOST_NOT_READY' : 'INTERNAL'; return { ok: false, errorCode, message: msg }; }
        },
      },
      // submit_github_issue: 官方反馈提交(确认卡片 → serverApiFetch)。
      // holder 同样是延迟查找，registerMakerIpc 里 init。
      githubIssue: (req) => submitGithubIssueForSession(req),
    },
    // cindy_orca: 多 worker 协同 team 工具集。创建权限由 Main handler 实时校验。
    orca: {
      startTeam: wrap((s, params) => s.startTeam(params)),
      createWorker: wrap((s, params) => s.createWorker(params)),
      listWorkers: wrap((s, params) => s.listWorkers(params)),
      switchFocus: wrap((s, params) => s.switchFocus(params)),
      sendToWorker: wrap((s, params) => s.sendToWorker(params)),
      listWorkerQueuedMessages: wrap((s, params) => s.listWorkerQueuedMessages(params)),
      updateWorkerQueuedMessage: wrap((s, params) => s.updateWorkerQueuedMessage(params)),
      cancelWorkerQueuedMessage: wrap((s, params) => s.cancelWorkerQueuedMessage(params)),
      idleWorker: wrap((s, params) => s.idleWorker(params)),
      endTeam: wrap((s, params) => s.endTeam(params)),
      archiveWorker: wrap((s, params) => s.archiveWorker(params)),
      listAvailableModels: wrap((s, params) => s.listAvailableModels(params)),
      getWorkspaceInfo: wrap((s, params) => s.getWorkspaceInfo(params)),
      getWorkerStatus: wrap((s, params) => s.getWorkerStatus(params)),
      readWorker: wrap((s, params) => s.readWorker(params)),
    } as OrcaMcpDeps,
    // xd-service 已于 2026-07-13 整包退役:Pages 全部能力(含部署)迁入内置
    // 意识 xd-pages(登录邮箱派生凭证 + 目录过户上传),经 ghost_call 调用。
  });

  // 用 plugin registry gate 包装每个 provider 的 isEnabled。
  // essential plugin 始终放行；非 essential plugin 按 project → user → default 判定。
  // provider name(如 'lizi_jira') 会先映射成用户可见的 plugin id(如 'jira')。
  const gated = providers.map((p) => {
    const originalIsEnabled = p.isEnabled;
    const pluginId = pluginIdForProviderName(p.name);
    return {
      ...p,
      isEnabled: (ctx: LiziMcpSessionContext) => {
        // Codex 与 Pi 的共享 app-server / bridge 在还没有 thread/workdir 的阶段构建
        // MCP 工具清单。普通工具必须先全部注册，真正调用时由 HTTP bridge 按新会话
        // 冻结的策略阻断；否则某个用户默认会错误地影响所有项目（空 workdir 快照被缓存后，
        // 全局启用但项目停用的工具仍暴露、反向配置则永久缺席，codex review）。机器级工具
        // 仍沿用现有 spawn-time gate + 环境重建语义。
        const deferOrdinaryGate =
          (ctx.agentKind === 'codex' || ctx.agentKind === 'pi')
          && !ctx.workingDir
          && !GLOBAL_PLUGIN_IDS.has(pluginId);
        // Orca 工具面必须在会话生命周期内保持稳定：Claude query 不会在项目策略
        // 动态启用后重建 MCP。创建入口仍由 Main 按调用时的项目策略 fail closed。
        const keepOrcaProviderStable = pluginId === 'collab';
        // Keep the lightweight gateway visible even before the public plugin
        // is installed. Its live call gate returns an actionable install/enable
        // result, while every runtime mutation remains blocked in Main.
        const keepIOSSimulatorGatewayStable = pluginId === 'ios-simulator';
        // Plugin gate：registry 负责 essential / machine / project / user / default 判定。
        if (
          !keepOrcaProviderStable &&
          !keepIOSSimulatorGatewayStable &&
          !deferOrdinaryGate &&
          !pluginRegistry.isEnabled(pluginId, ctx.workingDir)
        ) {
          return false;
        }
        // 继续走原 provider gate，例如 memory manager check、feishu bot source check。
        return originalIsEnabled?.(ctx) ?? true;
      },
    };
  });

  // cindy:意识总机(cindy-tools;网关模式,
  // docs/dev-rules/plugin-security-and-authoring.md;2026-07-12 由 cindy_ghosts 更名——server 名进
  // 工具全名 mcp__<server>__<tool>,短名让调用行少啰嗦一截,历史消息的旧
  // 全名由 shared/ghost.ts isGhostCallToolName 兼容匹配)。常注册不设
  // plugin gate——工具面恒定是缓存前缀稳定的前提,"没装任何意识"表现为
  // ghost_list 返回空清单而非 server 消失,LLM 不困惑、老会话即时生效。
  gated.push({
    name: 'cindy_group_history',
    isEnabled: () => true,
    toClaudeSdkConfig: (ctx) => ({
      type: 'sdk',
      name: 'cindy_group_history',
      instance: createGroupHistoryMcpServer({
        getSessionContext: () => resolveLiziMcpSessionContext(ctx),
      }),
    }),
  });

  gated.push({
    name: 'cindy',
    isEnabled: () => true,
    // ctx 闭包进 deps:claude in-process 路径的 tool-call 没有 ALS 语境,
    // 目录过户(workdir 钳制)与卡片 session 锚定都靠这份按 session 绑定的
    // 语境;codex 路径运行期仍以 ALS 恢复的语境优先(见 getCindyGhostsMcpDeps)。
    toClaudeSdkConfig: (ctx) => ({
      type: 'sdk',
      name: 'cindy',
      instance: createCindyGhostsMcpServer(
        getCindyGhostsMcpDeps(ctx, {
          getLiveSessionGrantState: deps.getLiveSessionGrantState,
        }),
      ),
    }),
  });

  return gated;
}
