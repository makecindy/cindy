import type { Agent } from 'node:http';
import type { createOutboundTransport } from '../../desktop/src/main/maker-host/outbound-fetch.js';
import type { createEnvOutboundProxyResolver } from '@cindy/anthropic-compat-proxy';

export const hostOutbound: ReturnType<typeof createOutboundTransport>;
export const resolveHostOutboundProxy: ReturnType<typeof createEnvOutboundProxyResolver>;
export function createHostWebSocketAgent(url: string | URL): Promise<Agent | undefined>;
