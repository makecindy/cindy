/**
 * 钉钉 dws CLI 的宿主侧 runner：定位用户自行安装的 dws 可执行文件，并以
 * argv 数组（不经 shell）拉起一次性命令或长驻事件流。
 *
 * - 只读取 dws 的输出，不读取、不复制其登录凭证（凭证由 dws 自己保管）。
 * - Windows 只直接执行 .exe：npm 装出来的 dws.cmd 会把正文参数交给 cmd.exe
 *   解析，消息里的特殊字符不安全，因此改为定位 npm 包内 vendor/dws.exe。
 * - stderr 不原样写日志（可能含消息正文或订阅标识）。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DWS_NOT_INSTALLED,
  parseDwsJsonOutput,
  type DwsRunner,
  type DwsStreamProcess,
} from '@cindy/im';

import { doctorSearchDirectories } from '../../cindy-make/doctorEnvironment';
import { killProcessTree } from '../../scheduler-host/proc-util';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_STDOUT_BYTES = 8 * 1024 * 1024;
const NPM_PACKAGE_VENDOR = ['node_modules', 'dingtalk-workspace-cli', 'vendor'];

export interface DwsBinaryLookupDeps {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  home: string;
  isExecutableFile(candidate: string): boolean;
}

/** 按优先级列出可能的 dws 可执行文件位置（纯函数，便于测试）。 */
export function dwsBinaryCandidates(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  home: string,
): string[] {
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  const exe = platform === 'win32' ? 'dws.exe' : 'dws';
  const dirs = doctorSearchDirectories(env, platform, home);
  const candidates: string[] = [];
  if (env.DWS_INSTALL_DIR) candidates.push(join(env.DWS_INSTALL_DIR, exe));
  // 官方安装脚本的默认位置（Windows 不在 doctor 搜索目录里）。
  candidates.push(join(home, '.local', 'bin', exe));
  for (const dir of dirs) candidates.push(join(dir, exe));
  if (platform === 'win32') {
    if (env.APPDATA) candidates.push(join(env.APPDATA, 'npm', ...NPM_PACKAGE_VENDOR, exe));
    if (env.LOCALAPPDATA) {
      candidates.push(join(env.LOCALAPPDATA, 'pnpm', 'global', '5', ...NPM_PACKAGE_VENDOR, exe));
    }
  }
  return [
    ...new Set(
      candidates.filter((candidate) => path.isAbsolute(candidate) || candidate.startsWith('/')),
    ),
  ];
}

export function findDwsBinary(deps: DwsBinaryLookupDeps): string | null {
  for (const candidate of dwsBinaryCandidates(deps.env, deps.platform, deps.home)) {
    if (deps.isExecutableFile(candidate)) return candidate;
  }
  return null;
}

function isExecutableFile(candidate: string): boolean {
  try {
    if (!fs.statSync(candidate).isFile()) return false;
    if (process.platform !== 'win32') fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export interface DwsRunnerDeps {
  resolveBinary(): string | null;
  spawnProcess(binary: string, args: readonly string[], options: { cwd?: string }): ChildProcess;
  killTree(child: ChildProcess): void;
}

const defaultDeps: DwsRunnerDeps = {
  resolveBinary: () =>
    findDwsBinary({
      env: process.env,
      platform: process.platform,
      home: os.homedir(),
      isExecutableFile,
    }),
  spawnProcess: (binary, args, options) =>
    spawn(binary, [...args], {
      cwd: options.cwd,
      windowsHide: true,
      // POSIX 下独立进程组，强杀时能连同子进程一起清理。
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    }),
  killTree: (child) => killProcessTree(child.pid, child),
};

/** 构造宿主 runner；测试注入假 spawn 与假 resolveBinary。 */
export function createDwsRunner(deps: DwsRunnerDeps = defaultDeps): DwsRunner {
  return {
    async isAvailable() {
      return deps.resolveBinary() !== null;
    },

    runJson(args, options = {}) {
      const binary = deps.resolveBinary();
      if (!binary) return Promise.reject(new Error(DWS_NOT_INSTALLED));
      return new Promise<unknown>((resolve, reject) => {
        let child: ChildProcess;
        try {
          child = deps.spawnProcess(binary, args, { cwd: options.cwd });
        } catch {
          reject(new Error(DWS_NOT_INSTALLED));
          return;
        }
        child.stdin?.end();
        const chunks: Buffer[] = [];
        let size = 0;
        let overflow = false;
        child.stdout?.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_STDOUT_BYTES) {
            overflow = true;
            return;
          }
          chunks.push(chunk);
        });
        // dws 在 stderr 打印诊断；只需排空，不记录内容。
        child.stderr?.resume();
        const timer = setTimeout(() => {
          deps.killTree(child);
          reject(new Error('dws command timed out'));
        }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
        child.once('error', () => {
          clearTimeout(timer);
          reject(new Error(DWS_NOT_INSTALLED));
        });
        child.once('close', () => {
          clearTimeout(timer);
          if (overflow) {
            reject(new Error('dws output exceeded the size limit'));
            return;
          }
          try {
            // dws 的错误也以 JSON 输出（含非零退出码）；统一按输出解析。
            resolve(parseDwsJsonOutput(Buffer.concat(chunks).toString('utf8')));
          } catch (error) {
            reject(error);
          }
        });
      });
    },

    spawnStream(args): DwsStreamProcess {
      const binary = deps.resolveBinary();
      if (!binary) throw new Error(DWS_NOT_INSTALLED);
      const child = deps.spawnProcess(binary, args, {});
      if (!child.stdout || !child.stderr) {
        deps.killTree(child);
        throw new Error('dws stream has no stdio');
      }
      return {
        stdout: child.stdout,
        stderr: child.stderr,
        closeStdin: () => child.stdin?.end(),
        forceKill: () => deps.killTree(child),
        onExit: (handler) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            handler(child.exitCode);
            return;
          }
          child.once('exit', (code) => handler(code));
        },
        onError: (handler) => {
          child.once('error', handler);
        },
      };
    },
  };
}
