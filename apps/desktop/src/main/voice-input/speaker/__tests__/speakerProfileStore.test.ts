import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { speakerModelAsset } from '@cindy/voice-input-core';

import {
  SpeakerProfileStorageUnavailableError,
  SpeakerProfileStore,
  type SpeakerProfileCipher,
} from '../speakerProfileStore';

let dir = '';

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-speaker-profile-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Reversible stand-in for safeStorage that is visibly not plaintext. */
function fakeCipher(available = true): SpeakerProfileCipher {
  return {
    isAvailable: () => available,
    encrypt: (plain) => Buffer.from(Buffer.from(plain, 'utf-8').map((byte) => byte ^ 0x5a)),
    decrypt: (cipher) => Buffer.from(cipher.map((byte) => byte ^ 0x5a)).toString('utf-8'),
  };
}

describe('SpeakerProfileStore', () => {
  it('round-trips the voiceprint through the cipher and never writes it in plain text', () => {
    const file = path.join(dir, 'owners', 'a', 'voice-speaker-profile.json');
    const store = new SpeakerProfileStore(() => file, fakeCipher());
    store.write(Float32Array.from([0.25, -0.5, 0.125]), 1_700_000_000_000);

    const raw = fs.readFileSync(file, 'utf-8');
    expect(raw).not.toContain('0.25');
    expect(raw).not.toContain('embedding');

    const fresh = new SpeakerProfileStore(() => file, fakeCipher());
    const profile = fresh.read();
    expect(Array.from(profile?.embedding ?? [])).toEqual([0.25, -0.5, 0.125]);
    expect(profile?.createdAt).toBe(1_700_000_000_000);
  });

  it('keeps each account separate', () => {
    let owner = 'a';
    const store = new SpeakerProfileStore(() => path.join(dir, owner, 'profile.json'), fakeCipher());
    store.write(Float32Array.from([1, 0]));
    owner = 'b';
    expect(store.read()).toBeNull();
  });

  it('reads a voiceprint from another embedding model as not enrolled', () => {
    const file = path.join(dir, 'profile.json');
    const cipher = fakeCipher();
    const payload = { embedding: [1, 0], createdAt: 1, modelSha256: 'f'.repeat(64) };
    fs.writeFileSync(file, JSON.stringify({ version: 1, data: cipher.encrypt(JSON.stringify(payload)).toString('base64') }));
    expect(speakerModelAsset('embedding').sha256).not.toBe('f'.repeat(64));
    expect(new SpeakerProfileStore(() => file, cipher).read()).toBeNull();
  });

  it('treats corrupt or undecryptable files as not enrolled', () => {
    const file = path.join(dir, 'profile.json');
    fs.writeFileSync(file, '{not json');
    expect(new SpeakerProfileStore(() => file, fakeCipher()).read()).toBeNull();

    fs.writeFileSync(file, JSON.stringify({ version: 1, data: 'AAAA' }));
    const throwing: SpeakerProfileCipher = {
      ...fakeCipher(),
      decrypt: () => {
        throw new Error('keychain locked');
      },
    };
    expect(new SpeakerProfileStore(() => file, throwing).read()).toBeNull();
  });

  it('refuses to write without OS encryption and leaves no file behind', () => {
    const file = path.join(dir, 'profile.json');
    const store = new SpeakerProfileStore(() => file, fakeCipher(false));
    expect(() => store.write(Float32Array.from([1]))).toThrow(SpeakerProfileStorageUnavailableError);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('deletes the voiceprint file and its cached copy', () => {
    const file = path.join(dir, 'profile.json');
    const store = new SpeakerProfileStore(() => file, fakeCipher());
    store.write(Float32Array.from([1, 0]));
    expect(store.read()).not.toBeNull();
    store.delete();
    expect(fs.existsSync(file)).toBe(false);
    expect(store.read()).toBeNull();
  });

  it.each(['write', 'rename'] as const)('removes the temporary voiceprint after a failed %s and keeps the committed profile', failure => {
    const file = path.join(dir, 'profile.json');
    const store = new SpeakerProfileStore(() => file, fakeCipher());
    store.write(Float32Array.of(1, 0));
    const previous = fs.readFileSync(file, 'utf8');
    const originalWrite = fs.writeFileSync;
    if (failure === 'write') {
      vi.spyOn(fs, 'writeFileSync').mockImplementationOnce((target, data, options) => {
        originalWrite(target, data, options);
        throw new Error('disk error');
      });
    } else {
      vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw new Error('disk error'); });
    }
    expect(() => store.write(Float32Array.of(0, 1))).toThrow('disk error');
    expect(fs.existsSync(`${file}.${process.pid}.tmp`)).toBe(false);
    expect(fs.readFileSync(file, 'utf8')).toBe(previous);
    expect(Array.from(store.read()!.embedding)).toEqual([1, 0]);
  });

  it('reclaims crashed writers on read without touching live writers or unrelated files', () => {
    const file = path.join(dir, 'profile.json');
    const deadPid = process.pid + 1;
    const old = `${file}.${deadPid}.tmp`;
    const live = `${file}.${process.pid + 2}.tmp`;
    const unrelated = path.join(dir, 'other-profile.json.123.tmp');
    for (const target of [old, live, unrelated, `${file}.notes.tmp`]) fs.writeFileSync(target, 'fixture');
    vi.spyOn(process, 'kill').mockImplementation(pid => {
      if (pid === deadPid) throw Object.assign(new Error('no process'), { code: 'ESRCH' });
      return true;
    });
    expect(new SpeakerProfileStore(() => file, fakeCipher()).read()).toBeNull();
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(live)).toBe(true);
    expect(fs.existsSync(unrelated)).toBe(true);
    expect(fs.existsSync(`${file}.notes.tmp`)).toBe(true);
  });

  it('explicit deletion removes all matching temporary files even without a committed profile', () => {
    const file = path.join(dir, 'profile.json');
    const otherAccount = path.join(dir, 'other-account');
    fs.mkdirSync(otherAccount);
    const otherFile = path.join(otherAccount, 'profile.json.123.tmp');
    fs.writeFileSync(otherFile, 'other account');
    for (const pid of [123, 456, process.pid]) fs.writeFileSync(`${file}.${pid}.tmp`, 'ciphertext fixture');
    new SpeakerProfileStore(() => file, fakeCipher()).delete();
    expect(fs.readdirSync(dir)).toEqual(['other-account']);
    expect(fs.readFileSync(otherFile, 'utf8')).toBe('other account');
  });

  it('attempts every deletion, reports a locked temporary file and allows retry', () => {
    const file = path.join(dir, 'profile.json');
    const store = new SpeakerProfileStore(() => file, fakeCipher());
    store.write(Float32Array.of(1, 0));
    const locked = `${file}.123.tmp`;
    const other = `${file}.456.tmp`;
    fs.writeFileSync(locked, 'ciphertext fixture');
    fs.writeFileSync(other, 'ciphertext fixture');
    const originalRm = fs.rmSync;
    const spy = vi.spyOn(fs, 'rmSync').mockImplementation((target, options) => {
      if (target === locked) throw new Error('file locked');
      originalRm(target, options);
    });
    expect(() => store.delete()).toThrow('Speaker profile cleanup failed');
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(other)).toBe(false);
    expect(fs.existsSync(locked)).toBe(true);
    spy.mockRestore();
    store.delete();
    expect(fs.existsSync(locked)).toBe(false);
    expect(store.read()).toBeNull();
  });
});
