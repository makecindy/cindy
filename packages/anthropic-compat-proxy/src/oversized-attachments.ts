import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, open, rm, statfs, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { IncomingMessage } from 'node:http';

export interface OversizedBody {
  filePath: string;
  bytes: number;
  signal: AbortSignal;
  /** Account for decoded/published file allocation overhead while recovery is active. */
  reserveAttachment?: () => Promise<void>;
}

export interface RecoveredAttachment {
  filePath: string;
  mimeType: string;
  filename?: string;
}

export interface AttachmentKeeper {
  /** Prepare a path without publishing files or references. */
  prepare(attachment: RecoveredAttachment): Promise<string>;
  /** Publish the prepared batch; undo its own partial writes if it fails. */
  commit(): Promise<void>;
}

// Reserve room for the request, tokenized strings, decoded files and publication.
// All concurrent recoveries share this budget; it is based on free disk, not an
// arbitrary attachment size. Leave 256 MiB available to the rest of the app.
const DISK_RESERVE_BYTES = 256 * 1024 * 1024;
let reservedDiskBytes = 0;
let diskAdmission: Promise<unknown> = Promise.resolve();
async function reserveDisk(bytes: number): Promise<number> {
  const operation = diskAdmission.then(async () => {
    const disk = await statfs(tmpdir());
    const available = disk.bavail * disk.bsize - DISK_RESERVE_BYTES;
    if (bytes + reservedDiskBytes > available) throw new Error('RECOVERY_STORAGE_EXHAUSTED');
    reservedDiskBytes += bytes;
    return disk.bsize;
  });
  diskAdmission = operation.catch(() => undefined);
  return operation;
}

/** Normal requests remain byte-for-byte unchanged. Only overflow spills to disk. */
export async function collectRecoverableBody(
  req: IncomingMessage,
  limit: number,
  recover: (body: OversizedBody) => Promise<Buffer | null>,
  signal: AbortSignal,
): Promise<Buffer> {
  let chunks: Buffer[] = [];
  let bytes = 0;
  let directory: string | undefined;
  let file: FileHandle | undefined;
  let filePath = '';
  let reserved = 0;
  let allocationUnit = 0;
  try {
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      signal.throwIfAborted();
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > limit) {
        const required = bytes * 4 - reserved;
        allocationUnit = await reserveDisk(required);
        reserved += required;
      }
      if (!file && bytes > limit) {
        directory = await mkdtemp(path.join(tmpdir(), 'cindy-request-'));
        filePath = path.join(directory, 'body.json');
        file = await open(filePath, 'wx', 0o600);
        for (const previous of chunks) await file.writeFile(previous);
        chunks = [];
      }
      if (file) await file.writeFile(buffer);
      else chunks.push(buffer);
    }
    if (!file) return Buffer.concat(chunks, bytes);
    await file.close();
    file = undefined;
    signal.throwIfAborted();
    const result = await recover({ filePath, bytes, signal, reserveAttachment: async () => {
      const overhead = allocationUnit * 2;
      await reserveDisk(overhead);
      reserved += overhead;
    } });
    signal.throwIfAborted();
    if (!result || result.length > limit) throw new Error('REQUEST_TOO_LARGE');
    return result;
  } finally {
    try { await file?.close(); }
    finally {
      try { if (directory) await rm(directory, { recursive: true, force: true }); }
      finally { reservedDiskBytes -= reserved; }
    }
  }
}

interface StringPart { path: string; start: number; bytes: number; prefix: string }
interface TokenizedBody { json: string; parts: Map<string, StringPart> }
const STRING_MEMORY_BYTES = 64 * 1024;

/**
 * Index attachment and long JSON strings as ranges in the request spool before
 * JSON.parse (not one temporary file per small string). No image or oversized
 * request is materialized in RAM. Random markers cannot collide with input text.
 * The original request file is retained until recovery has completely finished.
 */
