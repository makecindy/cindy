/**
 * 对外模型代理(给用户自己的 Claude Code CLI 用)的 preload/main/renderer 共享类型。
 *
 * 安全约束(勿改):
 *   - token 明文只在 `getEnvExample` / `writeExternalConfig` 这两个「用户主动触发」的
 *     出口经 IPC 返回给 renderer(复制到剪贴板 / 写入用户配置需要明文);常态 `getState`
 *     只给 `maskedToken`。
 *   - 写用户 `~/.claude` 配置是外向文件写,必须先 `previewExternalConfig` 展示改动 +
 *     二次确认,再 `writeExternalConfig` 非破坏性 merge。
 */

/** 「对外默认供应商」候选(只投影 id/name,不含任何凭证)。 */
export interface LocalProxyProviderOption {
  id: string;
  name: string;
}

/** 设置页渲染所需的全部非明文状态。 */
export interface LocalProxyServiceState {
  /** 是否已对外开放(默认关闭)。 */
  enabled: boolean;
  /** 当前实际 127.0.0.1 url;proxy 未就绪为 null。 */
  url: string | null;
  /** 固定端口;0 表示未固定(启动时随机)。 */
  port: number;
  /** 是否已生成对外 token。 */
  hasToken: boolean;
  /** 掩码 token(永不把明文交给 renderer 的常态出口)。 */
  maskedToken: string | null;
  /** claude-code 可路由的供应商候选。 */
  providers: LocalProxyProviderOption[];
  /** 已选「对外默认供应商」id;为空表示未选。 */
  defaultProviderId: string;

  // ───────── Codex / 通用 OpenAI 出口(codex loopback,第三期:独立开关 + 独立 token)─────────
  /** B 族是否已对外开放(默认关闭,与 A 族 enabled 独立)。 */
  codexEnabled: boolean;
  /** 是否已生成 B 族独立对外 token。 */
  codexHasToken: boolean;
  /** B 族掩码 token(永不把明文交给 renderer 的常态出口)。 */
  codexMaskedToken: string | null;
  /** codex loopback 当前实际 127.0.0.1 url;未就绪为 null。 */
  codexUrl: string | null;
  /** codex loopback 固定端口;0 表示未固定(启动时随机)。 */
  codexPort: number;
  /** codex agent 可路由的供应商候选(排除 oauth-passthrough 订阅直连)。 */
  codexProviders: LocalProxyProviderOption[];
  /** 已选 codex「对外默认供应商」id;为空表示未选。 */
  codexDefaultProviderId: string;
}

/** 复制 / 写入用的示例环境变量(含明文 token —— 仅用户主动触发时返回)。 */
export interface LocalProxyEnvExample {
  baseUrl: string;
  /** 对外 token 明文(作为 ANTHROPIC_API_KEY,非真供应商 key)。 */
  apiKey: string;
  /** 可直接粘进 shell 运行的 `export KEY=VALUE` 行(供复制;渲染层用换行连接)。 */
  lines: string[];
}

export type LocalProxyEnvExampleResult =
  | { success: true; env: LocalProxyEnvExample }
  | { success: false; error: string };

/** 写入 `~/.claude/settings.json` 前的预览:展示将改动的 env 段与冲突项。 */
export interface LocalProxyConfigPreview {
  /** 目标文件绝对路径。 */
  path: string;
  /** 文件当前是否存在。 */
  exists: boolean;
  /** 将写入的 env 键值。 */
  proposedEnv: Record<string, string>;
  /** 目标里同名但取值不同、将被覆盖的项(用于二次确认提示)。 */
  conflicts: { key: string; current: string; next: string }[];
}

export type LocalProxyConfigPreviewResult =
  | { success: true; preview: LocalProxyConfigPreview }
  | { success: false; error: string };

export type LocalProxyConfigWriteResult =
  | { success: true; path: string }
  | { success: false; error: string };

/**
 * 写入 `~/.codex/config.toml` 前的预览。TOML 结构与 `~/.claude` 的 env 段不同,单独建型。
 * **token 绝不写进文件** —— codex 经 `env_key=CINDY_LOCAL_TOKEN` 从环境变量读;`tokenExportLine`
 * 给出用户需自设的 `export CINDY_LOCAL_TOKEN=<token>`(含明文 token,仅用户主动触发时返回)。
 */
export interface LocalProxyCodexConfigPreview {
  /** 目标文件绝对路径。 */
  path: string;
  /** 文件当前是否存在。 */
  exists: boolean;
  /** merge 后将写入的完整 TOML 文本(供二次确认展示)。 */
  proposedToml: string;
  /** 已有但取值不同、将被覆盖的项(用于二次确认提示)。 */
  conflicts: { key: string; current: string; next: string }[];
  /** 用户需在外部 shell 自设的 token 环境变量行(含明文 token)。 */
  tokenExportLine: string;
}

export type LocalProxyCodexConfigPreviewResult =
  | { success: true; preview: LocalProxyCodexConfigPreview }
  | { success: false; error: string };

/** set-port 入参校验失败等的通用返回(带最新 state 便于 UI 同步)。 */
export type LocalProxyMutationResult =
  | { success: true; state: LocalProxyServiceState }
  | { success: false; error: string; state: LocalProxyServiceState };
