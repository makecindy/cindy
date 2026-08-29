import { describe, expect, it } from 'vitest';
import type { BrowserControlResult } from '@cindy/browser-control-runtime';

import { assertManagedBrowserStopped, managedConfigPatchBeforeStop } from '../runtime-stop.js';
import { RealProfileError } from '../types.js';

function result(action: 'status' | 'stop', ok: boolean, data?: unknown): BrowserControlResult {
  return { ok, action, data };
}

describe('managedConfigPatchBeforeStop', () => {
  it('never rebuilds config before stop, even when a relocated CDP port was remembered', () => {
    expect(managedConfigPatchBeforeStop({ rememberedCdpPort: 18801 })).toBeNull();
    expect(managedConfigPatchBeforeStop({ rememberedCdpPort: null })).toBeNull();
  });
});

describe('assertManagedBrowserStopped', () => {
  it('allows the switch when status says the browser is not running', () => {
    expect(() =>
      assertManagedBrowserStopped({
        status: result('status', true, { running: false }),
        stop: null,
      }),
    ).not.toThrow();
  });

  it('allows the switch after a successful stop', () => {
    expect(() =>
      assertManagedBrowserStopped({
        status: result('status', true, { running: true }),
        stop: result('stop', true, { stopped: true }),
      }),
    ).not.toThrow();
  });

  it('fails closed when status cannot be verified', () => {
    try {
      assertManagedBrowserStopped({
        status: result('status', false),
        stop: null,
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(RealProfileError);
      expect(err).toMatchObject({ code: 'STOP_FAILED' });
    }
  });

  it('fails closed when stop returns ok:false or is missing', () => {
    try {
      assertManagedBrowserStopped({
        status: result('status', true, { running: true }),
        stop: result('stop', false),
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(RealProfileError);
      expect(err).toMatchObject({ code: 'STOP_FAILED' });
    }

    expect(() =>
      assertManagedBrowserStopped({
        status: result('status', true, { running: true }),
        stop: null,
      }),
    ).toThrow(RealProfileError);
  });

  it('fails closed when stop is ok but did not actually stop the process', () => {
    try {
      assertManagedBrowserStopped({
        status: result('status', true, { running: true }),
        stop: result('stop', true, { stopped: false }),
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(RealProfileError);
      expect(err).toMatchObject({ code: 'STOP_FAILED' });
    }

    expect(() =>
      assertManagedBrowserStopped({
        status: result('status', true, { running: true }),
        stop: result('stop', true, {}),
      }),
    ).toThrow(RealProfileError);
  });
});
