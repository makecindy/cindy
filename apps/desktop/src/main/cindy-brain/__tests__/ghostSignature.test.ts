/** ghostSignature.test — 发布者签名、审核签名、篡改拒装与信任等级。 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GhostManager } from '../GhostManager';
import type { GhostManifest } from '../../../shared/ghost';
import {
  GHOST_SIGNATURE_FILE,
  reviewGhostPackage,
  signGhostPackage,
  verifyGhostZipSignatures,
  type GhostSignatureDocument,
} from '../ghostSignature';

const MANIFEST: GhostManifest = {
  schemaVersion: 2 as const,
  id: 'signed-demo',
  name: 'Signed Demo',
  version: '1.0.0',
  kind: 'chip' as const,
  entry: 'main.js',
  slots: ['card'],
};

let workDir: string;

beforeEach(async () => {
  workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cindy-signature-test-'));
});

afterEach(async () => {
  await fs.promises.rm(workDir, { recursive: true, force: true });
});

async function unsignedPackage(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('ghost.json', JSON.stringify(MANIFEST));
  zip.file('main.js', '// browser brain');
  zip.file('assets/value.txt', 'original');
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function readSignature(buffer: Buffer): Promise<GhostSignatureDocument> {
  const zip = await JSZip.loadAsync(buffer);
  return JSON.parse(await zip.file(GHOST_SIGNATURE_FILE)!.async('text')) as GhostSignatureDocument;
}

describe('ghostSignature · 发布者签名', () => {
  it('signing and review preserve safe Unix executable metadata', async () => {
    const source = new JSZip();
    source.file('ghost.json', JSON.stringify(MANIFEST), { unixPermissions: 0o100644 });
    source.file('main.js', '// browser brain', { unixPermissions: 0o100755 });
    source.file('linked-dir/', null, { dir: true, unixPermissions: 0o120777 });
    const unsigned = await source.generateAsync({ type: 'nodebuffer', platform: 'UNIX' });
    const publisher = crypto.generateKeyPairSync('ed25519');
    const reviewer = crypto.generateKeyPairSync('ed25519');

    const signed = await signGhostPackage(unsigned, {
      publisherName: 'Publisher',
      privateKey: publisher.privateKey,
    });
    const signedZip = await JSZip.loadAsync(signed);
    expect(Number(signedZip.files['main.js'].unixPermissions) & 0o7777).toBe(0o755);
    expect(Number(signedZip.files['linked-dir/'].unixPermissions) & 0o7777).toBe(0o755);

    const reviewed = await reviewGhostPackage(signed, {
      reviewerPrivateKey: reviewer.privateKey,
    });
    const reviewedZip = await JSZip.loadAsync(reviewed);
    expect(Number(reviewedZip.files['main.js'].unixPermissions) & 0o7777).toBe(0o755);
  });

  it('无签名可以安装，但明确标为未验证', async () => {
    const zip = await JSZip.loadAsync(await unsignedPackage());
    const result = await verifyGhostZipSignatures(zip, '', MANIFEST);
    expect(result).toMatchObject({
      ok: true,
      trust: {
        level: 'unverified',
        publisherSigned: false,
        publisherVerified: false,
      },
    });
  });

  it('自签包先证明文件未改；key 进入信任表后才叫发布者已验证', async () => {
    const { privateKey } = crypto.generateKeyPairSync('ed25519');
    const signed = await signGhostPackage(await unsignedPackage(), {
      publisherName: 'TapTap Maker Team',
      privateKey,
    });
    const doc = await readSignature(signed);
    const zip = await JSZip.loadAsync(signed);

    expect(await verifyGhostZipSignatures(zip, '', MANIFEST)).toMatchObject({
      ok: true,
      trust: {
        level: 'unverified',
        publisherSigned: true,
        publisherVerified: false,
        publisherName: 'TapTap Maker Team',
      },
    });
    expect(
      await verifyGhostZipSignatures(zip, '', MANIFEST, {
        publishers: {
          [doc.publisher.keyId]: {
            name: 'Verified TapTap Publisher',
            publicKey: doc.publisher.publicKey,
          },
        },
      }),
    ).toMatchObject({
      ok: true,
      trust: {
        level: 'verified-publisher',
        publisherVerified: true,
        publisherName: 'Verified TapTap Publisher',
      },
    });
  });

  it('签名后任一文件被改，GhostManager inspect 直接拒绝，不能降级成无签名', async () => {
    const { privateKey } = crypto.generateKeyPairSync('ed25519');
    const signed = await signGhostPackage(await unsignedPackage(), {
      publisherName: 'Publisher',
      privateKey,
    });
    const zip = await JSZip.loadAsync(signed);
    zip.file('assets/value.txt', 'tampered');
    const tampered = await zip.generateAsync({ type: 'nodebuffer' });
    const file = path.join(workDir, 'tampered.cindy');
    await fs.promises.writeFile(file, tampered);
    const manager = new GhostManager({ getRootDir: () => path.join(workDir, 'ghosts') });

    expect(await manager.inspect(file)).toMatchObject({
      rejection: {
        code: 'file-invalid',
        reason: expect.stringContaining('签名验证失败'),
      },
    });
  });

  it('发布者显示名也在签名里，不能只改名字冒充别人', async () => {
    const { privateKey } = crypto.generateKeyPairSync('ed25519');
    const signed = await signGhostPackage(await unsignedPackage(), {
      publisherName: 'Real Publisher',
      privateKey,
    });
    const zip = await JSZip.loadAsync(signed);
    const doc = JSON.parse(
      await zip.file(GHOST_SIGNATURE_FILE)!.async('text'),
    ) as GhostSignatureDocument;
    doc.publisher.name = 'Cindy Official';
    zip.file(GHOST_SIGNATURE_FILE, JSON.stringify(doc));

    expect(
      await verifyGhostZipSignatures(
        await JSZip.loadAsync(await zip.generateAsync({ type: 'nodebuffer' })),
        '',
        MANIFEST,
      ),
    ).toMatchObject({ ok: false, reason: expect.stringContaining('发布者签名验证失败') });
  });
});

describe('ghostSignature · Cindy 审核签名', () => {
  it('审核 key 命中客户端信任表后，准确版本显示为已审核', async () => {
    const publisher = crypto.generateKeyPairSync('ed25519');
    const reviewer = crypto.generateKeyPairSync('ed25519');
    const signed = await signGhostPackage(await unsignedPackage(), {
      publisherName: 'Publisher',
      privateKey: publisher.privateKey,
    });
    const reviewed = await reviewGhostPackage(signed, {
      reviewerPrivateKey: reviewer.privateKey,
    });
    const doc = await readSignature(reviewed);
    const reviewerPublicDer = reviewer.publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
    const zip = await JSZip.loadAsync(reviewed);

    expect(
      await verifyGhostZipSignatures(zip, '', MANIFEST, {
        reviewers: {
          [doc.review!.keyId]: {
            name: 'Cindy Security Review',
            publicKey: reviewerPublicDer.toString('base64'),
          },
        },
      }),
    ).toMatchObject({
      ok: true,
      trust: {
        level: 'reviewed',
        reviewed: true,
        publisherVerified: true,
        reviewerName: 'Cindy Security Review',
      },
    });
  });

  it('不认识的审核 key 不抬高等级，只标记 unknownReviewer', async () => {
    const publisher = crypto.generateKeyPairSync('ed25519');
    const reviewer = crypto.generateKeyPairSync('ed25519');
    const signed = await signGhostPackage(await unsignedPackage(), {
      publisherName: 'Publisher',
      privateKey: publisher.privateKey,
    });
    const reviewed = await reviewGhostPackage(signed, {
      reviewerPrivateKey: reviewer.privateKey,
    });
    const zip = await JSZip.loadAsync(reviewed);
    expect(await verifyGhostZipSignatures(zip, '', MANIFEST)).toMatchObject({
      ok: true,
      trust: {
        level: 'unverified',
        reviewed: false,
        unknownReviewer: true,
      },
    });
  });
});
