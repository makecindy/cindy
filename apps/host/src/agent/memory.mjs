/**
 * Maker Memory in the host process.
 *
 * The memory store is the same owner-scoped state Desktop uses
 * (`<userData>/owners/<key>/...`); the host only supplies the host-neutral ports
 * the shared factory asks for, so both processes read one truth.
 */

import fs from 'node:fs';
import path from 'node:path';

import { attachAgentsToMakerMemory, createMakerMemoryManagerForHost } from '@cindy/maker-core';
import { createLiziMcpProviders } from '../../../../packages/lizi-mcps/src/index.ts';

import { getActiveAppSession, isAppSessionBoundaryPending } from '../../../desktop/src/main/appSessionState.ts';
import { hostMemoryManagerPorts } from './memory-manager-ports.ts';
import { hostMemoryMcpPorts } from './memory-mcp-ports.ts';

const DEFAULTS = Object.freeze({ maker: true, claudeCode: true, codex: true, pi: true });

/** `<ownerRoot>/memory-settings.json`, same file Desktop writes. */
export function readMemorySettings(ownerRoot) {
  const file = ownerRoot
    ? path.join(ownerRoot, 'memory-settings.json')
    : null;
  if (!file) return { ...DEFAULTS };
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
    const out = { ...DEFAULTS };
    for (const key of Object.keys(DEFAULTS)) {
      if (typeof raw[key] === 'boolean') out[key] = raw[key];
    }
    return out;
  } catch {
    return { ...DEFAULTS };
  }
}

/**
 * The port bag is written out in memory-manager-ports.ts, where `explicitPorts` is type-checked.
 * @param {{ userDataDir: string, ownerId: string }} options
 */
export function createHostMemoryManager({ userDataDir, ownerId }) {
  const scope = getActiveAppSession();
  if (scope.dataOwnerId !== ownerId || isAppSessionBoundaryPending()) throw new Error('Memory owner is not ready');
  return createMakerMemoryManagerForHost(hostMemoryManagerPorts({
    userDataDir,
    ownerId,
    generation: scope.generation,
    readEnabled: (ownerRoot) => readMemorySettings(ownerRoot).maker,
  }));
}

/**
 * The cindy_memory MCP server; Codex reaches it through the Host MCP bridge (mcp-runtime codexDeps), checked by codex-runtime.e2e.mjs.
 * The port bag is written out in memory-mcp-ports.ts, where `explicitPorts` is type-checked.
 * @param {import('./memory-mcp-ports.ts').HostMemoryMcpPortInput} ports
 */
export function createHostMemoryMcpProviders(manager, ports) {
  return createLiziMcpProviders({
    enabled: ['cindy_memory'],
    memory: hostMemoryMcpPorts(manager, ports),
  });
}

export { attachAgentsToMakerMemory };
