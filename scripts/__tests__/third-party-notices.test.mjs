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
  assert.ok(
    fs.existsSync(
      path.join(repoRoot, "apps/desktop/cindy-updater/src-tauri/Cargo.lock"),
    ),
  );
});
