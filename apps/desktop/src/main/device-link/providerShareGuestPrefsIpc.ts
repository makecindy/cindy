import { isIpcError } from '../../shared/ipc-errors.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { setProviderShareCredentialConsent } from './providerShareGuestPrefs.js';

/** 本机偏好写入的 IPC 边界：磁盘诊断留在存储层 main 日志，不把内部路径带给 Renderer。 */
export async function setProviderShareCredentialConsentFromIpc(
  ...args: Parameters<typeof setProviderShareCredentialConsent>
): Promise<void> {
  try {
    await setProviderShareCredentialConsent(...args);
  } catch (error) {
    if (isIpcError(error)) throw error;
    throwIpcError('INTERNAL', 'Failed to save provider share credential consent');
  }
}
