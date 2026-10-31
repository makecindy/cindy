/** Runs the standard real Electron Host with a plugin virtual service in a unique profile. */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
for (const extra of [[], ['--raw'], ['--author=static'], ['--author=loader'], ['--author=files']]) {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./mcp-apps-sandbox.verify.mjs', import.meta.url)), '--plugin', ...extra], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
