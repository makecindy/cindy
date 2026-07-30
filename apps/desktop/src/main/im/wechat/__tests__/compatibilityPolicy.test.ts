import { createPublicKey, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  WECHAT_COMPATIBILITY_MANIFEST_MAX_BYTES,
  WechatCompatibilityPolicyService,
  canonicalizeWechatCompatibilityManifestPayload,
  evaluateWechatCompatibilityManifest,
  parseAndVerifyWechatCompatibilityManifest,
  type WechatCompatibilityManifest,
  type WechatCompatibilityManifestPayload,
} from '../compatibilityPolicy';

const NOW = 2_000_000_000_000;
const MANIFEST_URL = 'https://config.cindy.example/compat/wechat/v1.json';
const HELP_PREFIX = 'https://support.cindy.example/help/wechat/';

let root = '';
let privateKey: KeyObject;
let publicKey: KeyObject;
let publicKeySpkiBase64 = '';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-wechat-policy-'));
  const pair = generateKeyPairSync('ed25519');
  privateKey = pair.privateKey;
  publicKey = pair.publicKey;
  publicKeySpkiBase64 = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('personal WeChat compatibility policy', () => {
  it('matches an independent fixed canonical JSON and Ed25519 signature vector', () => {
    const canonical =
      '{"expiresAt":2000003600000,"generatedAt":1999999940000,"rules":[{"action":"disable","maxVersion":"2.0.0","minVersion":"1.0.0","reason":"protocol_incompatible"}],"schemaVersion":1,"sequence":1}';
    const vectorPublicKey = createPublicKey({
      key: Buffer.from('MCowBQYDK2VwAyEAizSW8guHE66iKKL/AxC/hqHM5iHJKzrOvgXNK1Vke3g=', 'base64'),
      format: 'der',
      type: 'spki',
    });
    const payload = basePayload();
    const signature =
      'ZoIVg5vU5KGrA5/O1aZhp2l0ekES87M76I3FHxYhvyAE4VpO7OVAgmkS+2JE1WcLewICAgtkX2NqqcSi3Z7lDA==';

    expect(canonicalizeWechatCompatibilityManifestPayload(payload)).toBe(canonical);
    expect(
      parseAndVerifyWechatCompatibilityManifest(
        Buffer.from(JSON.stringify({ ...payload, signature })),
        vectorPublicKey,
        [],
        NOW,
      ),
    ).toMatchObject({ sequence: 1, signature });
  });

  it('verifies canonical Ed25519 payloads and matches inclusive semver ranges', () => {
    const bytes = signedManifest({
      rules: [
        {
          minVersion: '1.1.20',
          maxVersion: '1.1.21',
          action: 'disable',
          reason: 'protocol_incompatible',
          helpUrl: `${HELP_PREFIX}protocol`,
        },
      ],
    });

    const manifest = parseAndVerifyWechatCompatibilityManifest(
      bytes,
      publicKey,
      [HELP_PREFIX],
      NOW,
    );
    expect(evaluateWechatCompatibilityManifest(manifest, '1.1.21', NOW)).toEqual({
      disabled: true,
      sequence: 1,
      reasonCode: 'protocol_incompatible',
      helpUrl: `${HELP_PREFIX}protocol`,
    });
    expect(evaluateWechatCompatibilityManifest(manifest, '1.1.22', NOW)).toEqual({
      disabled: false,
      sequence: 1,
    });
  });

  it('rejects tampering, unknown fields, future timestamps, and untrusted help URLs', () => {
    const signed = JSON.parse(Buffer.from(signedManifest()).toString('utf8')) as Record<
      string,
      unknown
    >;
    const tampered = structuredClone(signed) as {
      rules: Array<Record<string, unknown>>;
    };
    tampered.rules[0].reason = 'tampered';
    expect(() =>
      parseAndVerifyWechatCompatibilityManifest(
        Buffer.from(JSON.stringify(tampered)),
        publicKey,
        [HELP_PREFIX],
        NOW,
      ),
    ).toThrow('SIGNATURE_INVALID');

    expect(() =>
      parseAndVerifyWechatCompatibilityManifest(
        Buffer.from(JSON.stringify({ ...signed, endpoint: 'https://evil.invalid' })),
        publicKey,
        [HELP_PREFIX],
        NOW,
      ),
    ).toThrow('UNKNOWN_FIELD');

    expect(() =>
      parseAndVerifyWechatCompatibilityManifest(
        signedManifest({ generatedAt: NOW + 6 * 60 * 1_000, expiresAt: NOW + 60 * 60 * 1_000 }),
        publicKey,
        [HELP_PREFIX],
        NOW,
      ),
    ).toThrow('GENERATED_AT_IN_FUTURE');

    expect(() =>
      parseAndVerifyWechatCompatibilityManifest(
        signedManifest({
          rules: [
            {
              minVersion: '1.0.0',
              maxVersion: '2.0.0',
              action: 'disable',
              reason: 'protocol_incompatible',
              helpUrl: 'https://evil.invalid/help',
            },
          ],
        }),
        publicKey,
        [HELP_PREFIX],
        NOW,
      ),
    ).toThrow('HELP_URL_INVALID');

    expect(() =>
      parseAndVerifyWechatCompatibilityManifest(
        signedManifest({
          rules: [
            {
              minVersion: '1.0.0',
              maxVersion: '2.0.0',
              action: 'disable',
              reason: 'protocol_incompatible',
              helpUrl: 'https://support.cindy.example/help/wechat-evil',
            },
          ],
        }),
        publicKey,
        ['https://support.cindy.example/help/wechat'],
        NOW,
      ),
    ).toThrow('HELP_URL_INVALID');

    expect(() =>
      parseAndVerifyWechatCompatibilityManifest(
        signedManifest({
          rules: [
            {
              minVersion: '1.0.0',
              maxVersion: '2.0.0',
              action: 'disable',
              reason: 'protocol_incompatible',
              helpUrl: 'https://support.cindy.example/help/wechat/%2fadmin',
            },
          ],
        }),
        publicKey,
        [HELP_PREFIX],
        NOW,
      ),
    ).toThrow('HELP_URL_INVALID');

    const rsaPublicKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey;
    expect(() =>
      parseAndVerifyWechatCompatibilityManifest(signedManifest(), rsaPublicKey, [HELP_PREFIX], NOW),
    ).toThrow('PUBLIC_KEY_INVALID');
  });

  it('keeps the last verified decision when a network response attempts sequence rollback', async () => {
    const cachePath = path.join(root, 'policy.json');
    const sequenceTwo = signedManifest({ sequence: 2 });
    const first = service({
      cachePath,
      fetch: vi.fn(async () => response(sequenceTwo, { type: 'Application/JSON; Charset=UTF-8' })),
    });
    await first.refresh();
    expect(first.getDecision()).toMatchObject({ disabled: true, sequence: 2 });
    expect(fs.readFileSync(cachePath)).toEqual(sequenceTwo);

    const sequenceOne = signedManifest({ sequence: 1 });
    const rollback = service({
      cachePath,
      fetch: vi.fn(async () => response(sequenceOne)),
    });
    await rollback.refresh();
    expect(rollback.getDecision()).toMatchObject({ disabled: true, sequence: 2 });
    expect(fs.readFileSync(cachePath)).toEqual(sequenceTwo);
  });

  it('applies a verified remote decision even when its cache cannot be persisted', async () => {
    const cacheParent = path.join(root, 'cache-parent');
    const cachePath = path.join(cacheParent, 'policy.json');
    fs.writeFileSync(cacheParent, 'not a directory');
    const policy = service({
      cachePath,
      fetch: vi.fn(async () => response(signedManifest({ sequence: 2 }))),
    });

    await expect(policy.refresh()).resolves.toBeUndefined();
    expect(policy.getDecision()).toMatchObject({ disabled: true, sequence: 2 });
  });

  it('fails open after the last verified cached manifest expires', async () => {
    const cachePath = path.join(root, 'policy.json');
    fs.writeFileSync(cachePath, signedManifest({ expiresAt: NOW }));
    const policy = service({
      cachePath,
      manifestUrl: null,
      fetch: vi.fn(),
    });

    await policy.refresh();

    expect(policy.getDecision()).toEqual({ disabled: false, sequence: 1 });
  });

  it('publishes fail-open immediately when an active cached disable naturally expires', async () => {
    vi.useFakeTimers();
    let now = NOW;
    const cachePath = path.join(root, 'policy.json');
    fs.writeFileSync(cachePath, signedManifest({ expiresAt: NOW + 1_000 }));
    const policy = service({
      cachePath,
      manifestUrl: null,
      fetch: vi.fn(),
      now: () => now,
    });
    const decisions: boolean[] = [];
    policy.subscribe((decision) => decisions.push(decision.disabled));

    await policy.refresh();
    expect(policy.getDecision()).toMatchObject({ disabled: true, sequence: 1 });

    now = NOW + 1_000;
    await vi.advanceTimersByTimeAsync(1_000);

    expect(policy.getDecision()).toEqual({ disabled: false, sequence: 1 });
    expect(decisions).toEqual([false, true, false]);
  });

  it('rejects oversized or non-JSON responses without replacing the cache', async () => {
    const cachePath = path.join(root, 'policy.json');
    const valid = signedManifest({ sequence: 3 });
    fs.writeFileSync(cachePath, valid);

    const oversized = service({
      cachePath,
      fetch: vi.fn(async () =>
        response(new Uint8Array(0), {
          contentLength: String(WECHAT_COMPATIBILITY_MANIFEST_MAX_BYTES + 1),
        }),
      ),
    });
    await oversized.refresh();
    expect(oversized.getDecision()).toMatchObject({ disabled: true, sequence: 3 });
    expect(fs.readFileSync(cachePath)).toEqual(valid);

    const spoofedLength = service({
      cachePath,
      fetch: vi.fn(async () =>
        response(new Uint8Array(WECHAT_COMPATIBILITY_MANIFEST_MAX_BYTES + 1), {
          contentLength: '1',
        }),
      ),
    });
    await spoofedLength.refresh();
    expect(spoofedLength.getDecision()).toMatchObject({ disabled: true, sequence: 3 });
    expect(fs.readFileSync(cachePath)).toEqual(valid);

    const wrongType = service({
      cachePath,
      fetch: vi.fn(async () => response(signedManifest({ sequence: 4 }), { type: 'text/html' })),
    });
    await wrongType.refresh();
    expect(wrongType.getDecision()).toMatchObject({ disabled: true, sequence: 3 });
    expect(fs.readFileSync(cachePath)).toEqual(valid);
  });

  it('never downloads policy code or endpoint overrides because the schema is exact', () => {
    const payload = basePayload();
    const raw = {
      ...payload,
      rules: [
        {
          ...payload.rules[0],
          endpoint: 'https://evil.invalid',
        },
      ],
    };
    const signature = sign(
      null,
      Buffer.from(canonicalizeWechatCompatibilityManifestPayload(payload)),
      privateKey,
    ).toString('base64');

    expect(() =>
      parseAndVerifyWechatCompatibilityManifest(
        Buffer.from(JSON.stringify({ ...raw, signature })),
        publicKey,
        [HELP_PREFIX],
        NOW,
      ),
    ).toThrow('UNKNOWN_FIELD');
  });
});

