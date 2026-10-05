/**
 * Codex 重置自动使用 —— main / renderer 共享的常量与 IPC 形状。
 *
 * 行为正本在 main/usage/codexResetCreditAutoUse.ts；这里只放 main 与 renderer 共用的
 * 字面量和 IPC 形状，避免 renderer 反向依赖 main 模块。续跑行的 reason 定义在两端共享的
 * `@cindy/maker-shared/synthetic-trigger`。
 */

/**
 * 配额耗尽中断、但没有用重置时交还给用户的错误 reason：报错横幅据此写明原因。
 *  - SHORT_WINDOW：卡住的是 5 小时等短窗口，周配额还有剩余，稍后自动恢复；
 *  - NONE：周配额用完了，但账号没有可用的重置；
 *  - FAILED：读额度或扣卡没有成功。
 */
export const CODEX_RESET_CREDIT_SKIPPED_SHORT_WINDOW_REASON = 'codex_reset_credit_short_window';
export const CODEX_RESET_CREDIT_SKIPPED_NONE_REASON = 'codex_reset_credit_none';
export const CODEX_RESET_CREDIT_FAILED_REASON = 'codex_reset_credit_failed';

/** 最近一次自动使用重置。 */
export interface CodexResetCreditAutoUseRecord {
  /** 用掉的时刻（毫秒）。 */
  atMs: number;
  /** 'usage-limit'：任务配额耗尽时用的；'expiring'：快过期时用的。 */
  kind: 'usage-limit' | 'expiring';
}

/** 某个 OpenAI 订阅账号的自动使用开关状态（设置页读写）。 */
export interface CodexResetCreditAutoUseState {
  providerId: string;
  enabled: boolean;
  /** 用户是否显式拨过开关；false = 跟随默认值。 */
  isCustomized: boolean;
  defaultEnabled: boolean;
  lastAutoUse: CodexResetCreditAutoUseRecord | null;
}
