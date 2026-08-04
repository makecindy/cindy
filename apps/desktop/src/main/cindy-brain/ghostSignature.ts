/**
 * ghostSignature — .cindy 发布者签名与 Cindy 审核签名的纯 Node 验证器。
 *
 * 签名文件位于包根 `cindy-signatures.json`，不参与内容哈希；它里面的 statement
 * 列出其它每个文件的 sha256/字节数。发布者签 statement + 自身显示名/公钥，
 * 审核方再签完整发布者声明，因此任何文件、版本、名称、公钥或签名被改都会验不过。
 *
 * 发布者公钥随包只能证明“这个版本和同一把私钥来自一处”，不能自己证明现实
 * 身份。只有 key 命中 Cindy 下发/随包的信任表才叫“发布者已验证”；Cindy 审核
 * key 命中且审核签名有效才叫“该准确版本已审核”。
 */

import crypto from 'node:crypto';

import JSZip from 'jszip';

import {
  GHOST_MANIFEST_FILE,
  type GhostManifest,
  type GhostTrustInfo,
  validateGhostManifest,
} from '../../shared/ghost.js';

export const GHOST_SIGNATURE_FILE = 'cindy-signatures.json';
export const MAX_SIGNATURE_FILE_BYTES = 64 * 1024;
const MAX_SIGNED_CONTENT_BYTES = 256 * 1024 * 1024;

export interface GhostTrustedKey {
  name: string;
  /** Ed25519 SubjectPublicKeyInfo DER，base64。 */
  publicKey: string;
}

export interface GhostTrustRegistry {
  publishers?: Record<string, GhostTrustedKey>;
  reviewers?: Record<string, GhostTrustedKey>;
}

export interface GhostSignatureStatement {
  schemaVersion: 1;
  ghostId: string;
  ghostVersion: string;
  files: Array<{ path: string; sha256: string; bytes: number }>;
}

export interface GhostSignatureDocument {
  schemaVersion: 1;
  statement: GhostSignatureStatement;
  publisher: {
    algorithm: 'ed25519';
    keyId: string;
    name: string;
    publicKey: string;
    signature: string;
  };
  review?: {
    algorithm: 'ed25519';
    keyId: string;
    signature: string;
  };
}

export type GhostSignatureVerification =
  | { ok: true; trust: GhostTrustInfo; document?: GhostSignatureDocument }
  | { ok: false; reason: string };

/** Deterministic JSON: object keys sorted lexicographically at all depths. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(v).sort()) sorted[k] = (v as Record<string, unknown>)[k];
      return sorted;
    }
    return v;
  });
}

function sha256Hex(data: Buffer | string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function publicKeyId(publicKeyDer: Buffer): string {
  return `ed25519:${sha256Hex(publicKeyDer).slice(0, 32)}`;
}

function publicKeyObject(publicKeyBase64: string): crypto.KeyObject {
  return crypto.createPublicKey({
    key: Buffer.from(publicKeyBase64, 'base64'),
    format: 'der',
    type: 'spki',
  });
}

function unsignedTrust(): GhostTrustInfo {
  return {
    level: 'unverified',
    publisherSigned: false,
    publisherVerified: false,
    reviewed: false,
  };
}

async function buildStatement(
  zip: JSZip,
  prefix: string,
  manifest: GhostManifest,
): Promise<GhostSignatureStatement> {
  const files: GhostSignatureStatement['files'] = [];
  let totalBytes = 0;
  const entries = Object.values(zip.files).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.dir || entry.name.startsWith('__MACOSX/')) continue;
    if (!entry.name.startsWith(prefix)) continue;
    const rel = entry.name.slice(prefix.length);
    if (!rel || rel === GHOST_SIGNATURE_FILE) continue;
    const digest = await hashZipEntry(entry, MAX_SIGNED_CONTENT_BYTES - totalBytes);
    totalBytes += digest.bytes;
    files.push({ path: rel, sha256: digest.sha256, bytes: digest.bytes });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return {
    schemaVersion: 1,
    ghostId: manifest.id,
    ghostVersion: manifest.version,
    files,
  };
}

/** 对 zip 条目做流式哈希；超上限立刻停流，不把大文件整体放进内存。 */
async function hashZipEntry(
  entry: JSZip.JSZipObject,
  remainingBytes: number,
): Promise<{ sha256: string; bytes: number }> {
  if (remainingBytes < 0) throw new Error('签名内容超过 256MB 上限');
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  await consumeZipEntry(entry, (chunk, stream) => {
    bytes += chunk.byteLength;
    if (bytes > remainingBytes) {
      stream.destroy();
      throw new Error('签名内容超过 256MB 上限');
    }
    hash.update(chunk);
  });
  return { sha256: hash.digest('hex'), bytes };
}

