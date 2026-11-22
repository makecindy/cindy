import { createCipheriv, createDecipheriv, createHash, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, type KeyObject } from 'node:crypto';
import { MAX_MEDIA_OBJECT_BYTES, MAX_MEDIA_BINARY_CHUNK_BYTES, MEDIA_ENCRYPTED_HEADER_BYTES as HEADER, MEDIA_PLAINTEXT_CHUNK_BYTES as BLOCK } from '@cindy/agent-net-protocol';
import type { AgentNetClient } from './client.js';

const tagBytes = 16;
const maxPlaintext = 2 * 1024 * 1024 * 1024;
const nonceFor = (header: Buffer, index: number) => {
  const nonce = Buffer.alloc(12); header.copy(nonce, 0, 33, 41); nonce.writeUInt32BE(index, 8); return nonce;
};
const aadFor = (header: Buffer, index: number) => { const suffix = Buffer.alloc(4); suffix.writeUInt32BE(index); return Buffer.concat([header, suffix]); };
const encryptedSize = (size: number) => HEADER + size + Math.ceil(size / BLOCK) * tagBytes;
function keyFor(privateKey: KeyObject, remote: string, salt: Uint8Array, binding?: string): Buffer {
  if (binding !== undefined && (!/^[\x21-\x7e]{1,256}$/.test(binding))) throw new Error('INVALID_MEDIA_BINDING');
  const peer = createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: remote }, format: 'jwk' });
  const shared = diffieHellman({ privateKey, publicKey: peer });
  try { return Buffer.from(hkdfSync('sha256', shared, salt, 'cindy-agent-net/media-key/3' + (binding === undefined ? '' : '\0' + binding), 32)); }
  finally { shared.fill(0); }
}
function unwrapMediaKey(api: AgentNetClient, header: Buffer, binding?: string): Buffer {
  const publicKey = Buffer.from(api.identity.transportKey, 'base64url');
  const index = [0, 1].find(i => header.subarray(61 + i * 80, 93 + i * 80).equals(publicKey));
  if (index === undefined) throw new Error('MEDIA_RECIPIENT_MISMATCH');
  const wrapping = keyFor(api.identity.transportPrivateKey, header.subarray(1, 33).toString('base64url'), header.subarray(33, 49), binding);
  try {
    const decipher = createDecipheriv('aes-256-gcm', wrapping, nonceFor(header, index));
    decipher.setAAD(Buffer.concat([aadFor(header.subarray(0, 61), index), publicKey]));
    const capsule = header.subarray(93 + index * 80, 141 + index * 80);
    decipher.setAuthTag(capsule.subarray(32));
    return Buffer.concat([decipher.update(capsule.subarray(0, 32)), decipher.final()]);
  } finally { wrapping.fill(0); }
}
/** Independent AEAD blocks allow authenticated seeks without downloading an entire video. */
export async function uploadEncryptedMedia(api: AgentNetClient, recipient: string, transportKey: string, size: number,
  read: (offset: number, length: number) => Promise<Uint8Array>, options: { signal?: AbortSignal; onProgress?(bytes: number): void; assertCurrent?(): void; binding?: string } = {},
): Promise<{ id: string; sha256: string; headerSha256: string }> {
  if (!Number.isSafeInteger(size) || size < 0 || size > maxPlaintext) throw new Error('INVALID_MEDIA_SIZE');
  const ephemeral = generateKeyPairSync('x25519'), salt = randomBytes(16);
  const header = Buffer.alloc(HEADER); header[0] = 3;
  Buffer.from(ephemeral.publicKey.export({ format: 'jwk' }).x!, 'base64url').copy(header, 1); salt.copy(header, 33);
  header.writeUInt32BE(BLOCK, 49); header.writeBigUInt64BE(BigInt(size), 53);
  const key = randomBytes(32), hash = createHash('sha256');
  const check = () => { options.signal?.throwIfAborted(); options.assertCurrent?.(); };
  let id: string | undefined;
  try {
  check();
  // The uploader can reopen its own attachment; the relay has neither wrapping private key.
  for (const [index, publicKey] of [api.identity.transportKey, transportKey].entries()) {
    const offset = 61 + index * 80, publicBytes = Buffer.from(publicKey, 'base64url');
    if (publicBytes.length !== 32) throw new Error('INVALID_MEDIA_RECIPIENT_KEY');
    publicBytes.copy(header, offset);
    const wrapping = keyFor(ephemeral.privateKey, publicKey, salt, options.binding);
    try {
      const cipher = createCipheriv('aes-256-gcm', wrapping, nonceFor(header, index));
      cipher.setAAD(Buffer.concat([aadFor(header.subarray(0, 61), index), publicBytes]));
      Buffer.concat([cipher.update(key), cipher.final(), cipher.getAuthTag()]).copy(header, offset + 32);
    } finally { wrapping.fill(0); }
  }
  const headerSha256 = createHash('sha256').update(header).digest('hex');
    const created = await api.createMedia(recipient, encryptedSize(size), options.signal);
    id = created.id; check();
    if (!Number.isSafeInteger(created.chunkBytes) || created.chunkBytes < BLOCK + tagBytes || created.chunkBytes > MAX_MEDIA_BINARY_CHUNK_BYTES) throw new Error('MEDIA_STREAM_UNSUPPORTED');
    let batch: Buffer[] = [header], bytes = header.length, written = 0;
    const flush = async () => {
      check(); const body = Buffer.concat(batch, bytes);
      const result = await api.putMediaChunk(id!, written, body, options.signal); check();
      written += bytes; if (result.received !== written) throw new Error('MEDIA_OFFSET_MISMATCH');
      batch = []; bytes = 0;
    };
    for (let offset = 0, index = 0; offset < size; offset += BLOCK, index++) {
      check(); const plain = await read(offset, Math.min(BLOCK, size - offset)); check();
      if (plain.byteLength !== Math.min(BLOCK, size - offset)) throw new Error('MEDIA_SOURCE_CHANGED');
      hash.update(plain);
      const cipher = createCipheriv('aes-256-gcm', key, nonceFor(header, index)); cipher.setAAD(aadFor(header, index));
      const encrypted = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
      if (bytes + encrypted.length > created.chunkBytes) await flush();
      batch.push(encrypted); bytes += encrypted.length; options.onProgress?.(Math.min(size, offset + plain.length));
    }
    if (bytes) await flush();
    if (written !== encryptedSize(size)) throw new Error('MEDIA_SIZE_MISMATCH');
    return { id, sha256: hash.digest('hex'), headerSha256 };
  } catch (error) {
    if (id) await api.request('DELETE', '/media/' + encodeURIComponent(id), undefined, { signal: AbortSignal.timeout(3000) }).catch(() => undefined);
    throw error;
  } finally { key.fill(0); }
}

