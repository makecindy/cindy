import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { speakerModelAsset, speakerModelLocalName, SpeakerGate } from '@cindy/voice-input-core';

let tempDir = '';
let owner = 'owner-1';
let generation = 1;

vi.mock('@cindy/voice-input-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cindy/voice-input-core')>();
  const assets = [
    { role: 'vad', fileName: 'vad.onnx', sha256: createHash('sha256').update(Buffer.alloc(8)).digest('hex'), bytes: 8 },
    { role: 'embedding', fileName: 'embed.onnx', sha256: createHash('sha256').update(Buffer.alloc(16)).digest('hex'), bytes: 16 },
  ] as const;
  return {
    ...actual,
    SPEAKER_MODEL_ASSETS: assets,
    SPEAKER_MODEL_TOTAL_BYTES: 24,
    speakerModelAsset: (role: string) => assets.find((asset) => asset.role === role),
  };
});

vi.mock('electron', () => ({
  app: { getPath: () => tempDir, once: vi.fn() },
  ipcMain: { handle: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plain: string) => Buffer.from(plain, 'utf-8'),
    decryptString: (cipher: Buffer) => cipher.toString('utf-8'),
  },
}));
vi.mock('../../../logger.js', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));
vi.mock('../../../appSessionState.js', () => ({
  ownerScopedUserDataPath: (...parts: string[]) => path.join(tempDir, 'owners', owner, ...parts),
  activeOwnerScopeKey: () => `${owner}:${generation}`,
  getActiveAppSession: () => ({ dataOwnerId: owner }),
  isAppSessionBoundaryPending: () => false,
}));
vi.mock('../../../clientEndpointsService.js', () => ({
  getClientEndpoint: () => 'https://cdn.example.com',
}));
vi.mock('../../../security/trustedAppRenderer.js', () => ({
  assertTrustedAppRendererEvent: () => {},
  isTrustedAppRendererWindow: () => true,
}));

const { getSpeakerFilterService, parseEnrollmentClips } = await import('../index');
const { SpeakerProfileStore } = await import('../speakerProfileStore');
const { SpeakerEngineHost } = await import('../speakerEngineHost');

beforeEach(() => {
  owner = 'owner-1';
  generation = 1;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-speaker-service-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  getSpeakerFilterService().shutdown();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function installModels(): void {
  const dir = path.join(tempDir, 'voice-models');
  fs.mkdirSync(dir, { recursive: true });
  for (const role of ['vad', 'embedding'] as const) {
    const asset = speakerModelAsset(role);
    fs.writeFileSync(path.join(dir, speakerModelLocalName(asset)), Buffer.alloc(asset.bytes));
  }
}

function enroll(): void {
  new SpeakerProfileStore(() => path.join(tempDir, 'owners', 'owner-1', 'voice-speaker-profile.json'), {
    isAvailable: () => true,
    encrypt: (plain) => Buffer.from(plain, 'utf-8'),
    decrypt: (cipher) => cipher.toString('utf-8'),
  }).write(Float32Array.from([1, 0, 0]));
}

const on = { speakerFilterEnabled: true, speakerFilterStrictness: 'standard' } as const;

describe('speaker filter service', () => {
  it.each(['switch', 'delete'] as const)('discards enrollment after %s while inference is pending', async (action) => {
    installModels();
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(SpeakerEngineHost.prototype, 'createEnrollmentEngine').mockReturnValue({
      extractSpeech: async () => { await waiting; return new Float32Array(48_000); },
      embed: async () => Float32Array.of(1, 0),
    });
    const service = getSpeakerFilterService();
    const pending = service.enroll([new ArrayBuffer(2), new ArrayBuffer(2), new ArrayBuffer(2)]);
    if (action === 'switch') { owner = 'owner-2'; generation += 1; }
    else service.deleteProfile();
    release();
    expect(await pending).toMatchObject({ ok: false });
    expect(service.getStatus().enrolled).toBe(false);
    expect(fs.existsSync(path.join(tempDir, 'owners', owner, 'voice-speaker-profile.json'))).toBe(false);
  });

  it.runIf(getSpeakerFilterService().supported)('builds a gate only when on, downloaded and enrolled', () => {
    const service = getSpeakerFilterService();
    expect(service.createGate(on)).toBeUndefined();

    installModels();
    expect(service.createGate(on)).toBeUndefined();

    enroll();
    expect(service.createGate({ ...on, speakerFilterEnabled: false })).toBeUndefined();
    expect(service.getStatus()).toMatchObject({ supported: true, modelState: 'ready', enrolled: true });
  });

  it.runIf(getSpeakerFilterService().supported)('returns a gate once every condition holds', () => {
    installModels();
    enroll();
    // The worker is started lazily; warming it fails harmlessly in tests.
    expect(getSpeakerFilterService().createGate(on)).toBeInstanceOf(SpeakerGate);
  });

  it.runIf(getSpeakerFilterService().supported)('does not load a same-size corrupt model into the gate', () => {
    installModels();
    enroll();
    const service = getSpeakerFilterService();
    expect(service.getStatus().modelState).toBe('ready');
    const asset = speakerModelAsset('embedding');
    const file = path.join(tempDir, 'voice-models', speakerModelLocalName(asset));
    fs.writeFileSync(file, Buffer.alloc(asset.bytes, 1));
    fs.utimesSync(file, new Date(0), new Date(0));
    const warm = vi.spyOn(SpeakerEngineHost.prototype, 'warm');
    expect(service.getStatus().modelState).toBe('missing');
    expect(service.createGate(on)).toBeUndefined();
    expect(warm).not.toHaveBeenCalled();
  });
});

describe('parseEnrollmentClips', () => {
  const clip = (bytes: number) => new Uint8Array(bytes);

  it('accepts exactly three non-empty PCM16 clips', () => {
    const clips = parseEnrollmentClips({ clips: [clip(320), clip(640), new ArrayBuffer(960)] });
    expect(clips?.map((buffer) => buffer.byteLength)).toEqual([320, 640, 960]);
  });

  it('rejects malformed payloads', () => {
    expect(parseEnrollmentClips(null)).toBeNull();
    expect(parseEnrollmentClips({ clips: [clip(320), clip(320)] })).toBeNull();
    expect(parseEnrollmentClips({ clips: [clip(320), clip(320), 'nope'] })).toBeNull();
    expect(parseEnrollmentClips({ clips: [clip(320), clip(320), clip(0)] })).toBeNull();
    expect(parseEnrollmentClips({ clips: [clip(320), clip(320), clip(321)] })).toBeNull();
    // Longer than the 30-second limit.
    expect(parseEnrollmentClips({ clips: [clip(320), clip(320), clip(30 * 16_000 * 2 + 2)] })).toBeNull();
  });

  it('accepts three full 30-second recordings', () => {
    const clips = [clip(30 * 16_000 * 2), clip(30 * 16_000 * 2), clip(30 * 16_000 * 2)];
    expect(parseEnrollmentClips({ clips })?.map((buffer) => buffer.byteLength))
      .toEqual([960_000, 960_000, 960_000]);
  });
});
