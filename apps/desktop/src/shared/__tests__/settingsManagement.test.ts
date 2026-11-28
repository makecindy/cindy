import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { managementCommandSchema, managementResultSchema } from '../settingsManagement.js';
import { settingsWebConnectSchema, settingsWebCommandSchema } from '../settingsWeb.js';
const actionId = randomUUID(),
  operationId = randomUUID();
describe('cloud management wire contract (mirrored corpus)', () => {
  it('negotiates independently of frozen configuration v3 and batch reads', () => {
    const old = { runtimeId: randomUUID(), domains: ['appearance'] };
    expect(settingsWebConnectSchema.parse(old)).toEqual(old);
    expect(settingsWebConnectSchema.parse({ ...old, managementV1: true })).toMatchObject({
      managementV1: true,
    });
    expect(
      settingsWebCommandSchema.parse({
        kind: 'manage',
        command: { operation: 'list', section: 'bots' },
      }),
    ).toMatchObject({ kind: 'manage' });
  });
  it.each([
    { operation: 'run', actionId, operationId, values: { token: 'write-only-fixture' } },
    { operation: 'list', section: 'contacts', offset: 16 },
    {
      operation: 'respond',
      operationId,
      value: 'http://localhost:9999/callback?code=example&state=example',
    },
    { operation: 'cancel', operationId },
    { operation: 'status', operationId },
  ])('accepts bounded command %#', (command) =>
    expect(managementCommandSchema.safeParse(command).success).toBe(true),
  );
  it.each([
    { operation: 'list', section: 'secrets' },
    { operation: 'list', section: 'bots', offset: -1 },
    {
      operation: 'run',
      actionId,
      operationId,
      values: { token: 'x' },
      channel: 'safe-storage-read',
    },
    { operation: 'run', actionId: 'provider-id', operationId, values: {} },
    { operation: 'run', actionId, operationId, values: { token: 'x'.repeat(16385) } },
    { operation: 'run', actionId, operationId, values: { token: { value: 'x' } } },
  ])('rejects invalid or generic remote commands %#', (command) =>
    expect(managementCommandSchema.safeParse(command).success).toBe(false),
  );
  it('rejects existing credentials in password field defaults and unexpected result properties', () => {
    const field = {
      name: 'token',
      label: 'Token',
      kind: 'password',
      required: true,
      maxLength: 128,
      value: 'existing-secret',
    };
    const page = {
      kind: 'page',
      section: 'bots',
      items: [
        {
          id: 'bot',
          label: 'Bot',
          status: 'disconnected',
          actions: [
            {
              id: actionId,
              label: 'Connect',
              intent: 'connect',
              expiresAt: Date.now() + 60000,
              fields: [field],
            },
          ],
        },
      ],
    };
    expect(managementResultSchema.safeParse(page).success).toBe(false);
    expect(
      managementResultSchema.safeParse({
        kind: 'operation',
        operationId,
        phase: 'succeeded',
        token: 'secret',
      }).success,
    ).toBe(false);
  });
  it.each([
    'http://example.invalid/auth',
    'javascript:alert(1)',
    'https://user:password@example.invalid/auth',
  ])('rejects unsafe authorization navigation %s', (url) => {
    expect(
      managementResultSchema.safeParse({
        kind: 'operation',
        operationId,
        phase: 'waiting',
        prompt: { kind: 'browser', url, expiresAt: Date.now() + 60000 },
      }).success,
    ).toBe(false);
  });
});
