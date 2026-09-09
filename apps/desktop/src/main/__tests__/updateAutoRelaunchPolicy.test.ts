import { describe, expect, it } from 'vitest';

import {
  AUTO_UPDATE_BUSY_QUIET_PERIOD_MS,
  AUTO_UPDATE_IDLE_THRESHOLD_SECONDS,
  getAutoRelaunchBlockReason,
  type AutoRelaunchReadinessInput,
} from '../updateAutoRelaunchPolicy';

const BASE: AutoRelaunchReadinessInput = {
  enabled: true,
  isDev: false,
  status: 'ready',
  isRelaunching: false,
  hasBusyTasks: false,
  idleTimeSeconds: AUTO_UPDATE_IDLE_THRESHOLD_SECONDS,
  idleState: 'idle',
  nowMs: 120_000,
  lastBusyAtMs: null,
  lastResumeAtMs: null,
};

function check(patch: Partial<AutoRelaunchReadinessInput> = {}) {
  return getAutoRelaunchBlockReason({ ...BASE, ...patch });
}

describe('update auto relaunch policy', () => {
  it('allows relaunch only when enabled, ready, idle, and not busy', () => {
    expect(check()).toBeNull();
  });

  it('blocks when the user has not enabled auto relaunch', () => {
    expect(check({ enabled: false })).toBe('disabled');
  });

  it('blocks when the update is not ready yet', () => {
    expect(check({ status: 'downloading' })).toBe('not-ready');
  });

  it('blocks while any task is busy', () => {
    expect(check({ hasBusyTasks: true })).toBe('busy');
  });

  it('blocks briefly after busy tasks clear so terminal cleanup can drain', () => {
    expect(check({ lastBusyAtMs: BASE.nowMs - 1_000 })).toBe('recent-busy');
    expect(check({ lastBusyAtMs: BASE.nowMs - AUTO_UPDATE_BUSY_QUIET_PERIOD_MS })).toBeNull();
  });

  it('blocks until the system has been idle for the full threshold', () => {
    expect(check({ idleTimeSeconds: AUTO_UPDATE_IDLE_THRESHOLD_SECONDS - 1 })).toBe('user-active');
    expect(check({ idleState: 'active' })).toBe('user-active');
  });

  it('allows locked-idle unattended relaunch after the idle threshold', () => {
    expect(check({ idleState: 'locked' })).toBeNull();
  });

  it('fails closed when the system idle state cannot be read', () => {
    expect(check({ idleState: 'unknown' })).toBe('screen-state-unknown');
  });

  it('blocks for a short cooldown after resume or unlock', () => {
    expect(check({ lastResumeAtMs: BASE.nowMs - 1_000 })).toBe('recent-resume');
  });

  it('blocks unattended relaunch when apply needs interactive auth', () => {
    expect(check({ requiresInteractiveAuth: true })).toBe('interactive-auth');
  });
});
