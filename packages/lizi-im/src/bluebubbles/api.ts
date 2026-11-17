/** BlueBubbles REST transport. Credentials never leave the configured origin. */
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
  dateCreated: number;
  handle?: { address: string; service?: string };
  chats?: BlueBubblesChat[];
  attachments?: BlueBubblesAttachment[];
  associatedMessageGuid?: string;
  associatedMessageType?: number;
}

const WITH_MESSAGE = 'chats,chats.participants,attachments,attributed-body';
export const BLUEBUBBLES_MAX_BYTES = 64 * 1024 * 1024;

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

export class BlueBubblesApi {
  readonly origin: string;
  constructor(origin: string, private readonly password: string, private readonly fetcher: typeof fetch = fetch) {
    this.origin = blueBubblesOrigin(origin);
    if (!password) throw new BlueBubblesApiError('BLUEBUBBLES_PASSWORD_REQUIRED');
  }

  async request<T>(method: string, path: string, body?: unknown, binary = false): Promise<T> {
    if (!path.startsWith('/api/v1/') || path.includes('#')) throw new BlueBubblesApiError('BLUEBUBBLES_INVALID_ROUTE');
    const url = new URL(path, this.origin);
    url.searchParams.set('password', this.password);
    try {
      const response = await this.fetcher(url, {
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
        ...(body instanceof FormData ? { body } : body === undefined ? {} : {
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        }),
      });
      if (!response.ok) throw new BlueBubblesApiError(`BLUEBUBBLES_HTTP_${response.status}`);
      const reader = response.body?.getReader();
      if (!reader) throw new BlueBubblesApiError('BLUEBUBBLES_EMPTY_RESPONSE');
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.byteLength;
          if (size > BLUEBUBBLES_MAX_BYTES) throw new BlueBubblesApiError('BLUEBUBBLES_RESPONSE_TOO_LARGE');
          chunks.push(next.value);
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      const bytes = Buffer.concat(chunks);
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

  info(): Promise<{ server_version?: string }> { return this.request('GET', '/api/v1/server/info'); }
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
  sendText(chatGuid: string, message: string, tempGuid: string): Promise<{ guid: string }> {
    return this.request('POST', '/api/v1/message/text', { chatGuid, message, tempGuid, method: 'apple-script' });
  }
  sendFile(chatGuid: string, data: Uint8Array, name: string, tempGuid: string): Promise<{ guid: string }> {
    if (data.byteLength > BLUEBUBBLES_MAX_BYTES) throw new BlueBubblesApiError('BLUEBUBBLES_FILE_TOO_LARGE');
    const form = new FormData();
    form.set('chatGuid', chatGuid);
    form.set('tempGuid', tempGuid);
    form.set('method', 'apple-script');
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
