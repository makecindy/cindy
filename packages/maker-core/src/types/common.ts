/**
 * Common types shared across maker-core.
 *
 * 命名 / 字段语义对齐现有 apps/desktop/src/main/vendor/types.ts (v1.0 frozen)，
 * 故意保持兼容以便 desktop adapter 层零代码翻译。
 */

export type AgentKind = 'claude-code' | 'codex' | 'pi';
export type WorkspaceKind = 'project' | 'dialogue';

/**
 * Effort —— 全集 union，含历史持久化值和当前 runtime 支持值。
 *
 * 各 agent 实际能传哪些列在 capabilities.effortLevels（且随具体模型能力而定）：
 *   - Claude: low | medium | high | xhigh | max
 *   - Codex:  low | medium | high | xhigh | max | ultra
 *     （max/ultra 仅部分模型支持，如 GPT-5.6 Sol；旧模型仍只到 xhigh，由目录 efforts 决定）
 *
 * minimal 由原生支持它的 runtime（Pi，以及部分 Codex 模型）按 capability 暴露；
 * 其他模型收到历史 minimal 值时应按自身语义降级。
 *
 * UI 应该读对应 agent 的 capabilities.effortLevels 渲染下拉，避免传不支持的值。
 */
export type Effort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';

/**
 * Permission 5 态（Claude Code 完整集合）。
 * Codex 只支持子集 (ask / auto / bypassPermissions) — 其他抛 NotSupportedError。
 */
export type PermissionMode =
  | 'ask'
  | 'default'
  | 'acceptEdits'
  | 'plan'
  | 'auto'
  | 'bypassPermissions';

export type ReasoningDisplay = 'off' | 'summarized' | 'full';

/**
 * 用户消息 content block。
 * - text: 任何 agent 都支持
 * - image/file: host 归一化为本地路径后，由各 agent adapter 决定注入方式
 * - mention: 输入框 @ 资源引用；具体注入方式由各 agent adapter 决定
 */
export type UserContentBlock =
  | { type: 'text'; text: string }
  | {
      type: 'image';
      /** Filesystem location used by the harness to read image bytes. */
      path: string;
      /** Host-managed identity exposed for attachment-taking tools. */
      managedUrl?: string;
      mimeType?: string;
      pathOrigin?: 'desktop-host';
    }
  | { type: 'file'; path: string; mimeType?: string }
  | { type: 'mention'; name: string; path: string; kind?: 'file' | 'dir' | 'agent' };

export interface UserMessage {
  type: 'user';
  content: string | UserContentBlock[];
}

export interface AuthState {
  authenticated: boolean;
  identity?: string;
  expiresAt?: number;
  errorReason?: string;
  authSource?: 'oauth' | 'api-key';
  oauthWritesBlocked?: boolean;
  /**
   * Codex OAuth 凭证当前的物理存储范围。
   *
   * - system-shared: Cindy 的 auth.json 与本机 ChatGPT/Codex App 共用同一文件。
   * - instance-isolated: Cindy 使用自己的独立 auth.json。
   * - unknown: 凭证已失效/丢失，无法可靠回推失效前的范围。
   *
   * 其它 agent 不返回该字段。
   */
  credentialScope?: 'system-shared' | 'instance-isolated' | 'unknown';
  /** Local-only Codex credential topology. Additive; older renderers may ignore it. */
  credentialDiagnostics?: {
    linkType: 'symlink' | 'hardlink' | 'file' | 'missing' | 'dangling-symlink' | 'unknown';
    healthy: boolean;
    devReadOnly: boolean;
    systemAuthMtimeMs?: number;
    systemAuthLinkCount?: number;
    orphanRepair?: 'none' | 'relinked' | 'failed';
  };
  /**
   * A replacement Codex OAuth credential exists locally but must pass an account-level RPC before
   * UI may declare the previous invalidation recovered.
   */
  recoveryRequiredReason?: string;
}
