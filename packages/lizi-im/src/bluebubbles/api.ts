/** BlueBubbles REST transport. Credentials never leave the configured origin. */
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
export interface BlueBubblesAttachment {
  guid: string;
  transferName?: string;
  mimeType?: string;
  totalBytes?: number;
}

export interface BlueBubblesChat {
  guid: string;
  displayName?: string;
  participants?: Array<{ address: string; service?: string }>;
}

export interface BlueBubblesMessage {
  guid: string;
  text?: string | null;
  isFromMe: boolean;
  service?: string | null;
  tempGuid?: string;
  error?: number | string;
  dateCreated: number;
  handle?: { address: string; service?: string };
  chats?: BlueBubblesChat[];
  attachments?: BlueBubblesAttachment[];
  threadOriginatorGuid?: string;
  associatedMessageGuid?: string;
  associatedMessageType?: number;
  replyToGuid?: string | null;
  attributedBody?: unknown;
}

const WITH_MESSAGE = 'chats,chats.participants,attachments,attributed-body';
export const BLUEBUBBLES_MAX_BYTES = 64 * 1024 * 1024;
/** On-request original downloads stream to disk; only a runaway transfer is cut off. */
export const BLUEBUBBLES_ORIGINAL_MAX_BYTES = 4 * 1024 * 1024 * 1024;

export function blueBubblesOrigin(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
    || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw new Error('BLUEBUBBLES_INVALID_ORIGIN');
  }
  return url.origin;
}

export class BlueBubblesApiError extends Error {
  constructor(readonly code: string) { super(code); }
}

export const AUTOMATION_DENIED = 'BLUEBUBBLES_AUTOMATION_DENIED';

async function readResponseBytes(response: Response, limit: number): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) throw new BlueBubblesApiError('BLUEBUBBLES_EMPTY_RESPONSE');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new BlueBubblesApiError('BLUEBUBBLES_RESPONSE_TOO_LARGE');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  return Buffer.concat(chunks);
}

// BlueBubbles 1.9.9 wraps osascript stderr in error.message. The preceding
// command may contain the entire chat and message. Only inspect the diagnostic
// line, never expose or persist the body or use echoed command arguments.
async function sendHttpError(response: Response, path: string): Promise<BlueBubblesApiError> {
  const fallback = new BlueBubblesApiError(`BLUEBUBBLES_HTTP_${response.status}`);
  if (response.status !== 500 || !['/api/v1/message/text', '/api/v1/message/attachment'].includes(path)) return fallback;
  try {
    const bytes = await readResponseBytes(response, 64 * 1024);
    const envelope = JSON.parse(bytes.toString('utf8'));
    const detail = envelope?.error?.message;
    const lastLine = typeof detail === 'string' ? detail.trimEnd().split('\n').pop() : '';
    if (envelope?.status === 500 && envelope.error?.type === 'iMessage Error'
      && /^(?:\d+:\d+: )?execution error: [^\r\n]+\(-1743\)$/.test(lastLine ?? '')) {
      return new BlueBubblesApiError(AUTOMATION_DENIED);
    }
  } catch { /* A missing or malformed diagnostic leaves delivery uncertain. */ }
  return fallback;
}

export class BlueBubblesApi {
  readonly origin: string;
  private groupSendMethod: 'apple-script' | 'private-api' = 'apple-script';
  constructor(origin: string, private readonly password: string, private readonly fetcher: typeof fetch = fetch) {
    this.origin = blueBubblesOrigin(origin);
    if (!password) throw new BlueBubblesApiError('BLUEBUBBLES_PASSWORD_REQUIRED');
  }

  async request<T>(method: string, path: string, body?: unknown, binary = false, timeoutMs = 30_000): Promise<T> {
    if (!path.startsWith('/api/v1/') || path.includes('#')) throw new BlueBubblesApiError('BLUEBUBBLES_INVALID_ROUTE');
    const url = new URL(path, this.origin);
    url.searchParams.set('password', this.password);
    try {
      const response = await this.fetcher(url, {
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
        ...(body instanceof FormData ? { body } : body === undefined ? {} : {
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        }),
      });
      if (!response.ok) throw await sendHttpError(response, path);
      const bytes = await readResponseBytes(response, BLUEBUBBLES_MAX_BYTES);
      if (binary) return bytes as T;
      const result = JSON.parse(bytes.toString('utf8')) as { status?: number; data?: T };
      if (result.status !== undefined && result.status !== 200) throw new BlueBubblesApiError('BLUEBUBBLES_API_ERROR');
      if (method !== 'DELETE' && !Object.hasOwn(result, 'data')) throw new BlueBubblesApiError('BLUEBUBBLES_INVALID_RESPONSE');
      return result.data as T;
    } catch (error) {
      // fetch errors may contain the query password, remote text or URL.
      if (error instanceof BlueBubblesApiError) throw error;
      throw new BlueBubblesApiError('BLUEBUBBLES_REQUEST_FAILED');
    }
  }

