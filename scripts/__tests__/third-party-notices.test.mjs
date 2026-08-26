import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import parseSpdxExpression from "spdx-expression-parse";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const noticesDir = path.join(repoRoot, "docs", "legal", "notices");
const artifactNames = [
  "desktop-win",
  "desktop-macos",
  "desktop-linux",
  "mobile-ios",
  "mobile-android",
];

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

test("generated artifact notices are platform-scoped and disclose restricted components separately", () => {
  const windows = read("docs/legal/notices/desktop-win.txt");
  const macos = read("docs/legal/notices/desktop-macos.txt");
  const linux = read("docs/legal/notices/desktop-linux.txt");
  const windowsRestricted = read(
    "docs/legal/notices/desktop-win-restricted.txt",
  );
  const iosRestricted = read("docs/legal/notices/mobile-ios-restricted.txt");
  const androidRestricted = read(
    "docs/legal/notices/mobile-android-restricted.txt",
  );

  assert.match(windows, /@img\/sharp-win32-x64@/);
  assert.doesNotMatch(windows, /@img\/sharp-darwin-/);
  assert.match(windows, /SECTION \d+: cargo packages/);
  assert.match(windows, /Android SDK Platform-Tools/);
  // 安装包内资产和运行时受管下载的 agent 二进制，都必须出现在三个桌面平台声明里。
  for (const notice of [windows, macos, linux]) {
    assert.match(notice, /OpenAI Codex CLI \(runtime-downloaded binary\) \d/);
    assert.match(notice, /pi coding agent \(runtime-downloaded binary\) \d/);
    assert.match(notice, /ripgrep \(bundled binary\) \d/);
  }
  assert.match(macos, /@img\/sharp-darwin-/);
  assert.doesNotMatch(macos, /Android SDK Platform-Tools/);
  assert.match(linux, /@img\/sharp-linux-x64@/);
  assert.doesNotMatch(windowsRestricted, /@codesandbox\/nodebox/);
  assert.doesNotMatch(windowsRestricted, /Sustainable Use License/);
  assert.match(iosRestricted, /WeChat OpenSDK for iOS@2\.0\.5/);
  assert.match(iosRestricted, /docs\/legal\/wechat-open-sdk-compliance\.md/);
  assert.match(iosRestricted, /Mobile_App\/agreement\/sdk\.html/);
  assert.doesNotMatch(iosRestricted, /WeChat OpenSDK for Android@6\.8\.38/);
  assert.match(androidRestricted, /WeChat OpenSDK for Android@6\.8\.38/);
  assert.match(androidRestricted, /docs\/legal\/wechat-open-sdk-compliance\.md/);
  assert.match(androidRestricted, /Mobile_App\/agreement\/sdk\.html/);
  assert.doesNotMatch(androidRestricted, /Claude Code CLI@/);
  assert.doesNotMatch(windows, /@codesandbox\/nodebox@0\.1\.8 —/);
});

test("multi-arch desktop notices describe every architecture they ship with", () => {
  const macos = read("docs/legal/notices/desktop-macos.txt");
  const linux = read("docs/legal/notices/desktop-linux.txt");

  // 一个平台声明覆盖两个架构时,内嵌原生库的 README 和 versions.json 都是 per-arch 的:
  // 只读其中一份,另一个架构的分发物就会带着错误的架构描述发出去。
  assert.match(
    macos,
    /@img\/sharp-libvips-darwin-x64 embedded native libraries/,
  );
  assert.match(
    macos,
    /@img\/sharp-libvips-darwin-arm64 embedded native libraries/,
  );
  assert.match(macos, /for use with sharp on macOS x64\./);
  assert.match(macos, /for use with sharp on macOS 64-bit ARM\./);
  assert.match(
    linux,
    /@img\/sharp-libvips-linux-x64 embedded native libraries/,
  );
  assert.match(
    linux,
    /@img\/sharp-libvips-linux-arm64 embedded native libraries/,
  );
  assert.match(linux, /for use with sharp on Linux \(glibc\) x64\./);
  assert.match(linux, /for use with sharp on Linux \(glibc\) 64-bit ARM\./);
});

