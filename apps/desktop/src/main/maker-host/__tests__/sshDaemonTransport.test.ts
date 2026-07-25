/**
 * Tests for the pure-logic pieces of SshDaemonTransport — the ws handshake
 * math and shell-arg escaping that get exercised before any real SSH I/O.
 *
 * Why these tests matter:
 *   The end-to-end transport is hard to unit-test without a real SSH host
 *   (it bridges a remote codex daemon's unix socket through ssh exec and
 *   speaks raw HTTP-Upgrade-then-ws on top). But two pieces of the boot
 *   path are pure functions whose breakage would silently fail
 *   handshake / escape an attacker-controlled path through the shell:
 *
 *   - computeWsAccept: RFC 6455 §4.2.2 hash. If we ever swap algorithms or
 *     change the GUID, the daemon would reply with a valid 101 and a
 *     mismatched Accept header — we'd reject every connect. RFC ships an
 *     official sample vector; pin against it.
 *   - shellQuote: POSIX single-quote escape used to splice the codex binary
 *     path and the daemon socket path into `bash -c`. A typo would let
 *     paths containing `'` break out of the quoted argument and run
 *     arbitrary commands on the remote. Cover the round-trip explicitly.
 *
 * Also covered: a smoke that ws's internal `Sender`/`Receiver` classes can
 * still be require()'d from `ws/lib/sender` / `ws/lib/receiver` and round-
 * trip a text frame correctly. The transport reaches into ws's internals
 * because the public API only exposes a `WebSocket` class that wants a real
 * server URL. If ws ever moves these files, the transport breaks at runtime
 * with no compile-time signal — this test catches it.
 */

import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';

import {
  WS_GUID,
  computeWsAccept,
  decideCodexDaemonVersionAction,
  isManagedCodexDaemonVersion,
  shellQuote,
} from '../codex-remote-transport';

// ── computeWsAccept ──────────────────────────────────────────────────────────

