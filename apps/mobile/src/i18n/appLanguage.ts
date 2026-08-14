/**
 * 手动语言 override 桥。
 *
 * i18next 之外还有一批手写多语 catalog(loginMessages / newSessionMessages /
 * fullAccessConfirmation),它们以同步函数形式在渲染期取文案,原本只读系统语言。
 * LocaleProvider 在用户显式选择语言时把 override 写到这里,catalog 侧优先取
 * override、无 override 时照旧读系统语言——保证「设置里切语言」对全部文案面生效。
 *
 * 独立成最小模块(不 import i18next / React)是为了让 catalog 及其测试保持零依赖。
 */

import type { SupportedLocale } from "./locale";

let manualLocaleOverride: SupportedLocale | null = null;

/** LocaleProvider 专用:偏好为 'system' 时传 null。 */
export function setManualLocaleOverride(locale: SupportedLocale | null): void {
  manualLocaleOverride = locale;
}

export function getManualLocaleOverride(): SupportedLocale | null {
  return manualLocaleOverride;
}
