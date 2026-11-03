import { extractIpcError } from '@/utils/ipcError';

/** Local presentation only; never sent to the Host or persisted in task history. */
export interface PluginSetupCommandError {
  requestId: string;
  revision: number;
  code: 'REMOTE_UNSUPPORTED' | 'REMOTE_FAILED';
}

export function remotePluginSetupErrorCode(error: unknown): PluginSetupCommandError['code'] {
  return extractIpcError(error)?.code === 'UNSUPPORTED_CAPABILITY'
    ? 'REMOTE_UNSUPPORTED'
    : 'REMOTE_FAILED';
}
