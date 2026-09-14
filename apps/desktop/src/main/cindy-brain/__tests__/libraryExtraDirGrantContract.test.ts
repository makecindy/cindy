import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('library extraDirs grant wiring', () => {
  const mainSource = readFileSync(
    resolve(process.cwd(), 'src/main/cindy-brain/index.ts'),
    'utf8',
  ).replace(/\r\n/g, '\n');

  const start = mainSource.indexOf('export type LibraryExtraDirSyncResult');
  const end = mainSource.indexOf('\nlet previewSlotSingleton:', start);
  const body = mainSource.slice(start, end);

  it('picks an enabled library-capable ghost instead of a hardcoded mivo id', () => {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(body).toContain('function isLibraryCapableGhost(');
    expect(body).toContain('libraryExtraDirOwnerGhostId');
    expect(body).toContain('ghost.manifest.library === true');
    expect(body).toContain('const ownerId = libraryExtraDirOwnerGhostId;');
    expect(body).not.toContain('availableGhosts().find((ghost) => isLibraryCapableGhost(ghost))');
    expect(body).not.toContain('function selectLibraryCapableGhost(');
    expect(body).not.toContain("findAvailableGhost('xd-mivo')");
    expect(body).not.toContain("findAvailableGhost('cindy-mivo')");
    expect(body).not.toContain('MIVO_LIBRARY_GHOST_IDS');
  });

  it('slot sync refuses to no-op-success when the opener is not library-capable', () => {
    expect(body).toContain('async function syncMivoLibraryExtraDirFromSlot(');
    expect(body).toContain('if (root !== null && !isLibraryCapableGhost(findAvailableGhost(ghostId)))');
    expect(body).toContain('if (libraryExtraDirOwnerGhostId !== null && libraryExtraDirOwnerGhostId !== ghostId)');
    expect(body).toContain("if (result === 'granted') libraryExtraDirOwnerGhostId = ghostId;");
    expect(body).toContain('return result;');
  });
});
