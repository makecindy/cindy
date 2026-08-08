/**
 * ghCliTokenSource — 从本地 GitHub CLI(gh)登录态读取 token 的零配置来源。
 *
 * 动机:绝大多数开发者本机已 `gh auth login` 过,不该强迫再去设置页手填 PAT。
 * GitHub 插件网络层优先读取本来源，不可用时再回落设置页 PAT；其它宿主
 * GitHub 功能可直接复用同一个共享 token source。
 *
 * 实现要点:
 *   - `gh auth token` 输出当前登录 token(通常 gho_ 前缀 OAuth token),
 *     对 REST 只读查询(PR 状态)权限足够。
 *   - GUI app(packaged Electron)的 PATH 不含 homebrew 等目录,先探测各平台
 *     常见绝对路径,找不到再退回裸 'gh' 走 PATH。
 *   - 正缓存默认 5 min;**负缓存默认 30s**——UI 提示用户跑 gh auth login,
 *     登录完成后最迟 30s 内生效,不能让"未登录"被钉死 5 分钟(Codex review P2)。
 *     没有缓存的话每次徽标刷新都会 spawn 一次 gh。
 *   - 依赖注入(execFile / exists / platform / now),单测零子进程。
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';

import { createLogger } from '../logger.js';

const log = createLogger('git-context/gh-cli');

/** 各平台 gh 常见安装位置(按命中概率排序);都不存在则退回裸 'gh' 走 PATH。 */
const GH_CANDIDATES: Record<string, string[]> = {
  darwin: ['/opt/homebrew/bin/gh', '/usr/local/bin/gh'],
  linux: ['/usr/bin/gh', '/usr/local/bin/gh', '/home/linuxbrew/.linuxbrew/bin/gh'],
  win32: [
    'C:\\Program Files\\GitHub CLI\\gh.exe',
    'C:\\Program Files (x86)\\GitHub CLI\\gh.exe',
  ],
};

const DEFAULT_CACHE_TTL_MS = 5 * 60_000;
const DEFAULT_NEGATIVE_CACHE_TTL_MS = 30_000;
const GH_TIMEOUT_MS = 3_000;
const GH_PROBE_TIMEOUT_MS = 800;

export interface GhCliTokenSourceDeps {
  execFileFn?: (
    file: string,
    args: string[],
    opts: { timeout: number },
    cb: (err: Error | null, stdout: string, stderr: string) => void,
  ) => void;
  existsFn?: (p: string) => boolean;
  platform?: NodeJS.Platform;
  cacheTtlMs?: number;
  /** 未拿到 token(未安装/未登录)时的缓存时长,默认 30s。 */
  negativeCacheTtlMs?: number;
  now?: () => number;
}

export interface GhCliTokenSource {
  /** 返回本地 gh 登录 token;未安装 / 未登录 / 超时返回 null,永不抛错。 */
  readToken(): Promise<string | null>;
  /** 只探测 github.com 登录可用性，不读取或缓存 token。 */
  probeAvailability(): Promise<boolean>;
}

export function createGhCliTokenSource(deps: GhCliTokenSourceDeps = {}): GhCliTokenSource {
  const execFileFn = deps.execFileFn ?? execFile;
  const existsFn = deps.existsFn ?? fs.existsSync;
  const platform = deps.platform ?? process.platform;
  const ttl = deps.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const negativeTtl = deps.negativeCacheTtlMs ?? DEFAULT_NEGATIVE_CACHE_TTL_MS;
  const now = deps.now ?? Date.now;

  let cached: { token: string | null; expiresAt: number } | null = null;
  let inFlight: Promise<string | null> | null = null;

  function resolveGhBinary(): string {
    for (const candidate of GH_CANDIDATES[platform] ?? []) {
      if (existsFn(candidate)) return candidate;
    }
    return platform === 'win32' ? 'gh.exe' : 'gh';
  }

  async function fetchToken(): Promise<string | null> {
    const bin = resolveGhBinary();
    return new Promise<string | null>((resolve) => {
      try {
        execFileFn(bin, ['auth', 'token'], { timeout: GH_TIMEOUT_MS }, (err, stdout) => {
          if (err) {
            // 未安装(ENOENT)/ 未登录(exit 1)/ 超时都归一为 null,只 debug 级记录。
            log.debug('gh auth token unavailable', { bin, err: String(err) });
            resolve(null);
            return;
          }
          const token = stdout.trim();
          resolve(token.length > 0 ? token : null);
        });
      } catch (err) {
        log.debug('gh spawn threw', { err: String(err) });
        resolve(null);
      }
    });
  }

  async function probeAvailability(): Promise<boolean> {
    const bin = resolveGhBinary();
    return new Promise<boolean>((resolve) => {
      try {
        // stdout/stderr 都不进入日志；该调用只消费退出码，绝不取得 token。
        execFileFn(
          bin,
          ['auth', 'status', '--hostname', 'github.com'],
          { timeout: GH_PROBE_TIMEOUT_MS },
          (err) => resolve(err === null),
        );
      } catch {
        resolve(false);
      }
    });
  }

  return {
    probeAvailability,
    async readToken(): Promise<string | null> {
      if (cached && cached.expiresAt > now()) return cached.token;
      if (inFlight) return inFlight;
      inFlight = fetchToken()
        .then((token) => {
          cached = { token, expiresAt: now() + (token ? ttl : negativeTtl) };
          return token;
        })
        .finally(() => {
          inFlight = null;
        });
      return inFlight;
    },
  };
}

let sharedSource: GhCliTokenSource | null = null;

/**
 * 进程内共享实例。多个消费方(PR 状态徽标、「我的 Issue」列表)各自 new 一份的话,
 * 缓存互不可见 —— 同一段时间会重复 spawn `gh`,负缓存也各算一套。
 */
export function getSharedGhCliTokenSource(): GhCliTokenSource {
  if (!sharedSource) sharedSource = createGhCliTokenSource();
  return sharedSource;
}