  async info(): Promise<{ server_version?: string; private_api?: boolean; helper_connected?: boolean }> {
    const info = await this.request<{server_version?: string; private_api?: boolean; helper_connected?: boolean}>('GET', '/api/v1/server/info');
    this.groupSendMethod = info.private_api === true && info.helper_connected === true ? 'private-api' : 'apple-script';
    return info;
  }
  iMessageAccount(): Promise<{ vetted_aliases?: unknown } | null> {
    return this.request('GET', '/api/v1/icloud/account', undefined, false, 2_000);
  }
  message(guid: string): Promise<BlueBubblesMessage> {
    return this.request('GET', `/api/v1/message/${encodeURIComponent(guid)}?with=${WITH_MESSAGE}`);
  }
  chat(guid: string): Promise<BlueBubblesChat> {
    return this.request('GET', `/api/v1/chat/${encodeURIComponent(guid)}?with=participants`);
  }
  history(chatGuid: string, after: number, before: number, offset = 0): Promise<BlueBubblesMessage[]> {
    return this.request('POST', '/api/v1/message/query', {
      chatGuid, after, before, offset, limit: 100, sort: 'ASC', with: WITH_MESSAGE.split(','),
    });
  }
  download(guid: string): Promise<Uint8Array> {
    return this.request('GET', `/api/v1/attachment/${encodeURIComponent(guid)}/download?original=true`, undefined, true);
  }
  /** Stream the stored original to `dest` (written via a temporary file); returns the byte count. */
  async downloadToFile(guid: string, dest: string, limit = BLUEBUBBLES_ORIGINAL_MAX_BYTES, timeoutMs = 15 * 60_000): Promise<number> {
    const url = new URL(`/api/v1/attachment/${encodeURIComponent(guid)}/download?original=true`, this.origin);
    url.searchParams.set('password', this.password);
    // Each download writes its own file; concurrent downloads of one original never share it.
    const partial = `${dest}.${randomUUID()}.partial`;
    let size = 0;
    try {
      const response = await this.fetcher(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) throw new BlueBubblesApiError(`BLUEBUBBLES_HTTP_${response.status}`);
      if (!response.body) throw new BlueBubblesApiError('BLUEBUBBLES_EMPTY_RESPONSE');
      const counted = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream).on('data', (chunk: Buffer) => {
        size += chunk.byteLength;
        if (size > limit) counted.destroy(new BlueBubblesApiError('BLUEBUBBLES_RESPONSE_TOO_LARGE'));
      });
      await pipeline(counted, createWriteStream(partial, { mode: 0o600, flags: 'wx' }));
      // Windows may briefly lock the destination during another rename or a scanner read.
      // Retry atomic replacement only; never unlink the existing original to make room.
      const backoff = [10, 20, 40, 80, 160];
      for (let attempt = 0; ; attempt += 1) {
        try {
          await fs.rename(partial, dest);
          break;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException | null)?.code;
          const delay = backoff[attempt];
          if (delay === undefined || !code || !['EPERM', 'EACCES', 'EBUSY'].includes(code)) throw error;
          await new Promise<void>(resolve => setTimeout(resolve, delay));
        }
      }
      return size;
    } catch (error) {
      await fs.rm(partial, { force: true }).catch(() => {});
      // fetch errors may contain the query password, remote text or URL.
      if (error instanceof BlueBubblesApiError) throw error;
      throw new BlueBubblesApiError('BLUEBUBBLES_REQUEST_FAILED');
    }
  }
  sendText(chatGuid: string, message: string, tempGuid: string): Promise<{ guid: string }> {
    return this.request('POST', '/api/v1/message/text', { chatGuid, message, tempGuid, method: chatGuid.split(';')[1] === '+' ? this.groupSendMethod : 'apple-script' });
  }
  sendFile(chatGuid: string, data: Uint8Array, name: string, tempGuid: string): Promise<{ guid: string }> {
    if (data.byteLength > BLUEBUBBLES_MAX_BYTES) throw new BlueBubblesApiError('BLUEBUBBLES_FILE_TOO_LARGE');
    const form = new FormData();
    form.set('chatGuid', chatGuid);
    form.set('tempGuid', tempGuid);
    form.set('method', chatGuid.split(';')[1] === '+' ? this.groupSendMethod : 'apple-script');
    // BlueBubbles validates this field separately from the multipart filename.
    form.set('name', name);
    form.set('attachment', new Blob([new Uint8Array(data)]), name);
    return this.request('POST', '/api/v1/message/attachment', form);
  }
  async unregisterWebhook(url: string): Promise<void> {
    const rows = await this.request<Array<{ id: number; url: string }>>('GET', '/api/v1/webhook');
    if (!Array.isArray(rows)) throw new BlueBubblesApiError('BLUEBUBBLES_INVALID_WEBHOOKS');
    for (const row of rows.filter(item => item.url === url)) {
      if (!Number.isSafeInteger(row.id) || row.id <= 0) throw new BlueBubblesApiError('BLUEBUBBLES_INVALID_WEBHOOK');
      await this.request('DELETE', `/api/v1/webhook/${row.id}`);
    }
  }
  async registerWebhook(url: string): Promise<void> {
    // BlueBubbles 1.9.9 fails when filtering by URL. Read and compare locally.
    const rows = await this.request<Array<{ url: string; events: Array<string | { value: string }> }>>('GET', '/api/v1/webhook');
    if (!Array.isArray(rows)) throw new BlueBubblesApiError('BLUEBUBBLES_INVALID_WEBHOOKS');
    const existing = rows.filter(row => row.url === url);
    if (existing.length === 1 && existing[0]!.events.some(event =>
      ['new-message', '*'].includes(typeof event === 'string' ? event : event.value))) return;
    if (existing.length) throw new BlueBubblesApiError('BLUEBUBBLES_WEBHOOK_CONFLICT');
    await this.request('POST', '/api/v1/webhook', { url, events: ['new-message'] });
    const verified = await this.request<Array<{ url: string }>>('GET', '/api/v1/webhook');
    if (!Array.isArray(verified) || verified.filter(row => row.url === url).length !== 1) throw new BlueBubblesApiError('BLUEBUBBLES_WEBHOOK_NOT_REGISTERED');
  }
}
