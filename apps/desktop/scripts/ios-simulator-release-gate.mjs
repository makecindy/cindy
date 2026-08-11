#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SAFE_ENV_KEYS = [
  'DEVELOPER_DIR',
  'HOME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'PATH',
  'SHELL',
  'TMPDIR',
];

export function parseIOSSimulatorReleaseGateCli(argv) {
  const values = {};
  let requireNative = false;
  for (const argument of argv) {
    if (argument === '--require-native') {
      requireNative = true;
      continue;
    }
    const match = argument.match(/^--([^=]+)=(.*)$/);
    if (match) values[match[1]] = match[2];
  }
  const appPath = values['app-path'] ? path.resolve(values['app-path']) : null;
  const arch = values.arch ?? process.arch;
  const expectedTrust = values['expected-trust'];
  if (
    !appPath ||
    (arch !== 'arm64' && arch !== 'x64') ||
    (expectedTrust !== 'verified' && expectedTrust !== 'untrusted')
  ) {
    throw new Error(
      'Usage: ios-simulator-release-gate.mjs --app-path=<App.app> ' +
        '--arch=arm64|x64 --expected-trust=verified|untrusted [--require-native]',
    );
  }
  if (requireNative && expectedTrust !== 'verified') {
    throw new Error('--require-native requires --expected-trust=verified');
  }
  return { appPath, arch, expectedTrust, requireNative };
}

export function extractReleaseGateReport(stdout, stderr) {
  for (const output of [stdout, stderr]) {
    const lines = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index];
      if (!line.startsWith('{') || !line.endsWith('}')) continue;
      try {
        return JSON.parse(line);
      } catch {
        // Continue looking for an earlier structured result.
      }
    }
  }
  return null;
}

export function validateReleaseGateReport(report, options) {
  if (
    !report ||
    report.schemaVersion !== 1 ||
    report.ok !== true ||
    report.mode !== (options.requireNative ? 'native' : 'static') ||
    report.artifact?.trust !== options.expectedTrust ||
    report.artifact?.architecture !== (options.arch === 'x64' ? 'x86_64' : 'arm64') ||
    report.admission?.fallbackRoute !== 'wda-mjpeg'
  ) {
    throw new Error('Packaged iOS Simulator release gate report is invalid');
  }
  const serialized = JSON.stringify(report);
  for (const forbidden of [
    'designatedRequirement',
    'developerDir',
    'executablePath',
    'simulatorUdid',
    'teamIdentifier',
  ]) {
    if (serialized.includes(forbidden)) {
      throw new Error('Packaged iOS Simulator release gate report leaked private metadata');
    }
  }
  if (options.expectedTrust === 'untrusted') {
    if (
      report.admission.launchAllowed !== false ||
      report.admission.reasonCode !== 'ARTIFACT_UNTRUSTED' ||
      report.native !== null
    ) {
      throw new Error('Untrusted package did not fail closed to WDA/MJPEG');
    }
    return report;
  }
  if (report.compatibility?.sidecar === 'eligible' && report.admission.launchAllowed !== true) {
    throw new Error('Promoted verified package was not admitted');
  }
  if (report.compatibility?.sidecar !== 'eligible' && report.admission.launchAllowed !== false) {
    throw new Error('Unpromoted package did not stay on WDA/MJPEG');
  }
  if (options.requireNative) {
    if (
      report.admission.launchAllowed !== true ||
      report.native?.h264Frames !== 3 ||
      report.native?.keyFrames < 1 ||
      report.native?.singleTouchAccepted !== true ||
      report.native?.multiTouchAccepted !== true ||
      report.native?.cleanRestartReady !== true
    ) {
      throw new Error('Packaged native H.264/HID smoke was incomplete');
    }
  } else if (report.native !== null) {
    throw new Error('Static release gate unexpectedly executed native input');
  }
  return report;
}

function releaseGateEnvironment() {
  const environment = {};
  for (const key of SAFE_ENV_KEYS) {
    const value = process.env[key];
    if (typeof value === 'string' && value) environment[key] = value;
  }
  return environment;
}

export function runIOSSimulatorReleaseGateCli(options) {
  if (process.platform !== 'darwin') {
    throw new Error('Packaged iOS Simulator release gate requires macOS');
  }
  const appName = path.basename(options.appPath, '.app');
  const executablePath = path.join(options.appPath, 'Contents', 'MacOS', appName);
  if (!fs.existsSync(executablePath)) {
    throw new Error('Packaged application executable is unavailable');
  }
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-ios-release-gate-'));
  try {
    const result = spawnSync(
      executablePath,
      [
        `--ios-simulator-release-gate=${options.requireNative ? 'native' : 'static'}`,
        `--user-data-dir=${userDataPath}`,
      ],
      {
        encoding: 'utf8',
        env: releaseGateEnvironment(),
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: options.requireNative ? 5 * 60_000 : 60_000,
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    if (result.error || result.signal || result.status !== 0) {
      throw new Error('Packaged iOS Simulator release gate process failed');
    }
    const report = extractReleaseGateReport(result.stdout ?? '', result.stderr ?? '');
    return validateReleaseGateReport(report, options);
  } finally {
    fs.rmSync(userDataPath, { recursive: true, force: true });
  }
}

async function main() {
  try {
    const options = parseIOSSimulatorReleaseGateCli(process.argv.slice(2));
    const report = runIOSSimulatorReleaseGateCli(options);
    process.stdout.write(
      `[ios-simulator-release-gate] trust=${report.artifact.trust} ` +
        `compatibility=${report.compatibility.sidecar} ` +
        `route=${
          report.admission.launchAllowed ? 'native' : report.admission.fallbackRoute
        } native=${report.native ? 'passed' : 'not-run'}\n`,
    );
  } catch (error) {
    process.stderr.write(
      `[ios-simulator-release-gate] failed: ${
        error instanceof Error ? error.message : 'unknown error'
      }\n`,
    );
    process.exitCode = 1;
  }
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? '')) {
  await main();
}
