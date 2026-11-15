/**
 * 中转自带的媒体存储,替代官方 relay 的 OSS 预签名。
 *
 * 客户端契约(Desktop `device-link/mediaTransfer.ts`、Mobile 附件上传)不变:
 * - `presign-put` 返回 `putUrl`,客户端对它 `PUT` 原始字节(带 Content-Type,可能带 OSS 专用头,忽略即可);
 * - `presign-get` 返回 `getUrl`,客户端 `GET`,可带单段 `Range`,期望 200/206 与 Content-Range;
 * - 两种地址都是带签名、短期有效的地址,不需要再带凭证。
 *
 * 文件放在中转数据目录下,创建 24 小时后清理;单对象与总量都有上限。上传在声明大小内流式写入
 * 临时文件,完整后原子改名,中途失败不留半个对象。
 */
import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { hmacHex, safeEqualHex } from './credentials';
import { RelayError } from './errors';

export const BLOB_PATH_PREFIX = '/api/device-link/relay/blob/';

const KEY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]{1,16}$/;
const EXT_PATTERN = /^[a-z0-9]{1,16}$/;
const META_SUFFIX = '.meta.json';
const PART_PREFIX = '.part-';

export interface MediaLimits {
  /** 单对象上限,与客户端 `MAX_MEDIA_BYTES`(2 GiB)一致。 */
  maxObjectBytes: number;
  /** 所有对象加上已签发未完成的上传的总量上限。 */
  maxTotalBytes: number;
  /** 对象保留时长。 */
  objectTtlMs: number;
  /** 预签名地址有效期。 */
  urlTtlMs: number;
}

export const DEFAULT_MEDIA_LIMITS: MediaLimits = {
  maxObjectBytes: 2 * 1024 * 1024 * 1024,
  maxTotalBytes: 10 * 1024 * 1024 * 1024,
  objectTtlMs: 24 * 60 * 60 * 1000,
  urlTtlMs: 60 * 60 * 1000,
};

interface ObjectMeta {
  size: number;
  contentType: string;
  createdAt: number;
}

interface Reservation {
  size: number;
  contentType: string;
  expiresAt: number;
}

export interface PresignPutInput {
  size?: unknown;
  ext?: unknown;
  contentType?: unknown;
  sharedTaskId?: unknown;
}

function normalizeContentType(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 255 || /[\r\n]/.test(trimmed)) return null;
  return trimmed;
}

type ByteRange = { start: number; end: number };

