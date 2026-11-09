import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fingerprint, inside } from './files.js';
import { CompanionImportError, type ImportFile, type ImportItem, type ImportResourceRef } from './types.js';
import { createStreamingEnvironmentRedactor, redactEnvironmentValues } from './process.js';
import { inspectSkillFile, skillFileChunks, streamImportSkillFiles, SKILL_RESOURCE_CHUNK_BYTES, type SkillEncoding } from './skillFileStreams.js';

export interface SkillArchiveIo {
  writeResource(botId: string, id: string, chunks: AsyncIterable<string>, assertOwner: () => void): Promise<ImportResourceRef>;
  readResource(ref: ImportResourceRef, assertOwner: () => void): AsyncIterable<string>;
}
interface Header { name: string; size: number; hash: string; encoding: SkillEncoding; executable: boolean; interpreterLink?: string }

function codec(encoding: SkillEncoding) {
  const decoder = new StringDecoder(encoding === 'binary' || encoding === 'utf8' ? 'utf8' : 'utf16le');
  return {
    decode: (bytes: Buffer) => decoder.write(encoding === 'utf16be' ? Buffer.from(bytes).swap16() : bytes),
    end: () => decoder.end(),
    encode(text: string) {
      const bytes = Buffer.from(text, encoding === 'binary' || encoding === 'utf8' ? 'utf8' : 'utf16le');
      return encoding === 'utf16be' ? bytes.swap16() : bytes;
    },
  };
}

/** Capture selected originals directly into the account vault. A stable resource
 * slot per item bounds orphan storage after a crash before checkpoint acceptance. */
export async function captureSkillArchive(botId: string, item: ImportItem, io: SkillArchiveIo, secrets: Record<string, string>, assertOwner: () => void) {
  const matched = new Set<string>();
  const captured = new Map((item.files ?? []).map(file => [file.name, file]));
  let manifest = false;
  async function* records(header: Header, chunks: AsyncIterable<Buffer>): AsyncGenerator<string> {
    if (header.name === 'SKILL.md' && header.size > 0) manifest = true;
    yield JSON.stringify({ file: header });
    const digest = createHash('sha256'); let size = 0;
    const text = codec(header.encoding);
    const redact = createStreamingEnvironmentRedactor(secrets, value => matched.add(value));
    for await (const bytes of chunks) {
      assertOwner(); digest.update(bytes); size += bytes.length;
      if (header.encoding !== 'binary') redact(text.decode(bytes));
      yield JSON.stringify({ data: bytes.toString('base64') });
    }
    if (header.encoding !== 'binary') redact(text.end(), true);
    if (size !== header.size || digest.digest('hex') !== header.hash) throw new CompanionImportError('SOURCE_CHANGED');
    yield JSON.stringify({ end: true });
  }
  async function* inline(file: ImportFile): AsyncGenerator<string> {
    // Legacy snapshots already own the original bytes. Feed them into the same
    // bounded archive without re-reading a possibly edited source file.
    let encoding: SkillEncoding = 'utf8';
    if (file.bytes[0] === 0xff && file.bytes[1] === 0xfe) encoding = 'utf16le';
    else if (file.bytes[0] === 0xfe && file.bytes[1] === 0xff) encoding = 'utf16be';
    if (encoding === 'utf8') {
      try { new TextDecoder('utf-8', { fatal: true }).decode(file.bytes); if (file.bytes.includes(0)) encoding = 'binary'; } catch { encoding = 'binary'; }
    } else if (file.bytes.length % 2) encoding = 'binary';
    async function* chunks() {
      for (let offset = 0; offset < file.bytes.length; offset += SKILL_RESOURCE_CHUNK_BYTES) yield file.bytes.subarray(offset, offset + SKILL_RESOURCE_CHUNK_BYTES);
    }
    yield* records({ name: file.name, executable: file.executable, interpreterLink: file.interpreterLink,
      size: file.bytes.length, hash: createHash('sha256').update(file.bytes).digest('hex'), encoding }, chunks());
  }
  async function* archive() {
    if (item.sourceDirectory && !item.filesComplete) for await (const file of streamImportSkillFiles(item.sourceDirectory, assertOwner)) {
      if (captured.has(file.name)) continue;
      const info = await inspectSkillFile(file.handle, assertOwner);
      yield* records({ name: file.name, executable: file.executable, interpreterLink: file.interpreterLink, ...info }, skillFileChunks(file.handle, assertOwner));
      const stat = await file.handle.stat();
      if (stat.mtimeMs !== info.mtimeMs || stat.ctimeMs !== info.ctimeMs || stat.size !== info.size) throw new CompanionImportError('SOURCE_CHANGED');
    }
    for (const file of captured.values()) yield* inline(file);
    if (!manifest) throw new CompanionImportError('SOURCE_CONFIG_INVALID');
    yield JSON.stringify({ complete: true });
  }
  const ref = await io.writeResource(botId, fingerprint(['skill', item.view.id]), archive(), assertOwner);
  return { ref, redactions: Object.fromEntries(Object.entries(secrets).filter(([, value]) => matched.has(value))) };
}

