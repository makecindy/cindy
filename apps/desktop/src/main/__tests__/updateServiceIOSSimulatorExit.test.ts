import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../updateService.ts', import.meta.url), 'utf8');
const bootstrapSource = readFileSync(new URL('../bootstrap-electron.ts', import.meta.url), 'utf8');

describe('update force-quit iOS Simulator cleanup', () => {
  it('aborts detached simulator operations before exiting the process', () => {
    expect(source).toContain(
      "import { abortIOSSimulatorOperationsForExit } from './mcp-integrations/ios-simulator-exit';",
    );
    const forceQuitStart = source.indexOf('function forceQuit(): void {');
    const forceQuitEnd = source.indexOf('\nfunction executeUpdateMacOS', forceQuitStart);
    const forceQuitSource = source.slice(forceQuitStart, forceQuitEnd);
    const abortIndex = forceQuitSource.indexOf('abortIOSSimulatorOperationsForExit();');
    const exitIndex = forceQuitSource.indexOf('process.exit(0);');

    expect(forceQuitStart).toBeGreaterThanOrEqual(0);
    expect(forceQuitEnd).toBeGreaterThan(forceQuitStart);
    expect(abortIndex).toBeGreaterThanOrEqual(0);
    expect(exitIndex).toBeGreaterThan(abortIndex);
  });

  it('aborts detached simulator operations before the bounded async quit phase', () => {
    expect(bootstrapSource).toContain(
      "import { abortIOSSimulatorOperationsForExit } from './mcp-integrations/ios-simulator-exit';",
    );
    const abortIndex = bootstrapSource.indexOf(
      "onQuit('ios-simulator-exit-abort', abortIOSSimulatorOperationsForExit, 'sync');",
    );
    const hostDisposeIndex = bootstrapSource.indexOf(
      "onQuit('ios-simulator-host', disposeIOSSimulatorHost, 'async');",
    );
    const quitHandlerIndex = bootstrapSource.indexOf('installQuitHandler(6000);');

    expect(abortIndex).toBeGreaterThanOrEqual(0);
    expect(hostDisposeIndex).toBeGreaterThan(abortIndex);
    expect(quitHandlerIndex).toBeGreaterThan(hostDisposeIndex);
  });
});
