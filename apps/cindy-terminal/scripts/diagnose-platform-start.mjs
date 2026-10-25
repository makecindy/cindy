// CI-only diagnostic for a failed native startup. The imported host receives a
// fresh synthetic HOME/profile; no CI account credentials are loaded or printed.
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { runtimePackages, imRuntimePackages } from './runtime-externals.mjs';
const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!process.env.CINDY_ACCEPTANCE_OUTPUT) throw new Error('CINDY_ACCEPTANCE_OUTPUT must identify the packaged native runtime.');
const runtimeApp = path.resolve(process.env.CINDY_ACCEPTANCE_OUTPUT, 'app');
const output = path.join(runtimeApp, 'dist', 'diagnostic-service.mjs');
await build({
  stdin: { contents: "export { TerminalService } from './src/service.ts'; export { TerminalServiceManager } from './src/service-manager.ts';", resolveDir: app },
  outfile: output, platform: 'node', target: 'node22', format: 'esm', bundle: true,
  loader: { '.md': 'text' }, external: [...runtimePackages, ...imRuntimePackages, 'fsevents'],
  banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
});
const temporary = await mkdtemp(path.join(os.tmpdir(), 'cindy-start-diagnostic-'));
const home = path.join(temporary, 'home'); await mkdir(home);
const inheritedKeys = new Set(['path', 'systemroot', 'windir', 'comspec', 'pathext', 'temp', 'tmp', 'tmpdir', 'lang', 'lc_all', 'ci']);
for (const key of Object.keys(process.env)) {
  if (!inheritedKeys.has(key.toLowerCase())) delete process.env[key];
}
Object.assign(process.env, { HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData/Roaming'), LOCALAPPDATA: path.join(home, 'AppData/Local'), XDG_CONFIG_HOME: path.join(home, '.config'), XDG_STATE_HOME: path.join(home, '.local/state') });
const { TerminalService, TerminalServiceManager } = await import(pathToFileURL(output).href);
const service = new TerminalService(path.join(temporary, 'profile'));
const manager = new TerminalServiceManager(path.join(temporary, 'profile'), path.join(runtimeApp, 'dist', 'cli.js'));
try {
  await service.start(); console.log('ISOLATED_START_OK');
  await manager.install(); console.log('ISOLATED_REGISTRATION_OK');
  await manager.uninstall(); console.log('ISOLATED_UNREGISTRATION_OK');
}
catch (error) {
  // Raw details are confined to this explicit synthetic-profile diagnostic.
  const detail = error => error ? { name: error.name, message: error.message, code: error.code, signal: error.signal, killed: error.killed, syscall: error.syscall, stderr: error.stderr, stack: error.stack, cause: detail(error.cause) } : undefined;
  console.error(JSON.stringify(detail(error), null, 2));
  process.exitCode = 1;
} finally {
  await manager.uninstall().catch(() => {});
  await service.close().catch(() => {});
  await rm(temporary, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
}
