/**
 * myDevicesModel —— 「我的设备」面板里每台设备两个方向控件的纯状态推导(可单测)。
 * ---------------------------------------------------------------------------
 * 每台同账号设备对本机有两条独立关系:
 *  - outbound「我控制它」= 本机本地偏好 controlEnabled(setDeviceControlEnabled)。
 *    对方已拒绝本机 → 置灰 + 原因;对方未开被控 → 开关仍可编辑(本地偏好与对方状态无关),
 *    只附「对方未开启被控」说明、提示对方开启后才生效。
 *  - inbound「允许它控制本机」= 是否在本机黑名单(revokedControllers)的反面。
 *    受顶部「允许被控」总开关闸门约束:总开关关 → 置灰(黑名单状态仍保留)。
 */

import { isMobilePlatform } from '@cindy/maker-shared/device-list';

/**
 * 该平台的设备是否「可被控制」(能作为远程控制目标)。
 * 手机 / 平板(ios / android)是控制端,**不具备被控能力**(移动端硬编码 remoteControlEnabled=false),
 * 故不展示「我控制它」选项;桌面端(darwin / win32 / linux)即使当前关了被控,仍是可控目标。
 *
 * 与切换栏同口径(isMobilePlatform 的反面):只有手机 / 平板不可被控,**平台未知 / 旧记录 platform=null**
 * 都按可被控处理 —— 否则切换栏(只排除 ios/android)把 null-platform 桌面设备当可控、能连上,设置页却因
 * 白名单漏了 null 而藏掉「我控制它」,出现「能连不能管」的不一致。
 */
export function canBeControlledPlatform(platform: string | null): boolean {
  return !isMobilePlatform(platform);
}

/**
 * 「我控制它」开关状态(仅在该行**显示时**调用 —— 对方已拒绝本机时整行不渲染,见 MyDevicesPanel:
 * 不让用户看到一个"控不了"的选中态而纠结)。开关恒可编辑:controlEnabled 是本机的本地偏好
 * (想不想控这台),与对方当前是否开被控无关 —— 让用户能提前 opt-in/out,避免对方一开被控就按默认值
 * 自动接回。对方未开被控时附「对方未开启被控」说明文字,提示"等对方开启后你的设置才生效"。
 */
export function controlToggleState(
  device: { remoteControlEnabled: boolean; controlEnabled: boolean },
): { checked: boolean; reason: 'peer-off' | null } {
  return {
    checked: device.controlEnabled,
    reason: device.remoteControlEnabled ? null : 'peer-off',
  };
}

/** 「允许它控制本机」开关状态(总开关关 → 置灰,但黑名单值照旧)。 */
export function inboundToggleState(
  masterEnabled: boolean,
  isRevokedController: boolean,
): { checked: boolean; disabled: boolean } {
  return { checked: !isRevokedController, disabled: !masterEnabled };
}

/** 连接问题原因行的显示规则。unstable 描述跨连接抖动,即使当前短暂 online 也保留。 */
export function resolveActiveConnectionIssue<T extends { kind: string }>(
  linkStatus: 'stopped' | 'connecting' | 'online',
  issue: T | null,
): T | null {
  if (!issue) return null;
  if (issue.kind === 'unstable') return issue;
  return linkStatus === 'online' ? null : issue;
}
