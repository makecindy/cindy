import { withAvailabilityPolicyMutation } from './providerShareAvailabilityPolicy.js';
/**
 * device-link-settings-store —— 跨设备远程控制的 main 端持久化设置。
 *
 * 文件: <userData>/device-link-settings.json
 *
 * 字段:
 *  - remoteControlEnabled: 「允许同账号设备控制本机」全局开关,默认 false(授权语义:
 *    开关打开即授权,同账号设备无需逐次批准;详见 device-link 设计稿)
 *  - revokedControllers: 逐设备访问黑名单(被撤销访问权限的控制端 deviceId 列表)。
 *    全局开着时,名单内的设备单独被挡;持久化,被控端重启 / 离线后仍生效(恢复才解除)。
 *  - disabledControlDeviceIds: 本机不再主动控制的目标设备 deviceId 列表。它只影响本机
 *    控制其它设备的镜像 / 入口,不改变对方的被控授权。
 *  - lastKnownDeviceNames: 本机最后一次看见的有效设备名缓存。relay 离线后 Redis presence
 *    消失,DB 里只有用户手动重命名 name;未重命名设备会回落 unknown/no,这里用于本地补齐展示名。
 *
 * 模式对齐 maker-host/collaboration-settings-store.ts:同步 IO + tmp+rename 原子写 + 内存缓存。
 *
 * 多实例语义:多个实例共享同一 userData 时本文件也是共享的(device-link 单持有者
 * 仲裁场景,见 ./ownership.ts)。缓存按文件 mtime 失效——任何实例写入后,其它实例
 * 下一次 read 会检测到 mtime 变化并从盘上重载,保证被动实例改的授权(允许被控开关 /
 * 撤销控制端)能被持有 relay 连接的实例看到;持有者对变化的响应轮询在 index.ts。
 */

import { app } from 'electron';
import { createDeviceLinkSettingsStore } from "./settings-store.js";
export type * from "./settings-store.js";
export const { readDeviceLinkSettings, onDeviceLinkSettingChanged, updateDeviceLinkSetting, writeDeviceLinkSetting, readLastKnownDeviceNames, writeLastKnownDeviceNames, setDeviceControlEnabled, rememberLastKnownDeviceName, forgetLastKnownDeviceName, normalizeCachedDeviceName, isPlaceholderDeviceName, __testing } = createDeviceLinkSettingsStore({
getUserDataDir: () => app.getPath('userData'), withAvailabilityPolicyMutation,
});
