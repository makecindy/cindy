#!/usr/bin/env node
/**
 * ensure-agent-binaries — 按需下载 agent CLI 二进制（claude / codex / ripgrep）。
 *
 * 这些二进制不再进 git/LFS（见 .gitattributes / .gitignore）。本脚本在 dev 启动、
 * 打包、发版时按"当前/目标平台 + tools/<kind>/latest.json 里 pin 的版本"从上游按需
 * 下载到 apps/<kind>-bin/<platform>/，已存在合法文件则跳过。
 *
 * 下载实现复用 tools/<kind>/update.mjs 的 ensurePlatform()，本脚本只做编排：
 * 解析 pin 版本 → 校验本地是否已就位 → 先尝试从兄弟 git worktree 复用同 pin 版本
 * 的本地二进制（copy-on-write clone，秒级、不占双倍磁盘）→ 都没有才走网络下载。
 *
 * 既可 CLI 跑，也可被 import：
 *   CLI:    node scripts/ensure-agent-binaries.mjs --kinds=claude,codex,ripgrep --platform=current
 *   import: import { ensureBinary } from './ensure-agent-binaries.mjs'
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { downloadFromCdn } from './agent-binary-cdn-fallback.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const LFS_POINTER_HEADER = 'version https://git-lfs.github.com/spec/v1';
const MIN_EXPECTED_BYTES = 1024;

// kind → 本地落点 + 提供 ensurePlatform/readPinnedVersion 的下载模块
const KINDS = {
  claude: { binDir: 'claude-code-bin', base: 'claude', module: '../tools/claude/update.mjs' },
  codex: { binDir: 'codex-bin', base: 'codex', module: '../tools/codex/update.mjs' },
  ripgrep: { binDir: 'ripgrep-bin', base: 'rg', module: '../tools/ripgrep/update.mjs' },
};

const log = (msg) => console.log(`\x1b[36m[ensure-agent-binaries]\x1b[0m ${msg}`);
const warn = (msg) => console.log(`\x1b[33m[ensure-agent-binaries]\x1b[0m ${msg}`);

export function currentPlatformKey() {
  return `${process.platform}-${process.arch}`;
}

/** win32 平台二进制带 .exe 后缀；其它平台用裸名。 */
export function binFileFor(base, platformKey) {
  return platformKey.startsWith('win32') ? `${base}.exe` : base;
}

