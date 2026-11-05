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

import { dataOwnerStorageKey } from '../../../desktop/src/main/dataOwnerPath.ts';
import { createBetterSqliteDatabase } from '../../../desktop/src/main/localDb/betterSqliteFactory.ts';
import { LOGGER } from './runtime.mjs';

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

const sqliteFactory = (filePath) => {
  const db = createBetterSqliteDatabase(filePath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  return db;
};

/**
 * @param {{ userDataDir: string, ownerId: string }} options
 */
export function createHostMemoryManager({ userDataDir, ownerId }) {
  return createMakerMemoryManagerForHost({
    userDataDir,
    readSession: () => ({
      dataOwnerId: ownerId,
      generation: 1,
      mode: 'host',
      boundaryPending: false,
    }),
    ownerSegment: (id) => dataOwnerStorageKey(id),
    readEnabled: (ownerRoot) => readMemorySettings(ownerRoot).maker,
    sqliteFactory,
    logger: LOGGER.child('maker-memory'),
    reviewAgent: 'claude-code',
  });
}

/** The cindy_memory MCP server for Claude turns; Codex needs the desktop bridge (TODO). */
export function createHostMemoryMcpProviders(manager) {
  return createLiziMcpProviders({
    enabled: ['cindy_memory'],
    memory: {
      getManager: () => manager,
      logger: LOGGER.child('mcp/cindy_memory'),
    },
  });
}

export { attachAgentsToMakerMemory };
