/**
 * ghostConnectionsEndpoint.test.ts — /connections 协议端点单测(纯函数直测,
 * 假体管理器与假体确认弹窗,零 Electron)。覆盖:GET 状态回查(零 token
 * 字节)、POST 添加(新地址过受信确认 / 拒绝 CONFIRM_DENIED / 同 host 更新
 * 不确认)、非法 host/token/label、LIMIT 与 VAULT_WRITE_FAILED、DELETE 幂等、
 * 设默认、未声明 key 404、方法不符 405。
 */

import { describe, expect, it, vi } from 'vitest';

import { handleGhostConnectionsRequest, type GhostConnectionsEndpointManager } from '../ghostConnectionsEndpoint';
import { GhostConnectionManager, type GhostConnectionsVault } from '../../ghostConnections';

/** 内存保险库假体(与 ghostConnections.test 同款,tail 截真身规则)。 */
function makeVault(): GhostConnectionsVault {
  const store = new Map<string, string>();
  const k = (g: string, key: string) => `${g} ${key}`;
  return {
    read: (g, key) => store.get(k(g, key)) ?? null,
    store: (g, key, value) => {
      store.set(k(g, key), value);
      return true;
    },
    remove: (g, key) => {
      store.delete(k(g, key));
    },
    readTail: (g, key) => {
      const v = store.get(k(g, key));
      return v && v.length >= 12 ? v.slice(-4) : null;
    },
  };
}

const G = 'cindy-gitlab';
const DECLS = new Map([['gitlab', { label: 'GitLab 实例', maxConnections: 2 }]]);

function call(args: {
  method: string;
  pathname: string;
  body?: unknown;
  manager?: GhostConnectionsEndpointManager;
  decls?: ReadonlyMap<string, { label: string; maxConnections: number }>;
  confirm?: (declLabel: string, host: string) => Promise<boolean>;
  onChanged?: (declKey: string) => void;
}) {
  const manager = args.manager ?? new GhostConnectionManager({ vault: makeVault() });
  return handleGhostConnectionsRequest({
    method: args.method,
    pathname: args.pathname,
    readBodyText: async () => (args.body !== undefined ? JSON.stringify(args.body) : ''),
    decls: args.decls ?? DECLS,
    manager,
    ghostId: G,
    confirmAddHost: args.confirm ?? (async () => true),
    ...(args.onChanged ? { onChanged: args.onChanged } : {}),
  });
}

describe('ghostConnectionsEndpoint · GET /connections', () => {
  it('回每条声明的上限与连接清单(含 tail),永远零 token 字节', async () => {
    const manager = new GhostConnectionManager({ vault: makeVault() });
    manager.upsert(G, 'gitlab', { host: 'gitlab.example.com', token: 'glpat-1234567890ab', label: '主库', max: 2 });
    const out = await call({ method: 'GET', pathname: '/connections', manager });
    expect(out.status).toBe(200);
    const list = JSON.parse(out.body ?? '[]') as Array<Record<string, unknown>>;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ key: 'gitlab', label: 'GitLab 实例', maxConnections: 2 });
    const conns = list[0].connections as Array<Record<string, unknown>>;
    expect(conns[0]).toMatchObject({ host: 'gitlab.example.com', label: '主库', isDefault: true, tail: '90ab' });
    // 零 token 字节:响应文本里绝不能出现 token 明文。
    expect(out.body).not.toContain('glpat-1234567890ab');
  });

  it('根路径只认 GET,其它方法 405', async () => {
    for (const method of ['POST', 'PUT', 'DELETE']) {
      expect((await call({ method, pathname: '/connections' })).status).toBe(405);
    }
  });
});

