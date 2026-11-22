import { ipcMain, net } from 'electron';

import {
  captureImAccountGeneration,
  ImAccountScopeClosedError,
  isImAccountGenerationCurrent,
  runInImAccountGeneration,
} from './im/accountBoundary';
import { ownerScopedImSecrets } from './im/ownerScopedStorage';
import { createLogger } from './logger';
import { assertTrustedAppRendererEvent } from './security/trustedAppRenderer';

const log = createLogger('wecom-group-notification');
const WEBHOOK_SECRET_NAME = 'wecom-group-webhook-url';
const ENABLED_SETTING_NAME = 'wecom-group-notification-enabled';
const WEBHOOK_HOST = 'qyapi.weixin.qq.com';
const WEBHOOK_PATH = '/cgi-bin/webhook/send';
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 16 * 1024;
const MAX_MARKDOWN_BYTES = 4_000;
const TEST_MESSAGE_INVALID = 'WECOM_GROUP_TEST_MESSAGE_INVALID';

export interface WecomGroupNotificationState {
  configured: boolean;
  enabled: boolean;
  maskedKey?: string;
}

export interface WecomGroupNotificationPublisher {
  publishMarkdown(markdown: string): Promise<void>;
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;
type SecretStore = Pick<typeof ownerScopedImSecrets, 'read' | 'write' | 'remove'>;

function parseWebhookUrl(raw: string): URL {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 2_048) {
    throw new Error('WECOM_GROUP_WEBHOOK_INVALID');
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error('WECOM_GROUP_WEBHOOK_INVALID');
  }

  const queryNames = [...url.searchParams.keys()];
  const key = url.searchParams.get('key');
  if (
    url.protocol !== 'https:' ||
    url.hostname !== WEBHOOK_HOST ||
    url.port !== '' ||
    url.pathname !== WEBHOOK_PATH ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== '' ||
    queryNames.length !== 1 ||
    queryNames[0] !== 'key' ||
    !key ||
    key.length > 256
  ) {
    throw new Error('WECOM_GROUP_WEBHOOK_INVALID');
  }
  return url;
}

function maskWebhookKey(url: URL): string {
  const key = url.searchParams.get('key') ?? '';
  return key.length <= 4 ? '••••' : `••••${key.slice(-4)}`;
}

function splitUtf8(text: string, maxBytes = MAX_MARKDOWN_BYTES): string[] {
  const chunks: string[] = [];
  let current = '';
  let currentBytes = 0;

  for (const char of text) {
    const bytes = Buffer.byteLength(char, 'utf8');
    if (current && currentBytes + bytes > maxBytes) {
      chunks.push(current);
      current = '';
      currentBytes = 0;
    }
    current += char;
    currentBytes += bytes;
  }
  if (current) chunks.push(current);
  return chunks;
}

function parseTestMessage(raw: unknown): string {
  if (typeof raw !== 'string') throw new TypeError('testMessage must be a string');
  const message = raw.trim();
  if (!message || Buffer.byteLength(message, 'utf8') > MAX_MARKDOWN_BYTES) {
    throw new Error(TEST_MESSAGE_INVALID);
  }
  return message;
}

async function readResponseText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';

  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        throw new Error('WECOM_GROUP_RESPONSE_TOO_LARGE');
      }
      parts.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(parts).toString('utf8');
}

export class WecomGroupNotificationService implements WecomGroupNotificationPublisher {
  private publishTail: Promise<void> = Promise.resolve();
  private configGeneration = 0;

  constructor(
    private readonly fetchImpl: FetchLike = (input, init) => net.fetch(input, init),
    private readonly secrets: SecretStore = ownerScopedImSecrets,
  ) {}

