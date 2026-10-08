import { describe, expect, it } from 'vitest';

import { createProviderShareApi, isProviderShareInvitation } from '../providerShareApi.js';
import {
  decodeScopedEnvelope,
  encodeProviderShareEnvelope,
  encodeScopedEnvelope,
} from '../providerShareEnvelope.js';
import {
  buildProviderShareLink,
  parseProviderShareInvitationIntent,
  parseProviderShareLink,
  providerShareLinkRegion,
} from '../providerShareInvitation.js';
import { isProviderSharePeer, parseProviderSharePeer, providerShareGuestPeer, providerShareHostPeer } from '../providerSharePeer.js';
import { PROTOCOL_VERSION, isScopedPeer, type Envelope } from '../protocol.js';
import { parseSharedTaskPeer, sharedTaskHostPeer } from '../sharedTaskPeer.js';

const frame = (dst: string): Envelope => ({ v: PROTOCOL_VERSION, kind: 'invoke', id: 'request', dst, payload: { channel: 'maker:remote-agent:v1', args: [] } });
const BOTH = { sharedTask: true, providerShare: true };
const TOKEN = 'a'.repeat(43);

describe('provider share local handles', () => {
  it('round-trips host and guest keys and never collides with shared-task keys or device ids', () => {
    const host = providerShareHostPeer('share-1', 'desktop');
    const guest = providerShareGuestPeer('share-1', 'member-1', 'laptop');
    expect(parseProviderSharePeer(host)).toEqual({ shareId: 'share-1', role: 'host', deviceId: 'desktop' });
    expect(parseProviderSharePeer(guest)).toEqual({ shareId: 'share-1', role: 'guest', memberId: 'member-1', deviceId: 'laptop' });
    expect(host.length).toBeGreaterThan(128);
    const shared = sharedTaskHostPeer('share-1', 'desktop');
    expect(parseProviderSharePeer(shared)).toBeNull();
    expect(parseSharedTaskPeer(host)).toBeNull();
    expect(isProviderSharePeer('desktop')).toBe(false);
    expect(isScopedPeer(host)).toBe(true);
    expect(isScopedPeer(shared)).toBe(true);
    expect(isScopedPeer('desktop')).toBe(false);
  });
});

describe('provider share wire scope', () => {
  it('encodes to the physical device with a target scope and drops any client-supplied source', () => {
    const host = providerShareHostPeer('share-1', 'desktop');
    const out = encodeScopedEnvelope({ ...frame(host), src: 'me', providerShare: { shareId: 'x', target: { role: 'host' }, source: { role: 'host' } } }, BOTH);
    expect(out).toEqual({ ...frame('desktop'), providerShare: { shareId: 'share-1', target: { role: 'host' } } });
    expect(JSON.stringify(out)).not.toContain(host);
  });

  it('requires relay support and refuses a scope without a scoped peer', () => {
    expect(() => encodeProviderShareEnvelope(frame(providerShareHostPeer('share-1', 'desktop')), false)).toThrow(/provider-share-v1/);
    expect(() => encodeScopedEnvelope({ ...frame('desktop'), providerShare: { shareId: 's', target: { role: 'host' } } }, BOTH)).toThrow();
    expect(encodeScopedEnvelope(frame('desktop'), BOTH)).toEqual(frame('desktop'));
  });

  it('decodes relay-authored scopes into local keys and rejects frames with both scopes', () => {
    const inbound: Envelope = {
      ...frame('desktop'),
      src: 'laptop',
      providerShare: { shareId: 'share-1', target: { role: 'host' }, source: { role: 'guest', memberId: 'member-1' } },
    };
    expect(decodeScopedEnvelope(inbound, BOTH)).toMatchObject({
      src: providerShareGuestPeer('share-1', 'member-1', 'laptop'),
      dst: providerShareHostPeer('share-1', 'desktop'),
    });
    expect(decodeScopedEnvelope(inbound, { sharedTask: true, providerShare: false })).toBeNull();
    expect(decodeScopedEnvelope({ ...inbound, sharedTask: { sharedTaskId: 't', target: { role: 'host' } } }, BOTH)).toBeNull();
    expect(decodeScopedEnvelope({ ...inbound, providerShare: { shareId: 'share-1', target: { role: 'host' } } }, BOTH)).toBeNull();
  });
});

