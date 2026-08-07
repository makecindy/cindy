/**
 * 客户端日志上报的跨进程契约（main / preload / renderer 共用）。
 *
 * 真相全部在 main：授权闸、上报目标是否配置、开关的 override 状态都由 main 判定，
 * renderer 只消费结论（`available` / `crashAutoUploadEnabled` / `...Customized`），
 * 不自行推导「已同意 && 已配置」。
 *
 * 需求与设计见 `docs/client-log-upload-requirements.md`、
 * `docs/client-log-upload-implementation-plan.md`。
 */

/** 一次上报的触发原因。后台按它区分手动报障与崩溃现场。 */
export type LogUploadReason = 'manual' | 'crash-immediate' | 'crash-backfill';

export interface LogUploadSettingsPayload {
  /**
   * 本构建是否配置了上报目标。false = 功能整体静默关闭（等同未启用）：
   * 入口不可用，且任何路径都不会产生一个字节。
   */
  targetConfigured: boolean;
  /** 用户是否已明示同意《隐私政策》（复用使用统计那份事实记录，不是新的一份）。 */
  privacyConsentAccepted: boolean;
  /** 「崩溃时自动上传日志」开关。默认关闭。 */
  crashAutoUploadEnabled: boolean;
  /** 用户是否显式设置过该开关（盘上有 override）。false = 跟随当前版本默认值。 */
  crashAutoUploadCustomized: boolean;
  /**
   * 手动上传当前是否可用 = `targetConfigured && privacyConsentAccepted`。
   * 刻意**不看**「使用统计」开关——那是行为埋点的偏好，与排障上传不是一件事。
   */
  manualUploadAvailable: boolean;
}

/** 手动上传成功的结果。编号短、可读，用户报障时口述给我们。 */
export interface LogUploadResult {
  uploadCode: string;
  /** 本次实际上报的记录条数（>0；为 0 时走 LOG_UPLOAD_EMPTY 错误路径）。 */
  recordCount: number;
}

export const LOG_UPLOAD_SETTINGS_CHANGE_CHANNEL = 'log-upload:settings-change';

/**
 * 上传编号的字符集：Crockford base32 去掉易混字符（I / L / O / U）与 0 / 1。
 * 用户要能在群里口述出来，所以不能出现 0/O、1/I/L 这类读音或字形冲突。
 */
export const UPLOAD_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 编号总长度（不含分隔符）。8 位 × 30 字符集 ≈ 6.6e11 组合，足够避免口述冲突。 */
export const UPLOAD_CODE_LENGTH = 8;

/** `XXXX-XXXX`：分组让用户读得准、抄得对。 */
export function formatUploadCode(raw: string): string {
  return raw.length <= 4 ? raw : `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

/** 校验一个字符串是否是本协议产出的编号形态（用于测试与日志自检）。 */
export function isFormattedUploadCode(value: string): boolean {
  const pattern = new RegExp(
    `^[${UPLOAD_CODE_ALPHABET}]{4}-[${UPLOAD_CODE_ALPHABET}]{${UPLOAD_CODE_LENGTH - 4}}$`,
  );
  return pattern.test(value);
}
