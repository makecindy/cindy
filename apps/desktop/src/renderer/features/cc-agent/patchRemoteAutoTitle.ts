import { extractIpcError } from '@/utils/ipcError';

export async function patchRemoteAutoTitle(
  invoke: typeof window.electronAPI.deviceLink.invoke,
  deviceId: string,
  sessionId: string,
  title: string,
  expectedTitle: string,
): Promise<void> {
  try {
    await invoke(deviceId, 'local-db:sessions:patch-meta', [
      sessionId,
      { title, titleSource: 'auto', expectedTitle },
    ]);
  } catch (error) {
    const decoded = extractIpcError(error);
    if (
      decoded?.code !== 'INVALID_PARAMS' ||
      !['titleSource', 'expectedTitle'].some(
        (field) => decoded.message === 'field not allowed in patch-meta: ' + field,
      )
    ) {
      throw error;
    }
    await invoke(deviceId, 'local-db:sessions:patch-meta', [sessionId, { title }]);
  }
}
