/**
 * Migration runtime paths, injected by the host process.
 *
 * Desktop computes these from Electron (`process.resourcesPath` / its own
 * `.vite/build` location); the Node `cindy-host` computes them from the repo or
 * an installed package. Neither process should guess the other's layout, and
 * neither should import `electron` just to answer "which drizzle directory".
 */

export interface MigrationRuntimeConfig {
  /** Absolute directory holding `NNNN_*.sql` migrations and `scripts/`. */
  drizzleDir: string;
  /** Packaged build identity (release vs development). */
  isPackaged: boolean;
}

let config: MigrationRuntimeConfig | null = null;

export function configureMigrationRuntime(next: MigrationRuntimeConfig): void {
  config = next;
}

export function getMigrationRuntimeConfig(): MigrationRuntimeConfig {
  if (!config) {
    throw new Error(
      'migration runtime is not configured; call configureMigrationRuntime() during startup',
    );
  }
  return config;
}
