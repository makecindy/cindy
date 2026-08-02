import { throwIpcError } from '../utils/ipcValidate.js';

export interface CollabProjectPolicyContext {
  workingDir?: string | null;
  workspaceKind?: string | null;
  remoteHostId?: string | null;
  agentKind?: string | null;
}

/**
 * 协同 Team 可由启用 collab 插件的普通 Lead 会话创建,项目与对话都支持;SSH 远端会话 codex 与
 * claude-code 均已接通 —— 远端 agent 经 SSH remote-forward 直连本机 HTTP
 * MCP bridge(codex 走 daemon config 注入 + persistent token,cc 走
 * per-query http 注入 + persistent token 与 ?session= 路由),cindy_orca
 * 在两端都可用。
 *
 * device-link(跨设备远程控制)不需要在这里开任何例外:控制端的 enable-orca
 * 经隧道路由到**被控端**执行,到了那一侧它就是一个普通本地会话
 * (remoteHostId 为空、workingDir 是被控端真实路径),自然走下面对应的项目级或用户级
 * 分支。控制端 renderer 会先隧道读被控端的 collab 开关来置灰入口(见
 * makerTransport.pluginEnableStateFor),那只是体验层的提前告知。
 *
 * 这是主进程的最终授权边界；Renderer 的入口状态只是用户体验层，
 * 不能替代这里的校验。
 */
export function assertCollabProjectEnabled(
  context: CollabProjectPolicyContext,
  isPluginEnabled: (pluginId: 'collab', workingDir?: string) => boolean,
  isManagedDialogueWorkspace: (workingDir: string) => boolean,
): void {
  const workingDir = typeof context.workingDir === 'string' ? context.workingDir.trim() : null;
  if (context.workspaceKind !== 'project' && context.workspaceKind !== 'dialogue') {
    throwIpcError(
      'PRECONDITION_FAILED',
      'collaboration requires a supported lead session',
    );
  }
  // 正常 dialogue 在 createSession 时已经拿到 app 托管的运行目录。这里仍要求非空,
  // 防止损坏/legacy 行把空 cwd 带进 Worker bootstrap;区别只在它不参与项目级策略查询。
  if (workingDir === null || workingDir === '') {
    throwIpcError('PRECONDITION_FAILED', 'collaboration requires a session working directory');
  }

  // 远端会话的 workingDir 是远端机器上的路径, 在本机 fs 上查项目级插件配置
  // (.cindy/plugins.json) 没有意义 —— 命中同路径的本机目录会误判, 查不到又
  // 会误拒。远端项目级 collab 配置暂无对应机制; 协同边界由 "session 已在
  // 远端建立" + bridge 注入白名单 (cindy_orca / orca_worker_bridge) 兜底。
  // 但用户级/全局级 collab 开关 (registry Tier 4, 不依赖 workingDir) 对远端
  // 同样有效 — 用户全局禁用 Collab 时远端会话一样拒绝, 与本地行为一致。
  // TODO(follow-up): 远端项目级 collab 开关 (远端 fs 的 .cindy/plugins.json
  // 或 per-host 设置) 有需求时再做。
  if (context.remoteHostId) {
    if (!isPluginEnabled('collab')) {
      throwIpcError('PRECONDITION_FAILED', 'collaboration is disabled for this session');
    }
    return;
  }

  // 只有 Main 能确认属于 app 托管 dialogue root 的运行目录才跳过项目级策略。
  // workspaceKind 来自会话创建输入,不能单独作为授权依据:显式绑定真实目录的 dialogue
  // 仍需尊重该目录的 `.cindy/plugins.json`,否则伪造 kind 就能绕过项目级禁用。
  if (context.workspaceKind === 'dialogue' && isManagedDialogueWorkspace(workingDir)) {
    if (!isPluginEnabled('collab')) {
      throwIpcError('PRECONDITION_FAILED', 'collaboration is disabled for this session');
    }
    return;
  }

  if (!isPluginEnabled('collab', workingDir)) {
    throwIpcError('PRECONDITION_FAILED', 'collaboration is disabled for this session');
  }
}