async function tokenizeStrings(body: OversizedBody, limit: number): Promise<TokenizedBody> {
  const prefix = `cindy-spilled-${randomUUID()}-`;
  const parts = new Map<string, StringPart>();
  const output: string[] = [];
  let outputBytes = 0;
  let quoted = false;
  let escaped = false;
  let stringChunks: string[] = [];
  let stringBytes = 0;
  let stringPrefix = '';
  let spilled = false;
  let stringStart = 0;
  let chunkStart = 0;
  let previousString = '';
  let lastDelimiter = '';
  let attachmentValue = false;
  const attachmentKeys = new Set(['image_url', 'url', 'file_data', 'data']);
  const emit = (text: string) => {
    outputBytes += Buffer.byteLength(text);
    if (outputBytes > limit) throw new Error('REQUEST_TOO_LARGE');
    output.push(text);
  };
  const append = (text: string) => {
    stringPrefix = (stringPrefix + text.slice(0, 16)).slice(0, 16);
    stringBytes += Buffer.byteLength(text);
    if (attachmentValue || stringBytes > STRING_MEMORY_BYTES) {
      spilled = true;
      stringChunks = [];
    }
    if (!spilled) stringChunks.push(text);
  };
  for await (const chunk of createReadStream(body.filePath, { encoding: 'utf8' })) {
    body.signal.throwIfAborted();
    const text = String(chunk);
    let start = 0;
    // Scan only JSON delimiters, not every base64 character.
    const delimiters = /["\\]/g;
    let match: RegExpExecArray | null;
    while ((match = delimiters.exec(text))) {
      const index = match.index;
      if (!quoted) {
        if (match[0] !== '"') continue;
        const between = text.slice(start, index);
        emit(between);
        const delimiter = between.trim().at(-1) ?? lastDelimiter;
        attachmentValue = delimiter === ':' && attachmentKeys.has(previousString);
        stringStart = chunkStart + Buffer.byteLength(text.slice(0, index + 1));
        quoted = true;
        escaped = false;
        start = index + 1;
      } else {
        if (escaped && index === start) { escaped = false; continue; }
        // An escape only affects the immediately following character.
        if (escaped) escaped = false;
        if (match[0] === '\\') {
          append(text.slice(start, index + 1));
          start = index + 1;
          escaped = true;
        } else {
          append(text.slice(start, index));
          if (spilled) {
            spilled = false;
            const marker = `${prefix}${parts.size}`;
            parts.set(marker, { path: body.filePath, start: stringStart, bytes: stringBytes, prefix: stringPrefix });
            emit(JSON.stringify(marker));
            previousString = '';
          } else {
            const raw = `"${stringChunks.join('')}"`;
            emit(raw);
            previousString = JSON.parse(raw) as string;
          }
          lastDelimiter = '';
          stringChunks = [];
          stringBytes = 0;
          stringPrefix = '';
          quoted = false;
          start = index + 1;
        }
      }
    }
    if (quoted) {
      if (start < text.length) escaped = false;
      append(text.slice(start));
    } else {
      const tail = text.slice(start);
      emit(tail);
      lastDelimiter = tail.trim().at(-1) ?? lastDelimiter;
    }
    chunkStart += Buffer.byteLength(text);
  }
  if (quoted) throw new Error('Invalid JSON string');
  return { json: output.join(''), parts };
}

type RecordValue = Record<string, unknown>;
const record = (v: unknown): v is RecordValue => !!v && typeof v === 'object' && !Array.isArray(v);
interface Candidate { parent: unknown[]; index: number; marker: string; mimeType: string; filename?: string; textType: string }

function findCandidates(value: unknown, parts: Map<string, StringPart>, result: Candidate[]): void {
  if (Array.isArray(value)) {
    for (const [index, child] of value.entries()) {
      if (record(child)) {
        let data: unknown;
        let mimeType = 'application/octet-stream';
        let textType = 'text';
        if (child.type === 'input_image') { data = child.image_url; textType = 'input_text'; }
        else if (child.type === 'image_url') data = record(child.image_url) ? child.image_url.url : child.image_url;
        else if (child.type === 'input_file') { data = child.file_data; textType = 'input_text'; }
        else if (child.type === 'file' && record(child.file)) data = child.file.file_data;
        else if ((child.type === 'image' || child.type === 'document') && record(child.source) && child.source.type === 'base64') {
          data = child.source.data;
          if (typeof child.source.media_type === 'string') mimeType = child.source.media_type;
        } else if (child.type === 'input_audio' && record(child.input_audio)) {
          data = child.input_audio.data;
          if (typeof child.input_audio.format === 'string') mimeType = `audio/${child.input_audio.format}`;
        } else if (child.type === 'video_url' && record(child.video_url)) data = child.video_url.url;
        if (typeof data === 'string' && parts.has(data) && !/^https?:/i.test(parts.get(data)!.prefix)) {
          result.push({ parent: value, index, marker: data, mimeType, textType,
            filename: typeof child.filename === 'string' ? child.filename : undefined });
          continue;
        }
      }
      findCandidates(child, parts, result);
    }
  } else if (record(value)) {
    for (const child of Object.values(value)) findCandidates(child, parts, result);
  }
}

/** Decode canonical base64 incrementally; never accept Node's permissive truncation. */
async function decodeAttachment(part: StringPart, dest: string, signal: AbortSignal): Promise<string | undefined> {
  if (!part.bytes) throw new Error('Invalid attachment base64');
  const file = await open(dest, 'wx', 0o600);
  let prefix = '';
  let started = false;
  let mime: string | undefined;
  let pending = '';
  try {
    for await (const raw of createReadStream(part.path, { encoding: 'utf8', start: part.start, end: part.start + part.bytes - 1 })) {
      signal.throwIfAborted();
      let chunk = String(raw);
      // Native JSON encoders use unescaped base64. Refuse other representations
      // rather than silently producing a corrupted local attachment.
      if (chunk.includes('\\')) throw new Error('Unsupported escaped attachment encoding');
      if (!started) {
        prefix += chunk;
        if (prefix.startsWith('data:')) {
          const comma = prefix.indexOf(',');
          if (comma === -1) {
            if (prefix.length > 1024) throw new Error('Invalid attachment data URL');
            continue;
          }
          const header = /^data:([\w.+/-]+);base64$/i.exec(prefix.slice(0, comma));
          if (!header) throw new Error('Invalid attachment data URL');
          mime = header[1];
          chunk = prefix.slice(comma + 1);
        } else chunk = prefix;
        prefix = '';
        started = true;
      }
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(chunk)) throw new Error('Invalid attachment base64');
      pending += chunk;
      const length = Math.max(0, Math.floor(pending.length / 4) * 4 - 4);
      if (length) {
        const group = pending.slice(0, length);
        if (group.includes('=')) throw new Error('Invalid base64 padding');
        await file.writeFile(Buffer.from(group, 'base64'));
        pending = pending.slice(length);
      }
    }
    if (!started || !pending || pending.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(pending)) {
      throw new Error('Invalid attachment base64');
    }
    const tail = Buffer.from(pending, 'base64');
    if (tail.toString('base64') !== pending) throw new Error('Invalid attachment base64');
    await file.writeFile(tail);
    return mime;
  } finally { await file.close(); }
}

