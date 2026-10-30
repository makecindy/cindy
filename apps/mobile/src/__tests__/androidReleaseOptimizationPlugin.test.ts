import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { enableDefaultProguardOptimizations } = require('../../plugins/with-android-release-optimization.js') as {
  enableDefaultProguardOptimizations: (source: string) => string;
};

describe('Android release R8 configuration', () => {
  it.each(['cn', 'global', 'dev'])('enables code and resource shrinking for %s', (region) => {
    // Resolve the real dynamic Expo config without inheriting build-machine
    // identity, credentials, or private region configuration from the test runner.
    const output = execFileSync(process.execPath, ['-e', `
      if (process.env.EXPO_PUBLIC_CINDY_AUTH_REGION === 'dev') {
        const fs = require('node:fs');
        const path = require('node:path');
        const readFileSync = fs.readFileSync;
        fs.readFileSync = function(file, ...args) {
          if (String(file) === path.resolve('../../config/endpoint.dev.json')) {
            return JSON.stringify({ schemaVersion: 1, cdnBaseUrl: 'https://example.invalid/cindy' });
          }
          return readFileSync.call(this, file, ...args);
        };
      }
      const config = require('./app.config.js')();
      console.log(JSON.stringify({
        properties: config.plugins.find((item) => Array.isArray(item) && item[0] === 'expo-build-properties')[1],
        optimizerRegistered: config.plugins.includes('./plugins/with-android-release-optimization'),
      }));
    `], {
      cwd: resolve(__dirname, '../..'),
      env: { PATH: process.env.PATH, NODE_ENV: 'test', EXPO_PUBLIC_CINDY_AUTH_REGION: region },
      encoding: 'utf8',
    });
    const config = JSON.parse(output);
    expect(config.properties.android).toEqual({
      enableMinifyInReleaseBuilds: true,
      enableShrinkResourcesInReleaseBuilds: true,
    });
    expect(config.optimizerRegistered).toBe(true);
  });

  it('replaces the non-optimizing defaults in the installed Expo template and survives repeated prebuilds', () => {
    const templatePath = resolve(dirname(require.resolve('expo/package.json')), 'template.tgz');
    const template = execFileSync('tar', ['-xOf', templatePath, 'package/android/app/build.gradle'], { encoding: 'utf8' });
    const optimized = enableDefaultProguardOptimizations(template);
    expect(optimized).toContain('getDefaultProguardFile("proguard-android-optimize.txt")');
    expect(optimized).not.toContain('getDefaultProguardFile("proguard-android.txt")');
    expect(optimized).toContain('minifyEnabled enableMinifyInReleaseBuilds');
    expect(optimized).toContain('"proguard-rules.pro"');
    expect(enableDefaultProguardOptimizations(optimized)).toBe(optimized);
  });

  it('keeps application and SDK rules while replacing a single-quoted default', () => {
    const source = "proguardFiles getDefaultProguardFile('proguard-android.txt'), 'proguard-rules.pro', 'sdk-rules.pro'";
    expect(enableDefaultProguardOptimizations(source)).toBe(
      "proguardFiles getDefaultProguardFile('proguard-android-optimize.txt'), 'proguard-rules.pro', 'sdk-rules.pro'",
    );
  });

  it('stops prebuild when the default rule-file contract changes', () => {
    expect(() => enableDefaultProguardOptimizations("proguardFiles 'custom.pro'")).toThrow(/Expo template/);
  });
});