// 移动端安装包不分发构建期工具链的预编译二进制，但这些包的许可义务由其 JS 主包
// 承载，主包必须留在声明里。
test("mobile notices exclude build-time platform binaries but keep their JS packages", () => {
  for (const artifact of ["mobile-ios", "mobile-android"]) {
    const notices = read(`docs/legal/notices/${artifact}.txt`);
    // 覆盖 name-darwin-arm64 与 @scope/darwin-arm64 两种命名形式。
    assert.doesNotMatch(
      notices,
      /^- \S*(?:darwin|linux|win32|musl|freebsd)\S*@/im,
    );
    assert.match(notices, /^- lightningcss@/m);
  }
});

// 闭包必须按显式目标平台收集：collectClosure() 判断可选依赖是否存在只看 node_modules
// 里有没有目录，省掉 target 就会让产物随生成机器的安装集合漂移。
//
// 这里守的是那一处强制校验本身，而不是去枚举调用点。枚举的写法（无论正则还是括号扫描）
// 都能被换一种调用形式绕过，且在本文件上会实打实误报——生成器的错误消息与注释里都出现
// 了 `collectClosure(`，而源码含带引号的正则字面量，使得零依赖的字符串跳过无法可靠实现。
// 强制校验则覆盖全部调用形式：`licenses:generate` 是产物的唯一生成途径，缺 target 的调用
// 必然在生成时抛错，产物不可能带着机器相关的内容进仓库。
test("collectClosure() refuses to run without an explicit target", () => {
  const source = read("scripts/generate-third-party-notices.mjs");
  const signature = source.match(/function collectClosure\(([^)]*)\)/)?.[1];
  assert.ok(signature, "找不到 collectClosure 定义，守卫已失效");
  assert.doesNotMatch(
    signature,
    /=/,
    "target 不得有默认值：默认值会让缺 target 的调用静默恢复成机器相关行为",
  );
  assert.match(source, /requires an explicit target/);
  // linux 目标必须连 libc 一起强制：只有 linux 分 glibc / musl，缺了这一轴
  // matchesPackageConstraint() 会把两种变体同时放行，产物又随本机装了哪个变体漂移。
  assert.match(
    source,
    /os === "linux"\s*\?\s*\["os", "cpu", "libc"\]/,
    "linux 目标未强制 libc：glibc 与 musl 变体会同时进闭包",
  );
  // matchesTarget() 不得再有「target 为空则一律放行」的分支，那是漂移的根源。
  const matchesTarget = source.match(
    /function matchesTarget\([^)]*\)\s*\{[\s\S]*?\n\}/,
  )?.[0];
  assert.ok(matchesTarget, "找不到 matchesTarget 定义，守卫已失效");
  assert.doesNotMatch(matchesTarget, /return true/);
});

test("commercial distributions do not resolve forbidden Sustainable Use dependencies", () => {
  const lockfile = read("pnpm-lock.yaml");
  assert.doesNotMatch(lockfile, /@codesandbox\/nodebox/);
  assert.doesNotMatch(lockfile, /@codesandbox\/sandpack-(?:client|react)/);
});

