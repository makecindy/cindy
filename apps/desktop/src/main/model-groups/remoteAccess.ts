/** 模型组接口的桌面来源闸(model-groups.md §6.3)。纯 Node 判定见 remoteAccessCore.ts。 */
import type { IpcMainInvokeEvent } from 'electron';

import { isDeviceLinkInvoke, readDeviceLinkModelSelectionOrigin } from '../device-link/invoke-context.js';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { assertModelGroupsCallerCore } from './remoteAccessCore.js';

/**
 * 本机：可信主界面。远程：只认同账号本人控制的设备(与远程选模型同一判据)；分享来的任务、受限控制端拒绝。
 * 远程传来的选择一律按那台电脑自己的模式解析，去掉位置字段。
 */
export function assertModelGroupsCaller(
  event: IpcMainInvokeEvent,
  deps: { isDeviceLink: () => boolean; origin: () => 'owner' | 'scoped' | undefined; assertTrusted: (event: IpcMainInvokeEvent) => void } = {
    isDeviceLink: isDeviceLinkInvoke,
    origin: readDeviceLinkModelSelectionOrigin,
    assertTrusted: assertTrustedAppRendererEvent,
  },
): void {
  assertModelGroupsCallerCore({
    isDeviceLink: deps.isDeviceLink,
    origin: deps.origin,
    assertLocal: () => deps.assertTrusted(event),
  });
}
