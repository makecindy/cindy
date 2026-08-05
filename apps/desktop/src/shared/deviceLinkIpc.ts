/**
 * device-link(跨设备远程控制)的 IPC channel 常量。
 * main / preload / renderer 共用,禁止 hardcode 字符串。
 */

/** renderer → main invoke */
export const DEVICE_LINK_INVOKE = {
  /** 本机状态:{ remoteControlEnabled, linkStatus } */
  GET_STATE: 'device-link:get-state',
  /** 切换「允许同账号设备控制本机」开关 */
  SET_ENABLED: 'device-link:set-enabled',
  /** 切换「保持电脑唤醒」开关(本机 powerSaveBlocker,防休眠、允许锁屏) */
  SET_KEEP_AWAKE: 'device-link:set-keep-awake',
  /** 控制端本地偏好:切换是否主动控制某个目标设备 */
  SET_DEVICE_CONTROL_ENABLED: 'device-link:set-device-control-enabled',
  /** 同账号设备列表(REST 经 main 转发,带 online/busy/开关三态) */
  LIST_DEVICES: 'device-link:list-devices',
  /** 重命名设备 */
  RENAME_DEVICE: 'device-link:rename-device',
  /** 删除离线设备档案 */
  DELETE_DEVICE: 'device-link:delete-device',
  // —— 控制端:远程会话视图用 ——
  /** 与目标设备建立控制链路(进入远程设备视图时) */
  OPEN_LINK: 'device-link:open-link',
  /** 解除控制链路(离开远程设备视图时) */
  CLOSE_LINK: 'device-link:close-link',
  /** 对目标设备远程调用一个 allowlist 内的 maker/local-db channel */
  INVOKE: 'device-link:invoke',
  /** 控制端:订阅被控端某 topic 的变更推送(push 驱动侧边栏 / 会话视图);
   *  注意与隧道 channel `device-link:subscribe` 区分:这是 renderer→main 本地 IPC,
   *  main 再封成隧道 invoke 帧发给被控端 */
  SUBSCRIBE: 'device-link:topic-subscribe',
  /** 控制端:取消订阅某 topic */
  UNSUBSCRIBE: 'device-link:topic-unsubscribe',
  /** 被控端:一键断开当前所有控制链路 */
  DISCONNECT_ALL: 'device-link:disconnect-all',
  /** 被控端:撤销某控制端的访问权限(逐设备黑名单,持久化) */
  REVOKE: 'device-link:revoke',
  /** 被控端:恢复某控制端的访问权限 */
  RESTORE: 'device-link:restore',
} as const;

/** main → renderer push */
export const DEVICE_LINK_PUSH = {
  /** 同账号某设备 presence 变化(上线/下线/开关/busy),payload: PresenceSnapshot */
  PRESENCE_CHANGED: 'device-link:presence-changed',
  /** 本机 relay 连接状态变化,payload: { status: 'stopped'|'connecting'|'online' } */
  STATUS_CHANGED: 'device-link:status-changed',
  /**
   * 本机 relay 连接问题变化(鉴权失效/被顶号/超限/版本不符;null = 已恢复)。
   * payload: { issue: DeviceLinkConnectionIssue | null }
   */
  CONNECTION_ISSUE: 'device-link:connection-issue',
  /**
   * 控制端:被控端转发回来的 renderer 广播(maker:event / local-db:* 等)。
   * payload: { deviceId, channel, payload } —— deviceId 是来源被控端,
   * renderer 据此把事件路由到对应远程设备的 store。
   */
  REMOTE_PUSH: 'device-link:remote-push',
  /**
   * 被控端可见性:本机正在被哪些控制端控制(状态条 chip)。
   * payload: { controllers: Array<{ deviceId, name }> },空数组 = 未被控制。
   */
  CONTROLLED_STATE: 'device-link:controlled-state',
  /**
   * 控制端:被某被控端撤销了访问权限(收到该被控端的 link-close('revoked'))。
   * payload: { deviceId } —— 来源被控端。控制端据此移除其项目/对话 + 标记「已撤销」。
   */
  ACCESS_REVOKED: 'device-link:access-revoked',
  /**
   * 控制端本地偏好变化:某目标设备是否允许被本机主动控制。
   * payload: { deviceId, enabled, disabledControlDeviceIds }
   */
  CONTROL_TARGET_CHANGED: 'device-link:control-target-changed',
  /**
   * 「保持电脑唤醒」开关在另一个共享 userData 的实例里被翻转,main 侧已跟随。
   * payload: { keepAwake: boolean } —— renderer 据此同步开关显示状态。
   */
  KEEP_AWAKE_CHANGED: 'device-link:keep-awake-changed',
} as const;

/** 控制本机的控制端信息(同 main/device-link/dispatch.ts ActiveController) */
export interface ControlledByDevice {
  deviceId: string;
  name: string;
}

/** 本机 relay 连接状态(同 @cindy/device-link 的 DeviceLinkStatus) */
export type DeviceLinkStatus = 'stopped' | 'connecting' | 'online';

/** 连接问题分类(同 @cindy/device-link 的 DeviceLinkConnectionIssueKind) */
export type DeviceLinkConnectionIssueKind =
  | 'auth-failed'
  | 'replaced'
  | 'too-many-connections'
  | 'version-mismatch';

/** 连接问题(同 @cindy/device-link 的 DeviceLinkConnectionIssue) */
export interface DeviceLinkConnectionIssue {
  kind: DeviceLinkConnectionIssueKind;
  closeCode?: number;
  detail?: string;
  at: number;
}

/** 设备识别用的轻量硬件 / 系统信息。 */
export interface DeviceLinkDeviceInfo {
  cpuLabel?: string;
  memoryGb?: number;
  osVersion?: string;
  modelLabel?: string;
}

/** GET_STATE 返回值 */
export interface DeviceLinkState {
  remoteControlEnabled: boolean;
  /**
   * 「保持电脑唤醒」开关(本机本地偏好)。开启后 main 启动 powerSaveBlocker
   * (prevent-app-suspension):系统不休眠、后台 agent 持续运行,但允许显示器熄屏 / 锁屏。
   */
  keepAwake: boolean;
  linkStatus: DeviceLinkStatus;
  /** 当前连接问题(null = 无;变化走 CONNECTION_ISSUE push) */
  connectionIssue: DeviceLinkConnectionIssue | null;
  /** 当前正在控制本机的控制端(被控端可见性初值;后续变化走 CONTROLLED_STATE push) */
  controlledBy: ControlledByDevice[];
  /** 被撤销访问权限的控制端 deviceId 列表(逐设备黑名单,被控端 UI 渲染「已撤销」用) */
  revokedControllers: string[];
  /** 本机主动关闭控制的目标设备 deviceId 列表(控制端本地偏好)。 */
  disabledControlDeviceIds: string[];
}

/** LIST_DEVICES 返回的设备视图(同 server REST DeviceView) */
export interface DeviceLinkDeviceView {
  deviceId: string;
  name: string;
  selfName?: string | null;
  deviceInfo?: DeviceLinkDeviceInfo | null;
  platform: string | null;
  appVersion: string | null;
  lastSeenAt: string | null;
  online: boolean;
  busy: boolean;
  remoteControlEnabled: boolean;
  /** 本机是否允许主动控制该目标设备(控制端本地偏好)。 */
  controlEnabled: boolean;
  isSelf: boolean;
}
