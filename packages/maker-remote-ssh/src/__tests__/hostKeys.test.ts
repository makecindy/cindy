/**
 * Tests for hostKeys — SSH host key TOFU.
 *
 * Why these tests matter:
 *   Before this module, ssh2 was configured with no `hostVerifier`, which
 *   makes it accept ANY host key — a silent MITM hole on every remote
 *   connect. These tests pin the two load-bearing guarantees:
 *     1. the TOFU decision (trust-new / match / mismatch) — the policy that
 *        decides whether a connect is allowed;
 *     2. FileHostKeyStore persistence — first-use is remembered so a later
 *        key swap is actually detected across restarts.
 *   The fingerprint format is checked so it matches `ssh-keygen -lf` output
 *   (SHA256:base64-no-pad), which is what users see when they compare keys.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  FileHostKeyStore,
  decideHostKey,
  hostKeyFingerprint,
  hostKeyId,
} from '../hostKeys.js';

describe('hostKeyFingerprint', () => {
  it('formats as SHA256:<base64-no-padding>', () => {
    const fp = hostKeyFingerprint(Buffer.from('some-host-key-bytes'));
    expect(fp).toMatch(/^SHA256:[A-Za-z0-9+/]+$/);
    expect(fp.endsWith('=')).toBe(false);
  });

  it('is stable for identical keys and differs for different keys', () => {
    const a = hostKeyFingerprint(Buffer.from('key-a'));
    const b = hostKeyFingerprint(Buffer.from('key-a'));
    const c = hostKeyFingerprint(Buffer.from('key-b'));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe('hostKeyId', () => {
  it('keys by hostname:port so identity survives an alias rename', () => {
    expect(hostKeyId('example.com', 22)).toBe('example.com:22');
    expect(hostKeyId('example.com', 2222)).toBe('example.com:2222');
  });
});

describe('decideHostKey', () => {
  it('trusts a host on first use (null stored)', () => {
    expect(decideHostKey(null, 'SHA256:aaa')).toBe('trust-new');
  });

  it('treats empty string as a mismatch, not first use', () => {
    // stored='' means a corrupt/manually-edited entry; fall through to mismatch
    // rather than re-entering trust-new and bypassing TOFU.
    expect(decideHostKey('', 'SHA256:aaa')).toBe('mismatch');
  });

  it('accepts a matching key', () => {
    expect(decideHostKey('SHA256:aaa', 'SHA256:aaa')).toBe('match');
  });

  it('rejects a changed key (possible MITM / re-key)', () => {
    expect(decideHostKey('SHA256:aaa', 'SHA256:bbb')).toBe('mismatch');
  });
});

describe('FileHostKeyStore', () => {
  let scratchDir: string;
  let filePath: string;

  beforeEach(async () => {
    scratchDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hostkeys-test-'));
    filePath = path.join(scratchDir, 'nested', 'known-hosts.json');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(scratchDir, { recursive: true, force: true });
  });

  it('replaces only the reviewed fingerprint and survives reopening', async () => {
    const store = new FileHostKeyStore(filePath);
    await store.set('one:22', 'SHA256:old');
    await store.set('two:22', 'SHA256:other');
    await store.replace('one:22', 'SHA256:old', 'SHA256:new', () => true);
    const reopened = new FileHostKeyStore(filePath);
    expect(await reopened.get('one:22')).toBe('SHA256:new');
    expect(await reopened.get('two:22')).toBe('SHA256:other');
    await expect(store.set('one:22', 'SHA256:unreviewed')).rejects.toThrow();
  });

  it('preserves trust when confirmation expires while the temporary file is written', async () => {
    const store = new FileHostKeyStore(filePath);
    await store.set('one:22', 'SHA256:old');
    await store.set('two:22', 'SHA256:other');
    let current = true;
    const writeFile = fs.writeFile.bind(fs);
    vi.spyOn(fs, 'writeFile').mockImplementationOnce(async (...args) => {
      await writeFile(...args);
      current = false;
    });

    await expect(store.replace('one:22', 'SHA256:old', 'SHA256:new', () => current))
      .rejects.toThrow('Host key details changed');
    expect(await store.get('one:22')).toBe('SHA256:old');
    expect(JSON.parse(await fs.readFile(filePath, 'utf8'))).toEqual({
      'one:22': 'SHA256:old', 'two:22': 'SHA256:other',
    });
    expect(await fs.readdir(path.dirname(filePath))).toEqual(['known-hosts.json']);
    await store.replace('one:22', 'SHA256:old', 'SHA256:reviewed-again', () => true);
    expect(await new FileHostKeyStore(filePath).get('one:22')).toBe('SHA256:reviewed-again');
  });

  it('keeps concurrent reads and first-use writes behind a pending trust replacement', async () => {
    const store = new FileHostKeyStore(filePath);
    await store.set('one:22', 'SHA256:old');
    let releaseWrite!: () => void;
    let writing!: () => void;
    const blocked = new Promise<void>(resolve => { releaseWrite = resolve; });
    const entered = new Promise<void>(resolve => { writing = resolve; });
    const writeFile = fs.writeFile.bind(fs);
    vi.spyOn(fs, 'writeFile').mockImplementationOnce(async (...args) => {
      await writeFile(...args);
      writing();
      await blocked;
    });
    const replacing = store.replace('one:22', 'SHA256:old', 'SHA256:new', () => true);
    await entered;
    const readFile = fs.readFile.bind(fs);
    let releaseRead!: () => void;
    const readBlocked = new Promise<void>(resolve => { releaseRead = resolve; });
    const read = vi.spyOn(fs, 'readFile').mockImplementation(async (...args) => {
      const value = await readFile(...args);
      await readBlocked;
      return value;
    });
    store.reload();
    const concurrentRead = store.get('one:22');
    const firstUse = store.get('two:22').then(value => {
      expect(value).toBeNull();
      return store.set('two:22', 'SHA256:other');
    });
    // Let pending microtasks run while persistence is deliberately suspended.
    await new Promise<void>(resolve => setImmediate(resolve));
    const readsDuringWrite = read.mock.calls.length;
    releaseWrite();
    await replacing;
    releaseRead();
    const observed = await concurrentRead;
    await firstUse;
    expect(await store.get('one:22')).toBe('SHA256:new');
    const reopened = new FileHostKeyStore(filePath);
    expect(await reopened.get('one:22')).toBe('SHA256:new');
    expect(await reopened.get('two:22')).toBe('SHA256:other');
    expect(readsDuringWrite).toBe(0);
    expect(observed).toBe('SHA256:new');
  });

  it('rejects stale confirmations, removed entries, and concurrent replacements', async () => {
    const store = new FileHostKeyStore(filePath);
    await store.set('one:22', 'SHA256:old');
    await expect(store.replace('one:22', 'SHA256:old', 'SHA256:new', () => false)).rejects.toThrow();
    expect(await store.get('one:22')).toBe('SHA256:old');
    await expect(store.replace('missing:22', 'SHA256:old', 'SHA256:new', () => true)).rejects.toThrow();
    const results = await Promise.allSettled([
      store.replace('one:22', 'SHA256:old', 'SHA256:new', () => true),
      store.replace('one:22', 'SHA256:old', 'SHA256:other', () => true),
    ]);
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
    expect(await store.get('one:22')).toBe('SHA256:new');
  });

  it('rereads manual repairs and retains old trust when replacement cannot be saved', async () => {
    const store = new FileHostKeyStore(filePath);
    await store.set('one:22', 'SHA256:old');
    await fs.writeFile(filePath, JSON.stringify({ 'one:22': 'SHA256:manual' }));
    await expect(store.replace('one:22', 'SHA256:old', 'SHA256:new', () => true)).rejects.toThrow();
    expect(await store.get('one:22')).toBe('SHA256:manual');
    const blocker = `${filePath}.${process.pid}.tmp`;
    await fs.mkdir(blocker);
    await expect(store.replace('one:22', 'SHA256:manual', 'SHA256:new', () => true)).rejects.toThrow();
    expect(await store.get('one:22')).toBe('SHA256:manual');
    expect(await new FileHostKeyStore(filePath).get('one:22')).toBe('SHA256:manual');
  });

  it('returns null for an unknown host', async () => {
    const store = new FileHostKeyStore(filePath);
    expect(await store.get('example.com:22')).toBeNull();
  });

  it('persists a fingerprint and reads it back from a fresh instance', async () => {
    const store = new FileHostKeyStore(filePath);
    await store.set('example.com:22', 'SHA256:aaa');
    expect(await store.get('example.com:22')).toBe('SHA256:aaa');

    // A new instance reads the file from disk, proving persistence (so a
    // key swap is caught across app restarts, not just within one session).
    const reopened = new FileHostKeyStore(filePath);
    expect(await reopened.get('example.com:22')).toBe('SHA256:aaa');
  });

  it('creates the file 0600 and mkdir -p the parent', async () => {
    const store = new FileHostKeyStore(filePath);
    await store.set('h:22', 'SHA256:x');
    const stat = await fs.stat(filePath);
    if (process.platform !== 'win32') {
      expect(stat.mode & 0o777).toBe(0o600);
    }
  });

  it('throws on malformed existing file — fails closed', async () => {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, 'not json at all');
    const store = new FileHostKeyStore(filePath);
    // A corrupt file could be a sign of tampering; propagate rather than
    // silently resetting so callers can refuse the connection.
    await expect(store.get('h:22')).rejects.toThrow();
  });

  it('fails closed when file contains valid JSON that is not an object', async () => {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    for (const value of ['[]', 'null', '"string"', '42']) {
      await fs.writeFile(filePath, value);
      const store = new FileHostKeyStore(filePath);
      // Valid JSON but wrong shape is as dangerous as corrupt data: it discards
      // all trusted keys and re-enters trust-new, bypassing TOFU.
      await expect(store.get('h:22')).rejects.toThrow();
    }
  });

  it('fails closed when a stored entry has a non-string value', async () => {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    // null is the most dangerous: get() returns null via ?? null, re-entering
    // trust-new and accepting a changed key as if it were first use.
    for (const bad of [null, 42, [], {}]) {
      await fs.writeFile(filePath, JSON.stringify({ 'h:22': bad }));
      const store = new FileHostKeyStore(filePath);
      await expect(store.get('h:22')).rejects.toThrow();
    }
  });

  it('rolls back in-memory cache when first-use key cannot be persisted', async () => {
    if (process.platform === 'win32') return; // chmod is a no-op on Windows
    // Make the scratch dir read-only so mkdir/writeFile in persist() fails.
    await fs.chmod(scratchDir, 0o555);
    const store = new FileHostKeyStore(filePath);
    try {
      await expect(store.set('h:22', 'SHA256:aaa')).rejects.toThrow();
      // The rollback must ensure a reconnect in the same process also fails
      // closed rather than matching the unpersisted fingerprint.
      expect(await store.get('h:22')).toBeNull();
    } finally {
      await fs.chmod(scratchDir, 0o755);
    }
  });

  it('concurrent first-use with same fingerprint: both callers succeed', async () => {
    // Duplicate aliases pointing at the same host produce two simultaneous
    // connects that both observe stored===null. When both present the same
    // fingerprint (same real server), both should succeed.
    const store = new FileHostKeyStore(filePath);
    await Promise.all([
      store.set('h:22', 'SHA256:aaa'),
      store.set('h:22', 'SHA256:aaa'),
    ]);
    expect(await store.get('h:22')).toBe('SHA256:aaa');
  });

  it('concurrent first-use with different fingerprints: first wins, second fails closed', async () => {
    // If the two concurrent first-use callers present different fingerprints
    // (e.g. one connection is MITM'd), only the first to acquire the write
    // slot should succeed; the other must fail closed, not silently win on disk.
    const store = new FileHostKeyStore(filePath);
    const results = await Promise.allSettled([
      store.set('h:22', 'SHA256:aaa'),
      store.set('h:22', 'SHA256:bbb'),
    ]);
    const succeeded = results.filter(r => r.status === 'fulfilled');
    const failed = results.filter(r => r.status === 'rejected');
    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);
    const stored = await store.get('h:22');
    expect(['SHA256:aaa', 'SHA256:bbb']).toContain(stored);
  });

  it('reload() picks up external edits to the backing file', async () => {
    // Simulate: user connects (key trusted), then externally removes the entry
    // (e.g. after a legitimate server re-key), then reconnects.
    const store = new FileHostKeyStore(filePath);
    await store.set('h:22', 'SHA256:aaa');
    expect(await store.get('h:22')).toBe('SHA256:aaa');

    // External edit: remove the entry from the file directly.
    await fs.writeFile(filePath, JSON.stringify({}), { mode: 0o600 });

    // Without reload(), the in-memory cache returns the old value.
    expect(await store.get('h:22')).toBe('SHA256:aaa');

    // After reload(), the next get() re-reads from disk and sees the deletion.
    store.reload();
    expect(await store.get('h:22')).toBeNull();
  });

  it('reload() after load settles but before persist: second first-use fails closed', async () => {
    // Regression for the post-load/pre-persist window race:
    //   A: reload → load (settles) → set queued but not yet persisted
    //   B: reload (clears settled cache) → load (fresh disk read, new map object) → set queued
    // Bug: A's slot captured the old map reference; B's slot captured a different
    //      new-map reference. The conflict check examines unrelated objects and
    //      both first-use writers succeed — second write overwrites the first on disk.
    // Fix: each slot calls load() internally, so both share the same in-memory map
    //      and the conflict check fires correctly.
    const store = new FileHostKeyStore(filePath);

    // Warm the cache (simulate A's initial reload+connect)
    store.reload();
    await store.get('h:22'); // loadSettled=true

    // Block the write chain so A's set() queues its slot before B interferes
    let unblockChain!: () => void;
    const chainBlocker = new Promise<void>(resolve => {
      unblockChain = resolve;
    });
    (store as unknown as { writeChain: Promise<void> }).writeChain = chainBlocker;

    // A's set: slot queued behind chainBlocker
    const legitSet = store.set('h:22', 'SHA256:legit');

    // B's reload: clears the now-settled cache (loadSettled=true → loadInFlight=false)
    store.reload();

    // B's set: slot queued after A's slot; outer load starts a fresh disk read
    const mitmSet = store.set('h:22', 'SHA256:mitm');

    // Release the chain — let both slots run
    unblockChain();

    const results = await Promise.allSettled([legitSet, mitmSet]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
    const stored = await store.get('h:22');
    expect(['SHA256:legit', 'SHA256:mitm']).toContain(stored);
  });

  it('reload() during in-flight load: concurrent callers share the same map', async () => {
    // Regression: reload() clearing a pending loadPromise gave concurrent
    // verifiers separate map objects, breaking writeChain conflict detection —
    // allowing two different first-use fingerprints to both succeed (MITM risk).
    //
    // Reproduces the sequence: A starts loading → B calls reload() (must NOT
    // clear A's in-flight promise) → both callers share the same map object →
    // writeChain's conflict check correctly lets only one fingerprint win.
    const store = new FileHostKeyStore(filePath);

    const getA = store.get('h:22'); // starts load (loadPromise in-flight)
    store.reload();                  // B's reload — must preserve in-flight promise
    const getB = store.get('h:22'); // with fix: reuses same promise → same map

    expect(await getA).toBeNull();
    expect(await getB).toBeNull();

    const results = await Promise.allSettled([
      store.set('h:22', 'SHA256:legit'),
      store.set('h:22', 'SHA256:mitm'),
    ]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
  });

  it('serializes concurrent writes without losing entries', async () => {
    const store = new FileHostKeyStore(filePath);
    await Promise.all([
      store.set('a:22', 'SHA256:a'),
      store.set('b:22', 'SHA256:b'),
      store.set('c:22', 'SHA256:c'),
    ]);
    const reopened = new FileHostKeyStore(filePath);
    expect(await reopened.get('a:22')).toBe('SHA256:a');
    expect(await reopened.get('b:22')).toBe('SHA256:b');
    expect(await reopened.get('c:22')).toBe('SHA256:c');
  });
});
