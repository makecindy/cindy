import * as Notifications from 'expo-notifications';

import type { NativeNotificationsApi } from './nativeNotifications.types';

/**
 * expo-notifications 的接入点(iOS / Web / 单测走本文件;Android 由
 * `nativeNotifications.android.ts` 按 Metro 平台扩展顶掉)。
 *
 * 为什么要这层间接:expo-notifications 的 JS 入口在 **import 期**就
 * `requireNativeModule('ExpoNotificationsEmitter')`(见其
 * `build/NotificationsEmitterModule.native.js`),原生模块缺失即抛。而移动推送只实现了
 * iOS(APNs,见 `pushNotifications.ts` 的 `isPushSupported`),Android 从未走通:
 * 仓内没有 `google-services.json`,拿不到 FCM token,原生模块纯属搭载——却把
 * Firebase Messaging / Installations / DataTransport 与相关消息权限一整条链带进了包。
 *
 * 把 import 收进本模块后,Android bundle 里不会再出现 expo-notifications,
 * 该原生模块可以被安全剥离(是否剥离由出包侧决定,与本层解耦无关)。
 *
 * 与 `platform/appDistribution.ts` 的平台扩展方向相反(那里基础文件是兜底、
 * `.ios.ts` 才是原生):这里基础文件必须是真模块,才能让 iOS、Web 与 node 单测
 * (mock 'expo-notifications')都走真实接线,只有 Android 需要被顶掉。
 */
const nativeNotifications: NativeNotificationsApi = Notifications;

export default nativeNotifications;
