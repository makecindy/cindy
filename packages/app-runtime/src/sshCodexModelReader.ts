import type {CodexAgent} from '@cindy/maker-core';
import type {RemoteHost} from '@cindy/maker-remote-ssh';
import {remoteCodexProvider} from './ssh-codex-models.js';
export interface SshCodexModelReader {getActiveAppSession():{generation:unknown};getRemoteSshPool():{get(id:string):RemoteHost|undefined};ensureRemoteAgentInstalledOrInstall(hostId:string,kind:'codex'):Promise<unknown>;getAgent():Pick<CodexAgent,'listRemoteModels'>|null;}
export async function listSshCodexProviders(hostId: string, deps: SshCodexModelReader) {
  const {getActiveAppSession,getRemoteSshPool,ensureRemoteAgentInstalledOrInstall,getAgent}=deps;
  const owner = getActiveAppSession().generation;
  const remote = getRemoteSshPool().get(hostId);
  if (!remote || remote.getStatus() !== 'ready') throw new Error('SSH host is not connected');
  let changed = false;
  const stop = remote.onStatus((snapshot) => {
    if (snapshot.status !== 'ready') changed = true;
  });
  const assertCurrent = () => {
    if (changed || getActiveAppSession().generation !== owner ||
        getRemoteSshPool().get(hostId) !== remote || remote.getStatus() !== 'ready') {
      throw new Error('SSH model request is stale');
    }
  };
  try {
    await ensureRemoteAgentInstalledOrInstall(hostId, 'codex');
    assertCurrent();
    const agent = getAgent();
    if (!agent) throw new Error('Codex is not ready');
    const models = await agent.listRemoteModels(hostId);
    assertCurrent();
    if (getAgent() !== agent) throw new Error('Codex runtime changed');
    return [remoteCodexProvider(models)];
  } finally {
    stop();
  }
}
