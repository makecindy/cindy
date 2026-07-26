import { randomUUID } from 'node:crypto';
import type { HeadlessDeviceCodeConfig } from './config.js';
import type { HeadlessSecretStore } from './secret-store.js';

export interface DeviceCodePrompt {
  id: string;
  verificationUri: string;
  verificationUriComplete?: string;
  userCode: string;
  expiresAt: number;
  intervalSeconds: number;
}

export type DeviceCodeStatus =
  | { state: 'pending'; prompt: DeviceCodePrompt }
  | { state: 'completed'; completedAt: number }
  | { state: 'failed'; message: string };

export interface DeviceCodeTransport {
  requestDeviceCode(config: HeadlessDeviceCodeConfig): Promise<{
    device_code: string;
    user_code: string;
    verification_uri: string;
    verification_uri_complete?: string;
    expires_in: number;
    interval?: number;
  }>;
  pollToken(config: HeadlessDeviceCodeConfig, deviceCode: string): Promise<
    | { access_token: string; refresh_token?: string; expires_in?: number; token_type?: string }
    | { error: 'authorization_pending' | 'slow_down' | 'expired_token' | 'access_denied'; error_description?: string }
  >;
}

/** Generic RFC 8628 manager; it keeps only opaque device codes in daemon memory. */
export class DeviceCodeAuthManager {
  private readonly attempts = new Map<string, DeviceCodeStatus>();

  constructor(
    private readonly secrets: HeadlessSecretStore,
    private readonly transport: DeviceCodeTransport = new FetchDeviceCodeTransport(),
    private readonly sleep: (milliseconds: number) => Promise<void> = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    private readonly now: () => number = Date.now,
  ) {}

  async start(config: HeadlessDeviceCodeConfig, secretRef: string): Promise<DeviceCodePrompt> {
    const response = await this.transport.requestDeviceCode(config);
    if (!response.device_code || !response.user_code || !response.verification_uri || !Number.isFinite(response.expires_in)) {
      throw new Error('Provider returned an invalid device-code response');
    }
    const prompt: DeviceCodePrompt = {
      id: randomUUID(),
      verificationUri: response.verification_uri,
      verificationUriComplete: response.verification_uri_complete,
      userCode: response.user_code,
      expiresAt: this.now() + response.expires_in * 1_000,
      intervalSeconds: Math.max(1, response.interval ?? 5),
    };
    this.attempts.set(prompt.id, { state: 'pending', prompt });
    void this.poll(prompt, config, secretRef, response.device_code);
    return prompt;
  }

  getStatus(id: string): DeviceCodeStatus | null {
    return this.attempts.get(id) ?? null;
  }

  private async poll(prompt: DeviceCodePrompt, config: HeadlessDeviceCodeConfig, secretRef: string, deviceCode: string): Promise<void> {
    let interval = prompt.intervalSeconds;
    try {
      while (this.now() < prompt.expiresAt) {
        await this.sleep(interval * 1_000);
        const response = await this.transport.pollToken(config, deviceCode);
        if ('access_token' in response) {
          await this.secrets.set(secretRef, JSON.stringify({
            accessToken: response.access_token,
            refreshToken: response.refresh_token,
            expiresAt: response.expires_in ? this.now() + response.expires_in * 1_000 : undefined,
            tokenType: response.token_type,
          }));
          this.attempts.set(prompt.id, { state: 'completed', completedAt: this.now() });
          return;
        }
        if (response.error === 'slow_down') {
          interval += 5;
          continue;
        }
        if (response.error === 'authorization_pending') continue;
        this.attempts.set(prompt.id, { state: 'failed', message: response.error_description ?? response.error });
        return;
      }
      this.attempts.set(prompt.id, { state: 'failed', message: 'device_code_expired' });
    } catch (error) {
      this.attempts.set(prompt.id, { state: 'failed', message: error instanceof Error ? error.message : String(error) });
    }
  }
}

/** Fetch implementation isolated behind an interface so device-code logic is fully unit-testable. */
export class FetchDeviceCodeTransport implements DeviceCodeTransport {
  async requestDeviceCode(config: HeadlessDeviceCodeConfig): Promise<{
    device_code: string; user_code: string; verification_uri: string; verification_uri_complete?: string; expires_in: number; interval?: number;
  }> {
    const response = await fetchForm(config.deviceAuthorizationUrl, {
      client_id: config.clientId,
      ...(config.scopes ? { scope: config.scopes } : {}),
    });
    return response as {
      device_code: string; user_code: string; verification_uri: string; verification_uri_complete?: string; expires_in: number; interval?: number;
    };
  }

  async pollToken(config: HeadlessDeviceCodeConfig, deviceCode: string): Promise<
    | { access_token: string; refresh_token?: string; expires_in?: number; token_type?: string }
    | { error: 'authorization_pending' | 'slow_down' | 'expired_token' | 'access_denied'; error_description?: string }
  > {
    return fetchForm(config.tokenUrl, {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: deviceCode,
      client_id: config.clientId,
    }) as Promise<
      | { access_token: string; refresh_token?: string; expires_in?: number; token_type?: string }
      | { error: 'authorization_pending' | 'slow_down' | 'expired_token' | 'access_denied'; error_description?: string }
    >;
  }
}

async function fetchForm(url: string, values: Record<string, string>): Promise<unknown> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(values),
  });
  let body: unknown;
  try { body = await response.json(); } catch { throw new Error(`Device-code endpoint returned invalid JSON (${response.status})`); }
  if (!response.ok) throw new Error(`Device-code endpoint rejected request (${response.status})`);
  return body;
}