  getState(): WecomGroupNotificationState {
    const stored = this.secrets.read(WEBHOOK_SECRET_NAME);
    if (!stored) return { configured: false, enabled: false };
    try {
      return {
        configured: true,
        // Existing configurations predate the persisted master switch and
        // remain enabled until the user explicitly turns them off.
        enabled: this.secrets.read(ENABLED_SETTING_NAME) !== 'false',
        maskedKey: maskWebhookKey(parseWebhookUrl(stored)),
      };
    } catch {
      log.warn('stored webhook URL is invalid; treating it as unconfigured');
      return { configured: false, enabled: false };
    }
  }

  setEnabled(enabled: boolean): WecomGroupNotificationState {
    this.configGeneration += 1;
    const state = this.getState();
    if (!state.configured) throw new Error('WECOM_GROUP_WEBHOOK_NOT_CONFIGURED');
    if (!this.secrets.write(ENABLED_SETTING_NAME, String(enabled))) {
      throw new Error('WECOM_GROUP_ENABLED_SAVE_FAILED');
    }
    return { ...state, enabled };
  }

  async saveAndTest(
    rawUrl: string,
    testMessage: string,
    isAccountCurrent: () => boolean = () => true,
  ): Promise<WecomGroupNotificationState> {
    const url = parseWebhookUrl(rawUrl);
    const message = parseTestMessage(testMessage);
    const configGeneration = (this.configGeneration += 1);
    await this.enqueue(() => {
      if (!isAccountCurrent()) throw new ImAccountScopeClosedError();
      if (configGeneration !== this.configGeneration) {
        throw new Error('WECOM_GROUP_CONFIG_CHANGED');
      }
      return this.send(url, message);
    });
    if (!isAccountCurrent()) {
      throw new ImAccountScopeClosedError();
    }
    if (configGeneration !== this.configGeneration) {
      throw new Error('WECOM_GROUP_CONFIG_CHANGED');
    }
    const previousUrl = this.secrets.read(WEBHOOK_SECRET_NAME);
    const previousEnabled = this.secrets.read(ENABLED_SETTING_NAME);
    const saved =
      this.secrets.write(WEBHOOK_SECRET_NAME, url.toString()) &&
      this.secrets.write(ENABLED_SETTING_NAME, 'true');
    if (!saved) {
      this.restoreValue(WEBHOOK_SECRET_NAME, previousUrl);
      this.restoreValue(ENABLED_SETTING_NAME, previousEnabled);
      throw new Error('WECOM_GROUP_WEBHOOK_SAVE_FAILED');
    }
    return { configured: true, enabled: true, maskedKey: maskWebhookKey(url) };
  }

  async test(testMessage: string, isAccountCurrent: () => boolean = () => true): Promise<void> {
    const url = this.requireStoredUrl();
    const message = parseTestMessage(testMessage);
    const configGeneration = this.configGeneration;
    await this.enqueue(() => {
      if (!isAccountCurrent()) throw new ImAccountScopeClosedError();
      if (configGeneration !== this.configGeneration) {
        throw new Error('WECOM_GROUP_CONFIG_CHANGED');
      }
      return this.send(url, message);
    });
  }

  clear(): WecomGroupNotificationState {
    this.configGeneration += 1;
    this.secrets.remove(WEBHOOK_SECRET_NAME);
    this.secrets.remove(ENABLED_SETTING_NAME);
    return { configured: false, enabled: false };
  }

  async publishMarkdown(markdown: string): Promise<void> {
    if (!this.getState().enabled) {
      throw new Error('WECOM_GROUP_NOTIFICATIONS_DISABLED');
    }
    const accountGeneration = captureImAccountGeneration();
    if (accountGeneration === null) throw new ImAccountScopeClosedError();
    return this.enqueue(async () => {
      const chunks = splitUtf8(markdown.trim() || 'Cindy 通知');
      for (const chunk of chunks) {
        if (!isImAccountGenerationCurrent(accountGeneration)) {
          throw new ImAccountScopeClosedError();
        }
        if (!this.getState().enabled) {
          throw new Error('WECOM_GROUP_NOTIFICATIONS_DISABLED');
        }
        await this.send(this.requireStoredUrl(), chunk);
      }
    });
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const queued = this.publishTail
      .catch(() => {
        // A failed notification must not block later notifications.
      })
      .then(operation);
    this.publishTail = queued;
    return queued;
  }

