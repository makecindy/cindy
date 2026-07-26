#!/usr/bin/env node
/**
 * generate-third-party-notices.mjs
 *
 * 生成全工程及桌面端分发产物的第三方开源声明文件 THIRD-PARTY-NOTICES.txt。
 *
 * 范围:根目录及所有 pnpm workspace 包的生产依赖闭包(dependencies +
 * optionalDependencies,递归;workspace 内部包只穿透不收录),外加随安装包
 * 分发的非 npm 资产(ripgrep / Codex CLI / Electron / Android Platform-Tools /
 * vendored 代码)的手工条目。
 *
 * 输出(均应提交进仓库,但依赖范围不同):
 *   - <repo>/docs/legal/notices/ (全工程、各分发产物及 SBOM)
 *   - <repo>/apps/desktop/resources/THIRD-PARTY-NOTICES.txt
 *     (仅桌面端生产依赖,随 forge extraResource 打进安装包)
 *
 * 用法:node scripts/generate-third-party-notices.mjs
 * (依赖必须已 pnpm install;脚本纯离线,只读 node_modules。)
 */

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import parseSpdxExpression from "spdx-expression-parse";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const DESKTOP_DIR = path.join(REPO_ROOT, "apps", "desktop");
const MOBILE_DIR = path.join(REPO_ROOT, "apps", "mobile");
const NOTICES_DIR = path.join(REPO_ROOT, "docs", "legal", "notices");
const SBOM_DIR = path.join(NOTICES_DIR, "sbom");
const CARGO_MANIFEST = path.join(
  DESKTOP_DIR,
  "cindy-updater",
  "src-tauri",
  "Cargo.toml",
);

