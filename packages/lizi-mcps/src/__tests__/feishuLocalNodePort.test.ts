import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNodeFeishuLocalPort } from '../feishu-local/nodePort.js';

const MAX_OUTPUT_BYTES = 1024 * 1024;
const roots: string[] = [];

type FakeChild = EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: ReturnType<typeof vi.fn> };

function archive(text: string): string {
  return JSON.stringify({ v: 1, files: [{ rel: 'auth.json', data: Buffer.from(text, 'utf8').toString('base64') }] });
}

function fakeSpawn(
  handler: (argv: string[], env: Record<string, string | undefined>, child: FakeChild) => void,
) {
  return vi.fn((_binary: string, argv: string[], options: { env?: Record<string, string | undefined> }) => {
    const child = new EventEmitter() as FakeChild;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn(() => true);
    handler(argv, options.env ?? {}, child);
    return child;
  });
}

async function createPort(options: { spawnFn: ReturnType<typeof fakeSpawn>; initial?: string | null }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-feishu-local-node-port-'));
  roots.push(root);
  const binary = path.join(root, 'lark-cli');
  await fs.writeFile(binary, '', { mode: 0o755 });
  const homeDir = path.join(root, 'home');
  const configDir = path.join(homeDir, '.config', 'lark-cli');
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(path.join(configDir, 'auth.json'), 'fixture-terminal-profile');
  let value = options.initial ?? null;
  let owner = 'owner-a:1';
  const writes: string[] = [];
  const credentials = {
    read: async () => value,
    write: async (next: string) => { writes.push(next); value = next; },
    bind: () => {
      const scope = owner;
      return {
        read: async () => value,
        write: async (next: string) => { writes.push(next); value = next; },
        assertCurrent: () => { if (owner !== scope) throw new Error('OWNER_SCOPE_CHANGED'); },
      };
    },
  };
  const port = createNodeFeishuLocalPort({
    platform: 'linux',
    homeDir,
    profileDir: root,
    deviceId: () => 'device-fixture',
    credentials,
    managedBinaryPath: binary,
    resolveManagedImage: async () => null,
    spawnFn: options.spawnFn as never,
  });
  return {
    port,
    root,
    homeDir,
    configDir,
    credentials: {
      get value() { return value; },
      writes,
      write: credentials.write,
      setOwner(next: string) { owner = next; },
    },
  };
}

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe('Feishu local CLI Node port', () => {
  it('marks outputs above the byte cap as truncated CLI failures', async () => {
    const spawnFn = fakeSpawn((_argv, _env, child) => {
      setImmediate(() => {
        child.stdout.emit('data', Buffer.alloc(MAX_OUTPUT_BYTES + 1, 0x61));
        child.emit('close', 0);
      });
    });
    const { port } = await createPort({ spawnFn, initial: archive('fixture-managed-profile') });
    const result = await port.runCli({ argv: ['auth', 'status', '--json'], withCredential: true });
    expect(result.ok).toBe(false);
    expect(result.reasonCode).toBe('CLI_FAILED');
    expect(result.outputTruncated).toBe(true);
    expect(result.stdout.length).toBeLessThanOrEqual(MAX_OUTPUT_BYTES);
  });

  it('does not probe or project a terminal identity before setup', async () => {
    const spawnFn = fakeSpawn((argv, _env, child) => {
      setImmediate(() => {
        if (argv[0] === 'auth') {
          child.stdout.emit('data', Buffer.from(JSON.stringify({ identities: { user: {
            available: true, tokenStatus: 'valid', scope: 'sheets:spreadsheet drive:drive', userName: 'Owner A',
          } } })));
        }
        child.emit('close', 0);
      });
    });
    const { port } = await createPort({ spawnFn, initial: null });
    const auth = await port.readAuth();
    expect(auth).toEqual({ state: 'missing', identity_alias: null, scopes: [], reason_code: 'SETUP_REQUIRED' });
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('imports a terminal login without starting a new device flow', async () => {
    const spawnFn = fakeSpawn((argv, _env, child) => {
      setImmediate(() => {
        if (argv[0] === 'auth' && argv[1] === 'status') {
          child.stdout.emit('data', Buffer.from(JSON.stringify({ identities: { user: {
            available: true, tokenStatus: 'valid', scope: 'sheets:spreadsheet drive:drive', userName: 'Fixture User',
          } } })));
        }
        child.emit('close', 0);
      });
    });
    const { port, credentials } = await createPort({ spawnFn, initial: null });
    const result = await port.connect({ mode: 'import-terminal', beforeCommit: async () => {} });
    expect(result.ok).toBe(true);
    expect(credentials.value).not.toBeNull();
    expect(spawnFn.mock.calls.some(([, argv]) => argv.includes('auth') && argv.includes('status'))).toBe(true);
    expect(spawnFn.mock.calls.some(([, argv]) => argv.includes('login'))).toBe(false);
  });

  it('passes only a validated verification URL to the setup callback', async () => {
    const spawnFn = fakeSpawn((argv, env, child) => {
      void (async () => {
        if (argv.includes('--no-wait')) {
          const payload = JSON.stringify({
            verification_url: 'https://open.feishu.cn/verify?user_code=ABC',
            device_code: 'fixture-device-code',
          });
          setImmediate(() => {
            child.stdout.emit('data', Buffer.from(payload));
            child.emit('close', 0);
          });
        } else {
          const dir = path.join(env.HOME ?? '', '.config', 'lark-cli');
          await fs.mkdir(dir, { recursive: true });
          await fs.writeFile(path.join(dir, 'auth.json'), 'fixture-new-login-profile');
          setImmediate(() => {
            child.stdout.emit('data', Buffer.from('{"ok":true}'));
            child.emit('close', 0);
          });
        }
      })().catch(() => setImmediate(() => child.emit('error', new Error('fake spawn failed'))));
    });
    const { port } = await createPort({ spawnFn, initial: null });
    let seen = '';
    const result = await port.connect({ mode: 'login', onAuthorizationUrl: url => { seen = url; } });
    expect(result.ok).toBe(true);
    expect(seen).toBe('https://open.feishu.cn/verify?user_code=ABC');
    expect(JSON.stringify(result)).not.toContain('fixture-device-code');
    expect(spawnFn.mock.calls.some(([, argv]) => argv.includes('--no-wait'))).toBe(true);
  });

  it('does not overwrite a newer reauthorization with a stale command profile', async () => {
    let release!: () => void;
    let markSpawned!: () => void;
    const delayed = new Promise<void>(resolve => { release = resolve; });
    const spawned = new Promise<void>(resolve => { markSpawned = resolve; });
    const spawnFn = fakeSpawn((_argv, env, child) => {
      markSpawned();
      void (async () => {
        const dir = path.join(env.HOME ?? '', '.config', 'lark-cli');
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(path.join(dir, 'auth.json'), 'fixture-stale-profile');
        child.stdout.emit('data', Buffer.from('{"ok":true}'));
        await delayed;
        child.emit('close', 0);
      })().catch(() => {});
    });
    const { port, credentials } = await createPort({ spawnFn, initial: archive('fixture-original-profile') });
    const running = port.runCli({ argv: ['auth', 'status', '--json'], withCredential: true });
    await spawned;
    await credentials.write(archive('fixture-new-login'));
    release();
    const result = await running;
    expect(result.ok).toBe(true);
    expect(credentials.value).toBe(archive('fixture-new-login'));
    expect(credentials.writes).toEqual([archive('fixture-new-login')]);
  });

  function loginSpawn(url: string) {
    return fakeSpawn((argv, env, child) => {
      void (async () => {
        if (argv.includes('--no-wait')) {
          const payload = JSON.stringify({
            verification_url: url,
            device_code: 'fixture-device-code',
          });
          setImmediate(() => {
            child.stdout.emit('data', Buffer.from(payload));
            child.emit('close', 0);
          });
        } else {
          const dir = path.join(env.HOME ?? '', '.config', 'lark-cli');
          await fs.mkdir(dir, { recursive: true });
          await fs.writeFile(path.join(dir, 'auth.json'), 'fixture-new-login-profile');
          setImmediate(() => {
            child.stdout.emit('data', Buffer.from('{"ok":true}'));
            child.emit('close', 0);
          });
        }
      })().catch(() => setImmediate(() => child.emit('error', new Error('fake spawn failed'))));
    });
  }

  it('rejects an off-origin verification URL before the device-code login', async () => {
    const spawnFn = loginSpawn('https://attacker.example/verify?user_code=ABC');
    const { port } = await createPort({ spawnFn, initial: null });
    const result = await port.connect({ mode: 'login', onAuthorizationUrl: vi.fn() });
    expect(result.reasonCode).toBe('CLI_FAILED');
    expect(spawnFn.mock.calls.some(([, argv]) => argv.includes('--device-code'))).toBe(false);
  });

  it('does not commit a login when a newer reauthorization wins', async () => {
    const spawnFn = loginSpawn('https://open.feishu.cn/verify?user_code=ABC');
    const { port, credentials } = await createPort({ spawnFn, initial: null });
    const result = await port.connect({
      mode: 'login',
      beforeCommit: async () => { await credentials.write(archive('fixture-new-login')); },
    });
    expect(result.reasonCode).toBe('SETUP_REQUIRED');
    expect(credentials.value).toBe(archive('fixture-new-login'));
    expect(credentials.writes).toEqual([archive('fixture-new-login')]);
  });

  it('drops a login commit when the owner changes before credential write', async () => {
    const spawnFn = loginSpawn('https://open.feishu.cn/verify?user_code=ABC');
    const { port, credentials } = await createPort({ spawnFn, initial: null });
    const result = await port.connect({
      mode: 'login',
      beforeCommit: async () => { credentials.setOwner('owner-b:2'); },
    });
    expect(result.reasonCode).toBe('SETUP_UNAVAILABLE');
    expect(credentials.value).toBeNull();
    expect(credentials.writes).toEqual([]);
  });

  it('keeps new login profiles out of the shared terminal config and cleans the temp home', async () => {
    const spawnFn = loginSpawn('https://open.feishu.cn/verify?user_code=ABC');
    const { port, root, configDir, credentials } = await createPort({ spawnFn, initial: null });
    const before = await fs.readFile(path.join(configDir, 'auth.json'), 'utf8');
    const result = await port.connect({ mode: 'login', onAuthorizationUrl: () => {} });
    expect(result.ok).toBe(true);
    expect(await fs.readFile(path.join(configDir, 'auth.json'), 'utf8')).toBe(before);
    expect(credentials.value).toBe(archive('fixture-new-login-profile'));
    const tempHomes = (await fs.readdir(root)).filter(name => name.startsWith('feishu-local-login-'));
    expect(tempHomes).toHaveLength(0);
  });
});
