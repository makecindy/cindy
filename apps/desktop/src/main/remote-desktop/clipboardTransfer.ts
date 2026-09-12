import { randomUUID } from 'node:crypto';
import {
  CLIPBOARD_CHUNK_CHARS,
  CLIPBOARD_MAX_CHARS,
  parseClipboardContent,
  type ClipboardContentRequest,
  type RemoteClipboardContent,
} from '@cindy/device-link';

/** One bounded transfer per controller, released after 60s idle. Payloads never reach disk/logs. */
export class ClipboardTransfer {
  private value: {
    id: string;
    lease: string;
    length: number;
    data: string;
    direction: 'copy' | 'paste';
    sync?: boolean;
    version?: string;
  } | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  reset(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.value = null;
  }
  async handle(
    request: ClipboardContentRequest,
    isCurrent: () => boolean,
    transfer: (
      action: 'copy' | 'paste',
      content: RemoteClipboardContent | undefined,
      isCurrent: () => boolean,
      options?: { sync?: boolean; version?: string },
    ) => Promise<RemoteClipboardContent | { version: string } | void>,
  ): Promise<unknown> {
    if (!isCurrent()) throw new Error('DESKTOP_LEASE_EXPIRED');
    if (request.action === 'paste') {
      if (!request.sync || !request.version || request.data.length > CLIPBOARD_CHUNK_CHARS)
        throw new Error('INVALID_REQUEST');
      this.reset();
      const receipt = await transfer(
        'paste',
        parseClipboardContent(request.data),
        isCurrent,
        request,
      );
      if (!isCurrent()) throw new Error('DESKTOP_LEASE_EXPIRED');
      return receipt;
    }
    if (request.action === 'copy' || request.action === 'begin') {
      this.reset();
      const data =
        request.action === 'copy'
          ? JSON.stringify(
              await (request.sync
                ? transfer('copy', undefined, isCurrent, request)
                : transfer('copy', undefined, isCurrent)),
            )
          : '';
      if (!isCurrent()) throw new Error('DESKTOP_LEASE_EXPIRED');
      if (typeof data !== 'string') throw new Error('CLIPBOARD_EMPTY');
      const length = request.action === 'begin' ? request.length : data.length;
      if (length > CLIPBOARD_MAX_CHARS) throw new Error('CLIPBOARD_TOO_LONG');
      if (
        request.action === 'copy' &&
        request.sync &&
        request.inline &&
        length <= CLIPBOARD_CHUNK_CHARS
      )
        return { data, length };
      const id = randomUUID();
      this.value = {
        id,
        lease: request.lease,
        length,
        data,
        direction: request.action === 'copy' ? 'copy' : 'paste',
        sync: request.sync,
        version: request.version,
      };
      this.timer = setTimeout(() => this.reset(), 60_000);
      this.timer.unref();
      return { id, length };
    }
    const value = this.value;
    if (!value || value.id !== request.id || value.lease !== request.lease)
      throw new Error('CLIPBOARD_EXPIRED');
    if (Boolean(value.sync) !== Boolean(request.sync)) throw new Error('CLIPBOARD_EXPIRED');
    if (request.action === 'cancel') {
      this.reset();
      return { ok: true };
    }
    if (request.action === 'read' && value.direction === 'copy') {
      if (request.offset >= value.length) throw new Error('INVALID_REQUEST');
      this.timer?.refresh(); // Slow links may need more than a minute for a complete item.
      return { data: value.data.slice(request.offset, request.offset + CLIPBOARD_CHUNK_CHARS) };
    }
    if (request.action === 'write' && value.direction === 'paste') {
      if (
        request.offset !== value.data.length ||
        value.data.length + request.data.length > value.length
      )
        throw new Error('INVALID_REQUEST');
      value.data += request.data;
      this.timer?.refresh();
      return { ok: true };
    }
    if (request.action === 'commit' && value.direction === 'paste') {
      this.reset(); // Consume before any side effect: a repeated commit cannot paste twice.
      if (value.data.length !== value.length) throw new Error('INVALID_REQUEST');
      const content = parseClipboardContent(value.data);
      const receipt = await (value.sync
        ? transfer('paste', content, isCurrent, value)
        : transfer('paste', content, isCurrent));
      return {
        ok: true,
        ...(value.sync && receipt && 'version' in receipt ? { version: receipt.version } : {}),
      };
    }
    throw new Error('INVALID_REQUEST');
  }
}
