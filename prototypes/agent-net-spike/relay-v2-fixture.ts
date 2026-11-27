/** V2 self-hosted host with owner-approved device certificates. No V1 server or official URL. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { startAgentNetRelay } from '../../packages/agent-net-relay/src/server.ts';
import { createPrivateNetwork } from '../../packages/agent-net-relay/src/bootstrap.ts';
import { AgentNetClient, submitJoin } from '../../packages/agent-net-relay/src/client.ts';
import { generateIdentity, createJoinRequest, approveJoin } from '../../packages/agent-net-relay/src/identity.ts';

export async function startV2Relay(deviceIds: string[]) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'cindy-agent-net-poc-'));
  const owner = generateIdentity(deviceIds[0]);
  const { root, bootstrap } = createPrivateNetwork('V2 interoperability test', owner);
  const relay = await startAgentNetRelay({ dataDir, bootstrap, udpPort: 0 });
  const clients = new Map<string, AgentNetClient>();
  const identities = new Map([[deviceIds[0], owner]]);
  const ownerClient = new AgentNetClient(relay.url, owner, bootstrap.ownerCertificate, bootstrap.rootPublicKey);
  clients.set(deviceIds[0], ownerClient);
  try {
    for (const deviceId of deviceIds.slice(1)) {
      const identity = generateIdentity(deviceId);
      const { joinCode } = await ownerClient.request<{ joinCode: string }>('POST', '/join-codes');
      const secret = randomBytes(32).toString('base64url');
      const request = createJoinRequest(identity, bootstrap.networkId, joinCode, deviceId, secret);
      await submitJoin(relay.url, request);
      const certificate = approveJoin(root, request, secret, bootstrap.ownerCertificate.subject);
      await ownerClient.request('POST', '/join-requests/' + request.requestId + '/approve', { certificate });
      clients.set(deviceId, new AgentNetClient(relay.url, identity, certificate, bootstrap.rootPublicKey));
      identities.set(deviceId, identity);
    }
  } catch (error) { await relay.close(); throw error; }
  return {
    url: relay.url, credentials: new Map<string, string>(), clients, identities,
    stunServer: '127.0.0.1:' + relay.udpAddress!.port,
    async close() {
      await relay.close();
      if (!path.resolve(dataDir).startsWith(path.join(tmpdir(), 'cindy-agent-net-poc-'))) throw new Error('UNSAFE_POC_CLEANUP');
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}
