// 隐私同意闸门(更新链路复用版)。
//
// 更新检查(manifest / OTA 资源)在用户同意《隐私政策》前不得联网:expo-updates
// 原生层会在每次请求里携带稳定的 eas-client-id(可关联安装标识),属于「未经同意
// 收集、传输个人信息」的隐私合规风险。同意状态的本机真相就是 analyticsConsentStore
// 的 consent 字段(「用户是否明示同意过《隐私政策》」),这里只做语义别名,不新增
// 存储、不重复维护第二份同意标记——同一台设备不该出现「统计已同意、更新却未同意」
// 或反向的不一致。
//
// 原生层已通过 checkAutomatically:'NEVER' 关闭自动联网,唯一的 /manifest 泄漏源是
// JS 手动 checkForUpdateAsync();在 JS 层用本闸门前置拦截即可根治,无需动原生配置。

import {
  getAnalyticsConsentState,
  hydrateAnalyticsConsent,
  subscribeAnalyticsConsent,
} from '@/analytics/analyticsConsentStore';

/** 冷启动 hydrate 一次,返回是否已同意。读取失败一律 fail-closed 到 false。 */
export async function hydratePrivacyConsent(): Promise<boolean> {
  await hydrateAnalyticsConsent();
  return getAnalyticsConsentState().consent;
}

/** hydrate 之后可同步读;未 hydrate 时按未同意(fail-closed)。 */
export function hasPrivacyConsent(): boolean {
  return getAnalyticsConsentState().consent;
}

/**
 * 订阅同意状态变化(登录页 acceptPrivacyConsent 翻 true、登出 clearAnalyticsConsent
 * 翻 false 都会触发)。自建线「首启未同意 → 进程内同意」时,调用方需要据此补配置
 * OTA URL,否则设置页手动检查 / resume 静默检查会拿动态 true 却仍打占位地址。
 */
export function subscribePrivacyConsent(listener: () => void): () => void {
  return subscribeAnalyticsConsent(listener);
}
