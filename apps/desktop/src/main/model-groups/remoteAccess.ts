/** 模型组接口的来源闸(model-groups.md §6.3)。单独成模块：测试与调用方不必加载选路的整条依赖。 */
import type { IpcMainInvokeEvent } from 'electron';

import { isDeviceLinkInvoke, readDeviceLinkModelSelectionOrigin } from '../device-link/invoke-context.js';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { throwIpcError } from '../utils/ipcValidate.js';

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
  if (!deps.isDeviceLink()) {
    deps.assertTrusted(event);
    return;
  }
  if (deps.origin() !== 'owner') throwIpcError('PRECONDITION_FAILED', 'remote model groups require an owner controller');
}
