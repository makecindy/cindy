import { sealNotification, type AgentNetClient } from '@cindy/agent-net-relay/client';
import { verifyCertificate, verifyDelegation } from '@cindy/agent-net-relay';
import { AgentNetSocket as PortableSocket } from './portableSocket.js';
import type { PortableSocketOptions } from './socketPorts.js';
import type { TransportOptions } from './types.js';
import { createCoreTransport } from './transport.js';
import { LanDiscovery } from './lan.js';
import { BonjourDiscovery } from './bonjour.js';

export interface AgentNetSocketOptions extends Omit<PortableSocketOptions, 'client' | 'bindings'> {
  client: AgentNetClient;
  module?: WebAssembly.Module;
  udp?: boolean;
  bindAddress?: string;
  stunServers?: string[];
  tap?: TransportOptions['tap'];
}
/** Node bindings; device-link routing and framing are shared with mobile. */
export class AgentNetSocket extends PortableSocket {
  static async open(options: AgentNetSocketOptions): Promise<AgentNetSocket> {
    return this.openWithBindings({ ...options, bindings: {
      verifyCertificate,
      verifyDelegation,
      async notify(recipient, input, signal, activeClient) {
        const client = activeClient as AgentNetClient;
        options.assertCurrent?.();
        let ciphertext = '';
        const payload = { ...input, title: Array.from(input.title).slice(0, 128).join('') };
        for (const length of [640, 320, 160, 0]) {
          payload.body = Array.from(input.body ?? '').slice(0, length).join('');
          try { ciphertext = sealNotification(client.rootPublicKey, client.certificate.networkId, client.identity, recipient, payload); break; }
          catch (error) {
            if (!(error instanceof Error) || error.message !== 'NOTIFICATION_TOO_LARGE') throw error;
            if (payload.sender?.avatar) { payload.sender = { id: payload.sender.id }; }
          }
        }
        if (!ciphertext) throw new Error('NOTIFICATION_TOO_LARGE');
        options.assertCurrent?.();
        await client.request('POST', '/notify', { to: recipient.certificate.deviceId, ciphertext }, { signal });
        options.assertCurrent?.();
      },
      createTransport: request => createCoreTransport({ ...request,
        identity: options.client.identity.transportPrivateKey, module: options.module,
        bindAddress: options.bindAddress, udp: options.udp, stunServers: options.stunServers, tap: options.tap,
      }),
      createDiscovery: request => {
        const lan = new LanDiscovery({ ...request, identity: options.client.identity, interfaceAddress: options.bindAddress });
        const bonjour = new BonjourDiscovery(lan, request.port);
        return { start() { lan.start(); bonjour.start(); }, close() { lan.close(); bonjour.close(); } };
      },
    } }) as Promise<AgentNetSocket>;
  }
}
