import { execFile } from 'node:child_process';

/**
 * Enable or disable a Hermes home plugin through the Hermes CLI itself
 * (`hermes plugins enable|disable <name>`), so Hermes owns the config.yaml
 * format (`plugins.enabled` / `plugins.disabled`, `<name>/.hermes-plugin`
 * entries). Cindy never rewrites that section by hand (AGENTS.md §3).
 */

/** Plugin ids are directory names under `<home>/plugins`; anything else is refused. */
const PLUGIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isValidHermesPluginName(name: string): boolean {
  return PLUGIN_NAME.test(name) && !name.includes('..');
}

export interface HermesPluginToggleOptions {
  hermesBin: string;
  hermesHome: string;
  hermesExtraArgs?: string[];
  timeoutMs?: number;
}

export async function setHermesPluginEnabled(
  opts: HermesPluginToggleOptions,
  name: string,
  enabled: boolean,
): Promise<void> {
  if (!isValidHermesPluginName(name)) {
    throw new Error(`invalid plugin name "${name}"`);
  }
  await new Promise<void>((resolve, reject) => {
    execFile(
      opts.hermesBin,
      [...(opts.hermesExtraArgs ?? []), 'plugins', enabled ? 'enable' : 'disable', name],
      {
        env: { ...process.env, HERMES_HOME: opts.hermesHome, HERMES_MGR_CHILD: '1' },
        encoding: 'utf8',
        timeout: opts.timeoutMs ?? 30_000,
        maxBuffer: 256 * 1024,
      },
      (error, _stdout, stderr) => {
        if (!error) {
          resolve();
          return;
        }
        const detail = String(stderr ?? '').trim().split('\n').slice(-3).join(' ').slice(0, 400);
        reject(new Error(`hermes plugins ${enabled ? 'enable' : 'disable'} ${name} failed: ${detail || error.message}`));
      },
    );
  });
}
