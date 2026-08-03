/**
 * Device Link 的 maker:set-model 参数兼容。
 *
 * JSON 数组无法保留 undefined：中间的可选参数会变成 null，尾部的可选参数
 * 也会留下一个多余的 null。这里把 Device Link wire 层的可选占位归一化回
 * 本地 IPC handler 期望的 undefined；本地 IPC 不应调用此 helper。
 *
 * 旧控制端始终发送完整的五个 positional 槽位，model-only 切换会是
 * `[sessionId, model, null, null, null]`。只有这个完整占位形状可以把
 * `providerId: null` 视为“未提供”；短参数调用里的 `providerId: null` 仍是
 * 明确清除 provider 的语义。
 */
export function normalizeDeviceLinkSetModelWireArgs(
  isDeviceLink: boolean,
  wireArgCount: number,
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
      wireArgCount === 5 &&
      providerId === null &&
      expectedAgentSwitchRevision === null &&
      selection === null
        ? undefined
        : providerId,
    expectedAgentSwitchRevision:
      expectedAgentSwitchRevision === null ? undefined : expectedAgentSwitchRevision,
    selection: selection === null ? undefined : selection,
  };
}
