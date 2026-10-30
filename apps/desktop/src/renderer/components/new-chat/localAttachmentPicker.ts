interface LocalAttachmentPickerContext {
  sessionId?: string;
  runtimeAgentKind?: string | null;
  remoteHostId?: string | null;
  deviceLinkDeviceId?: string | null;
}

/**
 * 本机及 device-link 均从控制端选文件；device-link 出站层上传字节后替换路径。
 *
 * device-link 身份明确后即可上传；其它已建会话须等 runtime 身份回流。
 * SSH 没有这条上传链路，仍不提供本机选择器。
 */
export function canUseLocalAttachmentPicker({
  sessionId,
  runtimeAgentKind,
  remoteHostId,
  deviceLinkDeviceId,
}: LocalAttachmentPickerContext): boolean {
  if (remoteHostId) return false;
  if (deviceLinkDeviceId) return true;
  if (sessionId && !runtimeAgentKind) return false;
  return true;
}