test("project-owned iOS podspecs declare the repository Apache-2.0 license", () => {
  const podspecs = [
    "xdt-wechat-login/ios/XdtWechatLogin.podspec",
    "xdt-tapdb/ios/XdtTapdb.podspec",
    "xdt-mobile-realtime-audio/ios/XdtMobileRealtimeAudio.podspec",
    "xdt-ios-app-distribution/ios/XdtIosAppDistribution.podspec",
  ];
  for (const relativePath of podspecs) {
    const podspec = read(path.join("apps/mobile/modules", relativePath));
    assert.match(podspec, /:type\s*=>\s*['\"]Apache-2\.0['\"]/);
    assert.match(podspec, /:file\s*=>\s*['\"]\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/LICENSE['\"]/);
    assert.doesNotMatch(podspec, /UNLICENSED/i);
    assert.match(podspec, /https:\/\/github\.com\/makecindy\/cindy\.git/);
  }
});

test("every SPDX document is structurally consistent and has valid license expressions", () => {
  for (const artifact of artifactNames) {
    const file = path.join(noticesDir, "sbom", `${artifact}.spdx.json`);
    const document = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(document.spdxVersion, "SPDX-2.3");
    assert.equal(document.dataLicense, "CC0-1.0");
    assert.match(
      document.documentNamespace,
      new RegExp(`/spdx/${artifact}/[a-f0-9]{64}$`),
    );
    assert.ok(document.packages.length > 0);

    const packageIds = new Set();
    for (const pkg of document.packages) {
      assert.equal(pkg.filesAnalyzed, false);
      assert.doesNotThrow(
        () => parseSpdxExpression(pkg.licenseDeclared),
        pkg.name,
      );
      assert.equal(pkg.licenseDeclared, pkg.licenseConcluded);
      assert.ok(!packageIds.has(pkg.SPDXID), `duplicate SPDXID: ${pkg.SPDXID}`);
      packageIds.add(pkg.SPDXID);
    }
    assert.equal(document.relationships.length, document.packages.length);
    for (const relationship of document.relationships) {
      assert.equal(relationship.spdxElementId, "SPDXRef-DOCUMENT");
      assert.equal(relationship.relationshipType, "DESCRIBES");
      assert.ok(packageIds.has(relationship.relatedSpdxElement));
    }
  }
});

test("desktop resources include both open-source and restricted disclosures", () => {
  const desktopRestricted = read(
    "apps/desktop/resources/THIRD-PARTY-RESTRICTED.txt",
  );
  const assertProviderBrandingOrder = (noticePath) => {
    const notice = read(noticePath);
    const liteLlmIndex = notice.indexOf("LiteLLM mascot SVG path (adapted)");
    const lobeIndex = notice.indexOf("Lobe Icons SVG paths (vendored)");
    assert.notEqual(liteLlmIndex, -1, `${noticePath} includes the LiteLLM notice`);
    assert.notEqual(lobeIndex, -1, `${noticePath} includes the Lobe Icons notice`);
    assert.ok(
      liteLlmIndex < lobeIndex,
      `${noticePath} keeps provider branding notices in canonical name order`,
    );
  };
  assert.match(desktopRestricted, /Claude Code CLI@/);
  assert.doesNotMatch(desktopRestricted, /WeChat OpenSDK/);
  assert.match(
    read("apps/desktop/resources/THIRD-PARTY-NOTICES.txt"),
    /sqlite-vec/,
  );
  assert.match(
    read("apps/desktop/resources/THIRD-PARTY-NOTICES.txt"),
    /Lobe Icons SVG paths \(vendored\).*Copyright \(c\) 2023 LobeHub/s,
  );
  assert.match(
    read("apps/desktop/resources/THIRD-PARTY-NOTICES.txt"),
    /LiteLLM mascot SVG path \(adapted\).*Copyright \(c\) 2026 Berri AI/s,
  );
  assert.match(
    read("apps/desktop/resources/THIRD-PARTY-NOTICES.txt"),
    /oh-my-pi Windows Git PATH helpers \(adapted\).*Copyright \(c\) 2025 Mario Zechner.*Copyright \(c\) 2025-2026 Can Bölük/s,
  );
  assert.doesNotMatch(
    read("apps/desktop/resources/THIRD-PARTY-NOTICES.txt"),
    /LiteLLM mascot SVG path \(adapted\) adapted/,
  );
  assertProviderBrandingOrder(
    "apps/desktop/resources/THIRD-PARTY-NOTICES.txt",
  );
  assertProviderBrandingOrder(
    "docs/legal/notices/THIRD-PARTY-NOTICES.txt",
  );
  for (const platform of ["ios", "android"]) {
    const mobileNotice = read(
      `docs/legal/notices/mobile-${platform}.txt`,
    );
    assert.match(
      mobileNotice,
      /LiteLLM mascot SVG path \(adapted\).*Copyright \(c\) 2026 Berri AI/s,
    );
    assert.doesNotMatch(
      mobileNotice,
      /LiteLLM mascot SVG path \(adapted\) adapted/,
    );
    assertProviderBrandingOrder(`docs/legal/notices/mobile-${platform}.txt`);
  }
  assert.ok(
    fs.existsSync(
      path.join(repoRoot, "apps/desktop/cindy-updater/src-tauri/Cargo.lock"),
    ),
  );
});
