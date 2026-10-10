/**
 * 受邀者(供应商分享的另一个账号)在本机运行的 Codex 托管会话。
 *
 * 文件、命令与 Cindy 工具经隧道回到受邀者电脑；本机只出 Agent、登录与供应商。本机用户
 * 自己的配置与可在本机执行代码的能力不进入这个会话：插件、hooks、connectors(apps)、
 * 本机技能与 MCP、会读写本机 Codex 记忆的 memories、在本机进程里跑代码或操控本机的工具
 * (js_repl、code mode 宿主、浏览器、电脑操控)。全局说明与历史由独立的 CODEX_HOME(受邀者目录)隔开；
 * 项目说明经执行环境从受邀者电脑读取(与同账号一致，不沿本机影子目录向上找)。
 * Codex 功能按白名单开放(CODEX_DEVICE_HOSTED_GUEST_KEPT_FEATURES)，Codex 升级新增的功能不会自动
 * 开放给受邀者；联网搜索由模型服务方执行，保持可用。供应商只用分享给受邀者的那一个：不升格为带本机
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

/**
 * 受邀者线程可以保持开启的 Codex 功能(白名单)。其余功能一律在线程配置里写 false：本机默认开着的、
 * 本机或项目配置打开的、Codex 升级新增的都一样。启动时从 app-server 取完整的功能清单
 * (experimentalFeature/list)，名单外的逐个关闭，见 codexGuestFeatureOverrides。
 *
 * 留下的：命令、补丁与看图(经执行环境在受邀者电脑上执行)，shell 快照(由执行环境在受邀者电脑上
 * 按受邀者自己的 shell 配置生成，关掉会让命令缺少 .zshrc 等设置的 PATH)，子代理，技能搜索，等待，
 * 审批与提问，目标与 Fast，以及连接、鉴权、上下文压缩本身需要的。生图不在内：它能按本机路径读参考图。
 */
export const CODEX_DEVICE_HOSTED_GUEST_KEPT_FEATURES: ReadonlySet<string> = new Set([
  'shell_tool', 'unified_exec', 'unified_exec_tty', 'write_stdin_approval', 'view_image', 'shell_snapshot',
  'multi_agent', 'multi_agent_v2', 'skill_search', 'sleep_tool', 'mentions_v2',
  'guardian_approval', 'guardian_reuse_parent_compaction', 'auth_elicitation', 'tool_call_mcp_elicitation',
  'goals', 'fast_mode',
  'secret_auth_storage', 'enable_request_compression', 'system_proxy_fallback', 'unbounded_connection_retries',
  'content_item_kinds', 'compaction_image_budget',
]);

/** experimentalFeature/list 里的一项(只用到这几个字段)。 */
export interface CodexFeatureState {
  name: string;
  stage: string;
  enabled: boolean;
}

/** 取完整的功能清单(逐页)。清单拿不到或格式不对就抛错：确认不了哪些功能开着，就不启动受邀者会话。 */
export async function listCodexFeatures(
  requestPage: (cursor: string | undefined) => Promise<unknown>,
): Promise<CodexFeatureState[]> {
  const features: CodexFeatureState[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 50; page += 1) {
    const response = await requestPage(cursor) as { data?: unknown; nextCursor?: unknown } | null | undefined;
    if (!response || !Array.isArray(response.data)) throw new Error('Codex returned no feature list.');
    for (const item of response.data as Array<Record<string, unknown> | null>) {
      if (!item || typeof item.name !== 'string' || typeof item.stage !== 'string' || typeof item.enabled !== 'boolean') {
        throw new Error('Codex returned a feature entry Cindy cannot read.');
      }
      features.push({ name: item.name, stage: item.stage, enabled: item.enabled });
    }
    if (typeof response.nextCursor !== 'string' || response.nextCursor.length === 0) {
      if (features.length === 0) throw new Error('Codex returned an empty feature list.');
      return features;
    }
    cursor = response.nextCursor;
  }
  throw new Error('Codex returned too many feature pages.');
}

/**
 * 受邀者线程的功能关闭项：名单外的功能都写 false(不论现在是否开着，项目配置也打不开)。
 * 已移除的开关不再起作用，跳过；已弃用的开关可能映射到别的配置，只关现在开着的。
 */
export function codexGuestFeatureOverrides(features: readonly CodexFeatureState[]): Record<string, false> {
  const out: Record<string, false> = {};
  for (const feature of features) {
    if (CODEX_DEVICE_HOSTED_GUEST_KEPT_FEATURES.has(feature.name)) continue;
    if (feature.stage === 'removed') continue;
    if (feature.stage === 'deprecated' && !feature.enabled) continue;
    out[`features.${feature.name}`] = false;
  }
  return out;
}

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