describe('ghostConnectionsEndpoint · POST /connections/<key>', () => {
  it('新地址先过受信确认;允许 → 入库并回连接视图 + onChanged 触发', async () => {
    const confirm = vi.fn(async () => true);
    const onChanged = vi.fn();
    const out = await call({
      method: 'POST',
      pathname: '/connections/gitlab',
      body: { host: 'GitLab.Example.com', token: 'glpat-1234567890ab', label: '主库' },
      confirm,
      onChanged,
    });
    expect(out.status).toBe(200);
    const parsed = JSON.parse(out.body ?? '{}') as { ok: boolean; connection?: Record<string, unknown> };
    expect(parsed.ok).toBe(true);
    expect(parsed.connection).toMatchObject({ host: 'gitlab.example.com', label: '主库', isDefault: true });
    expect(confirm).toHaveBeenCalledWith('GitLab 实例', 'gitlab.example.com');
    expect(onChanged).toHaveBeenCalledWith('gitlab');
  });

  it('用户拒绝 → 200 CONFIRM_DENIED,不入库;确认弹窗抛错按拒绝收', async () => {
    const manager = new GhostConnectionManager({ vault: makeVault() });
    const denied = await call({
      method: 'POST',
      pathname: '/connections/gitlab',
      body: { host: 'gitlab.example.com', token: 'glpat-xxx' },
      manager,
      confirm: async () => false,
    });
    expect(denied.status).toBe(200);
    expect(JSON.parse(denied.body ?? '{}')).toEqual({ ok: false, error: 'CONFIRM_DENIED' });
    expect(manager.list(G, 'gitlab')).toHaveLength(0);
    const thrown = await call({
      method: 'POST',
      pathname: '/connections/gitlab',
      body: { host: 'gitlab.example.com', token: 'glpat-xxx' },
      manager,
      confirm: async () => {
        throw new Error('弹窗炸了');
      },
    });
    expect(JSON.parse(thrown.body ?? '{}')).toEqual({ ok: false, error: 'CONFIRM_DENIED' });
  });

  it('同 host 更新 token 不再确认,但会触发通用 mutation 回调', async () => {
    const manager = new GhostConnectionManager({ vault: makeVault() });
    manager.upsert(G, 'gitlab', { host: 'gitlab.example.com', token: 'glpat-old', max: 2 });
    const confirm = vi.fn(async () => true);
    const onChanged = vi.fn();
    const out = await call({
      method: 'POST',
      pathname: '/connections/gitlab',
      body: { host: 'gitlab.example.com', token: 'glpat-new' },
      manager,
      confirm,
      onChanged,
    });
    expect(JSON.parse(out.body ?? '{}')).toMatchObject({ ok: true });
    expect(confirm).not.toHaveBeenCalled();
    expect(onChanged).toHaveBeenCalledWith('gitlab');
  });

  it('非法 host / 空 token / 超长 token / 非法 label 一律结构化拒', async () => {
    const invalidHost = await call({
      method: 'POST',
      pathname: '/connections/gitlab',
      body: { host: '*.example.com', token: 'glpat-xxx' },
    });
    expect(invalidHost.status).toBe(400);
    expect(JSON.parse(invalidHost.body ?? '{}')).toEqual({ ok: false, error: 'INVALID_HOST' });
    const emptyToken = await call({
      method: 'POST',
      pathname: '/connections/gitlab',
      body: { host: 'gitlab.example.com', token: '  ' },
    });
    expect(emptyToken.status).toBe(400);
    expect(JSON.parse(emptyToken.body ?? '{}')).toEqual({ ok: false, error: 'INVALID_TOKEN' });
    const longToken = await call({
      method: 'POST',
      pathname: '/connections/gitlab',
      body: { host: 'gitlab.example.com', token: 'x'.repeat(4097) },
    });
    expect(longToken.status).toBe(413);
    const badLabel = await call({
      method: 'POST',
      pathname: '/connections/gitlab',
      body: { host: 'gitlab.example.com', token: 'glpat-xxx', label: 'x'.repeat(65) },
    });
    expect(badLabel.status).toBe(400);
    expect(JSON.parse(badLabel.body ?? '{}')).toEqual({ ok: false, error: 'INVALID_LABEL' });
  });

  it('超声明上限 → 200 LIMIT', async () => {
    const manager = new GhostConnectionManager({ vault: makeVault() });
    manager.upsert(G, 'gitlab', { host: 'a.example.com', token: 't1', max: 2 });
    manager.upsert(G, 'gitlab', { host: 'b.example.com', token: 't2', max: 2 });
    const out = await call({
      method: 'POST',
      pathname: '/connections/gitlab',
      body: { host: 'c.example.com', token: 't3' },
      manager,
    });
    expect(out.status).toBe(200);
    expect(JSON.parse(out.body ?? '{}')).toEqual({ ok: false, error: 'LIMIT' });
  });

  it('保险库写失败 → 200 VAULT_WRITE_FAILED', async () => {
    const manager: GhostConnectionsEndpointManager = {
      list: () => [],
      upsert: () => ({ ok: false, error: 'VAULT_WRITE_FAILED' }),
      remove: () => {},
      setDefault: () => false,
    };
    const out = await call({
      method: 'POST',
      pathname: '/connections/gitlab',
      body: { host: 'gitlab.example.com', token: 'glpat-xxx' },
      manager,
    });
    expect(out.status).toBe(200);
    expect(JSON.parse(out.body ?? '{}')).toEqual({ ok: false, error: 'VAULT_WRITE_FAILED' });
  });
});

