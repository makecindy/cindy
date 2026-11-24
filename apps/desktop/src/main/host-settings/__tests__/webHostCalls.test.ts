import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { executeWebHostCall, isWebHostCall, type WebHostCallDeps } from '../webHostCalls.js';
import { SETTINGS_WEB_CHANNELS, settingsWebCommandSchema, settingsWebResultSchema, type SettingsWebCommand, type SettingsWebEnvelope } from '../../../shared/settingsWeb.js';

type HostCall = Extract<SettingsWebCommand, { kind: 'channel' | 'desktop' | 'desktopIce' }>;
const sessionKey = 'c'.repeat(64);
const input = (command: HostCall): SettingsWebEnvelope & { command: HostCall } => ({ requestId: randomUUID(), runtimeId: randomUUID(), sessionKey, expiresAtMs: Date.now() + 30_000, command });
function deps(overrides: Partial<WebHostCallDeps> = {}) {
  const contexts: Array<[string, string]> = [];
  const handle = vi.fn(async (_controller: string, raw: unknown) => ({ echoed: raw }));
  const value: WebHostCallDeps = {
    privateHandler: vi.fn(async () => ({ handle })),
    invoke: vi.fn(async (_channel, args) => ({ args })),
    providerGroup: vi.fn(async (_controller, raw) => ({ managed: raw })),
    inContext: vi.fn(async (controller, channel, run) => { contexts.push([controller, channel]); return run(); }),
    desktop: vi.fn(async (_controller, request) => ({ answered: request })),
    ice: vi.fn(async () => [{ urls: ['stun:stun.example.invalid:3478'] }]),
    ...overrides,
  };
  return { deps: value, handle, contexts };
}

