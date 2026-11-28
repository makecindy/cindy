import type { AgentIslandService } from './service.js';

// The Desktop runtime installs the service. Status readers also run in the Node Host.
let current: AgentIslandService | null = null;

export function getAgentIslandService(): AgentIslandService | null {
  return current;
}

export function setAgentIslandService(service: AgentIslandService): void {
  current = service;
}
