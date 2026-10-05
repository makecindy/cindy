/**
 * Codex 重置自动使用 —— main / renderer 共享的常量与 IPC 形状。
 *
 * 行为正本在 main/usage/codexResetCreditAutoUse.ts；这里只放 main 与 renderer 共用的
 * 字面量和 IPC 形状，避免 renderer 反向依赖 main 模块。
 */

/** 自动续跑记录的 reason：续跑前先用掉了一次 Codex 重置。定义在两端共享的 maker-shared。 */
export { CODEX_RESET_CREDIT_RESUME_REASON } from '@cindy/maker-shared/synthetic-trigger';

/** 某个 OpenAI 订阅账号的自动使用开关状态（设置页读写）。 */
export interface CodexResetCreditAutoUseState {
  providerId: string;
  enabled: boolean;
  /** 用户是否显式拨过开关；false = 跟随默认值。 */
  isCustomized: boolean;
  defaultEnabled: boolean;
}
