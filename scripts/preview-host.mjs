/** Local PR preview: one isolated profile, never the installed Cindy profile. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appData = process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support')
  : process.platform === 'win32' ? process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
    : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
// Defaults can be overridden for a second preview: CINDY_HOST_PREVIEW_NAME / _PORT / _REGION.
const previewPort = process.env.CINDY_HOST_PREVIEW_PORT || '3466';
const profile = path.join(appData, 'CindyHostPreview', process.env.CINDY_HOST_PREVIEW_NAME || 'pr-9246');
const env = { ...process.env, CINDY_HOST_DATA_DIR: profile, XDT_USER_DATA_DIR: profile,
  CINDY_HOST_PORT: previewPort, CINDY_HOST_REGION: process.env.CINDY_HOST_PREVIEW_REGION || 'global',
  XDT_OFFICIAL_SHARED_PROFILE: '0' };
// Do not inherit an owner or endpoint from the Cindy process hosting this task.
delete env.CINDY_HOST_OWNER;
delete env.CINDY_HOST_OWNER_KEY;
delete env.CINDY_HOST_API;
const nodeArgs = ['--import', 'tsx', '--import', './apps/host/src/loaders/register-raw.mjs', 'apps/host/src/main.ts'];
const command = process.argv[2] ?? 'start';
function run(args) {
  const result = spawnSync(process.execPath, args, { cwd: root, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Preview command exited (${result.status ?? result.signal})`);
}
async function ready(expectedPid) {
  try {
    const endpoint = JSON.parse(fs.readFileSync(path.join(profile, 'host-endpoint.json'), 'utf8'));
    if (endpoint.baseUrl !== `http://127.0.0.1:${previewPort}` || (expectedPid && endpoint.pid !== expectedPid)) return false;
    const token = fs.readFileSync(path.join(profile, 'host-api-token'), 'utf8').trim();
    const response = await fetch(`${endpoint.baseUrl}/api/auth/state`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: '{}', redirect: 'error', signal: AbortSignal.timeout(1000),
    });
    return response.ok;
  } catch { return false; }
}

try {
  if (command === 'login') {
    const loginArgs = process.argv.slice(3);
    run([...nodeArgs, 'login', ...(loginArgs.length ? loginArgs : ['--method=google'])]);
    console.log('登录已保存到独立测试目录。运行 pnpm preview:host 启动网页版；若测试服务已启动，请先停止后重启。');
  } else if (command === 'open') {
    run(['apps/host/src/open-client.mjs']);
  } else if (command === 'start') {
    if (await ready()) {
      run(['apps/host/src/open-client.mjs']);
    } else {
      if (!fs.existsSync(path.join(root, 'apps/desktop/.vite/renderer/main_window/index.html'))) {
        throw new Error('缺少网页构建，请先运行 pnpm --filter desktop exec vite build --config vite.renderer.config.ts');
      }
      const child = spawn(process.execPath, [...nodeArgs, 'serve'], { cwd: root, env, stdio: 'inherit' });
      let ended = false;
      child.once('exit', code => { ended = true; process.exitCode = code ?? 1; });
      child.once('error', error => { ended = true; console.error(error.message); process.exitCode = 1; });
      for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
      let opened = false;
      for (let attempt = 0; attempt < 30 && !ended; attempt++) {
        if (await ready(child.pid)) { run(['apps/host/src/open-client.mjs']); opened = true; break; }
        await delay(500);
      }
      if (!opened && !ended) {
        console.error('测试服务尚未就绪，请查看上面的启动信息。就绪后运行 pnpm preview:host open。');
      }
    }
  } else throw new Error('Usage: pnpm preview:host [start|open|login [--method=google|apple]]');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
