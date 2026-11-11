// 非自建 EAS / TestFlight 手动更新的隐私同意闸门。
//
// 这些渠道仍由 expo-updates 携带单安装 eas-client-id，因此保留 #3359 的 consent 闸门。
// 自建 OTA 已改由 otaRequestCoordinator 在每次网络事务前覆盖全设备共享 UUID，不再复用
// analytics consent。TapDB 自身仍以 analyticsConsentStore 为唯一真相，本文件不修改它。
//
// 这里只保留语义别名，不新增或修改任何 consent 存储；hydrate / subscribe 导出继续
// 保持兼容，当前更新链只有设置页的非自建手动检查读取同步状态。

import {
  getAnalyticsConsentState,
  hydrateAnalyticsConsent,
  subscribeAnalyticsConsent,
} from '@/analytics/analyticsConsentStore';

/** hydrate analytics consent，读取失败语义由底层 store 统一收敛。 */
export async function hydratePrivacyConsent(): Promise<boolean> {
  await hydrateAnalyticsConsent();
  return getAnalyticsConsentState().consent;
}

/** hydrate 之后可同步读;未 hydrate 时按未同意(fail-closed)。 */
export function hasPrivacyConsent(): boolean {
  return getAnalyticsConsentState().consent;
}

/** 保留 analytics consent 的同源订阅，不维护第二份同意状态。 */
export function subscribePrivacyConsent(listener: () => void): () => void {
  return subscribeAnalyticsConsent(listener);
}
