import path from 'node:path';
import { execFile } from 'node:child_process';
import type { WorkLouderSdkLocation } from './WorkLouderCodexHostClient.js';

/** Host-supplied filesystem and package inventory keep SDK discovery testable. */
export interface WorkLouderSdkResolverDeps {
  platform: NodeJS.Platform;
  paths: typeof path;
  env: NodeJS.ProcessEnv;
  exists(file: string): boolean;
  resolvePackage(): string;
  queryStoreInstallRoots(): Promise<string[]>;
  onChanged(): void;
  now?: () => number;
  nativeFallback?: WorkLouderSdkLocation;
}

/** Resolves the optional SDK without loading native HID modules into main. */
export function createWorkLouderSdkResolver(
  deps: WorkLouderSdkResolverDeps,
): () => WorkLouderSdkLocation | null {
  const { paths } = deps;
  let storeDirs: string[] = [];
  let pending = false;
  let retryAt = 0;
  const tail = paths.join('resources', 'app.asar', 'node_modules', '@worklouder', 'device-kit-oai');
  const regularDirs =
    deps.platform === 'darwin'
      ? ['ChatGPT.app', 'Codex.app'].map((name) =>
          paths.join('/Applications', name, 'Contents', tail),
        )
      : deps.platform === 'win32'
        ? [deps.env.LOCALAPPDATA, deps.env.ProgramFiles]
            .filter((root): root is string => Boolean(root))
            .flatMap((root) =>
              ['ChatGPT', 'Codex'].flatMap((name) => [
                paths.join(root, name, tail),
                paths.join(root, 'Programs', name, tail),
              ]),
            )
        : [];
  return () => {
    try {
      return { entry: deps.resolvePackage(), source: 'cindy-package' };
    } catch {
      // The vendor SDK is optional.
    }
    for (const entry of [...regularDirs, ...storeDirs]) {
      if (deps.exists(paths.join(entry, 'package.json'))) return { entry, source: 'openai-app' };
    }
    if (deps.platform === 'win32' && deps.nativeFallback) return deps.nativeFallback;
    const now = (deps.now ?? Date.now)();
    if (deps.platform === 'win32' && !pending && now >= retryAt) {
      pending = true;
      retryAt = now + 30_000;
      void deps
        .queryStoreInstallRoots()
        .then((roots) => {
          // Store Electron apps nest their payload under app/; retain root layout too.
          storeDirs = roots
            .filter((root) => paths.isAbsolute(root))
            .flatMap((root) => [paths.join(root, 'app', tail), paths.join(root, tail)]);
          if (storeDirs.some((entry) => deps.exists(paths.join(entry, 'package.json'))))
            deps.onChanged();
        })
        .catch(() => {
          // Missing Appx tooling or a timeout must not break ordinary installations.
        })
        .finally(() => {
          pending = false;
        });
    }
    return null;
  };
}

/** Query only the current user's registered OpenAI packages; never crawl WindowsApps. */
export function queryWorkLouderStoreInstallRoots(): Promise<string[]> {
  const powershell = path.join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  const script =
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); 'OpenAI.Codex','OpenAI.ChatGPT' | ForEach-Object { Get-AppxPackage -Name $_ } | Select-Object -ExpandProperty InstallLocation";
  return new Promise((resolve, reject) => {
    execFile(
      powershell,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 10_000, maxBuffer: 64 * 1024, encoding: 'utf8' },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(
          stdout
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean),
        );
      },
    );
  });
}
