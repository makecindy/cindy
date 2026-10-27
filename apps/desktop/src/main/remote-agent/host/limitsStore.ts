import { activeOwnerScopeKey, ownerScopedUserDataPath } from '../../appSessionState.js';
import { createLogger } from '../../logger.js';
import { createOverrideSettingsFile } from '../../maker-host/override-settings-file.js';
import { captureProviderManagementScope } from '../../provider-group/managementScope.js';
import { throwIpcError } from '../../utils/ipcValidate.js';
import { DEFAULT_REMOTE_AGENT_LIMITS, isRemoteAgentLimits, isRemoteAgentLimitsPatch, type RemoteAgentLimits } from '../../../shared/remoteAgentLimits.js';

const store = createOverrideSettingsFile<RemoteAgentLimits>({
  filePath: () => ownerScopedUserDataPath('remote-agent-limits.json'),
  scopeKey: () => { captureProviderManagementScope(); return activeOwnerScopeKey(); },
  defaults: DEFAULT_REMOTE_AGENT_LIMITS,
  normalize: raw => isRemoteAgentLimits(raw)
    ? { perDevice: raw.perDevice, total: raw.total, idleMinutes: raw.idleMinutes ?? DEFAULT_REMOTE_AGENT_LIMITS.idleMinutes }
    : { ...DEFAULT_REMOTE_AGENT_LIMITS },
  log: createLogger('remote-agent:limits'),
  label: 'remote-agent-limits',
  preserveUnreadableFile: true,
});

export function readRemoteAgentLimitsState() {
  store.invalidateIfChanged();
  return store.readState();
}

export async function saveRemoteAgentLimits(value: Partial<RemoteAgentLimits> | null): Promise<void> {
  const assertCurrent = captureProviderManagementScope();
  if (value === null) await store.resetAtomic();
  else {
    if (!isRemoteAgentLimitsPatch(value)) throwIpcError('INVALID_PARAMS', 'Invalid remote task limits');
    // 显式保存默认值也是用户选择；恢复默认才删除 overrides。
    await store.updateAtomic(current => {
      if (!isRemoteAgentLimits({ ...current.value, ...value })) throwIpcError('INVALID_PARAMS', 'Invalid remote task limits');
      return value;
    }, { preserveDefaults: true });
  }
  assertCurrent();
}
