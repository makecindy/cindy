import { z } from 'zod';
import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { LiziMcpSessionContext } from '../types.js';
import { errorPayload, okPayload } from './_payload.js';

const metadataSchema = z.strictObject({
  sshHostId: z.string().max(200).optional(),
  sshHostAlias: z.string().max(200).optional(),
  host: z.string().max(253).optional(),
  programDir: z.string().max(4096).optional(),
  dataDir: z.string().max(4096).optional(),
  runtime: z.string().max(1000).optional(),
  service: z.string().max(1000).optional(),
  tls: z.string().max(1000).optional(),
});

export type RelayDeploymentRequest =
  | { operation: 'list' }
  | { operation: 'prepare'; deploymentKey: string; name: string }
  | { operation: 'upload'; relayId: string; sshHostId: string; remoteDir: string }
  | { operation: 'complete'; relayId: string; baseUrl: string; metadata?: z.infer<typeof metadataSchema> }
  | { operation: 'use' | 'forget'; relayId: string };

export interface RelayDeploymentCallbacks {
  call(input: RelayDeploymentRequest & { callerSessionId: string }): Promise<Record<string, unknown>>;
}

/** Returned on discovery of current routes, not injected into every task's system prompt. */
const deploymentGuide = {
  workflow: [
    'Inspect the selected server through cindy_ssh. Choose a writable persistent directory, compatible Node runtime, process supervisor, reachable URL and TLS arrangement based on that environment.',
    'prepare_relay_deployment creates or resumes the owner identity; reuse deployment_key. Create a private staging directory on the SSH server, then upload_relay_deployment transfers the bundle and public init JSON without putting the bundle in model context.',
    'Initialize only a new persistent data directory, using the uploaded JSON and the init arguments below. Never replace existing relay identity or device data on retry/upgrade.',
    'Run serve under a suitable persistent supervisor. A user service or container is fine. Reuse the existing trusted reverse proxy/certificate where appropriate; do not assume root, systemd or free 80/443. Proxy WebSocket upgrades and /api/device-link/ routes, including media.',
    'Check HTTPS and WebSocket reachability, then complete_relay_deployment performs owner-authenticated registration. Record actual SSH host, data/program directories, service, runtime and TLS ownership; do not store secrets or executable maintenance scripts.',
    'Only use_relay_deployment if activation was requested. Other devices join using Add device in the route details. For upgrades, preserve identity/data, deploy a new bundle, verify then register the same relay. For removal, re-inspect ownership and preserve shared websites/proxies before removing only owned resources.',
  ],
  cli: {
    invocation: '<chosen-node> <uploaded-bundle-path> <command> <arguments>',
    init: {
      data: '--data <persistent-directory>',
      jsonFieldsToFlags: { name: '--name', relayId: '--relay-id', ownerUserId: '--owner-user', ownerDeviceId: '--owner-device',
        ownerDeviceName: '--owner-device-name', ownerCredentialHash: '--owner-credential-hash', ownerPublicKey: '--owner-public-key' },
      ownerCert: '--owner-cert <base64url of UTF-8 JSON.stringify(init.ownerCert)>',
      note: 'The uploaded init JSON is not a CLI config file. Read it in a small server-side script and pass each value as an argument (e.g. spawn with an argv array), not unescaped shell interpolation.',
    },
    serve: '--data <persistent-directory> --host <listen-address> --port <port> --public-url <https-origin>',
    tls: 'Behind an existing TLS proxy, listen on a private/loopback HTTP port and use --trust-proxy only when the listener is reachable solely by the trusted proxy. Direct TLS uses --tls-cert <PEM> --tls-key <PEM>. Optional --acme-identifier <domain-or-IP> requires reachable HTTP-01 validation (--acme-http-port, normally public 80); it is not needed when using existing TLS.',
  },
};

