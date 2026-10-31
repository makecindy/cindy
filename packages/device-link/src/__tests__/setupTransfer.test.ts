/**
 * Unit, protocol boundary of the new-computer setup keys/SSH step
 * (docs/product-rules/new-device-setup-migration.md §3 invariant 1, §4). New channel: no existing
 * coverage. Each case is the smallest request or reply that must not be acted on, or that may
 * only be acted on in its bounded form.
 */
import { describe, expect, it } from 'vitest';

import { INVOKE_TIMEOUT_OVERRIDES_MS, REMOTE_INVOKE_ALLOWLIST } from '../allowlist.js';
import {
  SETUP_TRANSFER_CHANNEL,
  SETUP_TRANSFER_TIMEOUT_MS,
  parseSetupSecretBundle,
  parseSetupTransferReply,
  parseSetupTransferRequest,
} from '../setupTransfer.js';

const PUBLIC_KEY = 'A'.repeat(59);
const SSH_KEY = `ssh-ed25519 ${'A'.repeat(68)} cindy-setup@new-mac`;

describe('setup transfer protocol', () => {
  it('is a same-account invoke channel with room for a person to answer', () => {
    expect(REMOTE_INVOKE_ALLOWLIST.has(SETUP_TRANSFER_CHANNEL)).toBe(true);
    expect(INVOKE_TIMEOUT_OVERRIDES_MS[SETUP_TRANSFER_CHANNEL]).toBe(SETUP_TRANSFER_TIMEOUT_MS);
  });

  it('accepts only requests that name what they want and how to seal it', () => {
    const base = { action: 'transfer', requestId: 'request-0001', publicKey: PUBLIC_KEY };
    // Nothing asked: there is nothing a person could allow.
    expect(() => parseSetupTransferRequest({ ...base, secrets: null, ssh: null })).toThrow('SETUP_TRANSFER_INVALID');
    expect(() => parseSetupTransferRequest({ ...base, publicKey: 'short', secrets: { providers: ['or'] } })).toThrow();
    // Only plain API-key built-ins may be asked for; the xAI sign-in blob never.
    expect(
      parseSetupTransferRequest({ ...base, secrets: { providers: ['or'], builtinKeys: ['brave', 'xai', 'voice-asr'] } }),
    ).toMatchObject({ secrets: { providers: ['or'], builtinKeys: ['brave'], mcpServers: [], plugins: [] }, ssh: null });
    // SSH: one generated ed25519 line, never anything that could carry options or commands.
    expect(() =>
      parseSetupTransferRequest({ ...base, ssh: { publicKey: `command="sh" ${SSH_KEY}`, hosts: ['web'] } }),
    ).toThrow('SETUP_TRANSFER_INVALID');
    expect(parseSetupTransferRequest({ ...base, ssh: { publicKey: SSH_KEY, hosts: ['web', 'web', 'bad host'] } })).toMatchObject({
      ssh: { publicKey: SSH_KEY, hosts: ['web'] },
    });
  });

  it('treats a reply with keys but no sealing key as unreadable', () => {
    expect(() => parseSetupTransferReply({ publicKey: null, sealed: 'abc', ssh: null })).toThrow('SETUP_TRANSFER_INVALID');
    expect(parseSetupTransferReply({ publicKey: null, sealed: null, ssh: [{ host: 'web', outcome: 'added' }, { host: 'x', outcome: 'maybe' }] }))
      .toEqual({ publicKey: null, sealed: null, ssh: [{ host: 'web', outcome: 'added' }] });
  });

  it('drops copied values the new computer must not apply', () => {
    const bundle = parseSetupSecretBundle({
      providers: [
        { id: 'or', config: { id: 'or', runtimes: {} }, keys: { codex: 'sk-test', '__proto__': 'x' } },
        // Config of another connection than the one named.
        { id: 'a', config: { id: 'b' }, keys: { codex: 'sk-test' } },
      ],
      mcpServers: [{ id: 'docs', url: 'file:///etc/passwd', headers: {}, token: 't' }],
      builtinKeys: [{ id: 'xai', value: '{"refresh":"r"}' }, { id: 'brave', value: 'BSA-test' }],
      plugins: [{ ghostId: 'gmail', namespace: null, secrets: { api_key: 'k' } }],
    });
    expect(bundle).toEqual({
      providers: [{ id: 'or', config: { id: 'or', runtimes: {} }, keys: { codex: 'sk-test' } }],
      mcpServers: [],
      builtinKeys: [{ id: 'brave', value: 'BSA-test' }],
      plugins: [{ ghostId: 'gmail', namespace: null, secrets: { api_key: 'k' } }],
    });
  });
});