describe('computeWsAccept', () => {
  it('matches the RFC 6455 §1.3 sample vector', () => {
    // RFC 6455 §1.3:  "the client sends `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==`
    //                  the server replies `Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=`"
    // Any drift in algorithm / GUID / encoding would diverge from this value.
    expect(computeWsAccept('dGhlIHNhbXBsZSBub25jZQ==')).toBe('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
  });

  it('uses the standard WebSocket GUID', () => {
    expect(WS_GUID).toBe('258EAFA5-E914-47DA-95CA-C5AB0DC85B11');
  });

  it('produces deterministic output for the same key', () => {
    const a = computeWsAccept('AAAAAAAAAAAAAAAAAAAAAA==');
    const b = computeWsAccept('AAAAAAAAAAAAAAAAAAAAAA==');
    expect(a).toBe(b);
  });

  it('produces different output for different keys', () => {
    expect(computeWsAccept('AAAAAAAAAAAAAAAAAAAAAA==')).not.toBe(
      computeWsAccept('BBBBBBBBBBBBBBBBBBBBBA=='),
    );
  });
});

describe('isManagedCodexDaemonVersion', () => {
  it('accepts the managed daemon version from camel- or snake-case output', () => {
    expect(isManagedCodexDaemonVersion({ cliVersion: 'codex-cli 0.145.0' })).toBe(true);
    expect(isManagedCodexDaemonVersion({ app_server_version: '0.145.0' })).toBe(true);
  });

  it('rejects stale or unversioned daemon output', () => {
    expect(isManagedCodexDaemonVersion({ cli_version: 'codex-cli 0.144.0' })).toBe(false);
    expect(isManagedCodexDaemonVersion({ socketPath: '/tmp/codex.sock' })).toBe(false);
  });
});

describe('decideCodexDaemonVersionAction', () => {
  it('reuses the managed daemon regardless of auto-start policy', () => {
    expect(decideCodexDaemonVersionAction({ cliVersion: 'codex-cli 0.145.0' }, true))
      .toBe('reuse');
    expect(decideCodexDaemonVersionAction({ cliVersion: 'codex-cli 0.145.0' }, false))
      .toBe('reuse');
  });

  it('restarts a stale daemon only when auto-start is enabled', () => {
    const stale = { cliVersion: 'codex-cli 0.144.0' };

    expect(decideCodexDaemonVersionAction(stale, true)).toBe('restart');
    expect(decideCodexDaemonVersionAction(stale, false)).toBe('reject');
  });
});

// ── shellQuote ──────────────────────────────────────────────────────────────

describe('shellQuote', () => {
  it('wraps a plain string in single quotes', () => {
    expect(shellQuote('codex')).toBe(`'codex'`);
  });

  it('preserves spaces inside the quoted argument', () => {
    expect(shellQuote('path with spaces')).toBe(`'path with spaces'`);
  });

  it('escapes embedded single quotes so the shell sees one logical argument', () => {
    // The classic POSIX trick: end quote, escape literal ', start quote again.
    // Result for `it's` is `'it'\''s'` — four shell tokens that concatenate to `it's`.
    expect(shellQuote(`it's`)).toBe(`'it'\\''s'`);
  });

  it('escapes a path attempting to break out of the quoted command', () => {
    // Attacker-controlled socket path: if shellQuote returned `'foo';rm -rf /;:'`
    // the shell would run `rm -rf /`. Verify the embedded `'` is escaped.
    const malicious = `/tmp/foo';rm -rf /;:'`;
    const escaped = shellQuote(malicious);
    // The escape MUST close + escape + reopen — never produce an unquoted `;`.
    expect(escaped).toBe(`'/tmp/foo'\\'';rm -rf /;:'\\'''`);
    // Sanity: the leading and trailing chars are both `'`, and any literal `'`
    // inside is wrapped by `\\''`.
    expect(escaped.startsWith(`'`) && escaped.endsWith(`'`)).toBe(true);
  });

  it('handles an empty string as an empty quoted argument', () => {
    expect(shellQuote('')).toBe(`''`);
  });
});

// ── ws lib internal Receiver / Sender round-trip ─────────────────────────────

describe('ws/lib internals (round-trip via require)', () => {
  it('can require Sender and Receiver from ws via absolute path and round-trip a text frame', async () => {
    // Match production: ws@8's package.json `exports` field does NOT whitelist
    // `./lib/receiver` etc, so bare-specifier `require('ws/lib/receiver')`
    // throws ERR_PACKAGE_PATH_NOT_EXPORTED. Workaround in SshDaemonTransport:
    // resolve the ws package root via require.resolve('ws') then require by
    // absolute path (which bypasses the exports check). This test mirrors that
    // pattern so a future ws version that ALSO blocks absolute-path subpath
    // resolution (or deletes lib/receiver.js entirely) breaks here loud.
    const wsRequire = createRequire(import.meta.url);
    const wsBase = path.dirname(wsRequire.resolve('ws'));
    const ReceiverCtor = wsRequire(path.join(wsBase, 'lib/receiver.js')) as new (opts: {
      isServer: boolean; binaryType?: string; maxPayload?: number;
    }) => {
      write(chunk: Buffer): boolean;
      on(event: 'message', cb: (data: Buffer | string, isBinary: boolean) => void): unknown;
    };
    const SenderCtor = wsRequire(path.join(wsBase, 'lib/sender.js')) as new (sink: {
      write: (chunk: Buffer, cb?: (err?: Error) => void) => void;
      cork(): void;
      uncork(): void;
    }) => {
      send(
        data: string | Buffer,
        opts: { binary: boolean; fin: boolean; mask: boolean; compress: boolean },
        cb?: (err?: Error) => void,
      ): void;
    };

    // Server-side parser (no mask expected); client-side sender (masks).
    const receiver = new ReceiverCtor({ isServer: true, binaryType: 'nodebuffer' });
    const captured: Buffer[] = [];
    const sender = new SenderCtor({
      // ws Sender calls cork/uncork on the sink for 2-chunk frame batching;
      // satisfy the interface with no-op stubs (mirrors production sink).
      // Must invoke `cb` after write — ws threads the user-supplied
      // sender.send callback through the LAST socket.write call, so dropping
      // cb means the awaiter never resolves.
      write: (chunk: Buffer, cb?: (err?: Error) => void) => {
        captured.push(chunk);
        if (cb) cb();
      },
      cork: () => { /* noop */ },
      uncork: () => { /* noop */ },
    });

    const payload = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    await new Promise<void>((resolve, reject) => {
      sender.send(payload, { binary: false, fin: true, mask: true, compress: false }, (err?: Error) => {
        if (err) reject(err); else resolve();
      });
    });
    expect(captured.length).toBeGreaterThan(0);

    const received: string[] = [];
    receiver.on('message', (data) => {
      received.push(typeof data === 'string' ? data : data.toString('utf8'));
    });
    // Feed the encoded frame back through the receiver — one frame in, one message out.
    for (const chunk of captured) receiver.write(chunk);
    // Receiver fires 'message' synchronously after the last byte of a complete frame.
    expect(received).toEqual([payload]);
  });
});
