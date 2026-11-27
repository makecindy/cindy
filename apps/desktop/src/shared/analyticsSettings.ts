/**
 * 使用统计(TapDB)同意闸的跨进程协议类型。
 *
 * 真相在 main(<userData>/analytics-settings.json),renderer 只消费 `allowed`
 * 这个结论,不自行推导「同意 && 开关」。
 */

export interface AnalyticsSettingsPayload {
  /** 用户是否已明示同意《隐私政策》。 */
  privacyConsentAccepted: boolean;
  /** 同意之后的统计开关(opt-out),默认开启。 */
  analyticsEnabled: boolean;
  /** 用户是否显式设置过开关(盘上有 override)。false = 跟随当前默认值。 */
  analyticsEnabledCustomized: boolean;
  /**
   * 是否允许初始化 TapDB / 继续上报
   * = isReportingBuild() && privacyConsentAccepted && analyticsEnabled。
   * isReportingBuild = packaged 构建,或 dev 下显式 XDT_TAPDB_DEV=1。
   * 构建闸的理由见 main/analytics-settings-store.ts。
   */
  allowed: boolean;
  /**
   * 是否需要请用户确认更新后的《服务条款》《隐私协议》
   * = privacyConsentAccepted && 本机记录的同意版本 ≠ 当前版本(shared/legalTermsVersion)。
   * 只对已同意过旧版的人为 true;renderer 只在个人账号已登录时据此弹出确认。
   */
  legalTermsUpdateRequired: boolean;
}

export const ANALYTICS_SETTINGS_CHANGE_CHANNEL = 'analytics:settings-change';