describe('ghostConnectionsEndpoint · DELETE / default / 404 兜底', () => {
  it('DELETE /connections/<key>/<id> 幂等 204;非 DELETE 方法 405', async () => {
    const manager = new GhostConnectionManager({ vault: makeVault() });
    const r = manager.upsert(G, 'gitlab', { host: 'a.example.com', token: 't1', max: 2 });
    if (!r.ok) throw new Error('准备失败');
    const del = await call({ method: 'DELETE', pathname: `/connections/gitlab/${r.connection.id}`, manager });
    expect(del.status).toBe(204);
    expect(manager.list(G, 'gitlab')).toHaveLength(0);
    // 幂等:再删同 id 仍 204。
    expect((await call({ method: 'DELETE', pathname: `/connections/gitlab/${r.connection.id}`, manager })).status).toBe(204);
    expect((await call({ method: 'GET', pathname: `/connections/gitlab/${r.connection.id}`, manager })).status).toBe(405);
  });

  it('POST /connections/<key>/default:已知 id 204,未知 id 404,坏 body 400', async () => {
    const manager = new GhostConnectionManager({ vault: makeVault() });
    const a = manager.upsert(G, 'gitlab', { host: 'a.example.com', token: 't1', max: 2 });
    const b = manager.upsert(G, 'gitlab', { host: 'b.example.com', token: 't2', max: 2 });
    if (!a.ok || !b.ok) throw new Error('准备失败');
    const out = await call({
      method: 'POST',
      pathname: '/connections/gitlab/default',
      body: { connectionId: b.connection.id },
      manager,
    });
    expect(out.status).toBe(204);
    expect(manager.list(G, 'gitlab').find((c) => c.isDefault)?.id).toBe(b.connection.id);
    expect(
      (await call({ method: 'POST', pathname: '/connections/gitlab/default', body: { connectionId: 'nope' }, manager }))
        .status,
    ).toBe(404);
    expect(
      (await call({ method: 'POST', pathname: '/connections/gitlab/default', body: { wrong: 1 }, manager })).status,
    ).toBe(400);
  });

  it('未声明的 key 一律 404(POST/DELETE/default 全路由)', async () => {
    for (const [method, pathname] of [
      ['POST', '/connections/nope'],
      ['DELETE', '/connections/nope/some-id'],
      ['POST', '/connections/nope/default'],
    ] as const) {
      const out = await call({ method, pathname, body: { host: 'a.example.com', token: 't' } });
      expect(out.status, `${method} ${pathname}`).toBe(404);
    }
  });
});
