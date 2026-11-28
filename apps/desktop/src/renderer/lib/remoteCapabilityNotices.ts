import { extractIpcError } from '@/utils/ipcError';

const missingEngine = /^(?:\[PRECONDITION_FAILED\]\s*)?binary_not_ready:/;

export function isRemoteEngineMissing(error: unknown): boolean {
  const ipc = extractIpcError(error);
  return ipc?.code === 'PRECONDITION_FAILED' && missingEngine.test(ipc.message);
}

export function isRemoteGoalUnsupported(error: unknown): boolean {
  const ipc = extractIpcError(error);
  if (!ipc) return false;
  if (ipc.code === 'UNSUPPORTED_CAPABILITY') return true;
  const message = ipc.message.replace(/^\[(?:DEVICE_LINK_)?CHANNEL_NOT_ALLOWED\]\s*/, '').trim();
  return (ipc.code === 'DEVICE_LINK_CHANNEL_NOT_ALLOWED' && message === "channel 'maker:goal:set' not allowed remotely")
    || (ipc.code === 'NOT_FOUND' && message === "no local IPC handler for channel 'maker:goal:set'");
}
