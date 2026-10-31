// 有界 pod install:sim-rebuild.mjs 的 pod 执行层,独立成模块以便单测。
//
// 为什么不是"总时长超时":fresh worktree 的 pod install 可能要下载 ~90MB 的
// RN prebuilt 产物,慢网络(实测 ~70KB/s)下合法耗时 20 分钟以上,按总时长杀会
// 误杀慢但在推进的下载。挂死(实测过 CDN 连接停在 CLOSE_WAIT 干等 20 分钟)的
// 特征是"没有任何输出":curl 下载、CocoaPods 安装日志都会持续产生 stdout/stderr。
// 所以这里用**输出空转看门狗**——连续 idleTimeoutMs 无任何输出才 SIGKILL,
// 把"无限等"变成"分钟级失败",同时不影响慢速但健康的下载。
import { execFileSync, spawn } from 'node:child_process';

export const COCOAPODS_SETUP_HINT = '请按 docs/dev-rules/environment-setup.md 的 iOS 工具链说明准备 CocoaPods，并在当前 Agent 环境验证 pod --version；已有 Homebrew 可用 brew install cocoapods，否则使用独立 Ruby 的 gem install cocoapods --user-install 并配置 PATH。';

// Only call after a cache miss: installing a compatible cached app does not need CocoaPods.
// Version/SDK probes are read-only; never install tools or accept Xcode licenses here.
/** @param {{ env?: NodeJS.ProcessEnv, run?: (command: string, args: string[], options: import('node:child_process').ExecFileSyncOptionsWithStringEncoding) => string }} options */
export function inspectIOSBuildTools({ env = process.env, run = execFileSync } = {}) {
  const checks = [
    ['xcodebuild', ['-version']],
    ['xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-path']],
    ['pod', ['--version']],
  ].map(([tool, args]) => {
    try {
      run(tool, args, {
        env: { ...env, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' },
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000,
        killSignal: 'SIGKILL',
      });
      return { tool, healthy: true, code: 'ready' };
    } catch (error) {
      // Do not return arbitrary child output or environment values in the receipt.
      return { tool, healthy: false, code: error.code === 'ENOENT' ? 'missing'
        : error.code === 'ETIMEDOUT' ? 'timeout' : 'failed' };
    }
  });
  return { healthy: checks.every((check) => check.healthy), checks };
}

// 连续无输出判挂死的窗口。CocoaPods 有静默阶段(依赖解析、Generating Pods
// project),实测在分钟级以内;5 分钟静默基本只剩死连接一种解释。
export const POD_IDLE_TIMEOUT_MS = 5 * 60_000;

/**
 * 跑一次 `pod install [args]`,带输出空转看门狗。
 * 输出透传到 stdout/stderr(可注入,便于测试);任何 stdout/stderr 活动都会
 * 重置看门狗。空转超时 SIGKILL 并 reject(error.idleKilled = true)。
 *
 * @param {{
 *   iosDir: string,
 *   args?: string[],
 *   env?: NodeJS.ProcessEnv,
 *   idleTimeoutMs?: number,
 *   podBin?: string,
 *   stdout?: NodeJS.WritableStream,
 *   stderr?: NodeJS.WritableStream,
 * }} input
 * @returns {Promise<void>}
 */
export function runPodInstallOnce({
  iosDir,
  args = [],
  env = process.env,
  idleTimeoutMs = POD_IDLE_TIMEOUT_MS,
  podBin = 'pod',
  stdout = process.stdout,
  stderr = process.stderr,
}) {
  return new Promise((resolvePromise, rejectPromise) => {
    // detached:让 pod 拿到自己的进程组。pod(ruby)会 spawn curl 等子进程下载
    // 产物,挂死时只 SIGKILL ruby 会留下持有 stdout/stderr 管道的孤儿 curl,
    // 既没杀干净又让 'close' 事件永不触发(CI 实测卡到测试超时)。组杀 + 按
    // 'exit'(进程终止即触发,不等管道)结算,孤儿进程无法阻塞收尾。
    const detached = process.platform !== 'win32';
    const child = spawn(podBin, ['install', ...args], {
      cwd: iosDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached,
    });
    let lastActivityAt = Date.now();
    let idleKilled = false;
    let settled = false;
    child.stdout.on('data', (chunk) => {
      lastActivityAt = Date.now();
      stdout.write(chunk);
    });
    child.stderr.on('data', (chunk) => {
      lastActivityAt = Date.now();
      stderr.write(chunk);
    });
    const killWholeGroup = () => {
      if (detached && child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL');
          return;
        } catch {
          // 进程组可能已消失;退回单进程 kill。
        }
      }
      child.kill('SIGKILL');
    };
    const watchdog = setInterval(() => {
      if (Date.now() - lastActivityAt >= idleTimeoutMs) {
        idleKilled = true;
        killWholeGroup();
      }
    }, Math.max(50, Math.min(10_000, Math.floor(idleTimeoutMs / 4))));
    const settle = (fn) => {
      if (settled) return;
      settled = true;
      clearInterval(watchdog);
      child.stdout.destroy();
      child.stderr.destroy();
      fn();
    };
    child.on('error', (error) => {
      settle(() => rejectPromise(error));
    });
    child.on('exit', (code, signal) => {
      settle(() => {
        if (code === 0) {
          resolvePromise();
          return;
        }
        const label = `pod install${args.length ? ` ${args.join(' ')}` : ''}`;
        const error = new Error(idleKilled
          ? `${label} 连续 ${Math.round(idleTimeoutMs / 1000)}s 无输出,按挂死处理(已 SIGKILL 进程组)`
          : `${label} 失败(${signal ?? `exit ${code}`})`);
        error.idleKilled = idleKilled;
        rejectPromise(error);
      });
    });
  });
}

/**
 * sim-rebuild 用的完整 pod install 策略:
 * 1. 先不带 --repo-update 用本地 specs(绝大多数情况足够,也不打 CDN 的 repo 更新);
 * 2. 失败(含空转挂死)再带 --repo-update 重试一次;
 * 两次都在空转看门狗下运行。LANG/LC_ALL 显式给 UTF-8:agent 终端里 LANG 常为空,
 * CocoaPods 的 unicode_normalize 会抛 Encoding::CompatibilityError。
 * `pod` 不存在时抛 error.podMissing = true,调用方给安装指引。
 *
 * @param {{
 *   iosDir: string,
 *   env?: NodeJS.ProcessEnv,
 *   idleTimeoutMs?: number,
 *   podBin?: string,
 *   log?: { warn?: (message: string) => void },
 * }} input
 * @returns {Promise<void>}
 */
export async function podInstallBounded({ iosDir, env = process.env, idleTimeoutMs, podBin, log = console }) {
  const podEnv = { ...env, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' };
  const once = (args) => runPodInstallOnce({ iosDir, args, env: podEnv, idleTimeoutMs, podBin });
  try {
    await once([]);
    return;
  } catch (error) {
    if (error.code === 'ENOENT') {
      const missing = new Error(`找不到 pod（CocoaPods）。${COCOAPODS_SETUP_HINT}`);
      missing.podMissing = true;
      missing.cause = error;
      throw missing;
    }
    log.warn?.(`  pod install(本地 specs)失败:${error.message}\n  带 --repo-update 重试一次…`);
  }
  await once(['--repo-update']);
}