function rangeFor(value: string | undefined, size: number): { start: number; end: number } | null {
  if (!value) return { start: 0, end: size - 1 };
  const parsed = /^bytes=(\d*)-(\d*)$/.exec(value); if (!parsed || (!parsed[1] && !parsed[2])) return null;
  const start = parsed[1] ? Number(parsed[1]) : Math.max(0, size - Number(parsed[2]));
  const end = parsed[1] && parsed[2] ? Math.min(size - 1, Number(parsed[2])) : size - 1;
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && start <= end && start < size ? { start, end } : null;
}
/** Ciphertext always stays in the relay; plaintext is streamed to the caller's existing media/file store. */
export async function openEncryptedMedia(api: AgentNetClient, id: string, headerSha256: string, range: string | undefined, contentType: string,
  options: { signal?: AbortSignal; assertCurrent?(): void; binding?: string } = {},
): Promise<Response> {
  const check = () => { options.signal?.throwIfAborted(); options.assertCurrent?.(); };
  check(); const first = await api.mediaResponse(id, `bytes=0-${HEADER - 1}`, options.signal); check();
  if (first.status !== 206 || !first.body || !/^bytes 0-220\/\d+$/.test(first.headers.get('content-range') ?? '')) {
    await first.body?.cancel(); throw new Error('INVALID_MEDIA_HEADER');
  }
  const headReader = first.body.getReader(), header = Buffer.alloc(HEADER); let headBytes = 0;
  try {
    while (headBytes < HEADER) {
      const chunk = await headReader.read(); check();
      if (chunk.done || chunk.value.length > HEADER - headBytes) throw new Error('INVALID_MEDIA_HEADER');
      header.set(chunk.value, headBytes); headBytes += chunk.value.length;
    }
  } finally { await headReader.cancel().catch(() => undefined); }
  if (header[0] !== 3 || header.readUInt32BE(49) !== BLOCK || createHash('sha256').update(header).digest('hex') !== headerSha256) throw new Error('INVALID_MEDIA_HEADER');
  const size = Number(header.readBigUInt64BE(53));
  if (!Number.isSafeInteger(size) || size < 0 || size > maxPlaintext || encryptedSize(size) > MAX_MEDIA_OBJECT_BYTES
    || first.headers.get('content-range') !== `bytes 0-${HEADER - 1}/${encryptedSize(size)}`) throw new Error('INVALID_MEDIA_HEADER');
  const selected = rangeFor(range, size);
  if (!selected) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}`, 'cache-control': 'no-store' } });
  const key = unwrapMediaKey(api, header, options.binding);
  if (size === 0) {
    key.fill(0);
    return new Response(null, { status: 200, headers: { 'content-type': contentType, 'content-length': '0',
      'accept-ranges': 'bytes', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
  }
  const firstBlock = Math.floor(selected.start / BLOCK), lastBlock = Math.floor(selected.end / BLOCK);
  const cipherStart = HEADER + firstBlock * (BLOCK + tagBytes);
  const cipherEnd = HEADER + lastBlock * (BLOCK + tagBytes) + Math.min(BLOCK, size - lastBlock * BLOCK) + tagBytes - 1;
  let response: Response | undefined;
  try {
    response = await api.mediaResponse(id, `bytes=${cipherStart}-${cipherEnd}`, options.signal); check();
    if (response.status !== 206 || response.headers.get('content-range') !== `bytes ${cipherStart}-${cipherEnd}/${encryptedSize(size)}` || !response.body) throw new Error('INVALID_MEDIA_RANGE');
  } catch (error) { key.fill(0); await response?.body?.cancel(); throw error; }
  const reader = response.body!.getReader(); let buffered = Buffer.alloc(0), index = firstBlock, done = false;
  const dispose = async (reason?: unknown) => { if (!done) { done = true; key.fill(0); await reader.cancel(reason).catch(() => undefined); } };
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        check(); const plainSize = Math.min(BLOCK, size - index * BLOCK), needed = plainSize + tagBytes;
        while (buffered.length < needed) {
          const chunk = await reader.read(); check();
          if (chunk.done) throw new Error('MEDIA_INCOMPLETE');
          buffered = Buffer.concat([buffered, chunk.value]);
          if (buffered.length > BLOCK * 2 + tagBytes * 2) throw new Error('MEDIA_STREAM_OVERFLOW');
        }
        const encrypted = buffered.subarray(0, needed); buffered = buffered.subarray(needed);
        const decipher = createDecipheriv('aes-256-gcm', key, nonceFor(header, index));
        decipher.setAAD(aadFor(header, index)); decipher.setAuthTag(encrypted.subarray(plainSize));
        const plain = Buffer.concat([decipher.update(encrypted.subarray(0, plainSize)), decipher.final()]);
        const from = Math.max(0, selected.start - index * BLOCK), to = Math.min(plain.length, selected.end - index * BLOCK + 1);
        controller.enqueue(plain.subarray(from, to)); index++;
        if (index > lastBlock) { await dispose(); controller.close(); }
      } catch (error) { await dispose(error); controller.error(error); }
    },
    cancel: dispose,
  });
  return new Response(stream, { status: range ? 206 : 200, headers: { 'content-type': contentType, 'content-length': String(selected.end - selected.start + 1),
    'accept-ranges': 'bytes', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...(range ? { 'content-range': `bytes ${selected.start}-${selected.end}/${size}` } : {}) } });
}
