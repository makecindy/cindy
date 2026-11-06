// Builds Cindy's macOS Live Activity pieces (Agent Island in the system Dynamic Island):
//   - cindy-agent-activity.node: N-API addon the Electron main process loads to
//     start/update/end the activity. ActivityKit only accepts the app process itself,
//     while it has a visible window, so this cannot live in the island helper.
//   - CindyAgentActivity.appex: WidgetKit extension that renders it, installed into
//     <app>/Contents/PlugIns after packaging.
// Both need the macOS 27.3 SDK and Apple silicon; otherwise every step is skipped
// and the app ships without the feature. Set CINDY_LIVE_ACTIVITY=0 to skip on purpose.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const source = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(source, '../../../package.json'));
const MIN_SDK = [27, 3];
const DEPLOYMENT_TARGET = 'arm64-apple-macos27.3';
const MODULE_NAME = 'CindyAgentActivity';
const EXTENSION_NAME = 'CindyAgentActivity';
export const AGENT_ACTIVITY_ADDON_RELATIVE_PATH = 'tools/agent-island/cindy-agent-activity.node';

function log(message) {
  console.log(`[agent-activity] ${message}`);
}

/** Returns why Live Activities cannot be built here, or null when they can. */
export function agentActivityBuildSkipReason(arch = process.arch) {
  if (process.platform !== 'darwin') return 'not macOS';
  if (process.env.CINDY_LIVE_ACTIVITY === '0') return 'CINDY_LIVE_ACTIVITY=0';
  if (arch !== 'arm64' && arch !== 'universal') return `unsupported arch ${arch} (macOS 27 is Apple silicon only)`;
  const probe = spawnSync('xcrun', ['--sdk', 'macosx', '--show-sdk-version'], { encoding: 'utf8' });
  const version = probe.status === 0 ? probe.stdout.trim() : '';
  const [major = 0, minor = 0] = version.split('.').map((part) => Number.parseInt(part, 10) || 0);
  if (major < MIN_SDK[0] || (major === MIN_SDK[0] && minor < MIN_SDK[1])) {
    return `macOS SDK ${version || 'unknown'} < ${MIN_SDK.join('.')}`;
  }
  return null;
}

function nodeApiHeaders() {
  const headers = path.join(os.homedir(), 'Library/Caches/node-gyp', process.versions.node, 'include/node');
  if (!fs.existsSync(path.join(headers, 'node_api.h'))) {
    const rebuild = createRequire(require.resolve('@electron/rebuild'));
    execFileSync(process.execPath, [rebuild.resolve('node-gyp/bin/node-gyp.js'), 'install', '--ensure'], {
      stdio: 'inherit',
    });
  }
  return headers;
}

function swiftc(args) {
  execFileSync('xcrun', ['swiftc', '-module-name', MODULE_NAME, '-target', DEPLOYMENT_TARGET, '-O', ...args], {
    stdio: 'inherit',
  });
}

/** Builds the addon to `output`, or removes a stale one when the build is skipped. */
export function buildAgentActivityAddon(output, arch = process.arch) {
  const skip = agentActivityBuildSkipReason(arch);
  if (skip) {
    fs.rmSync(output, { force: true });
    log(`addon skipped: ${skip}`);
    return false;
  }
  const headers = nodeApiHeaders();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-agent-activity-'));
  try {
    const shim = path.join(work, 'addon.o');
    execFileSync(
      'xcrun',
      [
        'clang++', '-std=c++17', '-c', '-arch', 'arm64', '-mmacosx-version-min=27.3',
        '-I', headers, path.join(source, 'addon.mm'), '-o', shim,
      ],
      { stdio: 'inherit' },
    );
    const built = path.join(work, 'cindy-agent-activity.node');
    swiftc([
      '-emit-library',
      path.join(source, 'CindyAgentActivityAttributes.swift'),
      path.join(source, 'CindyAgentActivityController.swift'),
      shim,
      '-Xlinker', '-undefined', '-Xlinker', 'dynamic_lookup',
      '-o', built,
    ]);
    execFileSync('codesign', ['--force', '--sign', '-', built], { stdio: 'inherit' });
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.copyFileSync(built, output);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
  log(`addon -> ${output}`);
  return true;
}

function plistBuddy(plist, command) {
  const result = spawnSync('/usr/libexec/PlistBuddy', ['-c', command, plist], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`[agent-activity] PlistBuddy "${command}" failed: ${result.stderr}`);
  return result.stdout.trim();
}

function plistSet(plist, key, type, value) {
  const set = spawnSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plist]);
  if (set.status !== 0) plistBuddy(plist, `Add :${key} ${type} ${value}`);
}