describe('provider share links', () => {
  const server = 'https://device-link.cindy.app';
  it('builds and parses fragment links and scheme intents', () => {
    const link = buildProviderShareLink(TOKEN, server, 'cindycn');
    expect(link).toBe(`${server}/provider-share/join#${TOKEN}?app=cindycn`);
    expect(parseProviderShareLink(`请打开 ${link} 。`)).toEqual({ invitation: TOKEN, server });
    expect(parseProviderShareInvitationIntent(`cindy://provider-share/join?invitation=${TOKEN}&server=${encodeURIComponent(server)}`))
      .toEqual({ invitation: TOKEN, server });
    expect(parseProviderShareInvitationIntent(`cindy://shared-task/join?invitation=${TOKEN}&server=${server}`)).toBeNull();
    expect(parseProviderShareInvitationIntent(`cindy://provider-share/join?invitation=${TOKEN}&server=${server}&x=1`)).toBeNull();
    expect(isProviderShareInvitation('short')).toBe(false);
  });

  it('accepts only official regions', () => {
    const intent = { invitation: TOKEN, server: 'https://device-link.cindy.com.cn' };
    expect(providerShareLinkRegion(intent, { global: server, cn: 'https://device-link.cindy.com.cn/' })).toBe('cn');
    expect(providerShareLinkRegion({ ...intent, server: 'https://evil.example' }, { global: server, cn: null })).toBeNull();
  });
});

describe('provider share api', () => {
  function api(response: unknown, calls: Array<{ path: string; body?: unknown }> = []) {
    return createProviderShareApi({
      request: async (path, options) => {
        calls.push({ path, body: options.body });
        return response;
      },
      captureScope: () => ({ isCurrent: () => true }),
    });
  }

  it('parses received shares strictly and keeps only nickname/avatar identity', async () => {
    const shares = await api({ shares: [{
      shareId: 's1', memberId: 'm1', providerId: 'cindy-ai', providerLabel: 'Cindy AI', hostDeviceId: 'desktop',
      deviceName: "Magi's Mac Mini", owner: { displayName: 'Magi', avatarUrl: 'https://cdn.example/a.png', region: 'global', email: 'x@y.z' },
      status: 'active', hostOnline: true, hostCapable: true,
    }] }).listReceived();
    expect(shares[0].owner).toEqual({ displayName: 'Magi', avatarUrl: 'https://cdn.example/a.png', region: 'global' });
  });

  it('rejects malformed pairing codes and sends invitations only in the body', async () => {
    await expect(api({ requestId: 'r1', status: 'pending', pairingCode: '12a4', expiresAt: new Date().toISOString() })
      .sendRequest(TOKEN, 'card')).rejects.toThrow();
    const calls: Array<{ path: string; body?: unknown }> = [];
    await api({ requestId: 'r1', status: 'pending', pairingCode: '0042', expiresAt: new Date().toISOString() }, calls).sendRequest(TOKEN, 'card');
    expect(calls[0]).toEqual({ path: '/api/device-link/provider-shares/requests', body: { invitation: TOKEN, identityCard: 'card' } });
  });
});

describe('provider share received catalogs', () => {
  it('keeps well-formed entries, drops forged ids and avatars that are not https', async () => {
    const { parseProviderShareReceivedCatalogs } = await import('../providerShareCatalog.js');
    const entry = {
      agentDeviceId: 'share:s1', shareId: 's1', providerId: 'anthropic', providerLabel: 'Anthropic', deviceName: 'Mac',
      owner: { displayName: 'Magi', avatarUrl: 'http://cdn.example/a.png', email: 'x@y.z' }, status: 'active', hostOnline: true,
      catalog: { providers: [] },
    };
    const parsed = parseProviderShareReceivedCatalogs({ shares: [entry, { ...entry, agentDeviceId: 'owner-mac' }, { bogus: true }] });
    expect(parsed).toEqual([{ ...entry, owner: { displayName: 'Magi', avatarUrl: null } }]);
    expect(parseProviderShareReceivedCatalogs(null)).toEqual([]);
  });
});