  private requireStoredUrl(): URL {
    const stored = this.secrets.read(WEBHOOK_SECRET_NAME);
    if (!stored) throw new Error('WECOM_GROUP_WEBHOOK_NOT_CONFIGURED');
    return parseWebhookUrl(stored);
  }

  private restoreValue(name: string, previous: string | null): void {
    if (previous === null) this.secrets.remove(name);
    else this.secrets.write(name, previous);
  }

  private async send(url: URL, markdown: string): Promise<void> {
    const response = await this.fetchImpl(url.toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ msgtype: 'markdown', markdown: { content: markdown } }),
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.status >= 300 && response.status < 400) {
      throw new Error('WECOM_GROUP_REDIRECT_REJECTED');
    }

    const responseText = await readResponseText(response);
    let result: { errcode?: unknown; errmsg?: unknown } = {};
    try {
      result = JSON.parse(responseText) as typeof result;
    } catch {
      throw new Error('WECOM_GROUP_RESPONSE_INVALID');
    }
    if (!response.ok || result.errcode !== 0) {
      const code = typeof result.errcode === 'number' ? result.errcode : response.status;
      throw new Error(`WECOM_GROUP_SEND_FAILED:${code}`);
    }
  }
}

export const wecomGroupNotificationService = new WecomGroupNotificationService();

export function initWecomGroupNotificationIpc(): void {
  const runAccountScoped = <T>(
    operation: (accountGeneration: number) => T | Promise<T>,
  ): Promise<T> => {
    const accountGeneration = captureImAccountGeneration();
    if (accountGeneration === null) {
      return Promise.reject(new ImAccountScopeClosedError());
    }
    return runInImAccountGeneration(accountGeneration, async () => operation(accountGeneration));
  };

  ipcMain.handle('wecomGroupNotification:get-state', (event) => {
    assertTrustedAppRendererEvent(event);
    return wecomGroupNotificationService.getState();
  });
  ipcMain.handle(
    'wecomGroupNotification:save-and-test',
    async (event, webhookUrl: unknown, testMessage: unknown) => {
      assertTrustedAppRendererEvent(event);
      if (typeof webhookUrl !== 'string') throw new TypeError('webhookUrl must be a string');
      const accountGeneration = captureImAccountGeneration();
      if (accountGeneration === null) throw new ImAccountScopeClosedError();
      return runInImAccountGeneration(accountGeneration, () =>
        wecomGroupNotificationService.saveAndTest(webhookUrl, parseTestMessage(testMessage), () =>
          isImAccountGenerationCurrent(accountGeneration),
        ),
      );
    },
  );
  ipcMain.handle('wecomGroupNotification:test', async (event, testMessage: unknown) => {
    assertTrustedAppRendererEvent(event);
    return runAccountScoped(async (accountGeneration) => {
      await wecomGroupNotificationService.test(parseTestMessage(testMessage), () =>
        isImAccountGenerationCurrent(accountGeneration),
      );
      return { ok: true as const };
    });
  });
  ipcMain.handle('wecomGroupNotification:set-enabled', (event, enabled: unknown) => {
    assertTrustedAppRendererEvent(event);
    if (typeof enabled !== 'boolean') throw new TypeError('enabled must be a boolean');
    return runAccountScoped(() => wecomGroupNotificationService.setEnabled(enabled));
  });
  ipcMain.handle('wecomGroupNotification:clear', (event) => {
    assertTrustedAppRendererEvent(event);
    return runAccountScoped(() => wecomGroupNotificationService.clear());
  });
}

export const __testing = {
  parseWebhookUrl,
  parseTestMessage,
  splitUtf8,
};
