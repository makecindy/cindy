import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contacts-change-events-test-'));

vi.mock('../../appSessionState.js', () => ({
  ownerScopedUserDataPath: (...parts: string[]) => path.join(tmpDir, ...parts),
}));

const { emitLocalContactsChanged, onLocalContactsChanged, readContactsChangeToken } =
  await import('../contacts-change-events.js');

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('contacts change events', () => {
  it('persists a content-free token for other shared-userData processes', () => {
    const listener = vi.fn();
    const unsubscribe = onLocalContactsChanged(listener);
    expect(readContactsChangeToken()).toBeNull();

    emitLocalContactsChanged();
    const first = readContactsChangeToken();
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(listener).toHaveBeenCalledTimes(1);

    emitLocalContactsChanged();
    expect(readContactsChangeToken()).not.toBe(first);
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });
});
