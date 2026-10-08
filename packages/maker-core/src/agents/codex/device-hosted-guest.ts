/**
 * 受邀者(供应商分享的另一个账号)在本机运行的 Codex 托管会话。
 *
 * 文件、命令与 Cindy 工具经隧道回到受邀者电脑；本机只出 Agent、登录与供应商。本机用户
 * 自己的配置与可在本机执行代码的能力不进入这个会话：插件、hooks、connectors(apps)、
 * 本机技能与 MCP、会读写本机 Codex 记忆的 memories、在本机进程里跑代码或操控本机的工具
 * (js_repl、code mode 宿主、浏览器、电脑操控)。全局说明与历史由独立的 CODEX_HOME(受邀者目录)隔开；
 * 项目说明经执行环境从受邀者电脑读取(与同账号一致，不沿本机影子目录向上找)。
 * 联网搜索与模型能力保持与同账号托管会话一致。供应商只用分享给受邀者的那一个：不升格为带本机
 * 订阅登录的超集进程，子代理不能指定模型或改道到本机的其它供应商。
 * 只对受邀者生效，同账号托管会话不变。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

const SPAWN_MODEL_OVERRIDES_KEY = 'features.multi_agent_v2.expose_spawn_agent_model_overrides';

/**
 * 去掉让 spawn_agent 指定模型的启动配置(`-c features.multi_agent_v2.expose_spawn_agent_model_overrides=…`)：
 * 受邀者的子代理只能沿用会话模型(Codex 默认不开放这项)。
 */
export function withoutCodexSpawnModelOverrides(args: readonly string[]): string[] {
  const kept: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!;
    const next = args[index + 1];
    if ((value === '-c' || value === '--config') && next?.trim().startsWith(SPAWN_MODEL_OVERRIDES_KEY)) {
      index += 1;
      continue;
    }
    kept.push(value);
  }
  return kept;
}

/**
 * 受邀者线程的固定关闭项(线程级配置覆盖，只关不开)。已用 Codex 0.145.0 / 0.159.2 实测
 * thread/start 接受全部键。不改 project_root_markers：托管时项目说明经执行环境从受邀者电脑读取，
 * 改了会让受邀者丢掉它自己仓库根到工作目录之间的说明文件(真机测试见 device-hosted-guest.native.test)。
 */
export const CODEX_DEVICE_HOSTED_GUEST_THREAD_CONFIG: Readonly<Record<string, unknown>> = Object.freeze({
  // 本机的 hooks(包括插件 hooks)会在本机执行命令。
  'features.hooks': false,
  'features.plugin_hooks': false,
  // 本机用户连接的 connectors / 插件 / 远程插件，以及「建议安装插件或连接器」。
  'features.apps': false,
  'features.plugins': false,
  'features.remote_plugin': false,
  'features.tool_suggest': false,
  // 技能声明的 MCP / 环境变量依赖会提示在本机安装 MCP 服务或填写本机变量。
  'features.skill_mcp_dependency_install': false,
  'features.skill_env_var_dependency_prompt': false,
  // 这些工具在本机进程里执行模型写的代码，或操控本机的浏览器与桌面。
  'features.js_repl': false,
  'features.code_mode': false,
  'features.code_mode_only': false,
  'features.browser_use': false,
  'features.browser_use_external': false,
  'features.in_app_browser': false,
  'features.computer_use': false,
  // Codex 记忆来自本机用户自己的对话；受邀者的对话也不写进去。
  'memories.generate_memories': false,
  'memories.use_memories': false,
});

/** Codex 的用户级说明文件(CODEX_HOME 下)，与 Codex 的读取顺序一致。 */
export const CODEX_USER_INSTRUCTION_FILE_NAMES = ['AGENTS.override.md', 'AGENTS.md'] as const;

/**
 * Codex 总会把 CODEX_HOME 里的 AGENTS.md 作为用户说明发给模型，没有线程级配置能关掉
 * (0.145.0 / 0.159.2 实测：`instructions` 会替换基础提示词而不是用户说明)。受邀者会话使用
 * 受邀者目录作为 CODEX_HOME，这里检查的是实际生效的目录；旧接线没有受邀者目录、仍用本机
 * 用户的 CODEX_HOME 时，本机用户写了全局说明就拒绝启动，不把它交给另一个账号。
 */
export async function assertNoCodexUserInstructions(codexHome: string | null | undefined): Promise<void> {
  if (!codexHome) {
    throw new Error('[REMOTE_AGENT_UNSUPPORTED] Codex did not report its home directory, so Cindy cannot confirm that personal Codex instructions stay on this computer.');
  }
  for (const name of CODEX_USER_INSTRUCTION_FILE_NAMES) {
    let content: string;
    try {
      content = await fs.readFile(path.join(codexHome, name), 'utf8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') continue;
      throw new Error(`Cindy could not check personal Codex instructions on this computer: ${code ?? 'read failed'}`);
    }
    if (content.trim().length > 0) {
      throw new Error(
        '[REMOTE_AGENT_UNSUPPORTED] Codex on this computer has personal global instructions (AGENTS.md), so it is not available to shared users yet.',
      );
    }
  }
}
