import { copyFile, lstat, mkdir, realpath, chmod, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { UserContentBlock, UserMessage } from '@cindy/maker-core';
import { isAttachmentOssRef, parseAttachmentOssRef } from '@cindy/device-link';
import { HeadlessMediaService } from './media-service.js';

const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;

type DeviceLinkMediaAccess = {
  deviceLinkApiBase(): string | null;
  getAccessToken(): Promise<string | null>;
  fetch?: typeof fetch;
};

/**
 * Owns terminal-provided attachments for the lifetime of a headless session.
 * We copy rather than pass the SSH client's source path to an agent: a
 * disconnected shell, editor rewrite, or removable mount must not silently
 * change an already accepted turn's input.
 */
export class HeadlessAttachmentService {
  constructor(
    private readonly rootDir: string,
    private readonly mediaAccess?: DeviceLinkMediaAccess,
    private readonly media?: HeadlessMediaService,
  ) {}

  /** Replace host-private image paths with stable, remote-fetchable URLs for history/UI persistence. */
  toDisplayContent(content: string | UserMessage): unknown {
    if (typeof content === 'string' || !Array.isArray(content.content)) return content;
    const text: string[] = [];
    const images: Array<{ url: string; mimeType?: string; originalName?: string }> = [];
    const files: Array<{ path: string; mimeType?: string }> = [];
    for (const block of content.content) {
      if (block.type === 'text' && typeof block.text === 'string') text.push(block.text);
      if ((block.type !== 'image' && block.type !== 'file') || typeof block.path !== 'string') continue;
      const url = this.displayUrls.get(block.path);
      if (block.type === 'image' && url) {
        images.push({ url, ...(typeof block.mimeType === 'string' ? { mimeType: block.mimeType } : {}) });
      } else if (block.type === 'file') {
        files.push({ path: block.path, ...(typeof block.mimeType === 'string' ? { mimeType: block.mimeType } : {}) });
      }
    }
    return { text: text.join('\n'), ...(images.length ? { images } : {}), ...(files.length ? { files } : {}) };
  }

  /** One-time compatibility projection for records written before cindy-media URLs existed. */
  async migrateDisplayContent(content: unknown): Promise<unknown> {
    const message = content && typeof content === 'object' && !Array.isArray(content)
      ? content as Partial<UserMessage>
      : null;
    if (!message || message.type !== 'user' || !Array.isArray(message.content) || !this.media) return content;
    let changed = false;
    for (const block of message.content) {
      if (block?.type !== 'image' || typeof block.path !== 'string' || this.displayUrls.has(block.path)) continue;
      if (!path.isAbsolute(block.path)) continue;
      try {
        const imported = await this.media.ingestFile(block.path, typeof block.mimeType === 'string' ? block.mimeType : undefined);
        this.displayUrls.set(imported.absPath, imported.url);
        this.displayUrls.set(block.path, imported.url);
        changed = true;
      } catch {
        // A missing or unsupported legacy image must not block daemon startup.
      }
    }
    return changed ? this.toDisplayContent(message as UserMessage) : content;
  }

  private readonly displayUrls = new Map<string, string>();

  async normalize(sessionId: string, content: unknown): Promise<string | UserMessage> {
    if (typeof content === 'string') {
      if (!content.trim()) throw new Error('content must be a non-empty string');
      return content;
    }
    if (!content || typeof content !== 'object' || Array.isArray(content)) throw new Error('content must be text or a user message');
    const message = content as Partial<UserMessage>;
    if (message.type !== 'user' || !Array.isArray(message.content)) throw new Error('content must be a user message');
    const blocks: UserContentBlock[] = [];
    let hasText = false;
    for (const raw of message.content) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid content block');
      const block = raw as Record<string, unknown>;
      if (block.type === 'text') {
        if (typeof block.text !== 'string' || !block.text.trim()) throw new Error('text block must be non-empty');
        blocks.push({ type: 'text', text: block.text });
        hasText = true;
        continue;
      }
      if (block.type !== 'file' && block.type !== 'image') throw new Error(`unsupported content block: ${String(block.type)}`);
      if (typeof block.path !== 'string' || (!path.isAbsolute(block.path) && !isAttachmentOssRef(block.path))) {
        throw new Error('attachment path must be absolute');
      }
      if (block.mimeType !== undefined && typeof block.mimeType !== 'string') throw new Error('attachment mimeType must be a string');
      blocks.push({
        type: block.type,
        path: await this.importFile(sessionId, block.path, block.type, typeof block.mimeType === 'string' ? block.mimeType : undefined),
        ...(typeof block.mimeType === 'string' ? { mimeType: block.mimeType } : {}),
      });
    }
    if (!hasText && blocks.length === 0) throw new Error('message must contain text or an attachment');
    return { type: 'user', content: blocks };
  }

  /** Materialize the queued Mobile payload into the maker-core user-message shape. */
  async normalizeQueued(sessionId: string, payload: Record<string, unknown>): Promise<string | UserMessage> {
    const text = typeof payload.text === 'string' ? payload.text.trim() : '';
    const files = Array.isArray(payload.files) ? payload.files : [];
    if (files.length === 0) {
      if (!text) throw new Error('queued message must contain text or an attachment');
      return text;
    }
    const content: Array<Record<string, unknown>> = [];
    if (text) content.push({ type: 'text', text });
    for (const raw of files) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid queued attachment');
      const file = raw as Record<string, unknown>;
      if (typeof file.path !== 'string' || !file.path) throw new Error('queued attachment path is required');
      const mimeType = typeof file.mimeType === 'string' ? file.mimeType : undefined;
      const category = typeof file.category === 'string' ? file.category : '';
      content.push({
        type: category === 'image' || mimeType?.startsWith('image/') ? 'image' : 'file',
        path: file.path,
        ...(mimeType ? { mimeType } : {}),
      });
    }
    return this.normalize(sessionId, { type: 'user', content });
  }

  private async importFile(sessionId: string, source: string, kind: 'image' | 'file', mimeType?: string): Promise<string> {
    if (isAttachmentOssRef(source)) return this.downloadDeviceLinkAttachment(sessionId, source, kind, mimeType);
    const resolved = await realpath(source);
    const stat = await lstat(resolved);
    if (!stat.isFile()) throw new Error(`attachment is not a regular file: ${source}`);
    if (stat.size > MAX_ATTACHMENT_BYTES) throw new Error(`attachment exceeds ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MiB limit`);
    if (kind === 'image' && this.media) {
      const imported = await this.media.ingestFile(resolved, mimeType);
      this.displayUrls.set(imported.absPath, imported.url);
      return imported.absPath;
    }
    const destinationDir = path.join(this.rootDir, safeSegment(sessionId));
    await mkdir(destinationDir, { recursive: true, mode: 0o700 });
    await chmod(destinationDir, 0o700);
    const extension = path.extname(resolved).slice(0, 16);
    const destination = path.join(destinationDir, `${randomUUID()}${extension}`);
    await copyFile(resolved, destination);
    await chmod(destination, 0o600);
    return destination;
  }

  /**
   * A phone cannot hand Linux a local filename. It uploads bytes to the
   * account-scoped Device Link media store; Linux obtains a short-lived GET
   * URL, verifies the sender's integrity declaration and stores a private
   * session copy before the agent starts. Bytes never travel in relay frames.
   */
  private async downloadDeviceLinkAttachment(sessionId: string, source: string, kind: 'image' | 'file', mimeType?: string): Promise<string> {
    const ref = parseAttachmentOssRef(source);
    if (!ref) throw new Error('invalid Device Link attachment reference');
    const access = this.mediaAccess;
    const baseUrl = access?.deviceLinkApiBase();
    const token = access ? await access.getAccessToken() : null;
    if (!access || !baseUrl || !token) throw new Error('Device Link media download requires a signed-in Cindy account');
    const fetchImpl = access.fetch ?? fetch;
    const response = await fetchImpl(`${trimTrailingSlash(baseUrl)}/api/device-link/media/presign-get`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: ref.ossKey }),
    });
    if (!response.ok) throw new Error(`Device Link media authorization failed (${response.status})`);
    const value = await response.json() as { getUrl?: unknown };
    if (typeof value.getUrl !== 'string' || !value.getUrl) throw new Error('Device Link media response is invalid');
    const media = await fetchImpl(value.getUrl);
    if (!media.ok) throw new Error(`Device Link media download failed (${media.status})`);
    const bytes = Buffer.from(await media.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_ATTACHMENT_BYTES) {
      throw new Error(`attachment must be between 1 byte and ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MiB`);
    }
    if (ref.size !== undefined && bytes.byteLength !== ref.size) throw new Error('attachment size verification failed');
    if (ref.sha256 && createHash('sha256').update(bytes).digest('hex') !== ref.sha256) {
      throw new Error('attachment checksum verification failed');
    }
    if (kind === 'image' && this.media) {
      const imported = await this.media.ingestBytes(bytes, ref.mimeType ?? mimeType ?? '');
      this.displayUrls.set(imported.absPath, imported.url);
      void this.removeRemote(ref.ossKey, access, token);
      return imported.absPath;
    }
    const destinationDir = path.join(this.rootDir, safeSegment(sessionId));
    await mkdir(destinationDir, { recursive: true, mode: 0o700 });
    await chmod(destinationDir, 0o700);
    const extension = path.extname(ref.originalName ?? '').slice(0, 16);
    const destination = path.join(destinationDir, `${randomUUID()}${extension}`);
    await writeFile(destination, bytes, { mode: 0o600 });
    await chmod(destination, 0o600);
    void this.removeRemote(ref.ossKey, access, token);
    return destination;
  }

  private async removeRemote(key: string, access: DeviceLinkMediaAccess, token: string): Promise<void> {
    const baseUrl = access.deviceLinkApiBase();
    if (!baseUrl) return;
    await (access.fetch ?? fetch)(`${trimTrailingSlash(baseUrl)}/api/device-link/media`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key }),
    }).catch(() => undefined);
  }
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function safeSegment(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error('invalid session id for attachment');
  return value;
}
