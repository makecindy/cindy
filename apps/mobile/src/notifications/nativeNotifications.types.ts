/**
 * 移动推送真正用到的 expo-notifications 接口面(纯类型,不产生任何运行期 import)。
 *
 * 这里刻意只列**已在用**的成员:Android 侧的实现(`nativeNotifications.android.ts`)
 * 必须逐个补齐,新增调用点时漏补会直接 typecheck 失败,不会静默漏到运行期。
 * 用 `typeof import(...)` 而不是 `import type * as`,保证本文件编译后为空模块,
 * Android bundle 不会因为它而牵进 expo-notifications。
 */
export type NativeNotificationsApi = Pick<
  typeof import('expo-notifications'),
  | 'setNotificationHandler'
  | 'getPermissionsAsync'
  | 'requestPermissionsAsync'
  | 'getDevicePushTokenAsync'
  | 'addPushTokenListener'
  | 'addNotificationResponseReceivedListener'
  | 'getLastNotificationResponseAsync'
  | 'clearLastNotificationResponseAsync'
>;