/** 只用于签名小 JSON；超过 64KB 时立刻停止解压。 */
async function readSignatureText(entry: JSZip.JSZipObject): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  await consumeZipEntry(entry, (chunk, stream) => {
    bytes += chunk.byteLength;
    if (bytes > MAX_SIGNATURE_FILE_BYTES) {
      stream.destroy();
      throw new Error('签名文件过大');
    }
    chunks.push(chunk);
  });
  return Buffer.concat(chunks, bytes).toString('utf8');
}

/** 把 JSZip 的 Node 流收成 Promise，并在消费回调失败时停止继续处理。 */
async function consumeZipEntry(
  entry: JSZip.JSZipObject,
  onChunk: (chunk: Buffer, stream: NodeJS.ReadableStream & { destroy(): void }) => void,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const stream = entry.nodeStream() as NodeJS.ReadableStream & { destroy(): void };
    let settled = false;
    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    stream.on('data', (value) => {
      if (settled) return;
      try {
        onChunk(Buffer.isBuffer(value) ? value : Buffer.from(value), stream);
      } catch (err) {
        fail(err);
      }
    });
    stream.on('error', fail);
    stream.on('end', () => {
      if (settled) return;
      settled = true;
      resolve();
    });
  });
}

function normalizeDocument(raw: unknown): GhostSignatureDocument | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const doc = raw as Record<string, unknown>;
  const statement = doc.statement as Record<string, unknown> | undefined;
  const publisher = doc.publisher as Record<string, unknown> | undefined;
  if (doc.schemaVersion !== 1 || !statement || !publisher) return null;
  if (
    statement.schemaVersion !== 1 ||
    typeof statement.ghostId !== 'string' ||
    typeof statement.ghostVersion !== 'string' ||
    !Array.isArray(statement.files)
  ) return null;
  const files: GhostSignatureStatement['files'] = [];
  for (const item of statement.files) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const file = item as Record<string, unknown>;
    if (
      typeof file.path !== 'string' ||
      !/^[a-f0-9]{64}$/.test(String(file.sha256)) ||
      typeof file.bytes !== 'number' ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 0
    ) return null;
    files.push({ path: file.path, sha256: String(file.sha256), bytes: file.bytes });
  }
  if (
    publisher.algorithm !== 'ed25519' ||
    typeof publisher.keyId !== 'string' ||
    typeof publisher.name !== 'string' ||
    publisher.name.trim().length === 0 ||
    publisher.name.length > 64 ||
    typeof publisher.publicKey !== 'string' ||
    typeof publisher.signature !== 'string'
  ) return null;
  let review: GhostSignatureDocument['review'];
  if (doc.review !== undefined) {
    if (!doc.review || typeof doc.review !== 'object' || Array.isArray(doc.review)) return null;
    const reviewRaw = doc.review as Record<string, unknown>;
    if (
      reviewRaw.algorithm !== 'ed25519' ||
      typeof reviewRaw.keyId !== 'string' ||
      typeof reviewRaw.signature !== 'string'
    ) return null;
    review = {
      algorithm: 'ed25519',
      keyId: reviewRaw.keyId,
      signature: reviewRaw.signature,
    };
  }
  return {
    schemaVersion: 1,
    statement: {
      schemaVersion: 1,
      ghostId: statement.ghostId,
      ghostVersion: statement.ghostVersion,
      files,
    },
    publisher: {
      algorithm: 'ed25519',
      keyId: publisher.keyId,
      name: publisher.name,
      publicKey: publisher.publicKey,
      signature: publisher.signature,
    },
    ...(review ? { review } : {}),
  };
}

function reviewPayload(doc: GhostSignatureDocument): Buffer {
  return Buffer.from(
    canonicalJson({
      statement: doc.statement,
      publisher: doc.publisher,
    }),
  );
}