/** Deployment decisions belong to the Agent; keys and authenticated registration stay in the Host. */
export function registerRelayDeploymentTools(
  registry: XdtHelperToolRegistry,
  callbacks: RelayDeploymentCallbacks,
  context: () => LiziMcpSessionContext,
): void {
  const invoke = async (input: RelayDeploymentRequest) => {
    const caller = context();
    if (!caller.sessionId || caller.remoteHostId) {
      return errorPayload('CAPABILITY_NOT_AVAILABLE', 'Use a local Cindy task on the computer that will own this relay. Operate the server through cindy_ssh; a phone may continue the local task.');
    }
    try {
      const result = await callbacks.call({ ...input, callerSessionId: caller.sessionId });
      return result.ok === false
        ? errorPayload(String(result.errorCode ?? 'RELAY_OPERATION_FAILED'),
          String(result.message ?? 'Read the current relay state before retrying; deployment may be partially complete.'))
        : okPayload(input.operation === 'list' ? { ...result, deploymentGuide } : result);
    } catch {
      // Host exceptions may contain paths or response bodies; never return them to the model.
      return errorPayload('RELAY_OPERATION_FAILED', 'The relay operation was not confirmed. Read the current state before retrying; do not assume the server or route changed.');
    }
  };
  const relayId = z.string().uuid().describe('Relay ID returned by prepare_relay_deployment or get_relay_deployments.');
  registry.register({
    name: 'get_relay_deployments', category: 'relay',
    description: 'Read this computer’s Cindy connection routes, including unfinished Agent deployments. Local account scope only. For deployment: inspect the chosen SSH server, prepare identity, upload the trusted relay bundle, choose runtime/ports/process supervision/TLS to suit the server, then complete authenticated registration. No mandatory root, systemd or public 80/443 when an alternative works. Never send account tokens or owner private keys to the server. Reuse existing relay identity and persistent data for retries and upgrades. Agent-managed routes appear in Settings > Remote Connection > Connection routes.',
    inputShape: {}, handler: () => invoke({ operation: 'list' }),
  });
  registry.register({
    name: 'prepare_relay_deployment', category: 'relay',
    description: 'Prepare or resume a self-hosted relay identity on this Cindy computer. Use one stable deployment_key per deployment and reuse it on retry. Returns trusted bundle metadata and public init material; owner credential and signing key remain in Host secure storage. Does not install, connect to a server or switch routes. Inspect the server using cindy_ssh first, then upload_relay_deployment. The CLI supports init and serve; select its port, data directory, TLS and supervisor to fit the actual environment.',
    inputShape: {
      deployment_key: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/).describe('Stable ASCII retry key, e.g. my-vps-relay; reuse for this deployment.'),
      name: z.string().trim().min(1).max(80),
    },
    handler: ({ deployment_key, name }) => invoke({ operation: 'prepare', deploymentKey: deployment_key, name }),
  });
  registry.register({
    name: 'upload_relay_deployment', category: 'relay',
    description: 'Upload the prepared, trusted relay program and public initialization material to a chosen directory on a configured SSH host. Host performs transfer and checksum verification; do not read the program into model context. This does not install Node, configure TLS or start services. Use cindy_ssh for those environment-dependent steps. Choose an isolated staging directory so existing installations are preserved.',
    inputShape: { relay_id: relayId, ssh_host_id: z.string().min(1).max(200), remote_dir: z.string().min(1).max(4096) },
    handler: ({ relay_id, ssh_host_id, remote_dir }) => invoke({ operation: 'upload', relayId: relay_id, sshHostId: ssh_host_id, remoteDir: remote_dir }),
  });
  registry.register({
    name: 'complete_relay_deployment', category: 'relay',
    description: 'Verify the deployed relay over trusted HTTPS (custom ports allowed), authenticate with the Host-held owner identity, and register it in Cindy’s connection routes. An HTTP 200 or started process alone is not completion. Save actual deployment locations and runtime/TLS ownership in metadata for later repair, upgrade and removal; metadata is descriptive, never an executable script. Does not switch the current route. After registration, use_relay_deployment only when the user requested activation.',
    inputShape: { relay_id: relayId, base_url: z.string().min(1).max(2048), metadata: metadataSchema.optional() },
    handler: ({ relay_id, base_url, metadata }) => invoke({ operation: 'complete', relayId: relay_id, baseUrl: base_url, metadata }),
  });
  registry.register({
    name: 'use_relay_deployment', category: 'relay',
    description: 'Switch this computer to a completed relay route at the user’s request. Other devices must join this relay separately. Self-hosted routes currently do not deliver mobile system task push notifications; cross-account sharing still uses Cindy’s official relay. Does not deploy a server.',
    inputShape: { relay_id: relayId },
    handler: ({ relay_id }) => invoke({ operation: 'use', relayId: relay_id }),
  });
  registry.register({
    name: 'forget_relay_deployment', category: 'relay',
    description: 'Permanently forget this relay on this computer: deletes its deployment record AND locally held owner credential/signing key. This computer loses the ability to manage it or add devices; if it is the active route, switches back to the official relay. Does not stop or uninstall the server. Call only when the user explicitly abandons management or after a requested uninstall has been verified. For Agent-managed uninstall, inspect recorded resources, remove only that relay’s owned resources using cindy_ssh, verify the outcome, then forget it. Never remove a shared proxy, unrelated website or data without authorization.',
    inputShape: { relay_id: relayId },
    handler: ({ relay_id }) => invoke({ operation: 'forget', relayId: relay_id }),
  });
}