function validateHeader(value: unknown): Header {
  const h = value as Header;
  if (!h || typeof h.name !== 'string' || !h.name || h.name.includes('\\') || path.isAbsolute(h.name)
    || h.name.split('/').some(part => !part || part === '.' || part === '..')
    || !Number.isSafeInteger(h.size) || h.size < 0 || typeof h.hash !== 'string' || !/^[a-f0-9]{64}$/.test(h.hash)
    || !['utf8', 'utf16le', 'utf16be', 'binary'].includes(h.encoding) || typeof h.executable !== 'boolean'
    || h.interpreterLink !== undefined && (typeof h.interpreterLink !== 'string' || !path.isAbsolute(h.interpreterLink)
      || !/^(?:\.venv|venv)\/(?:bin|Scripts)\/python(?:[23](?:\.\d+)?)?(?:\.exe)?$/.test(h.name))) throw new CompanionImportError('CREDENTIAL_STORAGE_INVALID');
  return h;
}

/** Caller owns a private staging directory. Nothing becomes an active Skill
 * until the final authenticated archive record has been consumed. */
export async function materializeSkillArchive(ref: ImportResourceRef, root: string, io: Pick<SkillArchiveIo, 'readResource'>,
  secrets: Record<string, string>, assertOwner: () => void, project = true, slug = '', onProjection?: (needsPrivate: boolean) => void): Promise<void> {
  let current: { header: Header; handle?: FileHandle; hash: ReturnType<typeof createHash>; size: number; text: ReturnType<typeof codec>; redact: ReturnType<typeof createStreamingEnvironmentRedactor> } | undefined;
  let complete = false, manifest: Header | undefined, changed = false, interpreter = false;
  try {
    for await (const encoded of io.readResource(ref, assertOwner)) {
      assertOwner();
      if (complete) throw new CompanionImportError('CREDENTIAL_STORAGE_INVALID');
      const record = JSON.parse(encoded) as { file?: unknown; data?: unknown; end?: unknown; complete?: unknown };
      if (record.file) {
        if (current) throw new CompanionImportError('CREDENTIAL_STORAGE_INVALID');
        const header = validateHeader(record.file);
        interpreter ||= !!header.interpreterLink;
        const output = path.resolve(root, header.name);
        if (!inside(root, output)) throw new CompanionImportError('INVALID_TARGET');
        await fs.mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
        const parent = await fs.realpath(path.dirname(output));
        if (!inside(await fs.realpath(root), parent)) throw new CompanionImportError('INVALID_TARGET');
        const handle = header.interpreterLink ? undefined : await fs.open(output, 'wx', header.executable ? 0o700 : 0o600);
        current = { header, handle, hash: createHash('sha256'), size: 0, text: codec(header.encoding), redact: createStreamingEnvironmentRedactor(secrets, () => { changed = true; }) };
        if (header.name === 'SKILL.md') { if (manifest || !header.size) throw new CompanionImportError('CREDENTIAL_STORAGE_INVALID'); manifest = header; }
      } else if (typeof record.data === 'string' && current) {
        const bytes = Buffer.from(record.data, 'base64');
        if (bytes.length > SKILL_RESOURCE_CHUNK_BYTES) throw new CompanionImportError('CREDENTIAL_STORAGE_INVALID');
        current.hash.update(bytes); current.size += bytes.length;
        if (current.size > current.header.size) throw new CompanionImportError('CREDENTIAL_STORAGE_INVALID');
        if (current.handle) {
          const output = project && current.header.encoding !== 'binary' ? current.text.encode(current.redact(current.text.decode(bytes))) : bytes;
          await current.handle.writeFile(output);
        }
      } else if (record.end === true && current) {
        if (current.size !== current.header.size || current.hash.digest('hex') !== current.header.hash) throw new CompanionImportError('CREDENTIAL_STORAGE_INVALID');
        if (current.handle) {
          if (project && current.header.encoding !== 'binary') await current.handle.writeFile(current.text.encode(current.redact(current.text.end(), true)));
          await current.handle.close();
        } else await fs.symlink(current.header.interpreterLink!, path.join(root, current.header.name), 'file');
        current = undefined;
      } else if (record.complete === true && !current && manifest) complete = true;
      else throw new CompanionImportError('CREDENTIAL_STORAGE_INVALID');
    }
    assertOwner();
    if (!complete || !manifest) throw new CompanionImportError('CREDENTIAL_STORAGE_INVALID');
    if (project && changed) {
      const guidance = `\n\nImported credentials are masked in these readable files. Execute this skill's commands with companion_connections.run_command, using the original resources at "$CINDY_IMPORTED_SKILLS/${slug}" (Windows cmd: "%CINDY_IMPORTED_SKILLS%\\${slug}") instead of this readable skill directory. Preserve relative resource paths within that directory. Write generated outputs to the current companion workspace.\n`;
      await fs.appendFile(path.join(root, 'SKILL.md'), codec(manifest.encoding).encode(guidance));
    }
    onProjection?.(changed || interpreter);
  } finally { await current?.handle?.close().catch(() => {}); }
}

