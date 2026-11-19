import path from 'node:path';
import { isProviderSharePeer } from '@cindy/device-link';
import { isProviderShareAgentDeviceId } from '../../../shared/providerShare.js';
import { getActiveAppSession } from '../../appSessionState';
import { createNativeHistoryTransfer, transferNativeHistory, type NativeHistoryEndpoint } from '../nativeHistoryTransfer';
import { nativeHistoryStorage } from '../nativeHistoryStorage';
import { remoteAgentInvoker, RemoteAgentRunClient } from './runClient';
import type { DeviceAgentServiceDeps } from './service';
import { isRetryableLinkError } from './poller';
import { readNativeHistoryBackupEndpoint } from './nativeHistoryBackup';

export function createNativeHistoryRelocator(userDataDir: string, invoke: DeviceAgentServiceDeps['remoteInvoke']) {
  const local = createNativeHistoryTransfer(path.join(userDataDir, 'native-history-transfers'), nativeHistoryStorage(userDataDir));
  return async (input: {
    sessionId: string; kind: 'claude-code' | 'codex' | 'pi'; nativeId: string; workingDir: string;
    fromDevice: string | null; toDevice: string | null; assertCurrent(): void;
  }): Promise<string | null> => {
    // Sharing relays have different ownership and storage. They retain the existing handoff fallback.
    if ([input.fromDevice, input.toDevice].some(device =>
      isProviderShareAgentDeviceId(device) || isProviderSharePeer(device))) return null;
    const owner = getActiveAppSession();
    const assertCurrent = () => {
      input.assertCurrent();
      if (getActiveAppSession().generation !== owner.generation) throw new Error('REMOTE_AGENT_ACCOUNT_CHANGED');
    };
    const endpoint = async (device: string | null): Promise<NativeHistoryEndpoint | null> => {
      if (!device) return command => local(`${owner.generation}:${input.sessionId}`, command, input.workingDir, assertCurrent);
      const remote = remoteAgentInvoker(device, invoke);
      const caps = await RemoteAgentRunClient.caps(remote);
      assertCurrent();
      if (!caps.nativeHistoryTransfer) return null;
      return command => remote([{ op: 'native-history', sessionId: input.sessionId, command }]);
    };
    // Verify the destination before creating a potentially large source snapshot.
    const target = await endpoint(input.toDevice);
    if (!target) return null;
    let unavailableSource = false;
    try {
      const source = await endpoint(input.fromDevice).catch(error => {
        unavailableSource = isRetryableLinkError(error);
        throw error;
      });
      if (!source) return null;
      // Only a failure of the source can select the backup. A disconnected
      // destination or failed native restore must use the existing fallback.
      const live: NativeHistoryEndpoint = async command => {
        try { return await source(command); }
        catch (error) {
          if (command.action !== 'release') unavailableSource = isRetryableLinkError(error);
          throw error;
        }
      };
      return await transferNativeHistory(live, target, input.kind, input.nativeId, assertCurrent);
    } catch (error) {
      assertCurrent();
      if (input.kind !== 'pi' || !input.fromDevice || !unavailableSource) throw error;
      const backup = await readNativeHistoryBackupEndpoint({ ...input, fromDevice: input.fromDevice }, assertCurrent);
      if (!backup) throw error;
      return transferNativeHistory(backup.endpoint, async command => {
        if (command.action === 'restore') await backup.validate();
        const result = await target(command);
        if (command.action === 'restore') await backup.validate();
        return result;
      }, input.kind, input.nativeId, assertCurrent);
    }
  };
}
