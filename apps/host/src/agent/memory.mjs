import { holdError } from './profile-hold.ts';
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
 * @param {Pick<import('./memory-manager-ports.ts').HostMemoryManagerPortInput, 'userDataDir' | 'ownerId' | 'review'> & {profileHold?: () => import('./profile-hold.ts').ProfileHold | null}} options
 */
export function createHostMemoryManager({ userDataDir, ownerId, review, profileHold }) {
  const scope = getActiveAppSession();
  if (scope.dataOwnerId !== ownerId || isAppSessionBoundaryPending()) throw new Error('Memory owner is not ready');
  const manager = createMakerMemoryManagerForHost(hostMemoryManagerPorts({
    userDataDir,
    ownerId,
    generation: scope.generation,
    review,
    readEnabled: (ownerRoot) => readMemorySettings(ownerRoot).maker,
  }));
  // Engine prompt injection can initialize a store and Pi compaction calls
  // manager.write(), which also opens its store here without going through MCP.
  if (profileHold) {
    const getStore = manager.getStore.bind(manager);
    manager.getStore = async (...args) => {
      const held = profileHold();
      if (held) throw holdError(held);
      return getStore(...args);
    };
  }
  return manager;
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
