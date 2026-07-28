import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mobileClientBundleEnv } from '../../../../scripts/shared/client-endpoint-build-env.mjs';
import { withLocalMobileRegionConfig } from './mobile-dev-region.mjs';

const mobileDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Parse the optional Metro port shared by sim:start and sim:whoami. */
export function extractSimMetroPortArgs(args, defaultPort = 8081) {
  let port = defaultPort;
  let seen = false;
  const passthrough = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    let value = null;
    if (arg === '--port' || arg === '-p') {
      value = args[++index];
    } else if (arg.startsWith('--port=')) {
      value = arg.slice('--port='.length);
    } else {
      passthrough.push(arg);
      continue;
    }

    if (seen) throw new Error('Metro 端口只能传一次');
    seen = true;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
      throw new Error(`Metro 端口无效: ${value ?? '(缺失)'}`);
    }
    port = parsed;
  }

  return { port, explicit: seen, passthrough };
}

/**
 * 用实际 Expo config 解析本地 Simulator development client 的 bundle id。
 * 测试可注入 execFile,避免真的启动 Expo CLI。
 */
export function resolveMobileSimulatorBundleId(region, options = {}) {
  const run = options.execFile ?? execFileSync;
  const buildEnv = withLocalMobileRegionConfig(
    mobileClientBundleEnv({ authRegion: region }),
  );
  let raw;
  try {
    raw = run('pnpm', ['exec', 'expo', 'config', '--type', 'public', '--json'], {
      cwd: options.mobileDir ?? mobileDir,
      env: { ...(options.env ?? process.env), ...buildEnv },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const detail = String(error?.stderr ?? error?.message ?? error).trim();
    throw new Error(
      `无法解析 ${region} Simulator bundle id${detail ? `: ${detail}` : ''}`,
      { cause: error },
    );
  }

  let config;
  try {
    config = JSON.parse(String(raw));
  } catch (error) {
    throw new Error(`Expo config 未返回合法 JSON(region=${region})`, { cause: error });
  }
  const bundleId = config?.ios?.bundleIdentifier;
  if (typeof bundleId !== 'string' || !bundleId.trim()) {
    throw new Error(`Expo config 缺少 ios.bundleIdentifier(region=${region})`);
  }
  return bundleId.trim();
}