/** 单段 Range;多段或无法解析时返回 'ignore'(按整文件 200 返回),越界返回 'unsatisfiable'。 */
function parseRange(header: string | undefined, size: number): ByteRange | 'ignore' | 'unsatisfiable' {
  if (!header) return 'ignore';
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return 'ignore';
  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) return 'ignore';
  if (size === 0) return 'unsatisfiable';
  if (!rawStart) {
    const suffix = Number(rawEnd);
    if (suffix === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(rawStart);
  const end = rawEnd ? Math.min(Number(rawEnd), size - 1) : size - 1;
  if (start >= size || end < start) return 'unsatisfiable';
  return { start, end };
}

export class MediaStore {
  private usedBytes = 0;
  private uploadingBytes = 0;
  private readonly reservations = new Map<string, Reservation>();
  private readonly removals = new Map<string, Promise<void>>();

  constructor(
    private readonly dir: string,
    private readonly signingKey: string,
    private readonly limits: MediaLimits,
    private readonly now: () => number,
  ) {}

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    this.usedBytes = 0;
    for (const name of await readdir(this.dir)) {
      if (!name.endsWith(META_SUFFIX)) continue;
      const meta = await this.readMeta(name.slice(0, -META_SUFFIX.length));
      if (meta) this.usedBytes += meta.size;
    }
    await this.sweep();
  }

  get stats(): { usedBytes: number; reservedBytes: number } {
    let reservedBytes = this.uploadingBytes;
    for (const reservation of this.reservations.values()) reservedBytes += reservation.size;
    return { usedBytes: this.usedBytes, reservedBytes };
  }

  private sign(op: 'put' | 'get', key: string, exp: number): string {
    return hmacHex(this.signingKey, `${op}\n${key}\n${exp}`);
  }

  private signedUrl(baseUrl: string, op: 'put' | 'get', key: string, exp: number): string {
    const params = new URLSearchParams({ op, exp: String(exp), sig: this.sign(op, key, exp) });
    return `${baseUrl}${BLOB_PATH_PREFIX}${key}?${params.toString()}`;
  }

  presignPut(input: PresignPutInput, baseUrl: string): { putUrl: string; key: string; expiresAt: string } {
    if (input.sharedTaskId !== undefined) {
      throw new RelayError('NOT_SUPPORTED', 'shared task media is not available on a self-hosted relay');
    }
    const size = input.size;
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 1) {
      throw new RelayError('BAD_REQUEST', 'size must be a positive integer');
    }
    if (size > this.limits.maxObjectBytes) throw new RelayError('PAYLOAD_TOO_LARGE', 'media object is too large');
    if (typeof input.ext !== 'string' || !EXT_PATTERN.test(input.ext)) {
      throw new RelayError('BAD_REQUEST', 'invalid extension');
    }
    const contentType = normalizeContentType(input.contentType);
    if (!contentType) throw new RelayError('BAD_REQUEST', 'invalid content type');
    this.expireReservations();
    const { usedBytes, reservedBytes } = this.stats;
    if (usedBytes + reservedBytes + size > this.limits.maxTotalBytes) {
      throw new RelayError('QUOTA_EXCEEDED', 'relay media storage is full');
    }
    const key = `${randomUUID()}.${input.ext}`;
    const expiresAt = this.now() + this.limits.urlTtlMs;
    this.reservations.set(key, { size, contentType, expiresAt });
    return { putUrl: this.signedUrl(baseUrl, 'put', key, expiresAt), key, expiresAt: new Date(expiresAt).toISOString() };
  }

  async presignGet(key: unknown, baseUrl: string): Promise<{ getUrl: string; expiresAt: string }> {
    if (typeof key !== 'string' || !KEY_PATTERN.test(key)) throw new RelayError('BAD_REQUEST', 'invalid key');
    if (!(await this.readMeta(key))) throw new RelayError('NOT_FOUND', 'media object not found');
    const expiresAt = this.now() + this.limits.urlTtlMs;
    return { getUrl: this.signedUrl(baseUrl, 'get', key, expiresAt), expiresAt: new Date(expiresAt).toISOString() };
  }

  async delete(key: unknown): Promise<void> {
    if (typeof key !== 'string' || !KEY_PATTERN.test(key)) throw new RelayError('BAD_REQUEST', 'invalid key');
    this.reservations.delete(key);
    await this.removeObject(key);
  }

  /** 处理签名地址上的 PUT / GET / HEAD。签名、有效期或 key 不对一律 403,不区分原因。 */
  async handleBlobRequest(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const key = decodeURIComponent(url.pathname.slice(BLOB_PATH_PREFIX.length));
    const op = url.searchParams.get('op');
    const exp = Number(url.searchParams.get('exp'));
    const sig = url.searchParams.get('sig') ?? '';
    const method = req.method ?? 'GET';
    const expectedOp = method === 'PUT' ? 'put' : method === 'GET' || method === 'HEAD' ? 'get' : null;
    if (
      !expectedOp ||
      op !== expectedOp ||
      !KEY_PATTERN.test(key) ||
      !Number.isSafeInteger(exp) ||
      exp < this.now() ||
      !safeEqualHex(sig, this.sign(expectedOp, key, exp))
    ) {
      throw new RelayError('FORBIDDEN', 'invalid or expired media link');
    }
    if (expectedOp === 'put') await this.receive(req, res, key);
    else await this.serve(req, res, key, method === 'HEAD');
  }

  private async receive(req: IncomingMessage, res: ServerResponse, key: string): Promise<void> {
    const reservation = this.reservations.get(key);
    if (!reservation || reservation.expiresAt < this.now()) {
      throw new RelayError('CONFLICT', 'media link was already used or has expired');
    }
    // 一个签名地址只能上传一次;开始上传后仍占配额,直到完成或失败,不随 URL 过期释放。
    this.reservations.delete(key);
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > reservation.size) {
      throw new RelayError('PAYLOAD_TOO_LARGE', 'upload is larger than the presigned size');
    }
    const partPath = path.join(this.dir, `${PART_PREFIX}${key}-${randomUUID()}`);
    let received = 0;
    const limiter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        received += chunk.length;
        if (received > reservation.size) {
          callback(new RelayError('PAYLOAD_TOO_LARGE', 'upload is larger than the presigned size'));
          return;
        }
        callback(null, chunk);
      },
    });
    this.uploadingBytes += reservation.size;
    try {
      await pipeline(req, limiter, createWriteStream(partPath, { flags: 'wx', mode: 0o600 }));
      if (received === 0) throw new RelayError('BAD_REQUEST', 'empty upload');
      // 先把数据改名到位,再写 meta:有 meta 才算对象存在,没有 meta 的数据由 sweep 清理。
      await rename(partPath, this.dataPath(key));
      const meta: ObjectMeta = { size: received, contentType: reservation.contentType, createdAt: this.now() };
      await writeFile(this.metaPath(key), JSON.stringify(meta), { mode: 0o600, flag: 'wx' });
      this.usedBytes += received;
    } catch (error) {
      await rm(partPath, { force: true }).catch(() => undefined);
      await rm(this.dataPath(key), { force: true }).catch(() => undefined);
      if (error instanceof RelayError) throw error;
      throw new RelayError('INTERNAL', 'failed to store media object');
    } finally {
      this.uploadingBytes -= reservation.size;
    }
    res.writeHead(200, { 'Content-Length': '0' });
    res.end();
  }

  private async serve(req: IncomingMessage, res: ServerResponse, key: string, headOnly: boolean): Promise<void> {
    const meta = await this.readMeta(key);
    if (!meta) throw new RelayError('NOT_FOUND', 'media object not found');
    const range = parseRange(req.headers.range, meta.size);
    if (range === 'unsatisfiable') {
      res.writeHead(416, { 'Content-Range': `bytes */${meta.size}` });
      res.end();
      return;
    }
    const headers: Record<string, string> = {
      'Content-Type': meta.contentType,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, no-store',
    };
    const start = range === 'ignore' ? 0 : range.start;
    const end = range === 'ignore' ? meta.size - 1 : range.end;
    headers['Content-Length'] = String(end - start + 1);
    if (range !== 'ignore') headers['Content-Range'] = `bytes ${start}-${end}/${meta.size}`;
    res.writeHead(range === 'ignore' ? 200 : 206, headers);
    if (headOnly) {
      res.end();
      return;
    }
    await pipeline(createReadStream(this.dataPath(key), { start, end }), res);
  }

  private expireReservations(): void {
    const now = this.now();
    for (const [key, reservation] of this.reservations) {
      if (reservation.expiresAt < now) this.reservations.delete(key);
    }
  }

  /** 清理过期对象与遗留的临时文件。 */
  async sweep(): Promise<void> {
    this.expireReservations();
    const now = this.now();
    const names = new Set(await readdir(this.dir));
    for (const name of names) {
      const full = path.join(this.dir, name);
      if (name.endsWith(META_SUFFIX)) {
        const key = name.slice(0, -META_SUFFIX.length);
        const meta = await this.readMeta(key);
        if (!meta || now - meta.createdAt > this.limits.objectTtlMs) await this.removeObject(key);
        continue;
      }
      // 上传中的临时文件,以及改名后没来得及写 meta 的数据:超过地址有效期仍无 meta 才清理。
      const orphanData = KEY_PATTERN.test(name) && !names.has(`${name}${META_SUFFIX}`);
      if (!name.startsWith(PART_PREFIX) && !orphanData) continue;
      const info = await stat(full).catch(() => null);
      if (info && now - info.mtimeMs > this.limits.urlTtlMs) await rm(full, { force: true }).catch(() => undefined);
    }
  }

  private dataPath(key: string): string {
    return path.join(this.dir, key);
  }

  private metaPath(key: string): string {
    return path.join(this.dir, `${key}${META_SUFFIX}`);
  }

  private async readMeta(key: string): Promise<ObjectMeta | null> {
    try {
      const meta = JSON.parse(await readFile(this.metaPath(key), 'utf8')) as Partial<ObjectMeta>;
      if (typeof meta.size !== 'number' || typeof meta.contentType !== 'string' || typeof meta.createdAt !== 'number') {
        return null;
      }
      // meta 在数据改名到位后才写;数据已被删除时视为不存在。
      const info = await stat(this.dataPath(key)).catch(() => null);
      return info ? (meta as ObjectMeta) : null;
    } catch {
      return null;
    }
  }

  private removeObject(key: string): Promise<void> {
    const pending = this.removals.get(key);
    if (pending) return pending;
    // DELETE 与过期清理共用同一次删除，不能各自减掉同一份 meta.size。
    const removing = this.removeObjectOnce(key).finally(() => { this.removals.delete(key); });
    this.removals.set(key, removing);
    return removing;
  }

  private async removeObjectOnce(key: string): Promise<void> {
    const meta = await this.readMeta(key);
    await rm(this.dataPath(key), { force: true }).catch(() => undefined);
    await rm(this.metaPath(key), { force: true }).catch(() => undefined);
    if (meta) this.usedBytes = Math.max(0, this.usedBytes - meta.size);
  }
}