function basePayload(
  overrides: Partial<WechatCompatibilityManifestPayload> = {},
): WechatCompatibilityManifestPayload {
  return {
    schemaVersion: 1,
    sequence: 1,
    generatedAt: NOW - 60_000,
    expiresAt: NOW + 60 * 60 * 1_000,
    rules: [
      {
        minVersion: '1.0.0',
        maxVersion: '2.0.0',
        action: 'disable',
        reason: 'protocol_incompatible',
      },
    ],
    ...overrides,
  };
}

function signedManifest(overrides: Partial<WechatCompatibilityManifestPayload> = {}): Buffer {
  const payload = basePayload(overrides);
  const signature = sign(
    null,
    Buffer.from(canonicalizeWechatCompatibilityManifestPayload(payload)),
    privateKey,
  ).toString('base64');
  const manifest: WechatCompatibilityManifest = { ...payload, signature };
  return Buffer.from(JSON.stringify(manifest));
}

function service({
  cachePath,
  fetch,
  manifestUrl = MANIFEST_URL,
  now = () => NOW,
}: {
  cachePath: string;
  fetch: ReturnType<typeof vi.fn>;
  manifestUrl?: string | null;
  now?: () => number;
}): WechatCompatibilityPolicyService {
  return new WechatCompatibilityPolicyService({
    manifestUrl,
    publicKeySpkiBase64,
    trustedHelpUrlPrefixes: [HELP_PREFIX],
    cachePath: () => cachePath,
    appVersion: () => '1.1.21',
    fetch,
    now,
    refreshIntervalMs: 0,
  });
}

function response(
  bytes: Uint8Array,
  options: { type?: string; contentLength?: string } = {},
): {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  body: ReadableStream<Uint8Array>;
  arrayBuffer(): Promise<ArrayBuffer>;
} {
  return {
    ok: true,
    status: 200,
    headers: {
      get(name) {
        if (name.toLowerCase() === 'content-type') return options.type ?? 'application/json';
        if (name.toLowerCase() === 'content-length') {
          return options.contentLength ?? String(bytes.byteLength);
        }
        return null;
      },
    },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    async arrayBuffer() {
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      return copy.buffer;
    },
  };
}