/** 发布者签名同时锁住显示名和公钥身份，避免只改 UI 名称而文件验签仍通过。 */
function publisherPayload(
  statement: GhostSignatureStatement,
  publisher: Omit<GhostSignatureDocument['publisher'], 'signature'>,
): Buffer {
  return Buffer.from(canonicalJson({ statement, publisher }));
}

/** 验证 zip 中的签名；无签名合法但等级为 unverified，坏签名直接拒装。 */
export async function verifyGhostZipSignatures(
  zip: JSZip,
  prefix: string,
  manifest: GhostManifest,
  registry: GhostTrustRegistry = {},
): Promise<GhostSignatureVerification> {
  const signatureEntry = zip.file(`${prefix}${GHOST_SIGNATURE_FILE}`);
  if (!signatureEntry) return { ok: true, trust: unsignedTrust() };
  let text: string;
  try {
    text = await readSignatureText(signatureEntry);
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : '签名文件无法读取',
    };
  }
  let doc: GhostSignatureDocument | null;
  try {
    doc = normalizeDocument(JSON.parse(text));
  } catch {
    doc = null;
  }
  if (!doc) return { ok: false, reason: '签名文件格式不合法' };

  let actualStatement: GhostSignatureStatement;
  try {
    actualStatement = await buildStatement(zip, prefix, manifest);
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : '签名内容无法读取',
    };
  }
  if (canonicalJson(doc.statement) !== canonicalJson(actualStatement)) {
    return { ok: false, reason: '插件文件或版本与签名记录不一致，包可能已被修改' };
  }
  let publisherKey: crypto.KeyObject;
  let publisherDer: Buffer;
  let publisherSignature: Buffer;
  try {
    publisherDer = Buffer.from(doc.publisher.publicKey, 'base64');
    publisherKey = publicKeyObject(doc.publisher.publicKey);
    publisherSignature = Buffer.from(doc.publisher.signature, 'base64');
  } catch {
    return { ok: false, reason: '发布者公钥或签名编码损坏' };
  }
  if (publicKeyId(publisherDer) !== doc.publisher.keyId) {
    return { ok: false, reason: '发布者 keyId 与公钥不匹配' };
  }
  const publisherIdentity = {
    algorithm: doc.publisher.algorithm,
    keyId: doc.publisher.keyId,
    name: doc.publisher.name,
    publicKey: doc.publisher.publicKey,
  };
  if (
    !crypto.verify(
      null,
      publisherPayload(doc.statement, publisherIdentity),
      publisherKey,
      publisherSignature,
    )
  ) {
    return { ok: false, reason: '发布者签名验证失败，包可能已被修改' };
  }

  const trustedPublisher = registry.publishers?.[doc.publisher.keyId];
  const publisherVerified = Boolean(
    trustedPublisher && trustedPublisher.publicKey === doc.publisher.publicKey,
  );
  let reviewed = false;
  let reviewerName: string | undefined;
  let unknownReviewer = false;
  if (doc.review) {
    const trustedReviewer = registry.reviewers?.[doc.review.keyId];
    if (!trustedReviewer) {
      unknownReviewer = true;
    } else {
      try {
        const reviewerDer = Buffer.from(trustedReviewer.publicKey, 'base64');
        if (publicKeyId(reviewerDer) !== doc.review.keyId) {
          return { ok: false, reason: '客户端内置的审核 key 配置不一致' };
        }
        reviewed = crypto.verify(
          null,
          reviewPayload(doc),
          publicKeyObject(trustedReviewer.publicKey),
          Buffer.from(doc.review.signature, 'base64'),
        );
      } catch {
        reviewed = false;
      }
      if (!reviewed) return { ok: false, reason: 'Cindy 审核签名验证失败，包可能已被修改' };
      reviewerName = trustedReviewer.name;
    }
  }

  const verifiedByReview = reviewed;
  const trust: GhostTrustInfo = {
    level: reviewed ? 'reviewed' : publisherVerified ? 'verified-publisher' : 'unverified',
    publisherSigned: true,
    publisherVerified: publisherVerified || verifiedByReview,
    reviewed,
    publisherName: trustedPublisher?.name ?? doc.publisher.name,
    publisherKeyId: doc.publisher.keyId,
    ...(reviewerName ? { reviewerName } : {}),
    ...(unknownReviewer ? { unknownReviewer: true } : {}),
  };
  return { ok: true, trust, document: doc };
}

