/**
 * 对外模型代理(给用户自己的 Claude Code CLI 用)的 preload/main/renderer 共享类型。
 *
 * 安全约束(勿改):
 *   - **token 明文绝不回传 renderer**。复制到剪贴板由 main 侧完成(`copy*` 通道在主进程
 *     `clipboard.writeText` 写明文,只回 `{success}`);写用户配置的明文 token 也只在 main
 *     侧落文件。renderer 常态只拿 `maskedToken`,预览里的 token 段一律掩码。
 *     (`assertTrustedAppRendererEvent` 只验来源帧、不验用户手势,所以哪怕来源可信也不把
 *     明文交给 renderer —— 被注入的渲染进程无法把它读出来外泄。)
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

/**
 * 主进程侧「复制到系统剪贴板」的结果。明文(token / 完整 env 行 / token export 行)只在 main
 * 里经 `clipboard.writeText` 落剪贴板,**绝不随此结果回传 renderer** —— 只回成功与否。
 */
export type LocalProxyCopyResult =
  | { success: true }
  | { success: false; error: string };

/** 写入 `~/.claude/settings.json` 前的预览:展示将改动的 env 段与冲突项。 */
export interface LocalProxyConfigPreview {
  /** 目标文件绝对路径。 */
  path: string;
  /** 文件当前是否存在。 */
  exists: boolean;
  /** 将写入的 env 键值(**展示用**:其中 `ANTHROPIC_API_KEY` 为掩码;真实明文只在 main 落文件)。 */
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
 * 给出用户需自设的 `export CINDY_LOCAL_TOKEN=<token>`,但**展示用为掩码**(真实明文复制走
 * main 侧 `copyCodexTokenExport` 剪贴板通道)。
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
  /** 用户需在外部 shell 自设的 token 环境变量行(**掩码展示**;真实明文走 main 剪贴板通道)。 */
  tokenExportLine: string;
}

export type LocalProxyCodexConfigPreviewResult =
  | { success: true; preview: LocalProxyCodexConfigPreview }
  | { success: false; error: string };

/** set-port 入参校验失败等的通用返回(带最新 state 便于 UI 同步)。 */
export type LocalProxyMutationResult =
  | { success: true; state: LocalProxyServiceState }
  | { success: false; error: string; state: LocalProxyServiceState };
