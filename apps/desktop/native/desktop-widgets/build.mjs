// Builds Cindy's macOS desktop widgets (subscription quota and daily usage):
//   - cindy-desktop-widgets.node: N-API addon the Electron main process loads to tell
//     WidgetKit that new data was written and to learn whether any widget is on the desktop.
//     WidgetKit only takes reloads from the containing app, so this cannot be a helper.
//   - CindyDesktopWidgets.appex: WidgetKit extension that renders them, installed into
//     <app>/Contents/PlugIns after packaging. Its views are the phone's widgets
//     (apps/mobile/plugins/usage-widgets); MacWidgetSupport.swift holds the Mac parts.
// The main process writes the data into a folder under Application Support named after the
// app's bundle id; the extension's sandbox may only read that folder. The folder is written
// into both Info.plists here, so an app without the extension never writes widget data.
// Needs the macOS 14 SDK; otherwise every step is skipped. CINDY_DESKTOP_WIDGETS=0 skips on purpose.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const source = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(source, '../..');
const shared = path.resolve(desktop, '../mobile/plugins/usage-widgets');
const require = createRequire(path.join(desktop, 'package.json'));
const MIN_SDK = [14, 0];
const MIN_SYSTEM = '14.0';
const MODULE_NAME = 'CindyDesktopWidgets';
const EXTENSION_NAME = 'CindyDesktopWidgets';
export const DESKTOP_WIDGETS_ADDON_RELATIVE_PATH = 'tools/desktop-widgets/cindy-desktop-widgets.node';
/** The phone widget sources the Mac compiles; the phone's entry point and Live Activity stay out. */
const SHARED_SOURCES = [
  'CindyUsageWidgets.swift',
  'UsageWidgetModel.swift',
  'WidgetPalette.swift',
  'QuotaWidgetViews.swift',
  'UsageWidgetViews.swift',
  'SingleSourceViews.swift',
  'ComputerIntent.swift',
];
/** Same number font as the menu bar panel and the phone widgets. */
const FONTS = ['BarlowCondensed-Medium.ttf', 'BarlowCondensed-SemiBold.ttf'];
const LOCALIZATIONS = ['en', 'zh-Hans', 'zh-Hant', 'ja', 'ko', 'de', 'es', 'fr', 'pt-BR', 'pt-PT'];

function log(message) {
  console.log(`[desktop-widgets] ${message}`);
}

function triple(arch) {
  return `${arch === 'x64' ? 'x86_64' : 'arm64'}-apple-macos${MIN_SYSTEM}`;
}

/** Returns why the widgets cannot be built here, or null when they can. */
export function desktopWidgetsBuildSkipReason(arch = process.arch) {
  if (process.platform !== 'darwin') return 'not macOS';
  if (process.env.CINDY_DESKTOP_WIDGETS === '0') return 'CINDY_DESKTOP_WIDGETS=0';
  if (arch !== 'arm64' && arch !== 'x64') return `unsupported arch ${arch}`;
  const probe = spawnSync('xcrun', ['--sdk', 'macosx', '--show-sdk-version'], { encoding: 'utf8' });
  const version = probe.status === 0 ? probe.stdout.trim() : '';
  const [major = 0, minor = 0] = version.split('.').map((part) => Number.parseInt(part, 10) || 0);
  if (major < MIN_SDK[0] || (major === MIN_SDK[0] && minor < MIN_SDK[1])) {
    return `macOS SDK ${version || 'unknown'} < ${MIN_SDK.join('.')}`;
  }
  return null;
}

