import { describe, expect, it } from "vitest";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";

const CONFIG_PATH = resolve(__dirname, "../../fingerprint.config.cjs");

function loadConfigSourceSkips(env: Record<string, string> = {}): string[] {
  const script = `
    for (const k of Object.keys(process.env)) {
      if (k.startsWith('EXPO_PUBLIC_')) delete process.env[k];
    }
    Object.assign(process.env, JSON.parse(process.argv[1]));
    delete require.cache[require.resolve(${JSON.stringify(CONFIG_PATH)})];
    const cfg = require(${JSON.stringify(CONFIG_PATH)});
    process.stdout.write(JSON.stringify(cfg.sourceSkips));
  `;
  const out = execFileSync(
    process.execPath,
    ["-e", script, JSON.stringify(env)],
    {
      encoding: "utf8",
      env: { ...process.env, ...env },
    },
  );
  return JSON.parse(out);
}

describe("fingerprint.config.cjs sourceSkips", () => {
  it("includes ExpoConfigVersions when EXPO_PUBLIC_XDT_OTA_SELFHOST=1", () => {
    const skips = loadConfigSourceSkips({ EXPO_PUBLIC_XDT_OTA_SELFHOST: "1" });
    expect(skips).toContain("ExpoConfigVersions");
    expect(skips).toContain("PackageJsonAndroidAndIosScriptsIfNotContainRun");
  });

  it("does not include ExpoConfigVersions without the self-host env", () => {
    const skips = loadConfigSourceSkips({});
    expect(skips).not.toContain("ExpoConfigVersions");
    expect(skips).toContain("PackageJsonAndroidAndIosScriptsIfNotContainRun");
  });

  it("ExpoConfigVersions is a valid @expo/fingerprint source skip", () => {
    let SourceSkips: Record<string, unknown>;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      SourceSkips = require("@expo/fingerprint").SourceSkips;
    } catch {
      return; // @expo/fingerprint not installed in test env — skip gracefully
    }
    expect(SourceSkips).toHaveProperty("ExpoConfigVersions");
  });
});

describe("remote credentials fingerprint boundary", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const config = require(CONFIG_PATH);
  const projectRoot = dirname(CONFIG_PATH);
  const core =
    "../../packages/remote-credentials-native/Sources/CindyRemoteCredentials/";

  it("only excludes core files wholly guarded for macOS", () => {
    const files: string[] = config.ignorePaths.filter((path: string) =>
      path.endsWith(".swift"),
    );
    expect(files).toHaveLength(6);
    for (const file of files) {
      const lines = readFileSync(resolve(projectRoot, file), "utf8")
        .trim()
        .split("\n");
      expect(lines[0], file).toBe("#if os(macOS)");
      let depth = 0;
      for (const [index, line] of lines.entries()) {
        if (/^\s*#if\b/.test(line)) depth++;
        if (/^\s*#(?:else|elseif)\b/.test(line))
          expect(depth, file).toBeGreaterThan(1);
        if (/^\s*#endif\b/.test(line)) depth--;
        if (index < lines.length - 1) expect(depth, file).toBeGreaterThan(0);
      }
      expect(depth, file).toBe(0);
    }
    const podspec = readFileSync(
      resolve(
        projectRoot,
        "../../packages/remote-credentials-native/CindyRemoteCredentials.podspec",
      ),
      "utf8",
    );
    expect(podspec).toContain(
      "s.source_files = 'Sources/CindyRemoteCredentials/**/*.swift'",
    );
  });

  it.each(["ios", "android"])(
    "%s ignores desktop changes but detects mobile inputs",
    (platform) => {
      const fixture = mkdtempSync(
        join(tmpdir(), "cindy-fingerprint-boundary-"),
      );
      try {
        const mobile = join(fixture, "apps/mobile");
        mkdirSync(mobile, { recursive: true });
        const nativePath = "../../packages/remote-credentials-native";
        const native = resolve(mobile, nativePath);
        mkdirSync(native, { recursive: true });
        cpSync(
          resolve(projectRoot, nativePath, "Sources"),
          join(native, "Sources"),
          { recursive: true },
        );
        cpSync(
          resolve(projectRoot, nativePath, "CindyRemoteCredentials.podspec"),
          join(native, "CindyRemoteCredentials.podspec"),
        );
        // Exercise Expo's actual directory hashing and ignore rules, without
        // spawning autolinking or modifying any working-tree/native source.
        const sources = config.extraSources.filter(
          (source: { filePath: string }) =>
            source.filePath.startsWith(nativePath),
        );
        writeFileSync(
          join(mobile, "fingerprint.config.cjs"),
          `module.exports = ${JSON.stringify({ ignorePaths: config.ignorePaths })}`,
        );
        const script = `
        const fs = require('node:fs');
        const path = require('node:path');
        const { normalizeOptionsAsync } = require('@expo/fingerprint/build/Options');
        const { createFingerprintFromSourcesAsync } = require('@expo/fingerprint/build/hash/Hash');
        (async () => {
          const root = process.argv[1];
          const options = await normalizeOptionsAsync(root, { platforms: [process.argv[2]], silent: true });
          const sources = ${JSON.stringify(sources)};
          const hash = async () => (await createFingerprintFromSourcesAsync(sources, root, options)).hash;
          const baseline = await hash();
          const results = {};
          for (const relative of ${JSON.stringify([
            ...config.ignorePaths.filter((path: string) =>
              path.endsWith(".swift"),
            ),
            `${nativePath}/Sources/CredentialHost/main.swift`,
            `${nativePath}/Sources/UnlockInspect/main.swift`,
            `${nativePath}/Sources/DesktopNativeCaller/DesktopNativeCaller.swift`,
            `${core}MobileCredentialClient.swift`,
            `${core}CredentialError.swift`,
            `${core}Resources/credentials.json`,
            `${core}NewSharedInput.swift`,
            `${nativePath}/CindyRemoteCredentials.podspec`,
          ])}) {
            const file = path.resolve(root, relative);
            const original = fs.existsSync(file) ? fs.readFileSync(file) : null;
            fs.appendFileSync(file, '\\n// fingerprint mutation probe\\n');
            results[relative] = (await hash()) === baseline;
            if (original) fs.writeFileSync(file, original); else fs.unlinkSync(file);
          }
          process.stdout.write(JSON.stringify(results));
        })().catch(error => { console.error(error); process.exitCode = 1; });
      `;
        const result = JSON.parse(
          execFileSync(process.execPath, ["-e", script, mobile, platform], {
            cwd: projectRoot,
            encoding: "utf8",
          }),
        ) as Record<string, boolean>;
        for (const [path, unchanged] of Object.entries(result)) {
          const desktopOnly =
            config.ignorePaths.includes(path) ||
            /Sources\/(CredentialHost|UnlockInspect|DesktopNativeCaller)\//.test(
              path,
            );
          expect(unchanged, path).toBe(desktopOnly);
        }
      } finally {
        rmSync(fixture, { recursive: true, force: true });
      }
    },
  );
});
