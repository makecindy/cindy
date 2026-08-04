import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  resolve(__dirname, '..', 'components', 'new-chat', 'ChatInput.tsx'),
  'utf8',
).replace(/\r\n?/g, '\n');

describe('ChatInput Ghost snapshot contract', () => {
  it('never performs a synchronous Ghost list IPC in the composer', () => {
    expect(source).not.toContain('ghosts.listSync()');
  });

  it('derives the $ palette from the workdir-filtered installed snapshot', () => {
    expect(source).toContain(
      'const ghostsForCommand = useMemo(\n    () => filterGhostsForWorkdir(installedGhosts, workingDir),',
    );
    expect(source).toContain(
      'const ghostCommandItems = useMemo(() => {\n    if (!isGhostSigil) return [];\n    return ghostsForCommand',
    );
    expect(source).toContain('}, [ghostsForCommand, isGhostSigil, t]);');
  });

  it('uses the latest installed snapshot and workdir at send time', () => {
    expect(source).toContain('const installedGhostsRef = useRef(installedGhosts);');
    expect(source).toContain('installedGhostsRef.current = installedGhosts;');
    expect(source).toContain(
      'const eligibleGhosts = filterGhostsForWorkdir(\n        installedGhostsRef.current,\n        workingDirRef.current,\n      );',
    );
  });

  it('does not expose controller-local plugin rows in device-link sessions', () => {
    expect(source).toContain(
      'if (deviceLinkDeviceId) return [];',
    );
    expect(source).toContain(
      '[deviceLinkDeviceId, pluginsForMenu, pluginAvailableIds]',
    );
  });
});
