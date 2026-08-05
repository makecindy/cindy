import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('safe storage Codex restart invariants', () => {
  const source = () => fs.readFileSync(path.resolve(__dirname, '../bootstrap-electron.ts'), 'utf-8');

  it('prepares api_key store before mutating storage and finalizes after', () => {
    const src = source();
    const start = src.indexOf("'safe-storage-store'");
    const end = src.indexOf("'safe-storage-read'", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = src.slice(start, end);

    const prepare = body.indexOf('await prepareApiKeyChangeMaybeRestartCodex(key);');
    const write = body.indexOf('fs.writeFileSync(');
    const finalize = body.indexOf('await finalizeApiKeyChangeMaybeRestartCodex(key);');
    expect(prepare).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(-1);
    expect(finalize).toBeGreaterThan(-1);
    expect(prepare).toBeLessThan(write);
    expect(write).toBeLessThan(finalize);
  });

  it('prepares api_key remove before mutating storage and finalizes after', () => {
    const src = source();
    const start = src.indexOf("'safe-storage-remove'");
    const end = src.indexOf('// ── Auth IPC handlers', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = src.slice(start, end);

    const prepare = body.indexOf('await prepareApiKeyChangeMaybeRestartCodex(key);');
    const unlink = body.indexOf('fs.unlinkSync(filepath);');
    const finalize = body.indexOf('await finalizeApiKeyChangeMaybeRestartCodex(key);');
    expect(prepare).toBeGreaterThan(-1);
    expect(unlink).toBeGreaterThan(-1);
    expect(finalize).toBeGreaterThan(-1);
    expect(prepare).toBeLessThan(unlink);
    expect(unlink).toBeLessThan(finalize);
  });

  it('gates generic store, read, and remove through the Renderer key allowlist', () => {
    const src = source();
    for (const [channel, nextChannel] of [
      ["'safe-storage-store'", "'safe-storage-read'"],
      ["'safe-storage-read'", "'safe-storage-remove'"],
      ["'safe-storage-remove'", '// ── Auth IPC handlers'],
    ] as const) {
      const start = src.indexOf(channel);
      const end = src.indexOf(nextChannel, start + channel.length);
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      expect(src.slice(start, end)).toContain('isValidRendererKey(key)');
    }
  });

  it('keeps safe-storage-read fail-closed and downgrades expected permission denials', () => {
    const src = source();
    const start = src.indexOf("'safe-storage-read'");
    const end = src.indexOf("'safe-storage-remove'", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = src.slice(start, end);
    expect(body).toContain('assertTrustedAppRendererEvent(event);');
    expect(body.indexOf('assertTrustedAppRendererEvent(event);')).toBeLessThan(
      body.indexOf('resolveSafeStorageFilepath(key)'),
    );
    expect(body).toContain("isIpcError(err) && err.code === 'PERMISSION_DENIED'");
    expect(body).toContain("safeStorageReadLog.debug('read denied for untrusted renderer')");
    expect(body).toContain("safeStorageReadLog.error('read failed'");
    expect(body).not.toContain("console.error('[safe-storage-read]', err)");
  });
});
