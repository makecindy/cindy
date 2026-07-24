import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const MAIN_ROOT = resolve(__dirname, '..');
const DESKTOP_ROOT = resolve(MAIN_ROOT, '..', '..');

function read(relativePath: string): string {
  return readFileSync(resolve(DESKTOP_ROOT, relativePath), 'utf8').replace(/\r\n?/g, '\n');
}

describe('Windows startup PowerShell compatibility', () => {
  it('keeps both startup maintenance paths free of PowerShell', () => {
    const reaper = read('src/main/claude-orphan-reaper.ts');
    const shortcuts = read('src/main/windowsLegacyDevShortcutCleanup.ts');

    expect(reaper.toLowerCase()).not.toContain('powershell.exe');
    expect(reaper).toContain('@vscode/windows-process-tree');
    expect(shortcuts.toLowerCase()).not.toContain('powershell.exe');
    expect(shortcuts).not.toContain('node:child_process');
    expect(shortcuts).toContain('shell.readShortcutLink');
  });

  it('awaits orphan ownership scanning before Maker tears down Claude', () => {
    const bootstrap = read('src/main/bootstrap-electron.ts');
    const shutdownStart = bootstrap.indexOf('async function shutdownMaker()');
    const shutdownEnd = bootstrap.indexOf('\nfunction readGitText', shutdownStart);
    const shutdownMaker = bootstrap.slice(shutdownStart, shutdownEnd);

    expect(shutdownMaker.indexOf('await reapClaudeOrphans()')).toBeGreaterThan(-1);
    expect(shutdownMaker.indexOf('await reapClaudeOrphans()')).toBeLessThan(
      shutdownMaker.indexOf('await m.shutdown()'),
    );
    expect(bootstrap).toContain('await cleanupLegacyDevShortcuts()');
    expect(bootstrap).not.toContain('function cleanupLegacyDevShortcut(');
  });

  it('ships the native snapshot runtime as an externalized packaged dependency', () => {
    const viteConfig = read('vite.main.config.ts');
    const forgeConfig = read('forge.config.ts');

    expect(viteConfig).toContain("'@vscode/windows-process-tree'");
    expect(forgeConfig).toContain(
      "targetPlatform === 'win32' ? [WINDOWS_PROCESS_TREE_RUNTIME_DEP] : []",
    );
    expect(forgeConfig).toContain('copyWindowsProcessTreeRuntime(src, dst)');
    expect(forgeConfig).toContain("'windows_process_tree.node'");
  });
});
