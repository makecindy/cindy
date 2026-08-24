import { execFileSync } from 'node:child_process';
import { dirname, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mobileClientBundleEnv } from '../../../../scripts/shared/client-endpoint-build-env.mjs';
import { withLocalMobileRegionConfig } from './mobile-dev-region.mjs';

const mobileDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SIMULATOR_UDID_PATTERN = /^[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}$/;

/** Parse one optional exact Simulator target without changing sim:start arguments. */
export function extractSimWhoamiUdidArgs(args) {
  let simulatorUdid = null;
  const passthrough = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    let value = null;
    if (arg === '--udid') {
      value = args[++index];
    } else if (arg.startsWith('--udid=')) {
      value = arg.slice('--udid='.length);
    } else {
      passthrough.push(arg);
      continue;
    }

    if (simulatorUdid !== null) throw new Error('Simulator UDID 只能传一次');
    const normalized = String(value ?? '').trim().toUpperCase();
    if (!SIMULATOR_UDID_PATTERN.test(normalized)) {
      throw new Error(`Simulator UDID 无效: ${value ?? '(缺失)'}`);
    }
    simulatorUdid = normalized;
  }

  return { simulatorUdid, passthrough };
}

/** Select only the exact booted device when Host supplies a Simulator target. */
export function bootedSimulatorLinesForTarget(lines, simulatorUdid) {
  const booted = lines.filter((line) => /\(Booted\)/.test(line));
  if (!simulatorUdid) return booted;
  const exactUdid = simulatorUdid.toUpperCase();
  return booted.filter((line) => line.toUpperCase().includes(`(${exactUdid})`));
}

/** Probe app installation on the exact Host-owned Simulator without fallback. */
export function getSimulatorAppContainer(run, simulatorUdid, bundleId) {
  return run('xcrun', [
    'simctl',
    'get_app_container',
    simulatorUdid ?? 'booted',
    bundleId,
    'app',
  ]);
}

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

/** Parse the explicit simulator handoff permission used only by the personal Skill. */
export function extractSimTakeoverArgs(args) {
  let takeover = false;
  const passthrough = [];

  for (const arg of args) {
    if (arg === '--takeover') {
      if (takeover) throw new Error('--takeover 只能传一次');
      takeover = true;
    } else {
      passthrough.push(arg);
    }
  }

  return { takeover, passthrough };
}

/** Decide whether a listener has enough Cindy-specific identity for an explicit handoff. */
export function classifySimMetroListener({ cwd, source, targetWorktree }) {
  if (!cwd) return { confirmed: false, worktree: null };

  const normalizedCwd = normalize(cwd).replaceAll('\\', '/').replace(/\/+$/, '');
  const normalizedTarget = normalize(targetWorktree).replaceAll('\\', '/').replace(/\/+$/, '');
  const suffix = '/apps/mobile';
  if (!normalizedCwd.endsWith(suffix) || !source) {
    return { confirmed: false, worktree: null };
  }

  const worktree = normalizedCwd.slice(0, -suffix.length);
  return {
    confirmed: true,
    worktree,
    isTarget: worktree === normalizedTarget,
  };
}

/**
 * Decide whether sim:start should reuse, restart, or refuse the occupant on 8081.
 *
 * `--takeover` may stop a confirmed Cindy Metro (cwd ends with /apps/mobile and
 * the process has an injected source token). It does not require the occupying
 * worktree's live git fingerprint to still match the running Metro. A missing
 * worktree is an orphan Metro and is also eligible. Unknown occupants stay
 * fail-closed even with `--takeover`.
 */
export function resolveSimMetroHandoff({
  port = 8081,
  cwd = null,
  takeover = false,
  envChanged = false,
  currentSource,
  runningSource,
  listener,
  listenerWorktreeExists = false,
} = {}) {
  const occupant = cwd || '(未知进程)';

  if (!listener?.confirmed) {
    return {
      action: 'refuse',
      code: 'occupied-unknown',
      lines: [
        `✗ 端口 ${port} 被其他进程占用:${occupant}`,
        '  不是可确认的 Cindy Metro(需要 .../apps/mobile 工作目录 + 注入的源码指纹)。',
        '  未知进程即使传 `--takeover` 也不会停。',
      ],
    };
  }

  if (listener.isTarget) {
    if (runningSource === currentSource) {
      if (envChanged && !takeover) {
        return {
          action: 'refuse',
          code: 'target-env-stale',
          lines: [
            `✗ 已补/改 apps/mobile/.env,但 ${port} 上的 Metro 是用旧 env 启动的(env 在 bundle 时注入)。`,
            '  需要刷新 env 时传 `--takeover` 重起,新 env 才会生效。',
          ],
        };
      }
      if (envChanged && takeover) {
        return { action: 'restart', code: 'target-env', lines: [] };
      }
      return {
        action: 'reuse',
        code: 'target-fresh',
        lines: [
          `✓ Metro 已在 ${port} 运行(本 worktree,源码指纹 ${currentSource})。改 JS 直接 Fast Refresh,无需重开。`,
        ],
      };
    }
    if (!takeover) {
      return {
        action: 'refuse',
        code: 'target-stale',
        lines: [
          `✗ ${port} 上是本 worktree 的 Metro,但源码指纹已过期(运行中=${runningSource || '(无)'} ≠ 当前=${currentSource})。`,
          '  这通常表示 Metro 启动后又 amend/rebase/reset/改过文件。需要接管时传 `--takeover` 重起。',
        ],
      };
    }
    return { action: 'restart', code: 'target-stale', lines: [] };
  }

  if (!listenerWorktreeExists) {
    if (!takeover) {
      return {
        action: 'refuse',
        code: 'occupied-orphan',
        lines: [
          `✗ 端口 ${port} 被已删除 worktree 的孤儿 Metro 占用:${occupant}`,
          '  该目录已不存在,进程还占着端口。确认可以清掉时传 `--takeover`。',
        ],
      };
    }
    return { action: 'restart', code: 'occupied-orphan', lines: [] };
  }

  if (!takeover) {
    return {
      action: 'refuse',
      code: 'occupied-foreign',
      lines: [
        `✗ 端口 ${port} 被其他 Cindy worktree 的 Metro 占用:${occupant}`,
        '  当前版本需要这块端口。确认可以切换时传 `--takeover`。',
      ],
    };
  }
  return { action: 'restart', code: 'occupied-foreign', lines: [] };
}

/** Parse the machine-readable output switch for mobile:sim:whoami. */
export function extractSimJsonArgs(args) {
  let json = false;
  const passthrough = [];

  for (const arg of args) {
    if (arg === '--json') {
      if (json) throw new Error('--json 只能传一次');
      json = true;
    } else {
      passthrough.push(arg);
    }
  }

  return { json, passthrough };
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
