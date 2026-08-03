/**
 * Device Link 的 maker:set-model 参数兼容。
 *
 * JSON 数组无法保留 undefined：中间的可选参数会变成 null，尾部的可选参数
 * 也会留下一个多余的 null。这里仅把 Device Link wire 层的两个可选占位
 * 归一化回本地 IPC handler 期望的 undefined；本地 IPC 不应调用此 helper。
 */
export function normalizeDeviceLinkSetModelWireArgs(
  isDeviceLink: boolean,
  expectedAgentSwitchRevision: unknown,
  selection: unknown,
): {
  expectedAgentSwitchRevision: unknown;
  selection: unknown;
} {
  if (!isDeviceLink) {
    return { expectedAgentSwitchRevision, selection };
  }
  return {
    expectedAgentSwitchRevision:
      expectedAgentSwitchRevision === null ? undefined : expectedAgentSwitchRevision,
    selection: selection === null ? undefined : selection,
  };
}
