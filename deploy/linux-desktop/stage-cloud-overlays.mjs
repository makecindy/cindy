// Applies the cloud runtime overlays to the exported client source before packaging.
// Maintenance comes last: it reads the activity that the activity overlay collects.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { transformCloudSource, cloudSettingsGuidancePlugin, targets as guidanceTargets } from './runtime-guidance/overlay.mjs';
import { transformCloudWindowSource, targets as windowTargets } from './runtime-window-controls/overlay.mjs';
import { transformCloudActivitySource, targets as activityTargets } from './runtime-activity/overlay.mjs';
import { transformMaintenanceSource, cloudMaintenancePlugin, targets as maintenanceTargets } from './runtime-maintenance/overlay.mjs';
import { transformCloudIdentitySource, targets as identityTargets } from './runtime-identity/overlay.mjs';
import { transformCloudUpdateSource, targets as updateTargets } from './runtime-updates/overlay.mjs';
import { cloudAppVersion } from './build-version.mjs';
import { assertImportOrderKept } from './overlay-imports.mjs';

const root = path.resolve(process.argv[2] || '/workspace/source'), recipe = path.resolve(process.argv[3] || '/workspace/recipe'), records = [];
// Written by build-image.py: the exported source has no Git metadata.
const commit = fs.readFileSync(recipe + '/source-commit', 'utf8').trim();
if (!/^[a-f0-9]{40}$/.test(commit)) throw Error('invalid source commit');
const APP_VERSION = cloudAppVersion(process.env.APP_VERSION, process.env.CINDY_UPSTREAM_VERSION);
const sha = (s) => createHash('sha256').update(s).digest('hex');

const guidance = cloudSettingsGuidancePlugin({ sourceRoot: root });
fs.writeFileSync(recipe + '/guidance-runtime.mjs', guidance.load(guidance.resolveId('virtual:cindy-cloud-settings-guidance')));
const maintenance = cloudMaintenancePlugin({ sourceRoot: root, expectedRegion: 'cn' });
maintenance.configResolved({ define: { 'import.meta.env.VITE_CINDY_AUTH_REGION': JSON.stringify(process.env.VITE_CINDY_AUTH_REGION) } });
fs.writeFileSync(recipe + '/maintenance-runtime.mjs', maintenance.load('\0virtual:cindy-cloud-maintenance'));

const virtuals = [
  ['virtual:cindy-cloud-settings-guidance', recipe + '/guidance-runtime.mjs'],
  ['virtual:cindy-cloud-main-window-controls', recipe + '/runtime-window-controls/policy.mjs'],
  ['virtual:cindy-cloud-task-activity', recipe + '/runtime-activity/publisher.mjs'],
  ['virtual:cindy-cloud-maintenance', recipe + '/maintenance-runtime.mjs'],
];
const transforms = [
  ['guidance', guidanceTargets, transformCloudSource],
  ['window', windowTargets, transformCloudWindowSource],
  ['updates', updateTargets, transformCloudUpdateSource],
  ['identity', identityTargets, transformCloudIdentitySource],
  ['activity', activityTargets, transformCloudActivitySource],
  ['maintenance', maintenanceTargets, transformMaintenanceSource],
];
for (const [overlay, targets, transform] of transforms) {
  for (const relative of targets) {
    const file = path.join(root, relative), before = fs.readFileSync(file, 'utf8');
    let after = transform(before, relative);
    if (!after) throw Error(`overlay ${overlay} missing for ${relative}`);
    for (const [id, target] of virtuals) after = after.replaceAll(`'${id}'`, JSON.stringify(target));
    if (after.includes("'virtual:cindy-cloud")) throw Error(`unresolved virtual import in ${relative}`);
    // Upstream modules must load in the same order as in the desktop build.
    assertImportOrderKept(before, after, relative);
    fs.writeFileSync(file, after);
    records.push({ overlay, file: relative, beforeSha256: sha(before), afterSha256: sha(after) });
  }
}

const forge = root + '/apps/desktop/forge.config.ts', forgeBefore = fs.readFileSync(forge, 'utf8');
let forgeAfter = forgeBefore.replace("execSync('git rev-parse HEAD', { cwd: __dirname, encoding: 'utf8' }).trim()", JSON.stringify(commit));
if (forgeAfter === forgeBefore) throw Error('source metadata anchor changed');
for (const [a, b] of [['concurrent: isDev ? false : true,', 'concurrent: false,'], ['packagerConfig: {', "packagerConfig: {\n    electronZipDir: '/workspace',"]]) {
  if (forgeAfter.split(a).length !== 2) throw Error(`forge anchor changed: ${a}`);
  forgeAfter = forgeAfter.replace(a, b);
}
const nativeAnchor = '  await electronRebuild({\n    buildPath,\n    electronVersion,\n    arch,\n    force: true,\n    onlyModules: modules,\n  });';
if (forgeAfter.split(nativeAnchor).length !== 2) throw Error('native rebuild anchor changed');
forgeAfter = forgeAfter.replace(nativeAnchor,
  "  _require('/workspace/recipe/prime-native-cache.cjs').clearMetadata(buildPath);\n  await electronRebuild({\n    buildPath,\n    electronVersion,\n    arch,\n    force: false,\n    useCache: true,\n    cachePath: '/workspace/native-cache/rebuild',\n    onlyModules: modules,\n  });\n  _require('/workspace/recipe/prime-native-cache.cjs').restorePackage(buildPath, electronVersion, arch, platform);");
fs.writeFileSync(forge, forgeAfter);
records.push({ overlay: 'build-metadata-and-memory-budget', file: 'apps/desktop/forge.config.ts', beforeSha256: sha(forgeBefore), afterSha256: sha(forgeAfter) });

const pkg = root + '/apps/desktop/package.json', pkgBefore = fs.readFileSync(pkg, 'utf8'), pkgJson = JSON.parse(pkgBefore);
if (pkgJson.version !== '0.0.0') throw Error('Unexpected package version input');
pkgJson.version = APP_VERSION;
const pkgAfter = JSON.stringify(pkgJson, null, 2) + '\n';
fs.writeFileSync(pkg, pkgAfter);
records.push({ overlay: 'package-version', file: 'apps/desktop/package.json', beforeSha256: sha(pkgBefore), afterSha256: sha(pkgAfter) });

fs.writeFileSync(recipe + '/overlay-application.json', JSON.stringify(records, null, 2));
console.log('Cloud overlays staged:', records.length);