/** 与 pnpm-workspace.yaml 的客户端 workspace 范围保持一致。 */
function discoverWorkspaceDirs() {
  const dirs = [];
  for (const parentName of ["apps", "packages", "cindy-protocol/packages"]) {
    const parentDir = path.join(REPO_ROOT, parentName);
    for (const entry of fs.readdirSync(parentDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(parentDir, entry.name);
      if (fs.existsSync(path.join(dir, "package.json"))) dirs.push(dir);
    }
  }
  return dirs.sort();
}

/** 已知 license 字段缺失 / 非常规的包,人工核实后在此固定声明 */
const PACKAGE_POLICIES = {
  // https://github.com/fabiospampinato/khroma (仓库内 LICENSE 为 MIT,npm 包漏带字段)
  khroma: { license: "MIT", url: "https://github.com/fabiospampinato/khroma" },
  // 明确选择双许可证中的宽松分支,避免声明口径含糊。
  jszip: { license: "MIT" },
  "node-forge": { license: "BSD-3-Clause" },
  "pause-stream": { license: "MIT" },
  "@anthropic-ai/claude-agent-sdk": {
    category: "proprietary",
    license: "LicenseRef-Anthropic-Commercial-Terms",
  },
};

/** 商业发行明确禁止进入生产依赖闭包的包。 */
const FORBIDDEN_PACKAGE_POLICIES = {
  "@codesandbox/nodebox": {
    license: "LicenseRef-Sustainable-Use-1.0",
    reason: "仅允许内部业务使用或非商业用途,不允许 Cindy 商业版本对外分发。",
  },
};

/** license 文件名候选(按优先级) */
const LICENSE_FILE_PATTERNS = /^(licen[cs]e|copying|unlicense)(\.|-|$)/i;
const NOTICE_FILE_PATTERNS = /^notice(\.|$)/i;

function normalizeNoticeText(text) {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

// ---------------------------------------------------------------------------
// 依赖闭包遍历
// ---------------------------------------------------------------------------

/** 从 fromDir 向上逐层找 node_modules/<name>,返回真实路径(解 symlink) */
function resolvePkgDir(name, fromDir) {
  let dir = fromDir;
  for (;;) {
    const candidate = path.join(dir, "node_modules", ...name.split("/"));
    if (fs.existsSync(path.join(candidate, "package.json"))) {
      return fs.realpathSync(candidate);
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

/**
 * 建立仓库内 package name -> 源码目录映射。
 *
 * 除 pnpm workspace 包外,apps/mobile/modules 下还有通过 file: 引用的本地包。
 * pnpm 在部分平台会把 file: 包复制到 node_modules 而非创建指向源码的 symlink,
 * 因此不能只靠真实路径是否位于 node_modules 来判断它是不是内部包。
 */
function discoverProjectPackageDirs() {
  const result = new Map();
  const queue = [
    REPO_ROOT,
    path.join(REPO_ROOT, "apps"),
    path.join(REPO_ROOT, "packages"),
  ];
  const visited = new Set();

  while (queue.length) {
    const dir = queue.shift();
    if (visited.has(dir) || !fs.existsSync(dir)) continue;
    visited.add(dir);

    const packageJsonPath = path.join(dir, "package.json");
    if (fs.existsSync(packageJsonPath)) {
      const pkg = readJson(packageJsonPath);
      if (pkg.name && !result.has(pkg.name)) result.set(pkg.name, dir);
    }

    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (
        !entry.isDirectory() ||
        entry.name === "node_modules" ||
        entry.name.startsWith(".")
      ) {
        continue;
      }
      queue.push(path.join(dir, entry.name));
    }
  }
  return result;
}

const PROJECT_PACKAGE_DIRS = discoverProjectPackageDirs();

/** 包目录里找 license / notice 文本 */
function findLicenseFiles(pkgDir) {
  let entries = [];
  try {
    entries = fs.readdirSync(pkgDir);
  } catch {
    return { licenseText: null, noticeText: null };
  }
  const licenseFiles = entries
    .filter((e) => LICENSE_FILE_PATTERNS.test(e))
    .sort();
  const noticeFiles = entries
    .filter((e) => NOTICE_FILE_PATTERNS.test(e))
    .sort();
  const read = (files) =>
    files.length
      ? files
          .map((f) => {
            try {
              const full = path.join(pkgDir, f);
              if (!fs.statSync(full).isFile()) return null;
              return normalizeNoticeText(fs.readFileSync(full, "utf8"));
            } catch {
              return null;
            }
          })
          .filter(Boolean)
          .join("\n\n")
      : null;
  return {
    licenseText: read(licenseFiles) || null,
    noticeText: read(noticeFiles) || null,
  };
}

function licenseFieldToString(license, pkgJson) {
  if (typeof license === "string") return license;
  if (Array.isArray(license)) {
    return license
      .map((l) => (typeof l === "string" ? l : l?.type))
      .filter(Boolean)
      .join(" OR ");
  }
  if (license && typeof license === "object" && license.type)
    return license.type;
  // 老式 licenses 数组
  if (Array.isArray(pkgJson.licenses)) {
    return pkgJson.licenses.map((l) => l.type || l).join(" OR ");
  }
  return null;
}

function normalizeLicenseExpression(license) {
  if (!license) return "UNKNOWN";
  const normalized = license
    .replace(/\bApache2\b/g, "Apache-2.0")
    .replace(/\bMIT\s*\/\s*Apache-2\.0\b/g, "MIT OR Apache-2.0")
    .replace(/\bApache-2\.0\s*\/\s*MIT\b/g, "Apache-2.0 OR MIT")
    .replace(/\bUnlicense\s*\/\s*MIT\b/g, "Unlicense OR MIT")
    .replace(/\bBSD-3-Clause\s*\/\s*MIT\b/g, "BSD-3-Clause OR MIT")
    .trim();
  return normalized === "BSD" ? "LicenseRef-BSD-Variant" : normalized;
}

function repoUrl(pkgJson) {
  const r = pkgJson.repository;
  let url = typeof r === "string" ? r : r?.url || pkgJson.homepage || null;
  if (!url) return null;
  url = url
    .replace(/^git\+/, "")
    .replace(/\.git$/, "")
    .replace(/^git:\/\//, "https://")
    .replace(/^ssh:\/\/git@/, "https://")
    .replace(/^git@([^:]+):/, "https://$1/")
    .replace(/^github:/, "https://github.com/");
  if (/^[\w-]+\/[\w.-]+$/.test(url)) url = `https://github.com/${url}`;
  return url;
}

function matchesPackageConstraint(values, actual) {
  if (!Array.isArray(values) || values.length === 0 || !actual) return true;
  const denied = values
    .filter((value) => value.startsWith("!"))
    .map((value) => value.slice(1));
  if (denied.includes(actual)) return false;
  const allowed = values.filter((value) => !value.startsWith("!"));
  return allowed.length === 0 || allowed.includes(actual);
}

function matchesTarget(pkgJson, target) {
  if (!target) return true;
  return (
    matchesPackageConstraint(pkgJson.os, target.os) &&
    matchesPackageConstraint(pkgJson.cpu, target.cpu) &&
    matchesPackageConstraint(pkgJson.libc, target.libc)
  );
}

/** BFS 遍历给定入口的生产依赖闭包。workspace 内部包穿透但不收录。 */
function collectClosure(entryDirs, target = null) {
  const collected = new Map(); // key: name@version
  const visitedDirs = new Set();
  const missing = new Set();
  const excluded = new Map();
  const queue = [...entryDirs];

  while (queue.length) {
    const pkgDir = queue.shift();
    if (visitedDirs.has(pkgDir)) continue;
    visitedDirs.add(pkgDir);

    const pkgJson = readJson(path.join(pkgDir, "package.json"));
    const deps = new Map();
    for (const depName of Object.keys(pkgJson.dependencies || {})) {
      deps.set(depName, { optional: false });
    }
    for (const depName of Object.keys(pkgJson.optionalDependencies || {})) {
      deps.set(depName, { optional: true });
    }

    for (const [depName, depMeta] of deps) {
      const depDir = resolvePkgDir(depName, pkgDir);
      if (!depDir) {
        const label = `${depName} (from ${pkgJson.name})`;
        if (depMeta.optional) missing.add(label);
        else
          throw new Error(
            `required production dependency is not installed: ${label}`,
          );
        continue;
      }
      const depJson = readJson(path.join(depDir, "package.json"));
      if (!matchesTarget(depJson, target)) continue;
      const internalSourceDir = PROJECT_PACKAGE_DIRS.get(depJson.name);
      const isWorkspacePkg =
        Boolean(internalSourceDir) ||
        !depDir.split(path.sep).includes("node_modules");

      if (isWorkspacePkg) {
        // 内部包:穿透其依赖,不收录自身
        const sourceDir = internalSourceDir || depDir;
        if (!visitedDirs.has(sourceDir)) queue.push(sourceDir);
        continue;
      }

      const key = `${depJson.name}@${depJson.version}`;
      if (collected.has(key)) continue;

      const forbiddenPolicy = FORBIDDEN_PACKAGE_POLICIES[depJson.name];
      if (forbiddenPolicy) {
        throw new Error(
          `forbidden production dependency: ${key} (${forbiddenPolicy.license}) — ${forbiddenPolicy.reason}`,
        );
      }

      const policy = PACKAGE_POLICIES[depJson.name];
      if (policy?.category) {
        excluded.set(key, {
          ecosystem: "npm",
          name: depJson.name,
          version: depJson.version,
          license: policy.license,
          category: policy.category,
          url: repoUrl(depJson) || null,
          note: policy.note || null,
          licenseText: findLicenseFiles(depDir).licenseText,
        });
        collected.set(key, null); // 占位防重复入队遍历
        if (!visitedDirs.has(depDir)) queue.push(depDir);
        continue;
      }

      const override = policy;
      const { licenseText, noticeText } = findLicenseFiles(depDir);
      collected.set(key, {
        ecosystem: "npm",
        name: depJson.name,
        version: depJson.version,
        license: normalizeLicenseExpression(
          override?.license || licenseFieldToString(depJson.license, depJson),
        ),
        url: repoUrl(depJson) || override?.url || null,
        licenseText,
        noticeText,
      });
      if (!visitedDirs.has(depDir)) queue.push(depDir);
    }
  }

  const packages = [...collected.values()].filter(Boolean);
  packages.sort(
    (a, b) =>
      a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
  );
  return {
    packages,
    missing: [...missing].sort(),
    excluded: [...excluded.values()].sort(
      (a, b) =>
        a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
    ),
  };
}

function mergeClosures(...closures) {
  const packages = new Map();
  const excluded = new Map();
  const missing = new Set();
  for (const closure of closures) {
    for (const component of closure.packages) {
      packages.set(
        `${component.ecosystem}:${component.name}@${component.version}`,
        component,
      );
    }
    for (const component of closure.excluded || []) {
      excluded.set(
        `${component.ecosystem}:${component.name}@${component.version}`,
        component,
      );
    }
    for (const item of closure.missing || []) missing.add(item);
  }
  const sort = (a, b) =>
    a.ecosystem.localeCompare(b.ecosystem) ||
    a.name.localeCompare(b.name) ||
    a.version.localeCompare(b.version);
  return {
    packages: [...packages.values()].sort(sort),
    excluded: [...excluded.values()].sort(sort),
    missing: [...missing].sort(),
  };
}

/**
 * 由根 package.json 的 `pnpm.supportedArchitectures` 叉乘出的目标平台集合。
 *
 * 覆盖「本仓声明支持的全部架构」而非单一发行产物的闭包必须逐个 target 收集再合并，
 * 不能省掉 target 让 matchesTarget() 一律放行：collectClosure() 判断一个平台可选依赖
 * 是否存在只看 `node_modules` 里有没有对应目录，而实际装出来的集合可能超出
 * supportedArchitectures 的声明（例如 libc 只声明 glibc 时仍装进 musl 变体），产物
 * 内容就会随生成机器漂移。这里不假设包管理器只安装声明过的架构。
 */
function readSupportedTargets() {
  const declared = readJson(path.join(REPO_ROOT, "package.json")).pnpm
    ?.supportedArchitectures;
  for (const axis of ["os", "cpu", "libc"]) {
    const values = declared?.[axis];
    if (!Array.isArray(values) || values.length === 0) {
      throw new Error(
        `pnpm.supportedArchitectures.${axis} must list explicit values in the root package.json`,
      );
    }
    // pnpm 支持 "current" 表示生成机器自身的架构，那会把机器差异重新带回产物。
    if (values.includes("current")) {
      throw new Error(
        `pnpm.supportedArchitectures.${axis} must not use "current": license notices would depend on the generating machine`,
      );
    }
  }
  const targets = [];
  for (const os of declared.os) {
    for (const cpu of declared.cpu) {
      for (const libc of declared.libc) targets.push({ os, cpu, libc });
    }
  }
  return targets;
}

const SUPPORTED_TARGETS = readSupportedTargets();

/** 在全部支持架构上收集闭包并合并，结果与生成机器的安装集合无关。 */
function collectClosureForSupportedTargets(entryDirs) {
  return mergeClosures(
    ...SUPPORTED_TARGETS.map((target) => collectClosure(entryDirs, target)),
  );
}

function cargoExecutable() {
  const candidate = process.env.USERPROFILE
    ? path.join(process.env.USERPROFILE, ".cargo", "bin", "cargo.exe")
    : null;
  return candidate && fs.existsSync(candidate) ? candidate : "cargo";
}

/** 收集 Windows updater 的运行时依赖闭包,跳过根包的 build/dev dependency。 */
function collectCargoClosure() {
  const raw = execFileSync(
    cargoExecutable(),
    [
      "metadata",
      "--locked",
      "--format-version",
      "1",
      "--filter-platform",
      "x86_64-pc-windows-msvc",
      "--manifest-path",
      CARGO_MANIFEST,
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  ).replace(/^\uFEFF/, "");
  const metadata = JSON.parse(raw);
  const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
  const packageById = new Map(metadata.packages.map((pkg) => [pkg.id, pkg]));
  const rootId = metadata.resolve.root;
  const includedIds = new Set();
  const queue = [rootId];
  while (queue.length) {
    const id = queue.shift();
    if (includedIds.has(id)) continue;
    includedIds.add(id);
    const node = nodes.get(id);
    for (const dep of node?.deps || []) {
      const kinds = dep.dep_kinds || [];
      if (kinds.some((kind) => kind.kind === null)) queue.push(dep.pkg);
    }
  }

  const packages = [];
  for (const id of includedIds) {
    if (id === rootId) continue;
    const pkg = packageById.get(id);
    if (!pkg) continue;
    const pkgDir = path.dirname(pkg.manifest_path);
    const texts = findLicenseFiles(pkgDir);
    let licenseText = texts.licenseText;
    if (!licenseText && pkg.license_file) {
      const licensePath = path.resolve(pkgDir, pkg.license_file);
      if (fs.existsSync(licensePath)) {
        licenseText = normalizeNoticeText(fs.readFileSync(licensePath, "utf8"));
      }
    }
    packages.push({
      ecosystem: "cargo",
      name: pkg.name,
      version: pkg.version,
      license: normalizeLicenseExpression(pkg.license),
      url:
        pkg.repository ||
        pkg.homepage ||
        `https://crates.io/crates/${pkg.name}`,
      licenseText,
      noticeText: texts.noticeText,
    });
  }
  packages.sort(
    (a, b) =>
      a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
  );
  return { packages, excluded: [], missing: [] };
}

// ---------------------------------------------------------------------------
// 非 npm 渠道的手工条目
// ---------------------------------------------------------------------------

const MIT_TEXT = (copyright) => `${copyright}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.`;

function readToolVersion(tool) {
  try {
    return readJson(path.join(REPO_ROOT, "tools", tool, "latest.json")).version;
  } catch {
    return "bundled";
  }
}

function readAndroidPlatformToolsVersion() {
  try {
    const properties = fs.readFileSync(
      path.join(
        REPO_ROOT,
        "apps",
        "android-platform-tools-bin",
        "win32-x64",
        "source.properties",
      ),
      "utf8",
    );
    return /^Pkg\.Revision=(.+)$/m.exec(properties)?.[1]?.trim() || "bundled";
  } catch {
    return "bundled";
  }
}

function bundledComponent(component) {
  return { ecosystem: "bundled", ...component };
}

function readBundledLicense(relativePath) {
  return normalizeNoticeText(
    fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8"),
  );
}

/**
 * 桌面三平台共有的随包分发组件声明。
 *
 * @param sharpPackageNames sharp 预编译包名,可传单个或数组。该包的 README 与
 *   versions.json 是 per-arch 的(见下方 sharp 段),所以一个平台声明覆盖多个架构时
 *   应把每个架构的包都传进来。desktop-linux 已按此传 x64 + arm64;desktop-macos
 *   的 productName 同样是 x64/arm64 但目前只传 arm64,属既存缺口,记在 issue #452。
 */
function buildDesktopCommonEntries(apacheText, sharpPackageNames) {
  const entries = [];

  // ripgrep — 随包分发的搜索二进制
  entries.push(
    bundledComponent({
      name: "ripgrep (bundled binary)",
      version: readToolVersion("ripgrep"),
      license: "MIT OR Unlicense",
      url: "https://github.com/BurntSushi/ripgrep",
      licenseText: MIT_TEXT(
        "The MIT License (MIT)\n\nCopyright (c) 2015 Andrew Gallant",
      ),
    }),
  );

  // OpenAI Codex CLI — 随包分发的 agent 二进制
  entries.push(
    bundledComponent({
      name: "OpenAI Codex CLI (bundled binary)",
      version: readToolVersion("codex"),
      license: "Apache-2.0",
      url: "https://github.com/openai/codex",
      licenseText:
        (apacheText ||
          "Apache License 2.0 — full text: https://www.apache.org/licenses/LICENSE-2.0") +
        "\n\nCopyright (c) OpenAI",
    }),
  );

  // Electron(devDependency 但二进制随包分发)
  let electronVersion = "bundled";
  let electronLicense = null;
  const electronDir = resolvePkgDir("electron", DESKTOP_DIR);
  if (electronDir) {
    electronVersion = readJson(path.join(electronDir, "package.json")).version;
    electronLicense = findLicenseFiles(electronDir).licenseText;
  }
  entries.push(
    bundledComponent({
      name: "Electron (bundled runtime)",
      version: electronVersion,
      license: "MIT",
      url: "https://github.com/electron/electron",
      licenseText:
        (electronLicense ||
          MIT_TEXT(
            "Copyright (c) Electron contributors\nCopyright (c) 2013-2020 GitHub Inc.",
          )) +
        "\n\nElectron 自身捆绑了 Chromium、Node.js、V8 等组件,其完整许可证集合\n" +
        "(LICENSES.chromium.html)由 Electron 打包流程自动包含在应用安装目录中。",
    }),
  );

  // TapDB SDK — vendored 进仓库的统计 SDK
  try {
    const tapdbLicense = normalizeNoticeText(
      fs.readFileSync(
        path.join(DESKTOP_DIR, "src", "renderer", "vendor", "tapdb", "LICENSE"),
        "utf8",
      ),
    );
    entries.push(
      bundledComponent({
        name: "TapDB SDK (vendored)",
        version: "vendored",
        license: "Apache-2.0",
        url: "https://www.taptap.cn/developer",
        licenseText: tapdbLicense,
      }),
    );
  } catch {
    /* vendored 目录被移除时自动跳过 */
  }

  // drawio viewer — vendored 进仓库的 .drawio 文件预览脚本(renderer 资源随包分发)
  try {
    const drawioDir = path.join(DESKTOP_DIR, "src", "renderer", "vendor", "drawio");
    const drawioLicense = normalizeNoticeText(
      fs.readFileSync(path.join(drawioDir, "LICENSE"), "utf8"),
    );
    const drawioVersion =
      /VERSION:"([\d.]+)"/.exec(
        fs.readFileSync(path.join(drawioDir, "viewer-static.min.js"), "utf8"),
      )?.[1] || "vendored";
    entries.push(
      bundledComponent({
        name: "drawio viewer (vendored)",
        version: drawioVersion,
        license: "Apache-2.0",
        url: "https://github.com/jgraph/drawio",
        licenseText:
          drawioLicense +
          "\n\nOnly the viewer JavaScript (viewer-static.min.js) is redistributed. " +
          "Upstream icon sets / stencils / templates carry an additional no-Atlassian-use " +
          "restriction; none of those assets are redistributed by this product.",
      }),
    );
  } catch {
    /* vendored 目录被移除时自动跳过 */
  }

  // sqlite-vec — 四个平台均以原生动态库随桌面安装包分发。
  entries.push(
    bundledComponent({
      name: "sqlite-vec (bundled native extension)",
      version: fs
        .readFileSync(
          path.join(DESKTOP_DIR, "native", "sqlite-vec", "VERSION"),
          "utf8",
        )
        .trim(),
      license: "MIT",
      url: "https://github.com/asg017/sqlite-vec/tree/v0.1.9",
      licenseText: readBundledLicense("apps/desktop/native/sqlite-vec/LICENSE"),
    }),
  );

  // sharp 预编译包内含多种第三方动态库;保留包自带清单和精确版本表。
  // 逐架构出条目:README 与 versions.json 都是 per-arch 的,一个平台声明覆盖两个
  // 架构时只读其中一份,另一个架构的分发物就会带着错误的架构描述发出去
  // (arm64 用户拿到的声明写着 "Linux (glibc) x64")。
  for (const sharpPackageName of [sharpPackageNames].flat()) {
    const sharpDir = resolvePkgDir(sharpPackageName, DESKTOP_DIR);
    if (!sharpDir)
      throw new Error(
        `sharp platform package is not installed: ${sharpPackageName}`,
      );
    const sharpJson = readJson(path.join(sharpDir, "package.json"));
    const versions = readJson(path.join(sharpDir, "versions.json"));
    const licensingReadme = normalizeNoticeText(
      fs.readFileSync(path.join(sharpDir, "README.md"), "utf8"),
    );
    entries.push(
      bundledComponent({
        name: `${sharpPackageName} embedded native libraries`,
        version: sharpJson.version,
        license: "LicenseRef-Sharp-Third-Party-Licenses",
        url: `https://github.com/lovell/sharp-libvips/tree/v${sharpPackageName.includes("libvips") ? sharpJson.version : "1.2.4"}`,
        licenseText:
          `${licensingReadme}\n\nExact bundled library versions:\n${JSON.stringify(versions, null, 2)}\n\n` +
          "Corresponding build recipes and pinned upstream source locations are available at the exact sharp-libvips tag above. " +
          `The bundled libvips version is ${versions.vips}.`,
      }),
    );
  }

  // SQLite — better-sqlite3 静态编译进 native addon
  entries.push(
    bundledComponent({
      name: "SQLite (compiled into better-sqlite3)",
      version: "see better-sqlite3 package version above",
      license: "LicenseRef-Public-Domain",
      url: "https://sqlite.org",
      licenseText:
        "SQLite is in the public domain. See https://sqlite.org/copyright.html",
    }),
  );

  // vendored 上游源码不作为独立 npm 包出现,需显式声明。
  // (lark-openapi-mcp vendored 源已于 2026-07-22 随飞书 OpenAPI 工具链整体迁出
  // 本仓,改由独立插件包分发,不再随桌面包分发,故其声明从此处移除。)
  entries.push(
    bundledComponent({
      name: "openclaw fs-safe sources (vendored)",
      version: "vendored",
      license: "MIT",
      url: "https://github.com/openclaw/openclaw",
      licenseText: readBundledLicense(
        "packages/browser-control-runtime/src/_generated/vendor/fs-safe/LICENSE",
      ),
    }),
  );

  // ProviderLogoMark 中随桌面包分发的 xAI / 智谱 SVG 路径。
  entries.push(
    bundledComponent({
      name: "Lobe Icons SVG paths (vendored)",
      version: "5.14.0",
      license: "MIT",
      url: "https://github.com/lobehub/lobe-icons/tree/v5.14.0",
      licenseText: MIT_TEXT("MIT License\n\nCopyright (c) 2023 LobeHub"),
    }),
  );

  return entries;
}

function buildMacEntries() {
  return [
    // agent-island Swift helper 中的 NotchShape 轮廓与 SpriteMascotConfig 皮肤
    // 参数改编自 Code Island(见 macos-agent-island-helper.swift 内注释)。
    bundledComponent({
      name: "Code Island NotchPanelShape & mascot parameters (adapted)",
      version: "adapted",
      license: "MIT",
      url: "https://github.com/wxtsky/CodeIsland",
      licenseText: MIT_TEXT("MIT License\n\nCopyright (c) 2026 wxtsky"),
    }),
  ];
}

function buildWindowsEntries() {
  return [
    bundledComponent({
      name: "Android SDK Platform-Tools (bundled binaries)",
      version: readAndroidPlatformToolsVersion(),
      license: "LicenseRef-Android-Platform-Tools-Notice",
      url: "https://developer.android.com/tools/releases/platform-tools",
      licenseText: readBundledLicense(
        "apps/android-platform-tools-bin/win32-x64/NOTICE.txt",
      ),
    }),
  ];
}

function buildMobileEntries(apacheText, platform) {
  const entries = [
    bundledComponent({
      name: "JetBrains Mono fonts",
      version: "bundled",
      license: "OFL-1.1",
      url: "https://github.com/JetBrains/JetBrainsMono",
      licenseText: readBundledLicense(
        "apps/mobile/assets/fonts/JetBrainsMono-OFL.txt",
      ),
    }),
  ];
  if (platform === "ios") {
    entries.push(
      bundledComponent({
        name: "TapTapSDK/Core",
        version: "4.10.5",
        license: "MIT",
        url: "https://github.com/taptap/tapsdk-frameworks/tree/4.10.5",
        licenseText: MIT_TEXT("Copyright (c) TapTap"),
      }),
    );
  } else {
    entries.push(
      bundledComponent({
        name: "com.taptap.sdk:tap-core and declared TapTap modules",
        version: "4.10.5",
        license: "Apache-2.0",
        url: "https://github.com/taptap/TapSDK-Android",
        licenseText: apacheText,
      }),
    );
  }
  return entries;
}

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------

function buildOutput({
  packages,
  manualEntries,
  productName,
  description,
  coverageNotes = [],
}) {
  const lines = [];
  const push = (s = "") => lines.push(s);

  push("=".repeat(78));
  push("THIRD-PARTY SOFTWARE NOTICES AND INFORMATION");
  push(productName);
  push("=".repeat(78));
  push();
  for (const line of description) push(line);
  push();
  push("本文件由 scripts/generate-third-party-notices.mjs 自动生成,请勿手改;");
  push("依赖变更后运行 `pnpm licenses:generate` 重新生成。");
  push();
  push("我们感谢所有开源作者与维护者。");
  push("We are grateful to all open source authors and maintainers.");
  push();
  if (coverageNotes.length) {
    push("-".repeat(78));
    push("SCOPE NOTES:");
    for (const note of coverageNotes) push(`  - ${note}`);
    push();
  }
  push(
    "受限或专有第三方组件不列入开源包数量,另见配套的 THIRD-PARTY-RESTRICTED.txt。",
  );
  push(
    "Restricted or proprietary components are disclosed in the companion file.",
  );
  push();

  // —— Section 1: 非 npm 组件 ——
  push("=".repeat(78));
  push("SECTION 1: Bundled components (non-npm)");
  push("=".repeat(78));
  for (const e of manualEntries) {
    push();
    push("-".repeat(78));
    push(`${e.name} ${e.version}`);
    push(`License: ${e.license}`);
    if (e.url) push(`Source: ${e.url}`);
    push("-".repeat(78));
    push(e.licenseText);
  }
  push();

  let section = 2;
  for (const ecosystem of ["npm", "cargo"]) {
    const selected = packages.filter(
      (component) => component.ecosystem === ecosystem,
    );
    if (!selected.length) continue;
    push("=".repeat(78));
    push(
      `SECTION ${section}: ${ecosystem} packages (${selected.length} packages)`,
    );
    push("=".repeat(78));
    push();
    for (const p of selected) {
      push(
        `- ${p.name}@${p.version} — ${p.license}${p.url ? ` — ${p.url}` : ""}`,
      );
    }
    push();
    section += 1;
  }

  // —— 许可证文本(按相同文本归组去重) ——
  push("=".repeat(78));
  push(`SECTION ${section}: Package license texts`);
  push("=".repeat(78));
  push();
  push("下面每段许可证文本前列出适用的包。无独立 LICENSE 文件的包以其");
  push("包元数据声明的 SPDX 标识为准(见前述 package sections)。");
  push();

  const textGroups = new Map(); // text -> [pkg labels]
  const noTextPkgs = [];
  for (const p of packages) {
    if (p.licenseText) {
      const arr = textGroups.get(p.licenseText) || [];
      arr.push(`${p.ecosystem}:${p.name}@${p.version}`);
      textGroups.set(p.licenseText, arr);
    } else {
      noTextPkgs.push(`${p.ecosystem}:${p.name}@${p.version} (${p.license})`);
    }
    if (p.noticeText) {
      const key = `NOTICE for ${p.ecosystem}:${p.name}@${p.version}:\n\n${p.noticeText}`;
      if (!textGroups.has(key))
        textGroups.set(key, [`${p.ecosystem}:${p.name}@${p.version} (NOTICE)`]);
    }
  }

  let idx = 0;
  for (const [text, pkgs] of textGroups) {
    idx += 1;
    push("-".repeat(78));
    push(`[${idx}] Applies to: ${pkgs.join(", ")}`);
    push("-".repeat(78));
    push(text);
    push();
  }

  if (noTextPkgs.length) {
    push("-".repeat(78));
    push(
      "Packages without a standalone license file (license per package.json):",
    );
    push("-".repeat(78));
    for (const p of noTextPkgs) push(`- ${p}`);
    push();
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

function componentKey(component) {
  return `${component.ecosystem}:${component.name}@${component.version}`;
}

function mergeComponents(...groups) {
  const result = new Map();
  for (const group of groups) {
    for (const component of group)
      result.set(componentKey(component), component);
  }
  return [...result.values()].sort(
    (a, b) =>
      a.ecosystem.localeCompare(b.ecosystem) ||
      a.name.localeCompare(b.name) ||
      a.version.localeCompare(b.version),
  );
}

function buildRestrictedOutput(
  components,
  productName = "Cindy project distributions",
) {
  const lines = [
    "=".repeat(78),
    "RESTRICTED AND PROPRIETARY THIRD-PARTY COMPONENTS",
    productName,
    "=".repeat(78),
    "",
    "本文件单列不是开放源代码许可的第三方组件;它们不计入开源包数量。",
    "This file separately discloses components not distributed under open-source licenses.",
    "",
  ];
  if (components.length === 0) {
    lines.push(
      "No restricted or proprietary components are declared for this artifact.",
      "",
    );
  }
  for (const component of components) {
    lines.push("-".repeat(78));
    lines.push(`${component.name}@${component.version}`);
    lines.push(`Category: ${component.category}`);
    lines.push(`License: ${component.license}`);
    if (component.url) lines.push(`Source: ${component.url}`);
    if (component.note) lines.push(`Compliance note: ${component.note}`);
    if (component.licenseText) {
      lines.push("-".repeat(78));
      lines.push(component.licenseText);
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function purlFor(component) {
  if (component.ecosystem === "cargo") {
    return `pkg:cargo/${encodeURIComponent(component.name)}@${encodeURIComponent(component.version)}`;
  }
  if (component.ecosystem === "npm") {
    const name = component.name.startsWith("@")
      ? component.name.replaceAll("@", "%40")
      : encodeURIComponent(component.name);
    return `pkg:npm/${name}@${encodeURIComponent(component.version)}`;
  }
  return null;
}

function stableCreationTime() {
  try {
    const value = execFileSync(
      "git",
      [
        "log",
        "-1",
        "--format=%cI",
        "--",
        "pnpm-lock.yaml",
        path.relative(REPO_ROOT, CARGO_MANIFEST),
      ],
      { cwd: REPO_ROOT, encoding: "utf8" },
    ).trim();
    if (value) return new Date(value).toISOString().replace(".000Z", "Z");
  } catch {
    // 仅非 git 源码包会走固定 fallback,避免生成结果随机器时间漂移。
  }
  return "1970-01-01T00:00:00Z";
}

function buildSpdxDocument(artifact, components) {
  const sorted = mergeComponents(components);
  const digest = createHash("sha256")
    .update(sorted.map(componentKey).join("\n"))
    .digest("hex");
  const packages = sorted.map((component) => {
    const id = `SPDXRef-Package-${createHash("sha256").update(componentKey(component)).digest("hex").slice(0, 16)}`;
    const purl = purlFor(component);
    return {
      name: component.name,
      SPDXID: id,
      versionInfo: component.version,
      downloadLocation: /^https?:\/\//.test(component.url || "")
        ? component.url
        : "NOASSERTION",
      filesAnalyzed: false,
      licenseConcluded: component.license,
      licenseDeclared: component.license,
      copyrightText: "NOASSERTION",
      ...(purl
        ? {
            externalRefs: [
              {
                referenceCategory: "PACKAGE-MANAGER",
                referenceType: "purl",
                referenceLocator: purl,
              },
            ],
          }
        : {}),
    };
  });
  // licenseId -> (componentKey -> licenseText)。必须按组件分别留存,不能先到先得:
  // SPDX 的 hasExtractedLicensingInfos 对一个 licenseId 只存一份 extractedText,
  // 而同一个 LicenseRef 会被多个组件共用(desktop-linux 的 x64/arm64 两份 libvips
  // 预编译包就是如此)。只留其中一份,另一个组件就会引用到不属于它的说明和版本表。
  const licenseRefs = new Map();
  for (const component of sorted) {
    for (const match of component.license.matchAll(
      /LicenseRef-[A-Za-z0-9.-]+/g,
    )) {
      if (!licenseRefs.has(match[0])) licenseRefs.set(match[0], new Map());
      licenseRefs
        .get(match[0])
        .set(
          componentKey(component),
          component.licenseText || "No standalone license text available.",
        );
    }
  }
  return {
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name: `cindy-${artifact}`,
    documentNamespace: `https://cindy.app/spdx/${artifact}/${digest}`,
    creationInfo: {
      created: stableCreationTime(),
      creators: ["Tool: scripts/generate-third-party-notices.mjs"],
    },
    packages,
    relationships: packages.map((pkg) => ({
      spdxElementId: "SPDXRef-DOCUMENT",
      relationshipType: "DESCRIBES",
      relatedSpdxElement: pkg.SPDXID,
    })),
    ...(licenseRefs.size
      ? {
          hasExtractedLicensingInfos: [...licenseRefs].map(
            ([licenseId, textsByComponent]) => ({
              licenseId,
              // 独占该 licenseId 的组件保持原样输出(不给 win/macos 等单组件产物
              // 引入无谓的格式变化);多组件共用时按组件加标题分段,让每个 package
              // 条目都能在文本里找到属于自己的那段。
              extractedText:
                textsByComponent.size === 1
                  ? [...textsByComponent.values()][0]
                  : [...textsByComponent]
                      .map(([key, text]) => `### ${key}\n\n${text}`)
                      .join(`\n\n${"-".repeat(72)}\n\n`),
            }),
          ),
        }
      : {}),
  };
}

function auditArtifact(label, closure, manualEntries) {
  const components = [...closure.packages, ...manualEntries];
  const invalid = components.filter((component) =>
    /^(UNKNOWN|UNLICENSED|SEE LICENSE|NOASSERTION)$/i.test(component.license),
  );
  const strongCopyleft = components.filter(
    (component) =>
      /(?:^|[^L])GPL|AGPL|SSPL/i.test(component.license) &&
      !/LicenseRef-/.test(component.license),
  );
  const malformed = components.filter((component) => {
    try {
      parseSpdxExpression(component.license);
      return false;
    } catch {
      return true;
    }
  });
  if (invalid.length || strongCopyleft.length || malformed.length) {
    const lines = [`license audit failed for ${label}`];
    for (const component of invalid)
      lines.push(
        `  invalid: ${componentKey(component)} (${component.license})`,
      );
    for (const component of strongCopyleft)
      lines.push(
        `  strong copyleft: ${componentKey(component)} (${component.license})`,
      );
    for (const component of malformed)
      lines.push(
        `  malformed SPDX: ${componentKey(component)} (${component.license})`,
      );
    throw new Error(lines.join("\n"));
  }
  console.log(
    `${label}: ${closure.packages.length} package dependencies + ${manualEntries.length} bundled components`,
  );
}

function assertNativeDeclarations() {
  const iosWechat = fs.readFileSync(
    path.join(
      MOBILE_DIR,
      "modules",
      "xdt-wechat-login",
      "ios",
      "XdtWechatLogin.podspec",
    ),
    "utf8",
  );
  const androidWechat = fs.readFileSync(
    path.join(
      MOBILE_DIR,
      "modules",
      "xdt-wechat-login",
      "android",
      "build.gradle",
    ),
    "utf8",
  );
  const iosTap = fs.readFileSync(
    path.join(MOBILE_DIR, "modules", "xdt-tapdb", "ios", "XdtTapdb.podspec"),
    "utf8",
  );
  const androidTap = fs.readFileSync(
    path.join(MOBILE_DIR, "modules", "xdt-tapdb", "android", "build.gradle"),
    "utf8",
  );
  if (!/WechatOpenSDK', '2\.0\.5'/.test(iosWechat))
    throw new Error("WechatOpenSDK iOS version changed; update notice policy");
  if (!/com\.tencent\.mm\.opensdk:wechat-sdk-android:6\.8\.38/.test(androidWechat))
    throw new Error("WeChat OpenSDK Android version changed; update notice policy");
  if (!/TapTapSDK\/Core', '4\.10\.5'/.test(iosTap))
    throw new Error("TapTapSDK iOS version changed; update notice policy");
  if (!/com\.taptap\.sdk:tap-core:4\.10\.5/.test(androidTap))
    throw new Error("TapTapSDK Android version changed; update notice policy");
}

/**
 * Project-owned Expo modules are part of the Apache-2.0 source tree. Keep
 * their CocoaPods metadata aligned with the repository license so native
 * tooling cannot silently publish them as UNLICENSED/private pods.
 */
function assertProjectPodspecLicenses() {
  const podspecs = [
    "xdt-wechat-login/ios/XdtWechatLogin.podspec",
    "xdt-tapdb/ios/XdtTapdb.podspec",
    "xdt-mobile-realtime-audio/ios/XdtMobileRealtimeAudio.podspec",
    "xdt-ios-app-distribution/ios/XdtIosAppDistribution.podspec",
  ];
  for (const relativePath of podspecs) {
    const file = path.join(MOBILE_DIR, "modules", relativePath);
    const text = fs.readFileSync(file, "utf8");
    if (!/s\.license\s*=\s*\{[^}]*:type\s*=>\s*['\"]Apache-2\.0['\"]/s.test(text)) {
      throw new Error(`project podspec must declare Apache-2.0: ${relativePath}`);
    }
    if (/UNLICENSED/i.test(text)) {
      throw new Error(`project podspec must not declare UNLICENSED: ${relativePath}`);
    }
    if (!/https:\/\/github\.com\/makecindy\/cindy\.git/.test(text)) {
      throw new Error(`project podspec must point to the public source repository: ${relativePath}`);
    }
  }
}

function assertTrackedBinariesRegistered() {
  const binaryExtensions = new Set([
    ".exe",
    ".dll",
    ".dylib",
    ".so",
    ".aar",
    ".jar",
    ".wasm",
    ".ttf",
    ".otf",
    ".woff",
    ".woff2",
  ]);
  // cindy-updater.exe 不在列:它已不入仓(Windows 打包时现场 cargo build 生成,
  // 见 .gitignore)。若有人绕过 ignore 把它提交回来,这里会主动拦下要求登记。
  const registeredPrefixes = [
    "apps/android-platform-tools-bin/",
    "apps/desktop/native/sqlite-vec/",
    "apps/mobile/assets/fonts/JetBrainsMono-",
  ];
  const files = execFileSync("git", ["ls-files", "-z"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  })
    .split("\0")
    .filter(Boolean);
  const unregistered = files.filter(
    (file) =>
      binaryExtensions.has(path.extname(file).toLowerCase()) &&
      !registeredPrefixes.some((prefix) => file.startsWith(prefix)),
  );
  if (unregistered.length) {
    throw new Error(
      `tracked binary assets need license registration:\n${unregistered.join("\n")}`,
    );
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

assertNativeDeclarations();
assertProjectPodspecLicenses();
assertTrackedBinariesRegistered();
if (!fs.existsSync(path.join(path.dirname(CARGO_MANIFEST), "Cargo.lock"))) {
  throw new Error(
    "cindy-updater Cargo.lock is required for deterministic license generation",
  );
}

const projectNpm = collectClosureForSupportedTargets([
  REPO_ROOT,
  ...discoverWorkspaceDirs(),
]);
// 桌面三份产物的 target 是各自的实际发行矩阵（如 Windows 只发 x64），刻意不等于
// SUPPORTED_TARGETS——后者是仓库声明支持的全部架构，用于覆盖面更宽的聚合声明。
const desktopWinNpm = collectClosure([DESKTOP_DIR], {
  os: "win32",
  cpu: "x64",
});
const desktopMacNpm = mergeClosures(
  collectClosure([DESKTOP_DIR], { os: "darwin", cpu: "x64" }),
  collectClosure([DESKTOP_DIR], { os: "darwin", cpu: "arm64" }),
);
const desktopLinuxNpm = mergeClosures(
  collectClosure([DESKTOP_DIR], { os: "linux", cpu: "x64", libc: "glibc" }),
  collectClosure([DESKTOP_DIR], { os: "linux", cpu: "arm64", libc: "glibc" }),
);
// 移动端产物的 target 是「app 实际分发到的设备」，不是仓库支持的构建架构：
// 移动端 JS 依赖里的平台可选包（lightningcss / @parcel/watcher / @rollup 等预编译
// 二进制）属于开发机上的构建期工具链，不进 iOS bundle 或 APK/AAB。npm 生态里纯 JS
// 包不声明 os/cpu，matchesPackageConstraint() 对未声明的约束一律放行，所以按设备
// target 过滤只会摘掉这些原生变体，包自身（含其许可义务）仍然照常声明。
const mobileIosNpm = collectClosure([MOBILE_DIR], { os: "ios", cpu: "arm64" });
const mobileAndroidNpm = collectClosure([MOBILE_DIR], {
  os: "android",
  cpu: "arm64",
});
const cargoClosure = collectCargoClosure();

const apacheText =
  projectNpm.packages.find(
    (component) =>
      component.license === "Apache-2.0" &&
      component.licenseText?.includes("Version 2.0, January 2004"),
  )?.licenseText ||
  "Apache License 2.0: https://www.apache.org/licenses/LICENSE-2.0";

const artifactDefinitions = {
  "desktop-win": {
    closure: mergeClosures(desktopWinNpm, cargoClosure),
    manual: [
      ...buildDesktopCommonEntries(apacheText, "@img/sharp-win32-x64"),
      ...buildWindowsEntries(),
    ],
    productName: "Cindy desktop application — Windows x64",
    description: ["Windows x64 桌面安装包的第三方开源组件声明。"],
    notes: [
      "包含 Rust/Tauri updater 运行时 crate 闭包和随包 Android Platform-Tools。",
    ],
  },
  "desktop-macos": {
    closure: desktopMacNpm,
    manual: [
      ...buildDesktopCommonEntries(apacheText, [
        "@img/sharp-libvips-darwin-x64",
        "@img/sharp-libvips-darwin-arm64",
      ]),
      ...buildMacEntries(),
    ],
    productName: "Cindy desktop application — macOS x64/arm64",
    description: [
      "macOS Intel 与 Apple Silicon 桌面安装包的第三方开源组件声明。",
    ],
    notes: [
      "合并 x64 与 arm64 原生可选包;不包含运行时按需下载的 Android Platform-Tools。",
    ],
  },
  "desktop-linux": {
    closure: desktopLinuxNpm,
    manual: buildDesktopCommonEntries(apacheText, [
      "@img/sharp-libvips-linux-x64",
      "@img/sharp-libvips-linux-arm64",
    ]),
    productName: "Cindy desktop application — Linux x64/arm64 glibc",
    description: ["Linux x64 与 arm64 glibc 桌面安装包的第三方开源组件声明。"],
    notes: [
      "合并 x64 与 arm64 原生可选包;不包含运行时按需下载的 Android Platform-Tools。",
    ],
  },
  "mobile-ios": {
    closure: mobileIosNpm,
    manual: buildMobileEntries(apacheText, "ios"),
    productName: "Cindy mobile application — iOS",
    description: ["iOS JS 生产依赖及仓库显式声明的原生 SDK/字体组件。"],
    notes: [
      "Expo managed 工程的完整 Pod 闭包在构建时生成;本文件不声称替代具体构建产物的 Podfile.lock 审计。",
      "不含只在开发机构建期使用、不随 app 分发的平台可选原生包(其 JS 包自身仍已声明)。",
    ],
  },
  "mobile-android": {
    closure: mobileAndroidNpm,
    manual: buildMobileEntries(apacheText, "android"),
    productName: "Cindy mobile application — Android",
    description: ["Android JS 生产依赖及仓库显式声明的原生 SDK/字体组件。"],
    notes: [
      "Expo managed 工程的完整 Gradle 闭包在构建时生成;本文件不声称替代具体 APK/AAB 的依赖报告。",
      "不含只在开发机构建期使用、不随 app 分发的平台可选原生包(其 JS 包自身仍已声明)。",
    ],
  },
};

for (const [name, artifact] of Object.entries(artifactDefinitions)) {
  auditArtifact(name, artifact.closure, artifact.manual);
}

const projectClosure = mergeClosures(
  projectNpm,
  cargoClosure,
  ...Object.values(artifactDefinitions).map((artifact) => artifact.closure),
);
const projectManual = mergeComponents(
  ...Object.values(artifactDefinitions).map((artifact) => artifact.manual),
);
auditArtifact("project-aggregate", projectClosure, projectManual);

const restrictedManualEntries = [
  {
    ecosystem: "bundled",
    name: "Claude Code CLI",
    version: readToolVersion("claude"),
    license: "LicenseRef-Anthropic-Commercial-Terms",
    category: "proprietary",
    url: "https://www.anthropic.com/legal/commercial-terms",
    artifacts: ["desktop-win", "desktop-macos", "desktop-linux"],
  },
  {
    ecosystem: "bundled",
    name: "WeChat OpenSDK for iOS",
    version: "2.0.5",
    license: "NOASSERTION",
    category: "restricted-review-required",
    url: "https://developers.weixin.qq.com/doc/oplatform/Mobile_App/Access_Guide/iOS.html",
    note: "上游 CocoaPod 声明为 Copyright 且未提供标准开源许可证；按 docs/legal/wechat-open-sdk-compliance.md 完成条款、隐私披露和用户同意复核。官方合规指南：https://developers.weixin.qq.com/doc/oplatform/Mobile_App/agreement/sdk.html",
    artifacts: ["mobile-ios"],
  },
  {
    ecosystem: "bundled",
    name: "WeChat OpenSDK for Android",
    version: "6.8.38",
    license: "NOASSERTION",
    category: "restricted-review-required",
    url: "https://developers.weixin.qq.com/doc/oplatform/Mobile_App/Access_Guide/Android.html",
    note: "上游 Maven SDK 未提供标准开源许可证；按 docs/legal/wechat-open-sdk-compliance.md 完成条款、隐私披露和用户同意复核。官方合规指南：https://developers.weixin.qq.com/doc/oplatform/Mobile_App/agreement/sdk.html",
    artifacts: ["mobile-android"],
  },
];

function restrictedForArtifact(name, artifact) {
  return mergeComponents(
    artifact.closure.excluded,
    restrictedManualEntries.filter((component) =>
      component.artifacts.includes(name),
    ),
  );
}

const restrictedByArtifact = Object.fromEntries(
  Object.entries(artifactDefinitions).map(([name, artifact]) => [
    name,
    restrictedForArtifact(name, artifact),
  ]),
);
const restricted = mergeComponents(
  projectClosure.excluded,
  ...Object.values(restrictedByArtifact),
);

fs.mkdirSync(SBOM_DIR, { recursive: true });
const outputs = [];
for (const [name, artifact] of Object.entries(artifactDefinitions)) {
  outputs.push([
    path.join(NOTICES_DIR, `${name}.txt`),
    buildOutput({
      packages: artifact.closure.packages,
      manualEntries: artifact.manual,
      productName: artifact.productName,
      description: artifact.description,
      coverageNotes: artifact.notes,
    }),
  ]);
  const sbomComponents = mergeComponents(
    artifact.closure.packages,
    artifact.manual,
  );
  outputs.push([
    path.join(SBOM_DIR, `${name}.spdx.json`),
    `${JSON.stringify(buildSpdxDocument(name, sbomComponents), null, 2)}\n`,
  ]);
  outputs.push([
    path.join(NOTICES_DIR, `${name}-restricted.txt`),
    buildRestrictedOutput(restrictedByArtifact[name], artifact.productName),
  ]);
}

const desktopCombined = mergeClosures(
  artifactDefinitions["desktop-win"].closure,
  artifactDefinitions["desktop-macos"].closure,
  artifactDefinitions["desktop-linux"].closure,
);
const desktopManual = mergeComponents(
  artifactDefinitions["desktop-win"].manual,
  artifactDefinitions["desktop-macos"].manual,
  artifactDefinitions["desktop-linux"].manual,
);
const desktopRestricted = mergeComponents(
  restrictedByArtifact["desktop-win"],
  restrictedByArtifact["desktop-macos"],
  restrictedByArtifact["desktop-linux"],
);
outputs.push(
  [
    path.join(NOTICES_DIR, "THIRD-PARTY-NOTICES.txt"),
    buildOutput({
      packages: projectClosure.packages,
      manualEntries: projectManual,
      productName: "Cindy project aggregate",
      description: ["全工程各已定义分发产物的第三方开源组件聚合声明。"],
      coverageNotes: [
        "各产物精确范围见 docs/legal/notices/*.txt;受限组件见独立清单。",
      ],
    }),
  ],
  [
    path.join(DESKTOP_DIR, "resources", "THIRD-PARTY-NOTICES.txt"),
    buildOutput({
      packages: desktopCombined.packages,
      manualEntries: desktopManual,
      productName: "Cindy desktop application — all supported platforms",
      description: ["Windows、macOS 与 Linux 桌面产物的保守合并声明。"],
      coverageNotes: [
        "发布包可按 docs/legal/notices/desktop-<platform>.txt 使用平台精确版本。",
      ],
    }),
  ],
  [
    path.join(NOTICES_DIR, "THIRD-PARTY-RESTRICTED.txt"),
    buildRestrictedOutput(restricted),
  ],
  [
    path.join(DESKTOP_DIR, "resources", "THIRD-PARTY-RESTRICTED.txt"),
    buildRestrictedOutput(
      desktopRestricted,
      "Cindy desktop application — all supported platforms",
    ),
  ],
);

for (const [target, output] of outputs) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, output, "utf8");
  console.log(
    `written: ${path.relative(REPO_ROOT, target)} (${(output.length / 1024).toFixed(0)} KB)`,
  );
}

console.log(`restricted/proprietary components: ${restricted.length}`);
