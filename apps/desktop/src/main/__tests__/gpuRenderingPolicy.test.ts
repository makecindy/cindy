/**
 * gpuRenderingPolicy.test.ts
 * ---------------------------------------------------------------------------
 * Regression (P0-4.5): macOS Electron 42 GPU corruption mitigation — disables
 * SkiaGraphite by default on macOS (preserving existing --disable-features),
 * supports opt-in/env override, tracks repeated GPU crashes in a sliding window,
 * persists crash-loop software-rendering fallback (auto-reset on app upgrade),
 * and degrades vibrancy/transparent window settings cleanly in fallback mode.
 *
 * Production entry: `configureGpuRenderingPolicy`, `createGpuCrashTracker`,
 * `recordGpuCrashLoopFallback`, `resolveVibrancyConfig`, `readGpuFallbackFromArgv`.
 * Tier: unit.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  configureGpuRenderingPolicy,
  createGpuCrashTracker,
  GPU_RENDERING_POLICY_FILE,
  isHardwareAccelerationDisabled,
  readPersistedGpuRenderingPolicy,
  recordGpuCrashLoopFallback,
  resetActiveGpuRenderingPolicyForTest,
} from '../gpuRenderingPolicy.js';
import { resolveVibrancyConfig } from '../vibrancyConfig.js';
import {
  createGpuFallbackArgument,
  readGpuFallbackFromArgv,
} from '../../shared/windowBackdrop.js';

function createFakeCommandLine(initial: Record<string, string> = {}) {
  const switches = new Map<string, string>(Object.entries(initial));
  const appendSwitch = vi.fn((name: string, value = '') => {
    switches.set(name, value);
  });
  return {
    switches,
    appendSwitch,
    commandLine: {
      hasSwitch: (name: string) => switches.has(name),
      getSwitchValue: (name: string) => switches.get(name) ?? '',
      appendSwitch,
    },
  };
}

const tempDirs: string[] = [];
function mkTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-gpu-policy-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  resetActiveGpuRenderingPolicyForTest();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('gpuRenderingPolicy', () => {
  it('disables SkiaGraphite on macOS by default and merges with existing disable-features', () => {
    const { switches, commandLine } = createFakeCommandLine({
      'disable-features': 'FooFeature',
    });
    const disableHa = vi.fn();

    const result = configureGpuRenderingPolicy({
      platform: 'darwin',
      env: {},
      commandLine,
      disableHardwareAcceleration: disableHa,
      userDataDir: mkTempDir(),
      appVersion: '1.2.3',
    });

    expect(result).toEqual({
      hardwareAccelerationDisabled: false,
      fallbackReason: null,
      skiaGraphiteDisabled: true,
    });
    expect(disableHa).not.toHaveBeenCalled();
    expect(switches.get('disable-features')).toBe('FooFeature,SkiaGraphite');
  });

  it('allows opting back into SkiaGraphite via XDT_ENABLE_SKIA_GRAPHITE=1 and skips non-darwin', () => {
    const darwinOptIn = createFakeCommandLine();
    expect(
      configureGpuRenderingPolicy({
        platform: 'darwin',
        env: { XDT_ENABLE_SKIA_GRAPHITE: '1' },
        commandLine: darwinOptIn.commandLine,
        disableHardwareAcceleration: vi.fn(),
      }).skiaGraphiteDisabled,
    ).toBe(false);
    expect(darwinOptIn.appendSwitch).not.toHaveBeenCalled();

    const win = createFakeCommandLine();
    expect(
      configureGpuRenderingPolicy({
        platform: 'win32',
        env: {},
        commandLine: win.commandLine,
        disableHardwareAcceleration: vi.fn(),
      }).skiaGraphiteDisabled,
    ).toBe(false);
  });

  it('honors XDT_DISABLE_HARDWARE_ACCELERATION=1 and persists crash-loop fallback scoped to appVersion', () => {
    const dir = mkTempDir();
    const disableHaEnv = vi.fn();
    const envRes = configureGpuRenderingPolicy({
      platform: 'darwin',
      env: { XDT_DISABLE_HARDWARE_ACCELERATION: '1' },
      commandLine: createFakeCommandLine().commandLine,
      disableHardwareAcceleration: disableHaEnv,
      userDataDir: dir,
      appVersion: '1.0.0',
    });
    expect(envRes.hardwareAccelerationDisabled).toBe(true);
    expect(envRes.fallbackReason).toBe('env');
    expect(disableHaEnv).toHaveBeenCalledTimes(1);
    expect(isHardwareAccelerationDisabled()).toBe(true);

    // Persisted crash-loop fallback applies on the same version, respects env=0 override,
    // and auto-resets on a newer appVersion.
    expect(
      recordGpuCrashLoopFallback({ userDataDir: dir, appVersion: '1.0.0', crashCount: 3 }),
    ).toBe(true);
    expect(readPersistedGpuRenderingPolicy(dir)).toMatchObject({
      disableHardwareAcceleration: true,
      reason: 'gpu-crash-loop',
      appVersion: '1.0.0',
      crashCount: 3,
    });

    const disableSameVer = vi.fn();
    expect(
      configureGpuRenderingPolicy({
        platform: 'darwin',
        env: {},
        commandLine: createFakeCommandLine().commandLine,
        disableHardwareAcceleration: disableSameVer,
        userDataDir: dir,
        appVersion: '1.0.0',
      }),
    ).toMatchObject({ hardwareAccelerationDisabled: true, fallbackReason: 'gpu-crash-loop' });
    expect(disableSameVer).toHaveBeenCalledTimes(1);

    const disableBypassed = vi.fn();
    expect(
      configureGpuRenderingPolicy({
        platform: 'darwin',
        env: { XDT_DISABLE_HARDWARE_ACCELERATION: '0' },
        commandLine: createFakeCommandLine().commandLine,
        disableHardwareAcceleration: disableBypassed,
        userDataDir: dir,
        appVersion: '1.0.0',
      }),
    ).toMatchObject({ hardwareAccelerationDisabled: false, fallbackReason: null });
    expect(disableBypassed).not.toHaveBeenCalled();

    const disableUpgraded = vi.fn();
    expect(
      configureGpuRenderingPolicy({
        platform: 'darwin',
        env: {},
        commandLine: createFakeCommandLine().commandLine,
        disableHardwareAcceleration: disableUpgraded,
        userDataDir: dir,
        appVersion: '1.0.1',
      }),
    ).toMatchObject({ hardwareAccelerationDisabled: false, fallbackReason: null, skiaGraphiteDisabled: true });
    expect(disableUpgraded).not.toHaveBeenCalled();
  });

  it('preserves explicit user override across upgrades and refuses crash-loop overwrite', () => {
    const dir = mkTempDir();
    fs.writeFileSync(
      path.join(dir, GPU_RENDERING_POLICY_FILE),
      JSON.stringify({
        version: 1,
        disableHardwareAcceleration: true,
        reason: 'user',
        updatedAt: '2026-06-01T00:00:00.000Z',
      }),
      'utf8',
    );
    expect(
      recordGpuCrashLoopFallback({ userDataDir: dir, appVersion: '2.0.0', crashCount: 4 }),
    ).toBe(false);
    const disableHa = vi.fn();
    expect(
      configureGpuRenderingPolicy({
        platform: 'darwin',
        env: {},
        commandLine: createFakeCommandLine().commandLine,
        disableHardwareAcceleration: disableHa,
        userDataDir: dir,
        appVersion: '2.0.0',
      }),
    ).toMatchObject({ hardwareAccelerationDisabled: true, fallbackReason: 'user' });
    expect(disableHa).toHaveBeenCalledTimes(1);
  });

  it('tracks GPU crashes in a sliding window and trips once at threshold', () => {
    const tracker = createGpuCrashTracker({ threshold: 3, windowMs: 60_000 });
    expect(tracker.record(1_000)).toEqual({ crashCount: 1, thresholdReached: false });
    expect(tracker.record(10_000)).toEqual({ crashCount: 2, thresholdReached: false });
    // After > 60s from the first crash, the first timestamp expires.
    expect(tracker.record(65_000)).toEqual({ crashCount: 2, thresholdReached: false });
    expect(tracker.record(69_000)).toEqual({ crashCount: 3, thresholdReached: true });
    expect(tracker.isTripped()).toBe(true);
    // Subsequent crashes do not re-trigger thresholdReached.
    expect(tracker.record(69_500)).toEqual({ crashCount: 4, thresholdReached: false });
  });

  it('degrades vibrancy config to opaque surfaces and encodes argv fallback flag', () => {
    expect(
      resolveVibrancyConfig('cindy', true, 'darwin', { gpuFallback: true, desktopBlur: 12 }),
    ).toEqual({
      vibrancy: null,
      backgroundColor: '#1f1f1e',
    });
    expect(
      resolveVibrancyConfig('cindy', false, 'win32', { gpuFallback: true }),
    ).toEqual({
      vibrancy: null,
      backgroundColor: '#f8f8f6',
      backgroundMaterial: 'none',
    });
    expect(readGpuFallbackFromArgv(['--foo', createGpuFallbackArgument()])).toBe(true);
    expect(readGpuFallbackFromArgv(['--foo'])).toBe(false);
  });
});
