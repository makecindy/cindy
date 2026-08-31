import { afterEach, describe, expect, it } from 'vitest';

import { classifyConnectionError } from '../workLouderCodexHostProcess.js';

const originalPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

afterEach(() => {
  setPlatform(originalPlatform);
});

describe('Work Louder connection error classification', () => {
  it('keeps macOS authorization failures on the permission circuit breaker path', () => {
    setPlatform('darwin');

    expect(classifyConnectionError('HID access denied by Input Monitoring')).toBe(
      'permission-required',
    );
    expect(classifyConnectionError('operation not allowed')).toBe('permission-required');
  });

  it('keeps Windows access denied on the bounded connection retry path', () => {
    setPlatform('win32');

    expect(classifyConnectionError('HID access denied')).toBe('connection-failed');
    expect(classifyConnectionError('permission denied while opening HID handle')).toBe(
      'connection-failed',
    );
  });

  it('does not treat permission-looking errors as permanent outside macOS', () => {
    setPlatform('linux');

    expect(classifyConnectionError('not permitted')).toBe('connection-failed');
  });
});