export interface SignGhostPackageOptions {
  publisherName: string;
  privateKey: crypto.KeyLike;
}

/** 发布流水线使用：给一个未签名/重签的 .cindy Buffer 添加 Ed25519 发布者签名。 */
export async function signGhostPackage(
  packageBuffer: Buffer,
  options: SignGhostPackageOptions,
): Promise<Buffer> {
  const zip = await JSZip.loadAsync(packageBuffer);
  const prefix = detectSingleTopFolderPrefix(Object.keys(zip.files));
  zip.remove(`${prefix}${GHOST_SIGNATURE_FILE}`);
  const manifestEntry = zip.file(`${prefix}${GHOST_MANIFEST_FILE}`);
  if (!manifestEntry) throw new Error(`缺少 ${GHOST_MANIFEST_FILE}`);
  const validation = validateGhostManifest(JSON.parse(await manifestEntry.async('text')));
  if (!validation.ok) throw new Error(validation.reason);
  if (!options.publisherName.trim() || options.publisherName.length > 64) {
    throw new Error('publisherName 必须是 1–64 字符');
  }
  const statement = await buildStatement(zip, prefix, validation.manifest);
  const publicKey = crypto.createPublicKey(options.privateKey);
  const publicKeyDer = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  const publisher = {
    algorithm: 'ed25519' as const,
    keyId: publicKeyId(publicKeyDer),
    name: options.publisherName.trim(),
    publicKey: publicKeyDer.toString('base64'),
  };
  const document: GhostSignatureDocument = {
    schemaVersion: 1,
    statement,
    publisher: {
      ...publisher,
      signature: crypto
        .sign(null, publisherPayload(statement, publisher), options.privateKey)
        .toString('base64'),
    },
  };
  zip.file(`${prefix}${GHOST_SIGNATURE_FILE}`, `${JSON.stringify(document, null, 2)}\n`);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

export interface ReviewGhostPackageOptions {
  reviewerPrivateKey: crypto.KeyLike;
}

/** Cindy 审核流水线使用：在发布者签名已存在且有效的准确包上追加审核签名。 */
export async function reviewGhostPackage(
  packageBuffer: Buffer,
  options: ReviewGhostPackageOptions,
): Promise<Buffer> {
  const zip = await JSZip.loadAsync(packageBuffer);
  const prefix = detectSingleTopFolderPrefix(Object.keys(zip.files));
  const manifestEntry = zip.file(`${prefix}${GHOST_MANIFEST_FILE}`);
  const signatureEntry = zip.file(`${prefix}${GHOST_SIGNATURE_FILE}`);
  if (!manifestEntry || !signatureEntry) throw new Error('审核前必须已有发布者签名');
  const validation = validateGhostManifest(JSON.parse(await manifestEntry.async('text')));
  if (!validation.ok) throw new Error(validation.reason);
  const verified = await verifyGhostZipSignatures(zip, prefix, validation.manifest);
  if (!verified.ok || !verified.document) {
    throw new Error(verified.ok ? '缺少发布者签名' : verified.reason);
  }
  const reviewerPublicKey = crypto.createPublicKey(options.reviewerPrivateKey);
  const reviewerDer = reviewerPublicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  const document: GhostSignatureDocument = {
    ...verified.document,
    review: {
      algorithm: 'ed25519',
      keyId: publicKeyId(reviewerDer),
      signature: crypto
        .sign(null, reviewPayload(verified.document), options.reviewerPrivateKey)
        .toString('base64'),
    },
  };
  zip.file(`${prefix}${GHOST_SIGNATURE_FILE}`, `${JSON.stringify(document, null, 2)}\n`);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

function detectSingleTopFolderPrefix(names: string[]): string {
  let top: string | null = null;
  for (const name of names) {
    const normalized = name.replace(/\\/g, '/');
    const slash = normalized.indexOf('/');
    if (slash <= 0) return '';
    const first = normalized.slice(0, slash);
    if (top === null) top = first;
    else if (top !== first) return '';
  }
  return top === null ? '' : `${top}/`;
}
