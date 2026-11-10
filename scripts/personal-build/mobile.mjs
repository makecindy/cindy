/** Personal iOS delivery. Builds a frozen source report; device operations stay in Cindy's plugin. */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {spawnSync, execFileSync} from 'node:child_process';
import {verifyReport, verifyUpgradeSnapshot, run} from '../personal-build.mjs';
import {durableWrite} from './recovery.mjs';
import {acquire} from './lock.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const check = (ok, message) => { if (!ok) throw Error(message); };
const reportPath = file => path.join(path.dirname(path.resolve(file)), 'mobile', 'delivery.json');
const stamp = () => new Date().toISOString();

export function mobileConfig(value, base, region) {
  const m = structuredClone(value);
  check(m && typeof m === 'object' && !Array.isArray(m), 'mobile must be an object');
  check(m.enabled === true && m.platform === 'ios', 'Personal mobile delivery requires enabled=true and platform=ios');
  for (const key of ['bundleId', 'appGroupId']) check(typeof m[key] === 'string' && /^[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+$/.test(m[key]), `Invalid mobile.${key}`);
  check(m.appGroupId.startsWith('group.'), 'mobile.appGroupId must be an App Group');
  check(/^[A-Z0-9]{10}$/.test(m.teamId), 'Invalid mobile.teamId');
  check(!Object.hasOwn(m, 'signingCertificateSha1'), 'Legacy mobile.signingCertificateSha1: migrate the trusted certificate to signingCertificateSha256 and prepare a new build (docs/dev-rules/personal-build.md)');
  check(typeof m.signingCertificateSha256 === 'string' && /^[A-Fa-f0-9]{64}$/.test(m.signingCertificateSha256), 'Invalid mobile.signingCertificateSha256: expected 64 hex characters');
  check(typeof m.deviceId === 'string' && /^[A-Fa-f0-9-]{36}$/.test(m.deviceId), 'mobile.deviceId must identify the exact plugin device');
  check(typeof m.hardwareUdid === 'string' && /^[A-Fa-f0-9-]{20,40}$/.test(m.hardwareUdid), 'mobile.hardwareUdid required for provisioning');
  check(['global', 'cn'].includes(m.region) && m.region === region, 'Mobile and desktop regions must agree');
  check(m.launchAfterInstall === false && m.verifyInstallationMetadataOnly === true, 'Personal mobile delivery never launches or tests phone UI');
  check(typeof m.stateDir === 'string' && m.stateDir.length > 0, 'mobile.stateDir required');
  m.stateDir = path.resolve(base, m.stateDir);
  if (m.regionConfigFile) m.regionConfigFile = fs.realpathSync(path.resolve(base, m.regionConfigFile));
  m.signingCertificateSha256 = m.signingCertificateSha256.toUpperCase();
  return m;
}

export function mobileBuildNumber(previous = 0, date = new Date()) {
  check(Number.isSafeInteger(previous) && previous >= 0, 'Invalid previous mobile build number');
  return String(Math.max(Number(date.toISOString().slice(0, 10).replaceAll('-', '') + '00'), previous + 1));
}

export function verifyMobileArtifact(request, app) {
  return JSON.parse(execFileSync('python3', [path.join(here, 'mobile-ios.py'), 'verify', request, app], {encoding:'utf8', maxBuffer:4 * 1024 * 1024}));
}

/** No GitHub query here: both clients consume the exact same composition, including drafts. */
export async function buildMobile(file) {
  file = path.resolve(file);
  const r = verifyReport(file);
  verifyUpgradeSnapshot(r.configuration, r);
  for (const sha of [r.app.baseSha, ...r.app.prs.map(p => p.sha), ...(r.app.localRefs || []).map(p => p.sha)]) {
    run('git', ['merge-base', '--is-ancestor', sha, r.app.target], r.directory);
  }
  const m = mobileConfig(r.configuration.mobile, path.dirname(file), r.region);
  check(process.platform === 'darwin', 'Personal iOS builds require macOS and Xcode');
  const unlock = acquire(path.join(m.stateDir, 'build.lock'));
  const target = reportPath(file), out = path.dirname(target);
  let d;
  try {
    fs.mkdirSync(out, {recursive:true});
    d = fs.existsSync(target) ? read(target) : null;
    if (d) {
      check(d.commit === r.app.target && JSON.stringify(d.identity) === JSON.stringify(m), 'Mobile delivery identity changed; prepare a new upgrade');
      if (d.phase !== 'build-failed' && d.phase !== 'building') {
        verifyMobileArtifact(d.request, d.app); return d;
      }
    }
    const counter = path.join(m.stateDir, 'build-number.json');
    // Every attempt takes a fresh number from the shared counter: reusing a failed attempt's number could
    // write the counter backwards after a later candidate built with a larger one.
    const build = mobileBuildNumber(fs.existsSync(counter) ? read(counter).last : 0);
    durableWrite(counter, {last:Number(build)});
    const attempt = (d?.attempt || 0) + 1;
    const work = path.join(out, `attempt-${attempt}`);
    fs.mkdirSync(work); // never overwrite a previous artifact, including a failed signature
    d = {version:1, phase:'building', commit:r.app.target, snapshot:r.upgradeSnapshot.capturedAt,
      sourceReport:file, identity:m, build, attempt, request:path.join(work, 'request.json'), log:path.join(work, 'build.log'), updatedAt:stamp()};
    durableWrite(d.request, {identity:m, build, commit:r.app.target, directory:r.directory});
    durableWrite(target, d);
    const mobile = path.join(r.directory, 'apps/mobile');
    check(run('git', ['ls-files', 'apps/mobile/ios'], r.directory) === '', 'Refusing to clean tracked native sources');
    const {mobileClientBundleProcessEnv} = await import(pathToFileURL(path.join(r.directory, 'scripts/shared/client-endpoint-build-env.mjs')));
    const {withUserGemPodOnPath} = await import(pathToFileURL(path.join(mobile, 'scripts/sim-pod-install.mjs')));
    const regions = read(m.regionConfigFile || path.join(mobile, 'scripts/self-host-regions.json.example'));
    check(regions[m.region], 'Missing mobile region configuration');
    regions[m.region].iosBundleId = m.bundleId;
    const regionsFile = path.join(work, 'regions.json'); durableWrite(regionsFile, regions);
    const env = withUserGemPodOnPath({env:{...mobileClientBundleProcessEnv({authRegion:m.region}),
      CINDY_USE_LOCAL_REGION_CONFIG:'1', CINDY_SELF_HOST_REGIONS_FILE:regionsFile,
      EXPO_NO_DOTENV:'1', NODE_ENV:'production', BABEL_ENV:'production'}});
    for (const key of ['EXPO_PUBLIC_APP_VARIANT','EXPO_PUBLIC_BETA_DEV','EXPO_PUBLIC_UI_MOCK','EXPO_PUBLIC_MOCK',
      'EXPO_PUBLIC_CINDY_MOBILE_VISUAL_MOCK','EXPO_PUBLIC_XDT_OTA_SELFHOST','CINDY_MOBILE_OTA_NATIVE',
      'EAS_PROJECT_ID','EAS_OWNER','EXPO_PUBLIC_EAS_PROJECT_ID']) delete env[key];
    const log = fs.openSync(d.log, 'a');
    const exec = (cmd, args, cwd = mobile) => {
      const result = spawnSync(cmd, args, {cwd, env, stdio:['ignore', log, log]});
      check(!result.error && result.status === 0, `${cmd} failed; inspect ${d.log}`);
    };
    try {
      exec('pnpm', ['install', '--frozen-lockfile'], r.directory);
      exec('pnpm', ['exec', 'expo', 'prebuild', '--platform', 'ios', '--clean', '--no-install']);
      exec('python3', [path.join(here, 'mobile-ios.py'), 'configure', d.request]);
      exec('pod', ['install'], path.join(mobile, 'ios'));
      const workspaces = fs.readdirSync(path.join(mobile, 'ios')).filter(n => n.endsWith('.xcworkspace'));
      check(workspaces.length === 1, 'Expected one generated iOS workspace');
      const scheme = workspaces[0].slice(0, -12), derived = path.join(work, 'DerivedData');
      exec('xcodebuild', ['-workspace', path.join(mobile, 'ios', workspaces[0]), '-scheme', scheme,
        '-configuration', 'Release', '-destination', `platform=iOS,id=${m.hardwareUdid}`, '-derivedDataPath', derived,
        '-allowProvisioningUpdates', `DEVELOPMENT_TEAM=${m.teamId}`, 'CODE_SIGN_STYLE=Automatic',
        // Automatic provisioning requires a certificate class, not a certificate fingerprint.
        // verifyMobileArtifact still requires the configured exact certificate on every bundle;
        // an Xcode-selected identity mismatch blocks delivery rather than weakening the pin.
        'CODE_SIGN_IDENTITY=Apple Development', 'SWIFT_ENABLE_EXPLICIT_MODULES=NO',
        'CLANG_ENABLE_EXPLICIT_MODULES=NO', `CURRENT_PROJECT_VERSION=${build}`, '-quiet', 'build']);
      d.app = path.join(derived, 'Build/Products/Release-iphoneos', `${scheme}.app`);
    } finally { fs.closeSync(log); }
    verifyReport(file); verifyUpgradeSnapshot(r.configuration, r);
    const proof = verifyMobileArtifact(d.request, d.app);
    durableWrite(path.join(work, 'verification.json'), proof);
    d.artifactHash = proof.artifactHash; d.phase = 'awaiting-device'; d.updatedAt = stamp();
    durableWrite(target, d); return d;
  } catch (error) {
    if (d?.phase === 'building') { d.phase = 'build-failed'; d.error = error.message; durableWrite(target, d); }
    throw error;
  } finally { unlock(); }
}

/** Mobile failure must not turn a checked desktop into a failed or switched desktop. */
export async function mobileFollowup(file, build = buildMobile) {
  if (read(file).configuration.mobile?.enabled !== true) return {phase:'disabled'};
  try { const d = await build(file); return {phase:d.phase, report:reportPath(file)}; }
  catch (error) { return {phase:'build-failed', error:error.message, report:reportPath(file)}; }
}

function payload(receipt) {
  if (receipt?.content) receipt = JSON.parse(receipt.content.find(c => c.type === 'text').text);
  check(receipt?.ok !== false, receipt?.error?.message || 'Device plugin failed');
  const result = receipt.result || receipt;
  check(result.ok !== false, result.error?.message || 'Device operation failed');
  return result;
}

/** Pure delivery decisions. No phone launch, uninstall, downgrade, or automatic retry of an uncertain install. */
export function mobileReceipt(d, action, receipt) {
  const result = payload(receipt), next = structuredClone(d), m = d.identity;
  if (action === 'devices') {
    check(d.phase === 'awaiting-device', 'Unexpected device receipt');
    const device = result.devices?.find(v => v.udid === m.deviceId);
    next.phase = device?.isAvailable && device.kind === 'physical' && device.platform === 'ios' ? 'inspect-installed' : 'awaiting-device';
  } else {
    check(result.udid === m.deviceId && result.bundleId === m.bundleId, 'Receipt belongs to another device or app');
    if (action === 'install') {
      check(d.phase === 'installing', 'No installation was requested');
      check(result.installed === true && result.state === 'done' && result.execution === 'executed', 'Installation outcome unknown; read app info before any retry');
      next.installConfirmed = true;
    } else if (action === 'info') {
      check(['inspect-installed','installing'].includes(d.phase), 'Unexpected installed app receipt');
      const info = result.app;
      if (result.installed === false) {
        next.phase = d.phase === 'installing' ? 'installation-unconfirmed' : 'ready-to-install';
      } else {
        check(result.installed === true && info?.bundleIdentifier === m.bundleId && /^\d+$/.test(info.bundleVersion), 'Installed metadata is incomplete');
        const installed = BigInt(info.bundleVersion), wanted = BigInt(d.build);
        next.installedBuild = info.bundleVersion;
        next.phase = installed === wanted ? 'installed-metadata-verified' : installed > wanted ? 'superseded' :
          d.phase === 'installing' ? 'installation-unconfirmed' : 'ready-to-install';
        next.fullByteMatchVerified = false;
      }
    } else throw Error('Unknown mobile receipt action');
  }
  next.updatedAt = stamp(); return next;
}

export function mobileNext(d) {
  const base = {ghost_id:'cindy-simulator'}, args = {udid:d.identity.deviceId, bundleId:d.identity.bundleId};
  if (d.phase === 'awaiting-device') return {...base, tool:'devices', args:{}};
  if (['inspect-installed','installing'].includes(d.phase)) return {...base, tool:'app', args:{action:'info', ...args}};
  if (d.phase === 'ready-to-install') return {...base, tool:'app', args:{action:'install', udid:d.identity.deviceId, appPath:d.app, wait:60}};
  return null;
}

export async function mobileCommand(command, options) {
  check(options.report, '--report is required');
  if (command === 'mobile-build') return console.log(JSON.stringify(await buildMobile(options.report)));
  const target = reportPath(options.report), unlock = acquire(target + '.lock');
  try {
    let d = read(target);
    if (command === 'mobile-record') {
      check(options.receipt && options.action, '--receipt and --action are required');
      d = mobileReceipt(d, options.action, read(options.receipt));
      durableWrite(target, d);
    } else if (command === 'mobile-next') {
      const source = verifyReport(options.report); verifyUpgradeSnapshot(source.configuration, source);
      check(d.commit === source.app.target && d.snapshot === source.upgradeSnapshot.capturedAt, 'Mobile source changed');
      const next = mobileNext(d);
      if (d.phase === 'ready-to-install') {
        const proof = verifyMobileArtifact(d.request, d.app);
        check(proof.artifactHash === d.artifactHash, 'Mobile artifact changed after verification');
        // Persist intent before the plugin call. After interruption only query metadata, never blindly reinstall.
        d.phase = 'installing'; d.requestedAt = stamp(); durableWrite(target, d);
      }
      return console.log(JSON.stringify({phase:d.phase, next}));
    } else check(command === 'mobile-status', 'Unknown mobile command');
    console.log(JSON.stringify(d));
  } finally { unlock(); }
}
