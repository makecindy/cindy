import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const MAIN_ROOT = resolve(__dirname, '..');
const DESKTOP_ROOT = resolve(MAIN_ROOT, '..', '..');
const REPO_ROOT = resolve(DESKTOP_ROOT, '..', '..');

function read(relativePath: string): string {
  return readFileSync(resolve(DESKTOP_ROOT, relativePath), 'utf8').replace(/\r\n?/g, '\n');
}

function readRepo(relativePath: string): string {
  return readFileSync(resolve(REPO_ROOT, relativePath), 'utf8').replace(/\r\n?/g, '\n');
}

describe('Windows startup PowerShell compatibility', () => {
  it('keeps both startup maintenance paths free of PowerShell', () => {
    const reaper = read('src/main/claude-orphan-reaper.ts');
    const shortcuts = read('src/main/windowsLegacyDevShortcutCleanup.ts');

    expect(reaper.toLowerCase()).not.toContain('powershell.exe');
    expect(reaper).toContain('@vscode/windows-process-tree');
    expect(reaper).not.toContain("await import('@vscode/windows-process-tree')");
    expect(shortcuts.toLowerCase()).not.toContain('powershell.exe');
    expect(shortcuts).not.toContain('node:child_process');
    expect(shortcuts).toContain('shell.readShortcutLink');
  });

  it('awaits orphan ownership scanning before any concurrent teardown', () => {
    const bootstrap = read('src/main/bootstrap-electron.ts');
    const reaperRegistration = bootstrap.indexOf("onQuit('reap-claude-orphans'");
    const makerRegistration = bootstrap.indexOf("onQuit('shutdown-maker'");

    expect(reaperRegistration).toBeGreaterThan(-1);
    expect(bootstrap.slice(reaperRegistration, makerRegistration)).toContain("'pre-async'");
    expect(reaperRegistration).toBeLessThan(makerRegistration);
    expect(read('src/main/lifecycle.ts')).toContain(
      "registry.filter((x) => x.phase === 'pre-async')",
    );
    expect(bootstrap).not.toContain('function cleanupLegacyDevShortcut(');
  });

  it('does not block ready initialization on best-effort shortcut cleanup', () => {
    const bootstrap = read('src/main/bootstrap-electron.ts');

    expect(bootstrap).toContain('void cleanupLegacyDevShortcuts().catch');
    expect(bootstrap).not.toContain('await cleanupLegacyDevShortcuts()');
  });

  it('ships the native snapshot runtime as an externalized packaged dependency', () => {
    const viteConfig = read('vite.main.config.ts');
    const forgeConfig = read('forge.config.ts');

    expect(viteConfig).toContain("'@vscode/windows-process-tree'");
    expect(forgeConfig).toContain('copyWindowsProcessTreeRuntime(src, dst, targetPlatform)');
    expect(forgeConfig).toContain("if (targetPlatform !== 'win32') return;");
    expect(forgeConfig).toContain(
      "targetPlatform === 'win32' ? [WINDOWS_PROCESS_TREE_RUNTIME_DEP] : []",
    );
    expect(forgeConfig).toContain("'windows_process_tree.node'");
  });

  it('patches and rebuilds the Windows snapshot without the upstream 1024-process cap', () => {
    const dependencyPatch = readRepo(
      'dependency-patches/@vscode__windows-process-tree@0.8.0.patch',
    );
    const forgeConfig = read('forge.config.ts');

    expect(dependencyPatch).toContain(
      '-    } while (process_count < 1024 && Process32Next(snapshot_handle, &process_entry));',
    );
    expect(dependencyPatch).toContain(
      '+    } while (Process32Next(snapshot_handle, &process_entry));',
    );
    expect(forgeConfig).toContain('onlyModules: rebuildModules');
    expect(forgeConfig).toContain('pruned windows-process-tree build intermediates');
  });
});
