import { describe, expect, it, vi } from 'vitest';
import { DeviceCodeAuthManager, type DeviceCodeTransport } from './device-code-auth.js';
import { MemorySecretStore } from './secret-store.js';

describe('DeviceCodeAuthManager', () => {
  it('stores OAuth tokens only in the secret store after the user completes device authorization', async () => {
    const secrets = new MemorySecretStore();
    const transport: DeviceCodeTransport = {
      requestDeviceCode: vi.fn(async () => ({
        device_code: 'device-code-not-persisted', user_code: 'ABCD-EFGH', verification_uri: 'https://login.example.test/device', expires_in: 60, interval: 1,
      })),
      pollToken: vi.fn(async () => ({ access_token: 'access-token-not-in-config', refresh_token: 'refresh-token-not-in-config', expires_in: 3600 })),
    };
    const manager = new DeviceCodeAuthManager(secrets, transport, async () => undefined, () => 1_000);

    const prompt = await manager.start({
      deviceAuthorizationUrl: 'https://login.example.test/device/code', tokenUrl: 'https://login.example.test/token', clientId: 'public-client',
    }, 'company_gateway_oauth');

    await vi.waitFor(() => expect(manager.getStatus(prompt.id)).toMatchObject({ state: 'completed' }));
    await expect(secrets.get('company_gateway_oauth')).resolves.toContain('access-token-not-in-config');
    expect(prompt).toMatchObject({ userCode: 'ABCD-EFGH', verificationUri: 'https://login.example.test/device' });
  });
});
