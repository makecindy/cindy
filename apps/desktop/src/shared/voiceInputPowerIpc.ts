/**
 * 语音输入保活麦克风的电源事件契约(main → renderer 单向推送)。
 *
 * 放在 shared 是因为 main 广播端、preload bridge 与 renderer 订阅端必须共用同一
 * channel 名与 payload 形状;任意一处漂移都会退化成「订阅存在但永远收不到」的
 * 静默失效,而不是编译期错误。
 */

/** main → renderer 推送 channel。 */
export const VOICE_INPUT_POWER_STATE_CHANNEL = 'voice-input:power-state-change';

/**
 * 触发释放保活麦克风的系统电源事件。
 *
 * 只收录「用户已经离开」的事件。resume / unlock-screen 不在此列:回来后是否重新
 * 预热由 renderer 既有的 prewarm 路径决定,不需要额外推送来驱动。
 */
export type VoiceInputPowerReleaseReason = 'system_suspend' | 'screen_locked';

export interface VoiceInputPowerStatePayload {
  reason: VoiceInputPowerReleaseReason;
}
