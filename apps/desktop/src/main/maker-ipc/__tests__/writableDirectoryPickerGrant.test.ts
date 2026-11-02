import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  clearWritableDirectoryPickerGrantsForTesting,
  consumeWritableDirectoryPickerGrants,
  issueWritableDirectoryPickerGrant,
} from '../writableDirectoryPickerGrant.js';

describe('Main-owned writable directory picker grants', () => {
  let fixture: string;

  beforeEach(() => {
    clearWritableDirectoryPickerGrantsForTesting();
    fixture = mkdtempSync(join(tmpdir(), 'cindy-writable-picker-'));
  });

  afterEach(() => {
    clearWritableDirectoryPickerGrantsForTesting();
    rmSync(fixture, { recursive: true, force: true });
  });

  it('requires one matching, session-bound grant for every new root and consumes it once', async () => {
    const output = join(fixture, 'output');
    const second = join(fixture, 'second');
    mkdirSync(output);
    mkdirSync(second);

    await expect(consumeWritableDirectoryPickerGrants({
      scopeId: 'session-a',
      senderId: 7,
      requestedDirs: [output],
      previousDirs: [],
    })).rejects.toThrow(/system picker/i);

    await issueWritableDirectoryPickerGrant({
      scopeId: 'session-a',
      senderId: 7,
      directory: output,
    });
    await expect(consumeWritableDirectoryPickerGrants({
      scopeId: 'session-a',
      senderId: 7,
      requestedDirs: [output, second],
      previousDirs: [],
    })).rejects.toThrow(/system picker/i);
    // All-or-nothing validation keeps the first grant available after the failed batch.
    await expect(consumeWritableDirectoryPickerGrants({
      scopeId: 'session-a',
      senderId: 7,
      requestedDirs: [output],
      previousDirs: [],
    })).resolves.toBeUndefined();
    await expect(consumeWritableDirectoryPickerGrants({
      scopeId: 'session-a',
      senderId: 7,
      requestedDirs: [output],
      previousDirs: [],
    })).rejects.toThrow(/system picker/i);
  });

  it('rejects cross-session and cross-window reuse while allowing pure revoke/retention', async () => {
    const output = join(fixture, 'output');
    mkdirSync(output);
    await issueWritableDirectoryPickerGrant({
      scopeId: 'session-a',
      senderId: 7,
      directory: output,
    });

    await expect(consumeWritableDirectoryPickerGrants({
      scopeId: 'session-b', senderId: 7, requestedDirs: [output], previousDirs: [],
    })).rejects.toThrow(/system picker/i);
    await expect(consumeWritableDirectoryPickerGrants({
      scopeId: 'session-a', senderId: 8, requestedDirs: [output], previousDirs: [],
    })).rejects.toThrow(/system picker/i);
    await expect(consumeWritableDirectoryPickerGrants({
      scopeId: 'session-a', senderId: 8, requestedDirs: [output], previousDirs: [output],
    })).resolves.toBeUndefined();
    await expect(consumeWritableDirectoryPickerGrants({
      scopeId: 'session-a', senderId: 8, requestedDirs: [], previousDirs: [output],
    })).resolves.toBeUndefined();
  });

  it('fails closed when a selected symlink or junction changes its real target', async () => {
    const first = join(fixture, 'first');
    const second = join(fixture, 'second');
    const alias = join(fixture, 'alias');
    mkdirSync(first);
    mkdirSync(second);
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    symlinkSync(first, alias, linkType);
    await issueWritableDirectoryPickerGrant({
      scopeId: 'session-a', senderId: 7, directory: alias,
    });
    rmSync(alias, { recursive: true, force: true });
    symlinkSync(second, alias, linkType);

    await expect(consumeWritableDirectoryPickerGrants({
      scopeId: 'session-a', senderId: 7, requestedDirs: [alias], previousDirs: [],
    })).rejects.toThrow(/changed after it was selected/i);
  });

  // #7395: use the production issue/consume entry with controlled now, no real wait.
  // The existing one-use/target-swap cases did not exercise expiry or its error code.
  // Tier: unit (existing unique temporary filesystem fixture).
  it.each([299_999, 300_000, 300_001])('classifies the five-minute boundary at %dms', async (now) => {
    const output = join(fixture, 'output');
    mkdirSync(output);
    await issueWritableDirectoryPickerGrant({ scopeId: 'draft', senderId: 7, directory: output, now: 0 });
    const request = () => consumeWritableDirectoryPickerGrants({
      scopeId: 'draft', senderId: 7, requestedDirs: [output], previousDirs: [], now,
    });
    if (now < 300_000) await expect(request()).resolves.toBeUndefined();
    else {
      await expect(request()).rejects.toMatchObject({ code: 'WRITABLE_DIRECTORY_AUTHORIZATION_REQUIRED' });
      await expect(request()).rejects.toMatchObject({ code: 'WRITABLE_DIRECTORY_AUTHORIZATION_REQUIRED' });
    }
  });

  it('retains unexpired grants after a mixed batch fails and accepts a fresh picker proof', async () => {
    const first = join(fixture, 'first');
    const second = join(fixture, 'second');
    mkdirSync(first);
    mkdirSync(second);
    await issueWritableDirectoryPickerGrant({ scopeId: 'draft', senderId: 7, directory: first, now: 0 });
    await issueWritableDirectoryPickerGrant({ scopeId: 'draft', senderId: 7, directory: second, now: 200_000 });
    const request = (requestedDirs: string[]) => consumeWritableDirectoryPickerGrants({
      scopeId: 'draft', senderId: 7, requestedDirs, previousDirs: [], now: 300_001,
    });
    await expect(request([first, second])).rejects.toMatchObject({ code: 'WRITABLE_DIRECTORY_AUTHORIZATION_REQUIRED' });
    await expect(request([second])).resolves.toBeUndefined();
    await issueWritableDirectoryPickerGrant({ scopeId: 'draft', senderId: 7, directory: first, now: 300_001 });
    await expect(request([first])).resolves.toBeUndefined();
  });

  it('distinguishes an unavailable directory from missing authorization', async () => {
    const output = join(fixture, 'output');
    mkdirSync(output);
    await issueWritableDirectoryPickerGrant({ scopeId: 'draft', senderId: 7, directory: output });
    rmSync(output, { recursive: true });
    await expect(consumeWritableDirectoryPickerGrants({
      scopeId: 'draft', senderId: 7, requestedDirs: [output], previousDirs: [],
    })).rejects.toMatchObject({ code: 'WRITABLE_DIRECTORY_UNAVAILABLE' });
  });
});