/** 读 apps/<binDir>/<platform>/.version 里记录的已安装版本；缺失/读失败返回 null。 */
export function readInstalledVersion(markerPath) {
  try {
    return fs.readFileSync(markerPath, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

/** 本地文件是否为已就位的合法二进制（不是 LFS pointer、不是过小的占位）。 */
export function isValidBinary(absPath) {
  if (!fs.existsSync(absPath)) return false;
  let prefix = '';
  try {
    const fd = fs.openSync(absPath, 'r');
    try {
      const buffer = Buffer.alloc(64);
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
      prefix = buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
  if (prefix.startsWith(LFS_POINTER_HEADER)) return false;
  return fs.statSync(absPath).size >= MIN_EXPECTED_BYTES;
}

/**
 * 枚举当前仓库的其它 git worktree 根路径（排除 rootDir 自身；主 checkout 排最前，
 * 与 `git worktree list` 输出顺序一致）。git 不可用 / 不在 git 仓库里时返回 []，
 * 调用方直接走网络下载，不因此报错。
 */
export function listSiblingWorktreeRoots(rootDir) {
  let out = '';
  try {
    out = execFileSync('git', ['-C', rootDir, 'worktree', 'list', '--porcelain'], {
      encoding: 'utf8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return [];
  }
  let selfReal = rootDir;
  try {
    selfReal = fs.realpathSync(rootDir);
  } catch {
    /* keep rootDir as-is */
  }
  const roots = [];
  for (const line of out.split('\n')) {
    if (!line.startsWith('worktree ')) continue;
    const raw = line.slice('worktree '.length).trim();
    if (!raw) continue;
    let real;
    try {
      real = fs.realpathSync(raw); // stale 的 worktree 条目（目录已删）直接跳过
    } catch {
      continue;
    }
    if (real === selfReal) continue;
    roots.push(real);
  }
  return roots;
}

/**
 * 尝试从候选目录（兄弟 worktree 的 apps/<binDir>/<platform>/）复制同 pin 版本的
 * 合法二进制到 destDir。纯本地操作：优先 copy-on-write clone（APFS/ReFS，
 * COPYFILE_FICLONE，不支持的文件系统自动回退普通拷贝），先落 tmp 再 rename 保证
 * 不留半成品。成功返回来源目录路径，所有候选都不可用时返回 null（调用方走网络）。
 */
export function tryReuseFromSiblingWorktree({ candidates, binFile, version, destDir }) {
  for (const candidateDir of candidates) {
    const srcBin = path.join(candidateDir, binFile);
    if (readInstalledVersion(path.join(candidateDir, '.version')) !== version) continue;
    if (!isValidBinary(srcBin)) continue;
    const destBin = path.join(destDir, binFile);
    const tmpBin = `${destBin}.reuse-tmp`;
    try {
      fs.mkdirSync(destDir, { recursive: true });
      fs.copyFileSync(srcBin, tmpBin, fs.constants.COPYFILE_FICLONE);
      if (process.platform !== 'win32') fs.chmodSync(tmpBin, 0o755);
      fs.renameSync(tmpBin, destBin);
      fs.writeFileSync(path.join(destDir, '.version'), `${version}\n`);
      return candidateDir;
    } catch {
      // 目标被占用（EBUSY，app 运行中）或源被并发改动等——清理残留，试下一个候选。
      try {
        fs.rmSync(tmpBin, { force: true });
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}

/**
 * 确保 <kind> 在 <platformKey> 平台的二进制就位。已存在合法文件且非 force 时跳过。
 * 返回最终二进制的绝对路径。
 */
export async function ensureBinary(kind, platformKey = currentPlatformKey(), { force = false } = {}) {
  const cfg = KINDS[kind];
  if (!cfg) throw new Error(`Unknown kind: ${kind} (known: ${Object.keys(KINDS).join(', ')})`);

  const binFile = binFileFor(cfg.base, platformKey);
  const binDirPath = path.join(ROOT, 'apps', cfg.binDir, platformKey);
  const binPath = path.join(binDirPath, binFile);
  const markerPath = path.join(binDirPath, '.version');

  // 先解析 pin 版本——skip 判定必须同时比对版本，否则旧的合法二进制会让 pin 升级被静默跳过。
  const mod = await import(cfg.module);
  const version = mod.readPinnedVersion();
  if (!version) {
    throw new Error(
      `No pinned version found for ${kind} (tools/${kind}/latest.json). ` +
        `Run "pnpm update:${kind}" first to pin a version.`,
    );
  }

  // 已就位且版本标记 == pin 才跳过；标记缺失/不匹配则刷新（promoteOnePlatform 写入标记）。
  if (!force && isValidBinary(binPath) && readInstalledVersion(markerPath) === version) {
    log(`${kind} ${platformKey}: already present @ ${version}, skip`);
    return binPath;
  }

  // 网络下载前先看本机其它 worktree 有没有同 pin 版本的合法二进制——多 worktree
  // 工作流下新 checkout 十有八九能秒级 clone 复用（APFS copy-on-write，不占双倍
  // 磁盘），弱网/断网时这是唯一不用等超时的路径。force 语义是"强制重新获取"，
  // 保持走正宗下载不复用。
  let reusedFrom = null;
  if (!force) {
    reusedFrom = tryReuseFromSiblingWorktree({
      candidates: listSiblingWorktreeRoots(ROOT).map((root) =>
        path.join(root, 'apps', cfg.binDir, platformKey),
      ),
      binFile,
      version,
      destDir: binDirPath,
    });
    if (reusedFrom) {
      log(`${kind} ${platformKey}: reused local copy @ ${version} from ${reusedFrom}`);
    }
  }

  if (!reusedFrom) {
    log(`${kind} ${platformKey}: ensuring pinned version ${version}...`);
    try {
      await mod.ensurePlatform({ version, platformKey, force });
    } catch (upstreamErr) {
      // claude / codex / ripgrep：上游慢/失败（含 fetch-with-timeout 的 connect/stall/total/throughput 超时）→
      // 回退公司 CDN（国内快，.gz gunzip 后与上游裸二进制字节一致）。
      warn(`${kind} ${platformKey}: upstream failed/slow (${upstreamErr.message}); falling back to CDN...`);
      try {
        const r = await downloadFromCdn({ kind, version, platformKey, binPath });
        // CDN 兜底直接落 binPath（不走 updates/promote），手动写版本标记供后续 skip 判定与终检。
        try { fs.writeFileSync(markerPath, version + '\n'); } catch { /* ignore */ }
        log(`${kind} ${platformKey}: CDN fallback ok @ ${version} (gzVerified=${r.gzVerified}, binaryVerified=${r.binaryVerified})`);
      } catch (cdnErr) {
        throw new Error(
          `Failed to download ${kind} ${platformKey}@${version} from both upstream and CDN fallback:\n` +
            `  upstream: ${upstreamErr.message}\n` +
            `  CDN:      ${cdnErr.message}\n` +
            `  Fix: run "pnpm update:${kind}" manually, or check network / CDN availability.`,
        );
      }
    }
  }

  // 下载 / 本地复用后必须同时满足"二进制合法"且"版本标记 == pin"——promoteOnePlatform 在目标
  // 被占用（app 运行中、EBUSY）时只 warn 不抛，会留下旧 binary + 旧标记，这里据此把静默失败
  // 转成显式错误。本地复用路径同样受此终检兜底。
  const installed = readInstalledVersion(markerPath);
  if (!isValidBinary(binPath) || installed !== version) {
    throw new Error(
      `${kind} ${platformKey}: ensure failed — expected ${version} at ${binPath} but installed marker is ${installed ?? '(none)'}. ` +
        `The previous binary may be locked (app running); close it and retry, or run "pnpm update:${kind}".`,
    );
  }
  return binPath;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { kinds: null, platform: null, force: false, bestEffort: false };
  for (const a of argv) {
    if (a === '--force' || a === '-f') args.force = true;
    else if (a === '--best-effort') args.bestEffort = true;
    else if (a.startsWith('--kinds=')) args.kinds = a.slice('--kinds='.length);
    else if (a.startsWith('--platform=')) args.platform = a.slice('--platform='.length);
  }
  return args;
}

async function main() {
  const { kinds, platform, force, bestEffort } = parseArgs(process.argv.slice(2));
  const kindList = kinds ? kinds.split(',').map((k) => k.trim()).filter(Boolean) : Object.keys(KINDS);
  const platformKey = !platform || platform === 'current' ? currentPlatformKey() : platform;

  // best-effort 模式（postinstall hook 用）：可被 XDT_SKIP_AGENT_BIN_INSTALL 跳过；
  // 单 kind 失败只 warn、不阻断（典型：无网络 / GitHub 限流 / 不需要桌面端的 CI），
  // 真正的硬门槛留在 predev 的 ensure-dev-runtime-assets。
  if (bestEffort && process.env.XDT_SKIP_AGENT_BIN_INSTALL) {
    log(`skipped via XDT_SKIP_AGENT_BIN_INSTALL (${kindList.join(', ')}).`);
    return;
  }

  let failures = 0;
  for (const kind of kindList) {
    if (bestEffort) {
      try {
        await ensureBinary(kind, platformKey, { force });
      } catch (err) {
        failures++;
        warn(`${kind} ${platformKey}: ${err.message}`);
      }
    } else {
      await ensureBinary(kind, platformKey, { force });
    }
  }

  if (bestEffort && failures > 0) {
    warn(
      `${failures}/${kindList.length} agent 二进制未就位（best-effort，不阻断）。` +
        `首次桌面端 dev 启动会在 ensure-dev-runtime-assets 里重试，或手动 pnpm install:<kind>。`,
    );
    return; // best-effort 始终 exit 0
  }
  log(`done (${kindList.join(', ')} @ ${platformKey}).`);
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (isMain) {
  main().catch((err) => {
    console.error(`\x1b[31m[ensure-agent-binaries]\x1b[0m ${err.message ?? err}`);
    process.exit(1);
  });
}