/**
 * Installs the widget extension into a packaged `.app` and declares Live Activity
 * support in its Info.plist. Local builds are ad-hoc signed; release signing must
 * sign the `.appex` with `extension.entitlements` (App Sandbox) before the app.
 */
export function installAgentActivityExtension(appPath, arch = process.arch) {
  const skip = agentActivityBuildSkipReason(arch);
  if (skip) {
    log(`extension skipped: ${skip}`);
    return false;
  }
  const addon = path.join(appPath, 'Contents/Resources', AGENT_ACTIVITY_ADDON_RELATIVE_PATH);
  if (!fs.existsSync(addon)) {
    log('extension skipped: addon was not packaged');
    return false;
  }
  const appPlist = path.join(appPath, 'Contents/Info.plist');
  const appId = plistBuddy(appPlist, 'Print :CFBundleIdentifier');
  const shortVersion = plistBuddy(appPlist, 'Print :CFBundleShortVersionString');
  const bundleVersion = plistBuddy(appPlist, 'Print :CFBundleVersion');
  const appex = path.join(appPath, 'Contents/PlugIns', `${EXTENSION_NAME}.appex`);
  fs.rmSync(appex, { recursive: true, force: true });
  fs.mkdirSync(path.join(appex, 'Contents/MacOS'), { recursive: true });
  swiftc([
    '-parse-as-library',
    '-application-extension',
    path.join(source, 'CindyAgentActivityAttributes.swift'),
    path.join(source, 'CindyAgentActivityWidget.swift'),
    // Same entry point Xcode links app extensions with. Booting from Swift's `main`
    // skips ExtensionFoundation's process-identity setup and the extension traps
    // as soon as chronod launches it.
    '-Xlinker', '-e', '-Xlinker', '_NSExtensionMain',
    '-o', path.join(appex, 'Contents/MacOS', EXTENSION_NAME),
  ]);
  fs.cpSync(path.join(source, '../mascots'), path.join(appex, 'Contents/Resources/mascots'), { recursive: true });
  fs.writeFileSync(
    path.join(appex, 'Contents/Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleDisplayName</key><string>Cindy</string>
  <key>CFBundleExecutable</key><string>${EXTENSION_NAME}</string>
  <key>CFBundleIdentifier</key><string>${appId}.agent-activity</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>${EXTENSION_NAME}</string>
  <key>CFBundlePackageType</key><string>XPC!</string>
  <key>CFBundleSupportedPlatforms</key><array><string>MacOSX</string></array>
  <key>CFBundleShortVersionString</key><string>${shortVersion}</string>
  <key>CFBundleVersion</key><string>${bundleVersion}</string>
  <key>LSMinimumSystemVersion</key><string>27.3</string>
  <key>NSExtension</key>
  <dict>
    <key>NSExtensionPointIdentifier</key><string>com.apple.widgetkit-extension</string>
  </dict>
</dict>
</plist>
`,
  );
  execFileSync(
    'codesign',
    ['--force', '--sign', '-', '--entitlements', path.join(source, 'extension.entitlements'), appex],
    { stdio: 'inherit' },
  );
  plistSet(appPlist, 'NSSupportsLiveActivities', 'bool', 'true');
  log(`extension -> ${appex} (${appId}.agent-activity)`);
  return true;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command = 'addon', target, arch] = process.argv.slice(2);
  if (command === 'addon') {
    buildAgentActivityAddon(
      target || path.join(source, '../../../resources', AGENT_ACTIVITY_ADDON_RELATIVE_PATH),
      arch,
    );
  } else if (command === 'extension' && target) {
    installAgentActivityExtension(target, arch);
  } else {
    console.error('usage: build.mjs addon [output] [arch] | build.mjs extension <App.app> [arch]');
    process.exit(2);
  }
}
