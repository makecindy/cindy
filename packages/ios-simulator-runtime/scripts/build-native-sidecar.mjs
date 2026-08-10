import { execFile } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const desktopResourceRoot = path.resolve(
  packageRoot,
  "..",
  "..",
  "apps",
  "desktop",
  "resources",
);
const source = path.join(packageRoot, "native", "ios-simulator-sidecar.swift");
const shimSources = {
  arm64: path.join(packageRoot, "native", "ios-simulator-sidecar-arm64.s"),
  x86_64: path.join(packageRoot, "native", "ios-simulator-sidecar-x86_64.s"),
};
const nativeOutputRoot = path.join(
  desktopResourceRoot,
  "ios-simulator",
  "native",
);
const helperStagingRoot = path.join(
  desktopResourceRoot,
  "ios-simulator",
  "helper",
);
const helperBundleName = "Cindy iOS Simulator Helper.app";
const executableName = "ios-simulator-sidecar";

if (process.platform !== "darwin") {
  console.log("[ios-simulator-sidecar] skipped: macOS-only native helper");
  process.exit(0);
}

const outputMode =
  process.env.CINDY_IOS_SIDECAR_OUTPUT_MODE === "helper" ? "helper" : "raw";
const requestedArch = process.env.CINDY_IOS_SIDECAR_ARCH;
const defaultArch = os.arch() === "x64" ? "x86_64" : "arm64";
const architecture =
  requestedArch === "x86_64" ||
  requestedArch === "arm64" ||
  (requestedArch === "universal" && outputMode === "helper")
    ? requestedArch
    : defaultArch;
const targetArchitectures =
  architecture === "universal" ? ["x86_64", "arm64"] : [architecture];

const developerDir =
  process.env.DEVELOPER_DIR ??
  (
    await execFileAsync("xcode-select", ["-p"], {
      maxBuffer: 1024 * 1024,
    })
  ).stdout.trim();
if (!path.isAbsolute(developerDir)) {
  throw new Error(
    "[ios-simulator-sidecar] build failed: developer directory must be absolute",
  );
}
const simulatorKitFrameworks = path.join(
  developerDir,
  "Library",
  "PrivateFrameworks",
);

async function compileArchitecture(targetArchitecture, output) {
  const outputDir = path.dirname(output);
  const shimObject = path.join(
    outputDir,
    `ios-simulator-sidecar-shim-${targetArchitecture}.o`,
  );
  await mkdir(outputDir, { recursive: true });
  await rm(output, { force: true });
  await rm(shimObject, { force: true });

  try {
    await execFileAsync(
      "xcrun",
      [
        "clang",
        "-c",
        shimSources[targetArchitecture],
        "-target",
        `${targetArchitecture}-apple-macos14.0`,
        "-o",
        shimObject,
      ],
      { maxBuffer: 1024 * 1024 },
    );
    await execFileAsync(
      "xcrun",
      [
        "swiftc",
        source,
        shimObject,
        "-O",
        "-target",
        `${targetArchitecture}-apple-macos14.0`,
        "-F",
        "/Library/Developer/PrivateFrameworks",
        "-framework",
        "CoreSimulator",
        "-F",
        simulatorKitFrameworks,
        "-framework",
        "SimulatorKit",
        "-framework",
        "Accelerate",
        "-framework",
        "IOSurface",
        "-framework",
        "CoreMedia",
        "-framework",
        "CoreVideo",
        "-framework",
        "VideoToolbox",
        "-Xlinker",
        "-rpath",
        "-Xlinker",
        "/Library/Developer/PrivateFrameworks",
        "-Xlinker",
        "-rpath",
        "-Xlinker",
        simulatorKitFrameworks,
        "-o",
        output,
      ],
      { maxBuffer: 1024 * 1024 },
    );
    await chmod(output, 0o755);
  } finally {
    await rm(shimObject, { force: true });
  }
}

function normalizedBundleVersion(value) {
  const components = String(value ?? "")
    .match(/\d+/g)
    ?.slice(0, 3);
  return components?.length ? components.join(".") : "1.0.0";
}

function requireBundleIdentifier(value) {
  const candidate = value?.trim() || "com.xd.cindy.ios-simulator-helper";
  if (!/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(candidate)) {
    throw new Error(
      "[ios-simulator-sidecar] build failed: helper bundle identifier is invalid",
    );
  }
  return candidate;
}

function helperInfoPlist() {
  const version = normalizedBundleVersion(
    process.env.CINDY_IOS_SIDECAR_VERSION,
  );
  const bundleIdentifier = requireBundleIdentifier(
    process.env.CINDY_IOS_SIDECAR_BUNDLE_ID,
  );
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleDisplayName</key>
  <string>Cindy iOS Simulator Helper</string>
  <key>CFBundleExecutable</key>
  <string>${executableName}</string>
  <key>CFBundleIdentifier</key>
  <string>${bundleIdentifier}</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>Cindy iOS Simulator Helper</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>${version}</string>
  <key>CFBundleVersion</key>
  <string>${version}</string>
  <key>LSBackgroundOnly</key>
  <true/>
  <key>LSMinimumSystemVersion</key>
  <string>14.0</string>
</dict>
</plist>
`;
}

async function buildRawBinary() {
  if (architecture === "universal") {
    throw new Error(
      "[ios-simulator-sidecar] build failed: raw output requires one architecture",
    );
  }
  const output = path.join(nativeOutputRoot, architecture, executableName);
  await compileArchitecture(architecture, output);
  console.log(`[ios-simulator-sidecar] built ${output}`);
}

async function buildHelperBundle() {
  const tempRoot = await mkdtemp(
    path.join(os.tmpdir(), "cindy-ios-simulator-helper-"),
  );
  const helperBundle = path.join(helperStagingRoot, helperBundleName);
  const contents = path.join(helperBundle, "Contents");
  const executable = path.join(contents, "MacOS", executableName);

  await rm(helperStagingRoot, { recursive: true, force: true });
  await mkdir(path.dirname(executable), { recursive: true });
  try {
    const thinOutputs = [];
    for (const targetArchitecture of targetArchitectures) {
      const thinOutput = path.join(
        tempRoot,
        `${executableName}-${targetArchitecture}`,
      );
      await compileArchitecture(targetArchitecture, thinOutput);
      thinOutputs.push(thinOutput);
    }
    if (thinOutputs.length === 1) {
      await copyFile(thinOutputs[0], executable);
    } else {
      await execFileAsync(
        "xcrun",
        ["lipo", "-create", ...thinOutputs, "-output", executable],
        { maxBuffer: 1024 * 1024 },
      );
    }
    await chmod(executable, 0o755);
    await writeFile(
      path.join(contents, "Info.plist"),
      helperInfoPlist(),
      "utf8",
    );
    console.log(
      `[ios-simulator-sidecar] built helper ${helperBundle} (${targetArchitectures.join("+")})`,
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

try {
  if (outputMode === "helper") {
    await buildHelperBundle();
  } else {
    await buildRawBinary();
  }
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  throw new Error(`[ios-simulator-sidecar] build failed: ${detail}`);
}
