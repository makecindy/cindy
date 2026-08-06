import { PermissionStatus } from 'expo-modules-core';

import type { NativeNotificationsApi } from './nativeNotifications.types';

/**
 * Android 的 expo-notifications 替身(Metro 平台扩展在 `platform === 'android'` 时
 * 顶掉 `nativeNotifications.ts`)。
 *
 * 为什么是替身而不是直接用真模块:见 `nativeNotifications.ts` 的说明——真模块在
 * import 期就要求原生模块存在,而 Android 推送从未实现(`isPushSupported()` 只放行
 * iOS),那颗原生模块只是把 Firebase Messaging / Installations / DataTransport 与消息
 * 权限带进包里。本文件让 Android bundle 完全不引用 expo-notifications。
 *
 * 因此这里的实现只需保证「被 import 不炸」:所有真实调用点都在 `isPushSupported()`
 * 之后,正常路径下一个都不会执行到。行为上取最保守语义(权限拒绝、订阅空实现、
 * 无历史通知),而 `getDevicePushTokenAsync` 直接抛——它没有任何合理的假值可返回,
 * 静默返回空串只会把坏数据发到 server 的注册表。
 *
 * 要给 Android 接推送时:实现应该落在本文件(接国内厂商通道或 FCM),而不是把
 * `isPushSupported()` 放开去用真模块——那会把整条 Google 链重新带回来。
 */

const EMPTY_SUBSCRIPTION = { remove: () => {} };

const DENIED: Awaited<
  ReturnType<NativeNotificationsApi['getPermissionsAsync']>
> = {
  status: PermissionStatus.DENIED,
  expires: 'never',
  granted: false,
  canAskAgain: false,
};

const nativeNotifications: NativeNotificationsApi = {
  setNotificationHandler: () => {},
  getPermissionsAsync: async () => DENIED,
  requestPermissionsAsync: async () => DENIED,
  getDevicePushTokenAsync: async () => {
    throw new Error('Push notifications are not supported on Android');
  },
  addPushTokenListener: () => EMPTY_SUBSCRIPTION,
  addNotificationResponseReceivedListener: () => EMPTY_SUBSCRIPTION,
  getLastNotificationResponseAsync: async () => null,
  clearLastNotificationResponseAsync: async () => {},
};

export default nativeNotifications;