describe('provider share identity scrubbing', () => {
  it('drops account identity fields and removes login names or emails from provider names', async () => {
    const { scrubProviderShareLabel, scrubSharedProvider, scrubSharedProviderCatalog } = await import('../providerShareCatalog.js');
    expect(scrubProviderShareLabel('OpenAI · alice@corp.com')).toBe('OpenAI');
    expect(scrubProviderShareLabel('Claude 订阅 · alice', ['alice'])).toBe('Claude 订阅');
    expect(scrubProviderShareLabel('bob@x.io', [], 'openai-2')).toBe('openai-2');
    expect(scrubProviderShareLabel('My Gateway')).toBe('My Gateway');
    const provider = {
      id: 'openai-2', name: 'OpenAI · alice@corp.com', connected: true,
      subscriptionAccount: { source: 'local', identity: 'alice@corp.com' },
      openAiAccount: { source: 'oauth', identity: 'alice@corp.com' },
    };
    expect(scrubSharedProvider(provider)).toEqual({ id: 'openai-2', name: 'OpenAI', connected: true });
    expect(JSON.stringify(scrubSharedProviderCatalog({ providers: [provider], providerOrder: ['openai-2'] }))).not.toContain('alice');
  });

  it('drops a login name cut short by the 50-character auto-name limit', async () => {
    const { scrubProviderShareLabel, scrubSharedProvider } = await import('../providerShareCatalog.js');
    const longName = 'Alexandra Konstantinopoulou-Whitfield Junior';
    const truncated = `OpenAI · ${longName}`.slice(0, 50);
    expect(truncated.includes('@')).toBe(false);
    expect(scrubProviderShareLabel(truncated)).toBe('OpenAI');
    // 序号保留：同一台电脑分享的两个同类账号分得清。
    expect(scrubProviderShareLabel(`${truncated} (2)`)).toBe('OpenAI (2)');
    expect(scrubProviderShareLabel(`Claude · ${longName}`.slice(0, 50))).toBe('Claude');
    expect(scrubProviderShareLabel('Grok · bob')).toBe('Grok');
    const provider = {
      id: 'openai-3', name: `${truncated} (3)`,
      openAiAccount: { source: 'oauth', identity: longName },
    };
    expect(scrubSharedProvider(provider)).toEqual({ id: 'openai-3', name: 'OpenAI (3)' });
    expect(scrubSharedProvider({ id: 'c1', name: 'Team pool · Alexandra', subscriptionAccount: { identity: 'Alexandra K' } }))
      .toEqual({ id: 'c1', name: 'Team pool' });
    expect(scrubProviderShareLabel('My Gateway · EU')).toBe('My Gateway · EU');
  });

  it('removes the login name regardless of case, and the user part of a login email', async () => {
    const { scrubProviderShareLabel } = await import('../providerShareCatalog.js');
    expect(scrubProviderShareLabel('Claude Pro (ALICE@corp.com)', ['alice@corp.com'])).toBe('Claude Pro');
    expect(scrubProviderShareLabel('Claude Pro - Bob', ['bob@x.io'])).toBe('Claude Pro');
    expect(scrubProviderShareLabel('bob work key', ['bob@x.io'])).toBe('work key');
    expect(scrubProviderShareLabel('Gr+ok (a.b)', ['a.b'])).toBe('Gr+ok');
    expect(scrubProviderShareLabel('Kimi', ['jo@x.io'])).toBe('Kimi');
    // 用户名部分按整词匹配：不把「OpenAI」里的 open 删掉。
    expect(scrubProviderShareLabel('OpenAI', ['open@x.io'])).toBe('OpenAI');
    expect(scrubProviderShareLabel('Claude Max', ['max@x.io'])).toBe('Claude');
    expect(scrubProviderShareLabel('Claude bob＠corp.com')).toBe('Claude');
  });

  it('removes credentials embedded in endpoint addresses', async () => {
    const { scrubSharedProvider } = await import('../providerShareCatalog.js');
    const scrubbed = scrubSharedProvider({
      id: 'gw', name: 'Gateway',
      logoUrl: 'https://cdn.example.com/logo.png',
      routing: { 'claude-code': { upstream: 'https://user:pass@llm.example.com/v1?api_key=sk-secret#x', authStrategy: { kind: 'none' } } },
      models: { 'claude-code': [{ id: 'm', route: { baseUrl: 'https://llm.example.com/v2?key=sk-2' } }] },
    }) as { logoUrl: string; routing: Record<string, { upstream: string }>; models: Record<string, Array<{ route: { baseUrl: string } }>> };
    expect(scrubbed.routing['claude-code']!.upstream).toBe('https://llm.example.com/v1');
    expect(scrubbed.models['claude-code']![0]!.route.baseUrl).toBe('https://llm.example.com/v2');
    expect(scrubbed.logoUrl).toBe('https://cdn.example.com/logo.png');
    expect(JSON.stringify(scrubbed)).not.toMatch(/sk-|pass/);
  });

  it('scrubs labels and catalogs relayed to the phone', async () => {
    const { parseProviderShareReceivedCatalogs } = await import('../providerShareCatalog.js');
    const [entry] = parseProviderShareReceivedCatalogs({ shares: [{
      agentDeviceId: 'share:s1', shareId: 's1', providerId: 'anthropic', providerLabel: 'Claude · alice@corp.com', deviceName: 'Mac',
      owner: { displayName: 'Alice', avatarUrl: null }, status: 'active', hostOnline: true,
      catalog: { providers: [{ id: 'anthropic', name: 'Claude', subscriptionAccount: { source: 'local', identity: 'alice@corp.com' } }] },
    }] });
    expect(JSON.stringify(entry)).not.toContain('alice@corp.com');
    expect(entry.providerLabel).toBe('Claude');
  });
});
