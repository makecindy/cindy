import { mountPage, subscription, forbid } from '../../ui-page/harness';
import { RemoteSection } from '../../../src/renderer/components/settings/RemoteSection';
import { ToastContainer } from '../../../src/renderer/components/ui/toast/ToastContainer';
import i18n from '../../../src/renderer/i18n';

const agentErrorKeys: Record<string, string> = {
  'agent-configured-unset': 'settings.remote.agentError.environmentUnset',
  'agent-configured-empty': 'settings.remote.agentError.endpointEmpty',
  'agent-configured-unavailable': 'settings.remote.agentError.endpointUnavailable',
};

void mountPage({
  host: (ctx) => ({
    remoteSsh: {
      list: async () => ({ hosts: [{
        config: {
          id: 'build-server', hostname: 'build.example.com', user: 'developer', port: 22,
          authMethod: 'agent', source: 'ssh-config', managedByCindy: false,
          identityFileConfigured: true, identityFileName: 'id_ed25519',
        },
        status: 'disconnected', statusChangedAt: 0, autoConnect: false,
        agentProxy: null, agentProxyTunnel: null,
      }] }),
      onStatusChanged: subscription('sshStatus'),
      onHostsChanged: subscription('sshHosts'),
      connect: async () => {
        const key = agentErrorKeys[ctx.case] ?? 'ipcError.SSH_AGENT_UNAVAILABLE';
        throw new Error(`[SSH_AGENT_UNAVAILABLE] ${i18n.t(key)}`);
      },
      listLocalKeys: async () => ({ keys: [{
        privateKeyPath: '/fixture/.ssh/example_key', pubkeyPath: '/fixture/.ssh/example_key.pub',
        type: 'ed25519', comment: 'UI scenario', fingerprintSha256: null,
        inAgent: false, mtimeIso: null,
      }] }),
      // Exercise the real recovery dialog with a fake local-agent failure.
      addKeyToAgent: async () => ({ result: {
        success: false, failureReason: 'agent_unavailable', errorHint: null,
      } }),
      generateKey: forbid('remoteSsh.generateKey'),
      add: forbid('remoteSsh.add'),
      remove: forbid('remoteSsh.remove'),
    },
  }),
  render: () => (
    <main className="h-full overflow-auto p-6" data-ui-page-subject>
      <RemoteSection />
      <ToastContainer />
    </main>
  ),
});