/** Only called after a real byte overflow. Original native history is never edited. */
export async function recoverInlineAttachments(
  body: OversizedBody,
  targetBytes: number,
  keep: AttachmentKeeper,
): Promise<Buffer | null> {
  if (body.bytes <= targetBytes) return null;
  const directory = await mkdtemp(path.join(tmpdir(), 'cindy-attachment-recovery-'));
  try {
    const { json, parts } = await tokenizeStrings(body, targetBytes);
    const value: unknown = JSON.parse(json);
    const candidates: Candidate[] = [];
    // Only model-visible conversation content; never tool schemas or instructions.
    if (record(value)) {
      if (Array.isArray(value.input)) findCandidates(value.input, parts, candidates);
      if (Array.isArray(value.messages)) findCandidates(value.messages, parts, candidates);
    }
    let estimatedBytes = body.bytes;
    let replaced = 0;
    for (const candidate of candidates) {
      if (estimatedBytes <= targetBytes) break;
      body.signal.throwIfAborted();
      const part = parts.get(candidate.marker)!;
      await body.reserveAttachment?.();
      const dest = path.join(directory, `attachment-${replaced}`);
      const mime = await decodeAttachment(part, dest, body.signal);
      const localPath = await keep.prepare({ filePath: dest, mimeType: mime ?? candidate.mimeType, filename: candidate.filename });
      body.signal.throwIfAborted();
      if (!localPath || !path.isAbsolute(localPath)) throw new Error('Attachment recovery requires a local absolute path');
      const text = `Attachment moved out of model context because the request exceeded its size limit. Preserved local file: ${JSON.stringify(localPath)}. Read the file when needed; its contents are not visible in this message.`;
      const replacement = { type: candidate.textType, text };
      const oldBytes = Buffer.byteLength(JSON.stringify(candidate.parent[candidate.index]))
        + part.bytes - Buffer.byteLength(candidate.marker);
      candidate.parent[candidate.index] = replacement;
      estimatedBytes -= oldBytes - Buffer.byteLength(JSON.stringify(replacement));
      replaced++;
    }
    if (!replaced || estimatedBytes > targetBytes) return null;
    // Restore every untouched string exactly; the recovered body remains bounded.
    let output = JSON.stringify(value);
    for (const [marker, part] of parts) {
      const needle = JSON.stringify(marker);
      if (!output.includes(needle)) continue;
      if (Buffer.byteLength(output) - Buffer.byteLength(needle) + part.bytes + 2 > targetBytes) return null;
      let raw = '';
      if (part.bytes) {
        for await (const chunk of createReadStream(part.path, { encoding: 'utf8', start: part.start, end: part.start + part.bytes - 1 })) raw += chunk;
      }
      output = output.replace(needle, () => `"${raw}"`);
    }
    const result = Buffer.from(output);
    if (result.length > targetBytes) return null;
    body.signal.throwIfAborted();
    await keep.commit();
    return result;
  } finally { await rm(directory, { recursive: true, force: true }); }
}
