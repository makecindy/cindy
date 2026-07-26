import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HeadlessConfigStore } from './config.js';
import { HeadlessControlService } from './control-service.js';
import { HeadlessSessionStorage } from './session-storage.js';
import type { HeadlessSessionRuntime } from './session-runtime.js';
import { MemorySecretStore } from './secret-store.js';
import type { HeadlessCindyAccountService } from './cindy-account.js';

const dirs: string[] = [];
function makeService(): { service: HeadlessControlService; close: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-headless-control-'));
  dirs.push(dir);
  const storage = new HeadlessSessionStorage(path.join(dir, 'sessions.db'));
  return {
    service: new HeadlessControlService(storage, new HeadlessConfigStore(path.join(dir, 'config.json'))),
    close: () => storage.close(),
  };
}
afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

describe('HeadlessControlService', () => {
  it('accepts terminal and mobile input into the same session queue', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-headless-runtime-'));
    dirs.push(dir);
    const storage = new HeadlessSessionStorage(path.join(dir, 'sessions.db'));
    const sent: string[] = [];
    const runtime: HeadlessSessionRuntime = {
      send: async (_session, content) => { sent.push(typeof content === 'string' ? content : JSON.stringify(content)); },
      steer: async () => undefined,
      abort: async () => undefined,
      closeSession: async () => undefined,
      resolveInteraction: async () => false,
      reconfigure: async () => undefined,
      setOrcaRole: async () => undefined,
      isSessionBusy: () => false,
      isAnySessionBusy: () => false,
      close: async () => undefined,
    };
    const service = new HeadlessControlService(storage, new HeadlessConfigStore(path.join(dir, 'config.json')), runtime);
    const created = await service.handle({
      id: 'create', method: 'session.create', params: { agentKind: 'codex', model: 'gpt-5.6' },
    });
    const sessionId = (created as { result: { id: string } }).result.id;
    await expect(service.handle({
      id: 'send-terminal', method: 'session.send', params: { sessionId, content: 'from terminal' },
    })).resolves.toMatchObject({ ok: true, result: { accepted: true } });
    await expect(service.handle({
      id: 'send-mobile', method: 'session.send', params: { sessionId, content: 'from mobile' },
    })).resolves.toMatchObject({ ok: true, result: { accepted: true } });
    expect(sent).toEqual(['from terminal', 'from mobile']);
    await expect(storage.get(sessionId)).resolves.toMatchObject({ title: 'from terminal' });
    await expect(storage.listEvents(sessionId, 0, 20)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'session_configured', data: { patch: { title: 'from terminal' } } }),
    ]));
    storage.close();
  });

  it('backfills a meaningful title for an existing Linux draft session', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-headless-title-backfill-'));
    dirs.push(dir);
    const storage = new HeadlessSessionStorage(path.join(dir, 'sessions.db'));
    await storage.create({ id: 'old-session', agentKind: 'codex', workDir: '', title: 'New Cindy session', model: 'gpt-5.6' });
    await storage.appendEvent('old-session', 'user_message', { content: '看看我系统的版本' });
    const service = new HeadlessControlService(storage, new HeadlessConfigStore(path.join(dir, 'config.json')));

    await expect(service.handle({ id: 'list', method: 'session.list' })).resolves.toMatchObject({
      ok: true,
      result: [expect.objectContaining({ id: 'old-session', title: '看看我系统的版本' })],
    });
    storage.close();
  });

  it('persists a closed status even when the runtime never attached the session', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-headless-close-'));
    dirs.push(dir);
    const storage = new HeadlessSessionStorage(path.join(dir, 'sessions.db'));
    const runtime: HeadlessSessionRuntime = {
      send: async () => undefined,
      steer: async () => undefined,
      abort: async () => undefined,
      closeSession: async () => undefined,
      resolveInteraction: async () => false,
      reconfigure: async () => undefined,
      setOrcaRole: async () => undefined,
      isSessionBusy: () => false,
      isAnySessionBusy: () => false,
      close: async () => undefined,
    };
    const service = new HeadlessControlService(storage, new HeadlessConfigStore(path.join(dir, 'config.json')), runtime);
    const created = await service.handle({ id: 'create', method: 'session.create', params: { agentKind: 'codex', model: 'gpt-5.6' } });
    const sessionId = (created as { result: { id: string } }).result.id;

    await expect(service.handle({ id: 'close', method: 'session.close', params: { sessionId } }))
      .resolves.toMatchObject({ ok: true, result: { closed: true } });
    await expect(storage.get(sessionId)).resolves.toMatchObject({ status: 'archived' });
    await expect(storage.listEvents(sessionId, 0, 20)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'session_status', data: { status: 'closed' } }),
    ]));
    storage.close();
  });

  it('recreates only an idle runtime session when changing session settings', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-headless-configure-'));
    dirs.push(dir);
    const storage = new HeadlessSessionStorage(path.join(dir, 'sessions.db'));
    let reconfigured = 0;
    const runtime: HeadlessSessionRuntime = {
      send: async () => undefined,
      steer: async () => undefined,
      abort: async () => undefined,
      closeSession: async () => undefined,
      resolveInteraction: async () => false,
      reconfigure: async () => { reconfigured++; },
      setOrcaRole: async () => undefined,
      isSessionBusy: () => false,
      isAnySessionBusy: () => false,
      close: async () => undefined,
    };
    const service = new HeadlessControlService(storage, new HeadlessConfigStore(path.join(dir, 'config.json')), runtime);
    const created = await service.handle({ id: 'create', method: 'session.create', params: { agentKind: 'codex', model: 'gpt-5.6' } });
    const sessionId = (created as { result: { id: string } }).result.id;
    await expect(service.handle({
      id: 'configure', method: 'session.configure',
      params: { sessionId, model: 'gpt-5.7', effort: 'low' },
    })).resolves.toMatchObject({ ok: true, result: { model: 'gpt-5.7', effort: 'low' } });
    expect(reconfigured).toBe(1);
    storage.close();
  });

  it('persists the explicit provider selected for a session', async () => {
    const { service, close } = makeService();
    const result = await service.handle({
      id: 'create',
      method: 'session.create',
      params: { agentKind: 'codex', providerId: 'openai', model: 'gpt-5.6', workDir: '/srv/project' },
    });
    expect(result).toMatchObject({ ok: true, result: { providerId: 'openai', model: 'gpt-5.6' } });
    close();
  });

  it('uses the authenticated Cindy XD gateway when a remote client omits providerId', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-headless-managed-default-'));
    dirs.push(dir);
    const storage = new HeadlessSessionStorage(path.join(dir, 'sessions.db'));
    const config = new HeadlessConfigStore(path.join(dir, 'config.json'));
    await config.write({
      ...(await config.read()),
      account: { deviceId: 'linux-device', region: 'cn' },
      managedModels: [{ id: 'codex/gpt-5.6-terra', agents: ['codex'] }],
    });
    const account = { getState: () => ({ authenticated: true }) } as unknown as HeadlessCindyAccountService;
    const service = new HeadlessControlService(
      storage, config, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, account,
    );

    await expect(service.handle({
      id: 'create-managed-default', method: 'session.create',
      params: { agentKind: 'codex', model: 'codex/gpt-5.6-terra' },
    })).resolves.toMatchObject({ ok: true, result: { providerId: 'xd' } });
    await expect(service.handle({ id: 'managed-provider', method: 'catalog.providers', params: { agentKind: 'codex' } }))
      .resolves.toMatchObject({
        ok: true,
        result: expect.arrayContaining([expect.objectContaining({ id: 'xd', credentialConfigured: true })]),
      });
    storage.close();
  });

  it('previews and creates a usable session from the effective defaults without terminal-by-terminal picks', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-headless-default-preview-'));
    dirs.push(dir);
    const storage = new HeadlessSessionStorage(path.join(dir, 'sessions.db'));
    const config = new HeadlessConfigStore(path.join(dir, 'config.json'));
    await config.write({
      ...(await config.read()),
      account: { deviceId: 'linux-device', region: 'cn' },
      managedModels: [{ id: 'codex/gpt-5.6-terra', agents: ['codex'], defaultEffort: 'high' }],
      defaults: { permissionMode: 'ask' },
    });
    const account = { getState: () => ({ authenticated: true }) } as unknown as HeadlessCindyAccountService;
    const service = new HeadlessControlService(storage, config, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, account);

    await expect(service.handle({ id: 'preview', method: 'session.create.preview', params: { workDir: '', workspaceKind: 'dialogue' } }))
      .resolves.toMatchObject({ ok: true, result: { agentKind: 'codex', providerId: 'xd', model: 'codex/gpt-5.6-terra', effort: 'high', permissionMode: 'ask' } });
    await expect(service.handle({ id: 'create', method: 'session.create', params: { workDir: '', workspaceKind: 'dialogue' } }))
      .resolves.toMatchObject({ ok: true, result: { agentKind: 'codex', providerId: 'xd', model: 'codex/gpt-5.6-terra' } });
    storage.close();
  });

  it('resolves session, project, user, and product configuration in precedence order', async () => {
    const { service, close } = makeService();
    await expect(service.handle({
      id: 'user-default', method: 'config.defaults.set', params: { model: 'gpt-user', effort: 'medium' },
    })).resolves.toMatchObject({ ok: true, result: { user: { model: 'gpt-user' } } });
    await expect(service.handle({
      id: 'project-default', method: 'config.project-defaults.set',
      params: { workDir: '/srv/work/api', model: 'gpt-project' },
    })).resolves.toMatchObject({ ok: true, result: { effective: { model: 'gpt-project', effort: 'medium' } } });
    await expect(service.handle({
      id: 'create', method: 'session.create', params: { workDir: '/srv/work/api', model: 'gpt-session' },
    })).resolves.toMatchObject({ ok: true, result: { model: 'gpt-session', effort: 'medium' } });
    await expect(service.handle({
      id: 'reset', method: 'config.project-defaults.reset', params: { workDir: '/srv/work/api' },
    })).resolves.toMatchObject({ ok: true, result: { project: {}, effective: { model: 'gpt-user' } } });
    close();
  });

  it('exposes agent-filtered catalog queries through the shared control surface', async () => {
    const { service, close } = makeService();
    await expect(service.handle({ id: 'providers', method: 'catalog.providers', params: { agentKind: 'codex' } }))
      .resolves.toMatchObject({ ok: true, result: expect.arrayContaining([expect.objectContaining({ id: 'openai' })]) });
    await expect(service.handle({ id: 'models', method: 'catalog.models', params: { agentKind: 'claude-code' } }))
      .resolves.toMatchObject({ ok: true, result: expect.any(Array) });
    close();
  });

  it('creates a custom provider profile without placing its credential in config', async () => {
    const { service, close } = makeService();
    await expect(service.handle({
      id: 'add-provider', method: 'provider.add', params: {
      id: 'company-gateway', name: 'Company Gateway', agentKind: 'codex',
        baseUrl: 'https://models.example.test/v1', model: 'company-code-2',
      },
    })).resolves.toMatchObject({
      ok: true,
      result: { id: 'company-gateway', authMethod: 'apiKey', credentialConfigured: false },
    });
    await expect(service.handle({ id: 'providers', method: 'catalog.providers', params: { agentKind: 'codex' } }))
      .resolves.toMatchObject({ ok: true, result: expect.arrayContaining([expect.objectContaining({ id: 'company-gateway' })]) });
    close();
  });

  it('persists generic device-code metadata without token material', async () => {
    const { service, close } = makeService();
    await expect(service.handle({
      id: 'add-device-code-provider', method: 'provider.add', params: {
        id: 'company-device-code', name: 'Company Device Code', agentKind: 'codex',
        baseUrl: 'https://models.example.test/v1', model: 'company-code-2',
        deviceAuthorizationUrl: 'https://auth.example.test/device',
        tokenUrl: 'https://auth.example.test/token', clientId: 'cindy-headless', scopes: 'model.read',
      },
    })).resolves.toMatchObject({ ok: true });
    await expect(service.handle({ id: 'config', method: 'config.get' })).resolves.toMatchObject({
      ok: true,
      result: { providerProfiles: [expect.objectContaining({
        id: 'company-device-code', secretRef: expect.any(String),
        deviceCode: expect.objectContaining({ clientId: 'cindy-headless' }),
      })] },
    });
    close();
  });

  it('does not expose an invented session-control lease protocol', async () => {
    const { service, close } = makeService();
    await expect(service.handle({ id: '1', method: 'daemon.ping' })).resolves.toEqual({ id: '1', ok: true, result: { ok: true } });
    await expect(service.handle({ id: '2', method: 'lease.acquire', params: { sessionId: 's1' } }))
      .resolves.toMatchObject({ ok: false, error: { message: expect.stringContaining('Unsupported control method') } });
    close();
  });

  it('stores the Device Link token outside configuration and keeps remote control opt-in', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-headless-device-link-'));
    dirs.push(dir);
    const storage = new HeadlessSessionStorage(path.join(dir, 'sessions.db'));
    const secrets = new MemorySecretStore();
    const config = new HeadlessConfigStore(path.join(dir, 'config.json'));
    const service = new HeadlessControlService(storage, config, undefined, undefined, secrets);
    await expect(service.handle({
      id: 'import', method: 'device-link.token.import', params: { token: 'sensitive-token', deviceName: 'CI Linux' },
    })).resolves.toMatchObject({ ok: true, result: { stored: true, deviceId: expect.any(String) } });
    await expect(secrets.get('cindy_device_link')).resolves.toBe('sensitive-token');
    await expect(config.read()).resolves.toMatchObject({
      remoteControlEnabled: false,
      deviceLink: { tokenRef: 'cindy_device_link', deviceName: 'CI Linux' },
    });
    await expect(service.handle({ id: 'enable', method: 'device-link.set-enabled', params: { enabled: true } }))
      .resolves.toMatchObject({ ok: true, result: { remoteControlEnabled: true } });
    storage.close();
  });

  it('rebuilds Device Link after a Cindy login or remote-control switch', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-headless-device-link-refresh-'));
    dirs.push(dir);
    const storage = new HeadlessSessionStorage(path.join(dir, 'sessions.db'));
    const account = {
      activateLogin: vi.fn(async () => ({ authenticated: true })),
      clearLogin: vi.fn(async () => undefined),
      getState: () => ({ authenticated: false }),
    } as unknown as HeadlessCindyAccountService;
    const refreshDeviceLink = vi.fn(async () => undefined);
    const service = new HeadlessControlService(
      storage, new HeadlessConfigStore(path.join(dir, 'config.json')), undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, account, refreshDeviceLink,
    );

    await expect(service.handle({
      id: 'login', method: 'account.login.complete',
      params: { region: 'cn', deviceId: 'linux-device', accessToken: 'access-token', refreshToken: 'refresh-token' },
    })).resolves.toMatchObject({ ok: true, result: { authenticated: true } });
    await expect(service.handle({ id: 'enable', method: 'device-link.set-enabled', params: { enabled: true } }))
      .resolves.toMatchObject({ ok: true, result: { remoteControlEnabled: true } });
    expect(refreshDeviceLink).toHaveBeenCalledTimes(2);
    storage.close();
  });

  it('reports the active Cindy account as the Device Link source', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-headless-device-link-status-'));
    dirs.push(dir);
    const storage = new HeadlessSessionStorage(path.join(dir, 'sessions.db'));
    const config = new HeadlessConfigStore(path.join(dir, 'config.json'));
    await config.write({ ...(await config.read()), account: { deviceId: 'linux-device', region: 'cn' } });
    const account = {
      getState: () => ({ authenticated: true }),
      getDeviceLinkApiBase: () => 'https://relay.example.test',
    } as unknown as HeadlessCindyAccountService;
    const service = new HeadlessControlService(storage, config, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, account);

    await expect(service.handle({ id: 'status', method: 'device-link.status' }))
      .resolves.toMatchObject({ ok: true, result: { configured: true, source: 'cindy-account', deviceId: 'linux-device' } });
    storage.close();
  });

  it('persists a friendly Linux Device Link name and restarts the relay client', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-headless-device-name-'));
    dirs.push(dir);
    const storage = new HeadlessSessionStorage(path.join(dir, 'sessions.db'));
    const config = new HeadlessConfigStore(path.join(dir, 'config.json'));
    const refreshDeviceLink = vi.fn(async () => undefined);
    const service = new HeadlessControlService(
      storage, config, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, refreshDeviceLink,
    );

    await expect(service.handle({ id: 'name', method: 'device-link.set-name', params: { deviceName: 'TownsLinux' } }))
      .resolves.toMatchObject({ ok: true, result: { deviceName: 'TownsLinux' } });
    await expect(config.read()).resolves.toMatchObject({ deviceName: 'TownsLinux' });
    expect(refreshDeviceLink).toHaveBeenCalledOnce();
    storage.close();
  });
});
