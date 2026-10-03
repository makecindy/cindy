import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { configureProject, identity } = require('../../plugins/with-quota-widget.js');
const plist = require('@expo/plist').default;
const xcode = require('xcode');

describe('quota widget native integration', () => {
  it('is discoverable by real Expo Apple autolinking, including its native module', () => {
    const cli = require.resolve('expo-modules-autolinking/bin/expo-modules-autolinking');
    const resolved = JSON.parse(execFileSync(process.execPath, [cli, 'resolve', '--platform', 'apple', '--json'], { encoding: 'utf8' }));
    const module = resolved.modules.find((item: any) => item.packageName === 'cindy-quota-widget');
    expect(module?.modules.map((item: any) => item.class)).toContain('CindyQuotaWidgetModule');
    expect(module?.pods.some((pod: any) => pod.podName === 'CindyQuotaWidget')).toBe(true);
  });
  it.each([
    ['com.xd.cindy', 'cindy'], ['com.xd.cindycn', 'cindycn'], ['org.example.development', 'cindydev'],
  ])('derives an isolated extension and container from resolved identity %s', (bundle, scheme) => {
    expect(identity({ ios: { bundleIdentifier: bundle }, scheme })).toEqual({ bundle: bundle + '.quota-widget', group: 'group.' + bundle + '.quota', scheme });
  });

  it('embeds and builds exactly one extension, preserves the host configuration and is idempotent', () => {
    const directory = mkdtempSync(join(tmpdir(), 'cindy-quota-xcode-test-'));
    try {
      const template = join(dirname(require.resolve('expo/package.json')), 'template.tgz');
      const pbx = join(directory, 'project.pbxproj');
      writeFileSync(pbx, execFileSync('tar', ['-xOf', template, 'package/ios/HelloWorld.xcodeproj/project.pbxproj']));
      const project = xcode.project(pbx); project.parseSync();
      const before = JSON.stringify(project.pbxXCBuildConfigurationSection());
      const config = { ios: { bundleIdentifier: 'org.example.cindy', buildNumber: '123' }, scheme: 'cindy', version: '0.4.0' };
      configureProject(project, directory, config);
      const first = project.writeSync();
      configureProject(project, directory, config);
      expect(project.writeSync()).toBe(first);
      const targetEntries = Object.entries(project.pbxNativeTargetSection()).filter(([, t]: [string, any]) => typeof t === 'object' && t.name === '"CindySubscriptionWidget"');
      expect(targetEntries).toHaveLength(1);
      const [uuid, target] = targetEntries[0] as [string, any];
      const dependencies = project.hash.project.objects.PBXTargetDependency;
      expect(project.getFirstTarget().firstTarget.dependencies.some((ref: any) => dependencies[ref.value].target === uuid)).toBe(true);
      const sourcePhase = project.hash.project.objects.PBXSourcesBuildPhase[target.buildPhases.find((ref: any) => ref.comment === 'Sources').value];
      expect(sourcePhase.files).toHaveLength(3);
      const allSettings = project.pbxXCBuildConfigurationSection();
      for (const [id, value] of Object.entries(JSON.parse(before))) expect(allSettings[id]).toEqual(value);
      const info = plist.parse(readFileSync(join(directory, 'CindySubscriptionWidget/Info.plist'), 'utf8'));
      expect(info).toMatchObject({ CFBundleVersion: '123', CFBundleShortVersionString: '0.4.0', CindyQuotaAppGroup: 'group.org.example.cindy.quota', NSExtension: { NSExtensionPointIdentifier: 'com.apple.widgetkit-extension' } });
      expect(first).not.toContain('PROVISIONING_PROFILE_SPECIFIER');
      const group = Object.values(project.hash.project.objects.PBXGroup).find((g: any) => typeof g === 'object' && g.name === 'CindySubscriptionWidget') as any;
      expect(String(group.path).replace(/"/g, '')).toBe('.');
      const resources = project.hash.project.objects.PBXResourcesBuildPhase[target.buildPhases.find((ref: any) => ref.comment === 'Resources').value];
      expect(resources.files.some((ref: any) => ref.comment.includes('Assets.xcassets'))).toBe(true);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('keeps native palettes and five languages generated from the Mobile sources', () => {
    execFileSync(process.execPath, [resolve('../../scripts/generate-quota-widget-resources.mjs'), '--check'], { encoding: 'utf8' });
  });

  it('separates SVG arc flags for the Android drawable parser', () => {
    const drawable = readFileSync(resolve('modules/cindy-quota-widget/android/src/main/res/drawable/cindy_quota_xai.xml'), 'utf8');
    expect(drawable).toContain('a7.808 7.808 0 0 0 -1.829 -1');
    expect(drawable).toContain('A8.975 8.975 0 0 0 5.984 5.83');
  });

  it('preserves generated resource bytes when Git checks out with Windows autocrlf', () => {
    const directory = mkdtempSync(join(tmpdir(), 'cindy-quota-checkout-test-'));
    try {
      const repository = join(directory, 'repository');
      const checkout = join(directory, 'checkout');
      mkdirSync(repository); mkdirSync(checkout);
      cpSync(resolve('../../.gitattributes'), join(repository, '.gitattributes'));
      const native = 'apps/mobile/modules/cindy-quota-widget';
      const res = `${native}/android/src/main/res`;
      const paths = [`${native}/widget/QuotaWidgetResources.swift`, `${native}/android/src/main/java/expo/modules/cindyquotawidget/QuotaWidgetMetrics.kt`, ...readdirSync(resolve('../..', res), { recursive: true, encoding: 'utf8' })
        .filter(file => file.endsWith('.xml') && readFileSync(resolve('../..', res, file), 'utf8').includes('Generated from Mobile tokens'))
        .map(file => `${res}/${file}`)];
      expect(paths.length).toBeGreaterThan(1);
      for (const path of paths) {
        mkdirSync(dirname(join(repository, path)), { recursive: true });
        cpSync(resolve('../..', path), join(repository, path));
      }
      // A non-generated control must become CRLF, proving this exercises actual Git conversion.
      writeFileSync(join(repository, 'newline-control.txt'), 'control\n');
      const git = (...args: string[]) => execFileSync('git', ['-c', 'core.autocrlf=true', '-C', repository, ...args], { encoding: 'utf8', stdio: 'pipe' });
      git('init', '--quiet');
      git('add', '.');
      git('checkout-index', '--all', `--prefix=${checkout.replaceAll('\\', '/')}/`);
      expect(readFileSync(join(checkout, 'newline-control.txt'), 'utf8')).toBe('control\r\n');
      for (const path of paths) expect(readFileSync(join(checkout, path))).toEqual(readFileSync(resolve('../..', path)));
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it.each(['ios', 'android'])('includes separate WidgetKit source changes in the %s native fingerprint', async platform => {
    const directory = mkdtempSync(join(tmpdir(), 'cindy-quota-fingerprint-test-'));
    try {
      const config = require('../../fingerprint.config.cjs');
      const sources = config.extraSources.filter((source: { filePath: string }) => source.filePath === 'modules/cindy-quota-widget/widget');
      expect(sources).toHaveLength(1);
      cpSync(resolve('modules/cindy-quota-widget/widget'), join(directory, sources[0].filePath), { recursive: true });
      const { normalizeOptionsAsync } = require('@expo/fingerprint/build/Options');
      const { createFingerprintFromSourcesAsync } = require('@expo/fingerprint/build/hash/Hash');
      const options = await normalizeOptionsAsync(directory, { platforms: [platform], silent: true });
      const baseline = await createFingerprintFromSourcesAsync(sources, directory, options);
      appendFileSync(join(directory, sources[0].filePath, 'CindySubscriptionWidget.swift'), '\n// test mutation\n');
      const changed = await createFingerprintFromSourcesAsync(sources, directory, options);
      expect(changed.hash).not.toBe(baseline.hash);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