describe('Host calls from the cloud service browser pages', () => {
  // Unit: the personal instructions' text travels over DeviceLink only; the web relay neither
  // declares nor accepts their channel.
  it('never relays the personal instructions through the cloud service', () => {
    expect(SETTINGS_WEB_CHANNELS).not.toContain('cloud:personalization:v1');
    expect(settingsWebCommandSchema.safeParse({ kind: 'channel', channel: 'cloud:personalization:v1', args: [{ op: 'read' }] }).success).toBe(false);
  });
  it('recognizes only the browser-only kinds', () => {
    expect(isWebHostCall({ kind: 'desktopIce' })).toBe(true);
    expect(isWebHostCall({ kind: 'read', domain: 'appearance' })).toBe(false);
  });

  it('reaches the private cloud handler as one stable web controller with the DeviceLink context', async () => {
    const f = deps();
    const result = await executeWebHostCall(input({ kind: 'channel', channel: 'cloud:storage-usage:v1', args: [{ op: 'read' }, 'ignored'] }), f.deps);
    expect(settingsWebResultSchema.parse(result)).toEqual({ ok: true, channel: { echoed: { op: 'read' } } });
    expect(f.handle).toHaveBeenCalledWith(`web:${sessionKey}`, { op: 'read' });
    expect(f.contexts).toEqual([[`web:${sessionKey}`, 'cloud:storage-usage:v1']]);
    expect(f.deps.invoke).not.toHaveBeenCalled();
  });

  it('reports an unregistered private handler as unsupported instead of falling through to IPC', async () => {
    const f = deps({ privateHandler: vi.fn(async () => undefined) });
    expect(await executeWebHostCall(input({ kind: 'channel', channel: 'cloud:im-settings:v1', args: [] }), f.deps)).toEqual({ ok: false, code: 'SETTINGS_UNSUPPORTED' });
    expect(f.deps.invoke).not.toHaveBeenCalled();
  });

  it('calls ordinary read channels as DeviceLink does, including provider-list negotiation', async () => {
    const f = deps();
    expect(await executeWebHostCall(input({ kind: 'channel', channel: 'maker:model-catalog:read', args: ['codex'] }), f.deps)).toEqual({ ok: true, channel: { args: ['codex'] } });
    expect(await executeWebHostCall(input({ kind: 'channel', channel: 'maker:provider:list', args: [{ tunnel: 1 }] }), f.deps)).toEqual({ ok: true, channel: { args: [] } });
    expect(f.contexts.map(([, channel]) => channel)).toEqual(['maker:model-catalog:read', 'maker:provider:list']);
  });

  it('reaches the quota and favorites channels as ordinary DeviceLink calls', async () => {
    const f = deps();
    for (const [channel, args] of [['maker:usage:account', ['claude-code', 'cindy-quota-state-v1']],
      ['maker:usage:codex-rate-limits', ['openai']], ['maker:model-favorites:get', []],
      ['maker:model-favorites:apply', [{ op: 'add', key: 'codex:openai:gpt' }]]] as const) {
      expect(await executeWebHostCall(input({ kind: 'channel', channel, args: [...args] }), f.deps)).toEqual({ ok: true, channel: { args } });
    }
    expect(f.deps.providerGroup).not.toHaveBeenCalled();
  });

  it('takes only provider management on provider-group:remote, as the owner controller', async () => {
    const f = deps();
    const manage = { action: 'manage-share', command: { action: 'owned' } };
    expect(await executeWebHostCall(input({ kind: 'channel', channel: 'provider-group:remote', args: [manage] }), f.deps)).toEqual({ ok: true, channel: { managed: manage } });
    expect(f.deps.providerGroup).toHaveBeenCalledWith(`web:${sessionKey}`, manage);
    expect(f.contexts).toEqual([[`web:${sessionKey}`, 'provider-group:remote']]);
    // Group scheduling and continuity between the owner's computers never come from a browser.
    for (const raw of [{ action: 'continuity-inspect', id: 'x' }, { action: 'usage-part' }, null, 'manage-group']) {
      expect(await executeWebHostCall(input({ kind: 'channel', channel: 'provider-group:remote', args: [raw] }), f.deps)).toEqual({ ok: false, code: 'INVALID_PARAMS' });
    }
    expect(f.deps.providerGroup).toHaveBeenCalledTimes(1);
    expect(f.deps.invoke).not.toHaveBeenCalled();
  });

  it('relays desktop signaling and ICE configuration, keeping null replies distinct from missing ones', async () => {
    const f = deps({ desktop: vi.fn(async () => undefined) });
    expect(await executeWebHostCall(input({ kind: 'desktop', request: { op: 'heartbeat', lease: 'l' } }), f.deps)).toEqual({ ok: true, desktop: null });
    expect(f.deps.desktop).toHaveBeenCalledWith(`web:${sessionKey}`, { op: 'heartbeat', lease: 'l' });
    expect(settingsWebResultSchema.parse(await executeWebHostCall(input({ kind: 'desktopIce' }), f.deps))).toEqual({ ok: true, ice: [{ urls: ['stun:stun.example.invalid:3478'] }] });
  });

  it('returns stable codes only, never handler messages', async () => {
    const coded = deps({ desktop: vi.fn(async () => { throw new Error('DESKTOP_UNAVAILABLE'); }) });
    expect(await executeWebHostCall(input({ kind: 'desktop', request: { op: 'start' } }), coded.deps)).toEqual({ ok: false, code: 'DESKTOP_UNAVAILABLE' });
    const bracketed = deps({ invoke: vi.fn(async () => { throw new Error('[NOT_FOUND] no local IPC handler for a private path'); }) });
    expect(await executeWebHostCall(input({ kind: 'channel', channel: 'maker:get-capabilities', args: [] }), bracketed.deps)).toEqual({ ok: false, code: 'NOT_FOUND' });
    const plain = deps({ ice: vi.fn(async () => { throw new Error('connect ECONNREFUSED 192.0.2.1'); }) });
    expect(await executeWebHostCall(input({ kind: 'desktopIce' }), plain.deps)).toEqual({ ok: false, code: 'SETTINGS_REQUEST_FAILED' });
  });
});