/** Dependencies remain in the archive, but must not crowd out Skill instructions. */
export function isSkillContextFile(name: string): boolean {
  return /\.(md|py|js|mjs|cjs|sh|ts|json|ya?ml|toml)$/i.test(name)
    && !name.split('/').slice(0, -1).some(part => ['.venv', 'venv', 'node_modules'].includes(part));
}

/** Planning reads bounded, redacted excerpts, but exhausts the authenticated
 * stream before returning any text. It never materializes the resource tree. */
export async function readSkillArchiveContext(ref: ImportResourceRef, io: Pick<SkillArchiveIo, 'readResource'>,
  secrets: Record<string, string>, assertOwner: () => void, label: string, budget: { remaining: number }) {
  const files: Array<{ name: string; source: string; complete: boolean }> = [];
  let current: { header: Header; text: ReturnType<typeof codec>; redact: ReturnType<typeof createStreamingEnvironmentRedactor>;
    entry?: typeof files[number]; remaining: number } | undefined;
  let complete = false;
  // Reserve the entry point's existing per-file allowance regardless of archive
  // order. This is part of the caller's budget, not additional retained memory.
  let manifestReserve = Math.min(budget.remaining, 32000 + redactEnvironmentValues(`${label}/SKILL.md`, secrets).length);
  const available = () => Math.max(0, budget.remaining - manifestReserve);
  const append = (text: string) => {
    if (!current?.entry) return;
    const count = Math.min(text.length, current.remaining, available());
    current.entry.source += text.slice(0, count);
    current.entry.complete &&= count === text.length;
    current.remaining -= count; budget.remaining -= count;
  };
  for await (const encoded of io.readResource(ref, assertOwner)) {
    assertOwner();
    if (complete) throw new CompanionImportError('CREDENTIAL_STORAGE_INVALID');
    const record = JSON.parse(encoded) as { file?: unknown; data?: unknown; end?: unknown; complete?: unknown };
    if (record.file && !current) {
      const header = validateHeader(record.file);
      if (header.name === 'SKILL.md') manifestReserve = 0;
      const name = redactEnvironmentValues(`${label}/${header.name}`, secrets);
      const eligible = header.encoding !== 'binary' && isSkillContextFile(header.name) && name.length < available();
      const entry = eligible ? { name, source: '', complete: true } : undefined;
      if (entry) budget.remaining -= name.length;
      current = { header, text: codec(header.encoding), redact: createStreamingEnvironmentRedactor(secrets), entry, remaining: 32000 };
    } else if (typeof record.data === 'string' && current) {
      if (current.entry && current.remaining > 0 && available() > 0) append(current.redact(current.text.decode(Buffer.from(record.data, 'base64'))));
      else if (current.entry) current.entry.complete = false;
    } else if (record.end === true && current) {
      // Flush only a complete prefix; never expose a credential cut by a limit.
      if (current.entry?.complete) append(current.redact(current.text.end(), true));
      if (current.entry?.source) files.push(current.entry);
      current = undefined;
    } else if (record.complete === true && !current) complete = true;
    else throw new CompanionImportError('CREDENTIAL_STORAGE_INVALID');
  }
  if (!complete || current) throw new CompanionImportError('CREDENTIAL_STORAGE_INVALID');
  return files;
}
