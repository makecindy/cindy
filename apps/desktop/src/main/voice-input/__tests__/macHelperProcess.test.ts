import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

import {
  assertHelperCommandSucceeded,
  waitForSpawnedProcess,
} from '../macHelperProcess.js';

describe('waitForSpawnedProcess', () => {
  it('rejects when spawn emits error before start', async () => {
    const child = new EventEmitter();
    const pending = waitForSpawnedProcess(child);
    child.emit('error', new Error('ENOENT'));
    await expect(pending).rejects.toThrow('ENOENT');
  });

  it('resolves after spawn and swallows later errors', async () => {
    const child = new EventEmitter();
    const lateError = vi.fn();
    const pending = waitForSpawnedProcess(child, lateError);
    child.emit('spawn');
    await expect(pending).resolves.toBe(child);

    child.emit('error', new Error('EPIPE'));
    expect(lateError).toHaveBeenCalledOnce();
  });
});

describe('assertHelperCommandSucceeded', () => {
  it('throws on an explicit helper failure payload', () => {
    expect(() =>
      assertHelperCommandSucceeded({
        ok: false,
        error: 'Accessibility permission is not granted',
      }),
    ).toThrow('Accessibility permission is not granted');
  });

  it('ignores successful helper payloads', () => {
    expect(() => assertHelperCommandSucceeded({ ok: true })).not.toThrow();
  });
});
