import { describe, expect, it } from 'vitest';
import { NodeDeviceAuthorizationClient } from '../nodeDeviceAuthorizationClient';
import { NodeRequestScopes } from '../nodeRequestScope';

describe('bound Node device authorization transport', () => {
  it('captures the request before a stream callback loses context and cannot bind a sibling or expired call', async () => {
    const scopes = new NodeRequestScopes();
    const sent: Array<Record<string, unknown>> = [];
    const client = new NodeDeviceAuthorizationClient(scopes, (m) =>
      sent.push(m as Record<string, unknown>),
    );
    expect(client.bind()).toBeUndefined();
    let authorize!: (url: string) => Promise<void>;
    scopes.feed('{"id":"1","cindy":{"cancelWithCall":true}}', () => {
      authorize = client.bind()!;
    });
    let opening!: Promise<void>;
    scopes.feed('{"id":"2","cindy":{"cancelWithCall":true}}', () => {
      opening = authorize('https://provider.example/device?code=synthetic');
    });
    expect(sent[0]).toMatchObject({ type: 'device-authorize', rpcId: '1' });
    client.reply({ reqId: sent[0].reqId, ok: true });
    await opening;
    await expect(authorize('https://provider.example/again')).rejects.toThrow();
    let late!: (url: string) => Promise<void>;
    scopes.feed('{"id":"3","cindy":{"cancelWithCall":true}}', () => {
      late = client.bind()!;
    });
    scopes.finish('3');
    await expect(late('https://provider.example/late')).rejects.toThrow();
    expect(sent).toHaveLength(1);
  });
  it('rejects the captured request when the Host settles it and ignores a late opened reply', async () => {
    const scopes = new NodeRequestScopes();
    const sent: Array<Record<string, unknown>> = [];
    const client = new NodeDeviceAuthorizationClient(scopes, (m) =>
      sent.push(m as Record<string, unknown>),
    );
    let opening!: Promise<void>;
    scopes.feed('{"id":"1","cindy":{"cancelWithCall":true}}', () => {
      opening = client.bind()!('https://provider.example/device');
    });
    const rejected = expect(opening).rejects.toThrow('DEVICE_AUTHORIZATION_UNAVAILABLE');
    scopes.finish('1');
    client.finish('1');
    client.reply({ reqId: sent[0].reqId, ok: true });
    await rejected;
  });
});
