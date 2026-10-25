/**
 * Device Link 的 maker:set-model 参数兼容。
 *
 * JSON 数组无法保留 undefined：中间的可选参数会变成 null，尾部的可选参数
 * 也会留下一个多余的 null。这里把 Device Link wire 层的可选占位归一化回
 * 本地 IPC handler 期望的 undefined；本地 IPC 不应调用此 helper。
 *
 * `providerId: null` 的语义由控制端 capability 决定：旧控制端没有能力声明时，
 * 它一律是 JSON positional 占位并还原成 undefined；新控制端明确声明能力后，
 * null 才表示清除 provider。revision / selection 的 null 在 Device Link 中始终
 * 是 optional 占位。
 */
export function normalizeDeviceLinkSetModelWireArgs(
  isDeviceLink: boolean,
  controllerSupportsExplicitProviderNull: boolean,
  providerId: unknown,
  expectedAgentSwitchRevision: unknown,
  selection: unknown,
): {
  providerId: unknown;
  expectedAgentSwitchRevision: unknown;
  selection: unknown;
} {
  if (!isDeviceLink) {
    return { providerId, expectedAgentSwitchRevision, selection };
  }
  return {
    providerId:
      providerId === null && !controllerSupportsExplicitProviderNull
        ? undefined
        : providerId,
    expectedAgentSwitchRevision:
      expectedAgentSwitchRevision === null ? undefined : expectedAgentSwitchRevision,
    selection: selection === null ? undefined : selection,
  };
}
