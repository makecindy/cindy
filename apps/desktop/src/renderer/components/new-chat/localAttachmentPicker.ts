interface LocalAttachmentPickerContext {
  sessionId?: string;
  runtimeAgentKind?: string | null;
  remoteHostId?: string | null;
  deviceLinkDeviceId?: string | null;
}

/**
 * 本机文件选择器只能在本机执行语境已经确认后开放。
 *
 * 新建草稿没有 sessionId，可直接按远程标记判定；已建会话则必须等 runtime
 * 身份回流，避免 SSH / device-link 冷启动首帧把控制端路径摄入附件状态。
 */
export function canUseLocalAttachmentPicker({
  sessionId,
  runtimeAgentKind,
  remoteHostId,
  deviceLinkDeviceId,
}: LocalAttachmentPickerContext): boolean {
  if (remoteHostId || deviceLinkDeviceId) return false;
  if (sessionId && !runtimeAgentKind) return false;
  return true;
}