/** Home-relative folder the app writes and the extension reads. */
export function desktopWidgetDataPath(appId) {
  return `Library/Application Support/${appId}/Widgets`;
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

function swiftc(arch, args) {
  execFileSync('xcrun', ['swiftc', '-module-name', MODULE_NAME, '-target', triple(arch), '-O', ...args], {
    stdio: 'inherit',
  });
}

/** Builds the addon to `output`, or removes a stale one when the build is skipped. */
export function buildDesktopWidgetsAddon(output, arch = process.arch) {
  const skip = desktopWidgetsBuildSkipReason(arch);
  if (skip) {
    fs.rmSync(output, { force: true });
    log(`addon skipped: ${skip}`);
    return false;
  }
  const headers = nodeApiHeaders();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-desktop-widgets-'));
  try {
    const shim = path.join(work, 'addon.o');
    execFileSync(
      'xcrun',
      [
        'clang++', '-std=c++17', '-c', '-arch', arch === 'x64' ? 'x86_64' : 'arm64',
        `-mmacosx-version-min=${MIN_SYSTEM}`, '-I', headers, path.join(source, 'addon.mm'), '-o', shim,
      ],
      { stdio: 'inherit' },
    );
    const built = path.join(work, 'cindy-desktop-widgets.node');
    swiftc(arch, [
      '-emit-library',
      path.join(source, 'DesktopWidgetsController.swift'),
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
  if (result.status !== 0) throw new Error(`[desktop-widgets] PlistBuddy "${command}" failed: ${result.stderr}`);
  return result.stdout.trim();
}

function plistSet(plist, key, type, value) {
  const set = spawnSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plist]);
  if (set.status !== 0) plistBuddy(plist, `Add :${key} ${type} ${value}`);
}

function xmlEscape(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Provider logos only; the catalog also holds the phone's Live Activity artwork. */
function compileAssets(resources) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-desktop-widgets-assets-'));
  try {
    const from = path.join(shared, 'Assets.xcassets');
    const catalog = path.join(work, 'Assets.xcassets');
    fs.mkdirSync(catalog, { recursive: true });
    fs.copyFileSync(path.join(from, 'Contents.json'), path.join(catalog, 'Contents.json'));
    for (const name of fs.readdirSync(from).filter((entry) => /^(inline-)?logo-.+\.imageset$/.test(entry))) {
      fs.cpSync(path.join(from, name), path.join(catalog, name), { recursive: true });
    }
    fs.mkdirSync(resources, { recursive: true });
    execFileSync(
      'xcrun',
      [
        'actool', '--compile', resources, '--platform', 'macosx', '--minimum-deployment-target', MIN_SYSTEM,
        '--output-format', 'human-readable-text', '--warnings', '--errors', catalog,
      ],
      { stdio: ['ignore', 'ignore', 'inherit'] },
    );
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/**
 * Installs the widget extension into a packaged `.app`. Local builds are ad-hoc signed;
 * release signing (`signMacAppWithIdentity` in scripts/ci/lib.mjs) re-signs every `.appex`
 * keeping the entitlements written here (App Sandbox and the read-only data folder).
 */
export function installDesktopWidgetsExtension(appPath, arch = process.arch) {
  const skip = desktopWidgetsBuildSkipReason(arch);
  if (skip) {
    log(`extension skipped: ${skip}`);
    return false;
  }
  const addon = path.join(appPath, 'Contents/Resources', DESKTOP_WIDGETS_ADDON_RELATIVE_PATH);
  if (!fs.existsSync(addon)) {
    log('extension skipped: addon was not packaged');
    return false;
  }
  const appPlist = path.join(appPath, 'Contents/Info.plist');
  const appId = plistBuddy(appPlist, 'Print :CFBundleIdentifier');
  const shortVersion = plistBuddy(appPlist, 'Print :CFBundleShortVersionString');
  const bundleVersion = plistBuddy(appPlist, 'Print :CFBundleVersion');
  const dataPath = desktopWidgetDataPath(appId);
  const appex = path.join(appPath, 'Contents/PlugIns', `${EXTENSION_NAME}.appex`);
  fs.rmSync(appex, { recursive: true, force: true });
  fs.mkdirSync(path.join(appex, 'Contents/MacOS'), { recursive: true });
  const resources = path.join(appex, 'Contents/Resources');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-widget-intents-'));
  try {
    const sources = [...SHARED_SOURCES.map((file) => path.join(shared, file)), path.join(source, 'MacWidgetSupport.swift')];
    const toolchain = path.resolve(execFileSync('xcrun', ['--find', 'swiftc'], { encoding: 'utf8' }).trim(), '../../..');
    const constValues = path.join(work, 'widgets.swiftconstvalues');
    const protocols = path.join(work, 'protocols.json');
    // Protocol conformances used by ComputerIntent.swift, including WidgetConfigurationIntent's AppIntent.
    fs.writeFileSync(protocols, JSON.stringify(['AppIntent', 'AppEntity', 'EntityQuery', 'AppEnum', 'DynamicOptionsProvider']));
    swiftc(arch, [
      '-parse-as-library', '-application-extension', '-whole-module-optimization',
      '-emit-const-values-path', constValues,
      '-const-gather-protocols-list', protocols,
      ...sources,
      '-Xlinker', '-e', '-Xlinker', '_NSExtensionMain',
      '-o', path.join(appex, 'Contents/MacOS', EXTENSION_NAME),
    ]);
    const sourceList = path.join(work, 'sources');
    const valuesList = path.join(work, 'const-values');
    fs.writeFileSync(sourceList, sources.join('\n') + '\n');
    fs.writeFileSync(valuesList, constValues + '\n');
    fs.mkdirSync(resources, { recursive: true });
    execFileSync('xcrun', [
      'appintentsmetadataprocessor', '--module-name', MODULE_NAME,
      '--output', resources, '--toolchain-dir', toolchain,
      '--sdk-root', execFileSync('xcrun', ['--sdk', 'macosx', '--show-sdk-path'], { encoding: 'utf8' }).trim(),
      '--xcode-version', execFileSync('xcodebuild', ['-version'], { encoding: 'utf8' }).trim().split('Build version ')[1],
      '--platform-family', 'macOS', '--deployment-target', MIN_SYSTEM, '--target-triple', triple(arch),
      '--source-file-list', sourceList, '--swift-const-vals-list', valuesList,
    ], { stdio: 'inherit' });
    if (!fs.existsSync(path.join(resources, 'Metadata.appintents/extract.actionsdata'))) {
      throw new Error('Desktop widget App Intents metadata was not generated');
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
  compileAssets(resources);
  for (const font of FONTS) {
    fs.copyFileSync(path.join(desktop, 'native/menubar', font), path.join(resources, font));
  }
  for (const language of LOCALIZATIONS) {
    fs.cpSync(path.join(shared, `${language}.lproj`), path.join(resources, `${language}.lproj`), { recursive: true });
  }
  fs.writeFileSync(
    path.join(appex, 'Contents/Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>ATSApplicationFontsPath</key><string>.</string>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleDisplayName</key><string>Cindy</string>
  <key>CFBundleExecutable</key><string>${EXTENSION_NAME}</string>
  <key>CFBundleIdentifier</key><string>${xmlEscape(appId)}.desktop-widgets</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>${EXTENSION_NAME}</string>
  <key>CFBundlePackageType</key><string>XPC!</string>
  <key>CFBundleSupportedPlatforms</key><array><string>MacOSX</string></array>
  <key>CFBundleShortVersionString</key><string>${xmlEscape(shortVersion)}</string>
  <key>CFBundleVersion</key><string>${xmlEscape(bundleVersion)}</string>
  <key>CindyWidgetDataPath</key><string>${xmlEscape(dataPath)}</string>
  <key>LSMinimumSystemVersion</key><string>${MIN_SYSTEM}</string>
  <key>NSExtension</key>
  <dict>
    <key>NSExtensionPointIdentifier</key><string>com.apple.widgetkit-extension</string>
  </dict>
</dict>
</plist>
`,
  );
  const entitlements = path.join(os.tmpdir(), `cindy-desktop-widgets-${process.pid}.entitlements`);
  fs.writeFileSync(
    entitlements,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.app-sandbox</key>
  <true/>
  <key>com.apple.security.temporary-exception.files.home-relative-path.read-only</key>
  <array>
    <string>/${xmlEscape(dataPath)}/</string>
  </array>
</dict>
</plist>
`,
  );
  try {
    execFileSync('codesign', ['--force', '--sign', '-', '--entitlements', entitlements, appex], { stdio: 'inherit' });
  } finally {
    fs.rmSync(entitlements, { force: true });
  }
  plistSet(appPlist, 'CindyDesktopWidgetDataPath', 'string', `"${dataPath}"`);
  log(`extension -> ${appex} (${appId}.desktop-widgets)`);
  return true;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command = 'addon', target, arch] = process.argv.slice(2);
  if (command === 'addon') {
    buildDesktopWidgetsAddon(
      target || path.join(source, '../../resources', DESKTOP_WIDGETS_ADDON_RELATIVE_PATH),
      arch,
    );
  } else if (command === 'extension' && target) {
    installDesktopWidgetsExtension(target, arch);
  } else {
    console.error('usage: build.mjs addon [output] [arch] | build.mjs extension <App.app> [arch]');
    process.exit(2);
  }
}
