// dirDist(目录分发)安装清单 —— promote 与 ensure 共用的单一来源。
//
// pi 这类 kind 的产物是"主执行文件 + theme / docs / native prebuilds / wasm 等
// 旁侧资产"的整目录(实测缺 theme/ 时 RPC 模式启动即崩)。只校验主执行文件会把
// 旁侧资产被删/损坏的残缺目录当成"已就位"跳过安装,随后打包进安装包(codex 报)。
// promote 时写 .manifest(相对路径 + 字节数),ensure 的 skip 判定与终检据此校验
// 整目录;清单缺失(旧安装/半成品)按未就位处理,重新走一次下载/promote 即自愈。
import fs from 'node:fs';
import path from 'node:path';

import { sha256File } from './verify-sha256.mjs';

export const DIR_DIST_MANIFEST_FILE = '.manifest';
const MARKER_FILES = new Set(['.version', DIR_DIST_MANIFEST_FILE]);

/**
 * 递归收集 destDir 下全部普通文件(排序稳定),写 .manifest。symlink/目录不入清单。
 * 每条同时记录字节数与 sha256:只比字节数挡不住「同长度被替换/损坏」的资产(供应链
 * 加固,codex review P1)—— 主执行文件与所有旁侧资产(theme/wasm/prebuild 等)都记哈希。
 */
export function writeDirDistManifest(destDir) {
  const files = [];
  const walk = (dir) => {
    const entries = fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = path.relative(destDir, abs).split(path.sep).join('/');
      if (MARKER_FILES.has(rel)) continue;
      files.push({ path: rel, size: fs.statSync(abs).size, sha256: sha256File(abs) });
    }
  };
  walk(destDir);
  fs.writeFileSync(
    path.join(destDir, DIR_DIST_MANIFEST_FILE),
    JSON.stringify({ files }, null, 2) + '\n',
  );
  return files.length;
}

/**
 * 校验 destDir 与清单一致:清单缺失/空/任一文件缺失、字节数不符或 sha256 不符 → false。
 * 每条都按记录的 sha256 重算比对(fail-closed):清单缺 sha256(旧版本写的 size-only 清单)
 * 一律视为不可信 → false,让上层重下/重 promote 生成带哈希的新清单(自愈,一次性)。
 */
export function verifyDirDistManifest(destDir) {
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(destDir, DIR_DIST_MANIFEST_FILE), 'utf8'));
  } catch {
    return false;
  }
  const files = Array.isArray(manifest?.files) ? manifest.files : null;
  if (!files || files.length === 0) return false;
  for (const entry of files) {
    if (
      !entry
      || typeof entry.path !== 'string'
      || !Number.isFinite(entry.size)
      || typeof entry.sha256 !== 'string'
      || !/^[0-9a-f]{64}$/.test(entry.sha256)
    ) {
      return false;
    }
    const abs = path.join(destDir, ...entry.path.split('/'));
    let stat;
    try {
      stat = fs.statSync(abs);
    } catch {
      return false;
    }
    if (!stat.isFile() || stat.size !== entry.size) return false;
    let actual;
    try {
      actual = sha256File(abs);
    } catch {
      return false;
    }
    if (actual !== entry.sha256) return false;
  }
  // 反向精确匹配:目录里不得有清单之外的条目。逐文件哈希只覆盖清单内条目,清单外的
  // 字节(旧构建残留 / 本地污染)完全不参与校验,却会被 ensure-agent-binaries 跳过刷新、
  // 被 stagePi 原样打进安装包 —— 成为未验证资产(codex review P1)。故递归枚举实际集合,
  // 要求与清单精确一致:多出普通文件、或出现任何 symlink/非普通文件(污染向量)即 false。
  const manifestPaths = new Set(files.map((entry) => entry.path));
  const actualPaths = [];
  let sawUnexpectedEntry = false;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(destDir, abs).split(path.sep).join('/');
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      if (MARKER_FILES.has(rel)) continue;
      // symlink / 设备文件等非普通文件:writeDirDistManifest 从不收录,出现即视为污染。
      if (!entry.isFile()) {
        sawUnexpectedEntry = true;
        continue;
      }
      actualPaths.push(rel);
    }
  };
  try {
    walk(destDir);
  } catch {
    return false;
  }
  if (sawUnexpectedEntry) return false;
  if (actualPaths.length !== manifestPaths.size) return false;
  for (const rel of actualPaths) {
    if (!manifestPaths.has(rel)) return false;
  }
  return true;
}
