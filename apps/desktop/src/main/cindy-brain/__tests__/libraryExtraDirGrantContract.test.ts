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

describe('library extraDirs harness grant timing', () => {
  const registerSource = readFileSync(
    resolve(process.cwd(), 'src/main/maker-ipc/register.ts'),
    'utf8',
  ).replace(/\r\n/g, '\n');
  const grantStart = registerSource.indexOf('async function syncLibraryReadonlyExtraDir(');
  const grantBody = registerSource.slice(grantStart, grantStart + 2200);
  const claudeSource = readFileSync(
    resolve(process.cwd(), '../../packages/maker-core/src/agents/claude-code/index.ts'),
    'utf8',
  );
  const codexSource = readFileSync(
    resolve(process.cwd(), '../../packages/maker-core/src/agents/codex/index.ts'),
    'utf8',
  );
  const piSource = readFileSync(
    resolve(process.cwd(), '../../packages/maker-core/src/agents/pi/index.ts'),
    'utf8',
  );

  it('register only marks granted from the applied library slot, not a requested root', () => {
    expect(grantStart).toBeGreaterThan(-1);
    expect(grantBody).toContain('const applied = await applyLibraryReadonlyExtraDir(sessionId, nextRoot);');
    expect(grantBody).toContain('if (nextRoot && applied?.some(isLibraryExtraDirSlot)) granted = true;');
    expect(grantBody).toContain("if (grantRoot && !granted)");
    expect(grantBody).not.toContain('granted = Boolean(nextRoot)');
  });

  it('Claude rebuilds next send without fresh; Codex refuses old app-server; Pi writes the current-turn permission file', () => {
    expect(claudeSource).toContain('pendingRewindTo = sdkSessionId');
    expect(claudeSource).toContain('directoryGrantRebuild ? {} : { resumeSessionAt: resumeAt }');
    expect(claudeSource).toContain('下一 turn 生效,不用 fresh:true');
    expect(claudeSource).not.toMatch(/directoryGrantRebuild[\s\S]{0,80}fresh:\s*true/);
    expect(claudeSource).not.toContain('extraDirsCopyFallbackEnabled = true');
    expect(codexSource).toContain('Codex reference directories require app-server 0.144.6 or newer');
    expect(codexSource).toContain('if (newDirs.length > 0 && !readonlyReferenceDirsSupported)');
    expect(piSource).toContain('readOnlyRoots: [...dirs]');
    expect(piSource).toContain('await writePermissionSnapshotOrFailClosed');
    expect(piSource).toContain('library:assets/<2>/<hash>/blob.<ext>');
  });
});
