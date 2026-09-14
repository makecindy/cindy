import { app } from 'electron';
import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { parseRemoteCredentialRequest } from '@cindy/device-link';
import {
  credentialSigningIdentity,
  credentialSigningArguments,
  credentialVerificationArguments,
} from './credentialSigning';
import { createLogger } from '../logger';

const exec = promisify(execFile);
const diagnostic = createLogger('remote-credentials');
const binaryName = 'cindy-macos-remote-credentials';
let build: Promise<string> | undefined;
async function resolveBinary(realm: 'global' | 'cn'): Promise<string> {
  if (app.isPackaged) return path.join(process.resourcesPath, 'tools/remote-desktop', binaryName);
  if (build) return build;
  build = (async () => {
    const root = path.resolve(app.getAppPath(), '../../packages/remote-credentials-native');
    const signingIdentity = credentialSigningIdentity(
      process.env.CINDY_REMOTE_CREDENTIALS_SIGNING_IDENTITY,
    );
    const hash = createHash('sha256')
      .update(process.execPath)
      .update(process.arch)
      .update('credential-host-signed-v1')
      .update(signingIdentity);
    async function digest(directory: string): Promise<void> {
      for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) =>
        a.name.localeCompare(b.name),
      )) {
        const file = path.join(directory, entry.name);
        hash.update(path.relative(root, file));
        if (entry.isDirectory()) await digest(file);
        else hash.update(await fs.readFile(file));
      }
    }
    await digest(path.join(root, 'Sources'));
    for (const file of ['Package.swift', 'Package.resolved'])
      hash.update(await fs.readFile(path.join(root, file)));
    const directory = path.join(
      app.getPath('userData'),
      'remote-desktop/native-credentials',
      hash.digest('hex'),
    );
    const binary = path.join(directory, binaryName);
    try {
      await fs.access(binary);
      await exec('/usr/bin/codesign', credentialVerificationArguments(binary, signingIdentity));
      return binary;
    } catch {
      /* Build and sign this exact native source; never run an ad-hoc cache. */
    }
    await fs.mkdir(directory, { recursive: true });
    const source = await fs.mkdtemp(path.join(directory, 'compile-'));
    try {
      for (const file of ['Package.swift', 'Package.resolved', 'Sources', 'Tests']) {
        await fs.cp(path.join(root, file), path.join(source, file), { recursive: true });
      }
      const main = path.join(source, 'Sources/CredentialHost/main.swift');
      await fs.writeFile(
        main,
        (await fs.readFile(main, 'utf8')).replace(
          '"CREDENTIAL_HOST_DEVELOPMENT_EXECUTABLE"',
          JSON.stringify(Buffer.from(process.execPath).toString('base64')),
        ),
      );
      await exec(
        'swift',
        [
          'build',
          '--package-path',
          source,
          '-c',
          'release',
          '--product',
          binaryName,
          '-Xswiftc',
          '-D',
          '-Xswiftc',
          'DESKTOP_INPUT_DEVELOPMENT',
        ],
        { timeout: 240_000, maxBuffer: 1024 * 1024 },
      );
      const temporary = `${binary}.${process.pid}.tmp`;
      await fs.copyFile(path.join(source, '.build/release', binaryName), temporary);
      await fs.chmod(temporary, 0o755);
      await exec('/usr/bin/codesign', credentialSigningArguments(signingIdentity, temporary));
      await exec('/usr/bin/codesign', credentialVerificationArguments(temporary, signingIdentity));
      await fs.rename(temporary, binary);
      return binary;
    } finally {
      await fs.rm(source, { recursive: true, force: true });
    }
  })().finally(() => {
    build = undefined;
  });
  return build;
}

type Pending = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};
/** Stdio is authenticated in native code. This class never receives a password. */
class RemoteCredentialHost {
  private child: ChildProcessWithoutNullStreams | null = null;
  private starting: Promise<void> | null = null;
  private pending = new Map<string, Pending>();
  private sessions: Record<string, string> = {};
  private validUntil = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling: Promise<void> | null = null;
  private authorizing = 0;
  private epoch = 0;
  private configuredOwner = '';
  private configuredRealm: 'global' | 'cn' | null = null;
  currentToken:
    | (() => {
        realm: 'global' | 'cn';
        membership: string;
        authDevice: string;
        token: string;
      } | null)
    | undefined;
  onInvalidated: (() => void) | undefined;

  authenticationSession(peer: string): string | null {
    return performance.now() < this.validUntil ? (this.sessions[peer] ?? null) : null;
  }
  async configure(
    realm: 'global' | 'cn',
    membership: string,
    authDevice: string,
    token: string,
  ): Promise<string> {
    const owner = JSON.stringify([realm, membership, authDevice]);
    if (owner !== this.configuredOwner) {
      this.dispose();
      this.configuredOwner = owner;
    }
    this.configuredRealm = realm;
    const result = await this.authorizeCall('configure', { realm, membership, authDevice, token });
    if (typeof result !== 'string') throw new Error('CREDENTIAL_INVALID_IDENTITY');
    if (!this.timer)
      this.timer = setInterval(() => {
        const epoch = this.epoch;
        void this.refresh().catch(() => {
          if (this.epoch === epoch) this.invalidate();
        });
      }, 1000);
    return result;
  }
  async relayHeaders(): Promise<Record<string, string>> {
    const result = await this.call('relayHeaders');
    if (
      !result ||
      typeof result !== 'object' ||
      Object.values(result).some((v) => typeof v !== 'string')
    )
      throw new Error('CREDENTIAL_INVALID_IDENTITY');
    return result as Record<string, string>;
  }

  async request(
    peer: string,
    value: unknown,
    execute: (body: unknown) => Promise<unknown>,
  ): Promise<unknown> {
    const request = parseRemoteCredentialRequest(value);
    if (request.kind === 'open')
      return this.authorizeCall('begin', {
        peer,
        offer: request.offer,
        descriptor: request.descriptor ?? '',
      });
    const received = (await this.call('receive', {
      peer,
      handle: request.handle,
      ciphertext: request.ciphertext,
    })) as Record<string, unknown>;
    await this.refresh(true);
    if (received.kind === 'closed') return { closed: true };
    if (received.kind === 'reply' && typeof received.ciphertext === 'string')
      return { ciphertext: received.ciphertext };
    if (
      received.kind !== 'command' ||
      received.authenticationSession !== this.authenticationSession(peer) ||
      typeof received.id !== 'string' ||
      typeof received.body !== 'string'
    )
      throw new Error('CREDENTIAL_INVALID_MESSAGE');
    let body: unknown,
      success = true;
    try {
      body = await execute(JSON.parse(received.body));
    } catch (error) {
      success = false;
      // Ordinary desktop error codes only. Raw native/OS errors never cross.
      const message =
        error instanceof Error && /^[A-Z][A-Z0-9_]{1,100}$/.test(error.message)
          ? error.message
          : 'DESKTOP_UNAVAILABLE';
      body = { error: message };
    }
    const ciphertext = await this.call('response', {
      peer,
      handle: request.handle,
      requestId: received.id,
      body: JSON.stringify(body ?? null),
      success,
    });
    if (typeof ciphertext !== 'string') throw new Error('CREDENTIAL_INVALID_MESSAGE');
    return { ciphertext };
  }
  async close(peer: string): Promise<void> {
    this.epoch += 1;
    delete this.sessions[peer];
    if (this.child) await this.call('close', { peer });
  }
  async closeAll(): Promise<void> {
    this.epoch += 1;
    this.invalidate();
    if (this.child) await this.call('closeAll');
  }
  dispose(): void {
    this.epoch += 1;
    this.configuredOwner = '';
    this.configuredRealm = null;
    this.invalidate();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const child = this.child;
    this.child = null;
    child?.kill();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('CREDENTIAL_UNAVAILABLE'));
    }
    this.pending.clear();
  }
  private invalidate(): void {
    this.validUntil = 0;
    this.sessions = {};
    this.onInvalidated?.();
  }
  private async refresh(afterCommand = false): Promise<void> {
    // Security.framework can block the helper while macOS asks for Keychain
    // approval. Never queue a shorter-lived poll behind that system dialog.
    if (this.authorizing) return;
    if (this.polling) {
      await this.polling;
      if (!afterCommand || this.authorizing) return;
    }
    const epoch = this.epoch;
    const refresh = (async () => {
      const credentials = this.currentToken?.();
      if (credentials) await this.call('updateToken', credentials);
      const result = await this.call('status');
      if (epoch !== this.epoch) return;
      if (
        !result ||
        typeof result !== 'object' ||
        Object.values(result).some((v) => typeof v !== 'string')
      )
        throw new Error('CREDENTIAL_INVALID_MESSAGE');
      this.sessions = result as Record<string, string>;
      this.validUntil = performance.now() + 2500;
    })();
    this.polling = refresh;
    try {
      await refresh;
    } finally {
      if (this.polling === refresh) this.polling = null;
    }
  }
  private async start(): Promise<void> {
    if (this.child) return;
    if (this.starting) return this.starting;
    const epoch = this.epoch;
    this.starting = (async () => {
      const realm = this.configuredRealm;
      if (!realm) throw new Error('CREDENTIAL_INVALID_IDENTITY');
      const binary = await resolveBinary(realm);
      if (this.epoch !== epoch) throw new Error('CREDENTIAL_CANCELLED');
      const child = spawn(
        binary,
        [path.join(app.getPath('userData'), 'remote-desktop/credential-identity')],
        { stdio: ['pipe', 'pipe', 'pipe'] },
      );
      this.child = child;
      let buffer = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        if (this.child !== child) return;
        buffer += chunk;
        if (buffer.length > 48 * 1024 * 1024) {
          this.dispose();
          return;
        }
        let newline: number;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          try {
            const value = JSON.parse(line) as { id: string; error?: string; result?: unknown };
            const pending = this.pending.get(value.id);
            if (!pending) continue;
            this.pending.delete(value.id);
            clearTimeout(pending.timer);
            if (value.error)
              pending.reject(
                new Error(
                  /^CREDENTIAL_[A-Z_]+$/.test(value.error) ? value.error : 'CREDENTIAL_UNAVAILABLE',
                ),
              );
            else pending.resolve(value.result);
          } catch {
            this.dispose();
            return;
          }
        }
      });
      child.stderr.resume(); // Never forward native diagnostics into app logs.
      child.on('error', () => {
        if (this.child === child) this.dispose();
      });
      child.on('exit', () => {
        if (this.child === child) this.dispose();
      });
    })().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }
  private async authorizeCall(
    method: 'configure' | 'begin',
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const deadline = performance.now() + 50_000;
    this.authorizing++;
    try {
      // Drain a poll already sent before starting a potentially interactive call.
      await this.polling;
      return await this.call(method, args, deadline - performance.now());
    } finally {
      this.authorizing--;
    }
  }
  private async call(
    method: string,
    args: Record<string, unknown> = {},
    timeout = 35_000,
  ): Promise<unknown> {
    if (process.platform !== 'darwin') throw new Error('CREDENTIAL_UNAVAILABLE');
    if (timeout <= 0) throw new Error('CREDENTIAL_EXPIRED');
    const id = randomUUID();
    let timer: ReturnType<typeof setTimeout>;
    return new Promise((resolve, reject) => {
      // Include cold native build/start time; a late build must not open a
      // Keychain prompt after the remote request has already failed.
      timer = setTimeout(() => {
        this.dispose();
        reject(new Error('CREDENTIAL_UNAVAILABLE'));
      }, timeout);
      void (async () => {
        await this.start();
        const child = this.child;
        if (!child || this.pending.size >= 128) throw new Error('CREDENTIAL_UNAVAILABLE');
        this.pending.set(id, { resolve, reject, timer });
        child.stdin.write(JSON.stringify({ id, method, ...args }) + '\n', (error) => {
          if (error) this.dispose();
        });
      })().catch(reject);
    })
      .finally(() => clearTimeout(timer))
      .then(
        (result) => {
          if (['configure', 'begin', 'receive'].includes(method))
            diagnostic.debug(`${method}: completed`);
          return result;
        },
        (error) => {
          // Temporary development diagnosis: fixed operation/code only, no payload,
          // password, identity descriptor, account, device ID or raw OS error text.
          const code =
            error instanceof Error && /^CREDENTIAL_[A-Z_]+$/.test(error.message)
              ? error.message
              : 'CREDENTIAL_UNAVAILABLE';
          diagnostic.debug(`${method}: ${code}`);
          throw error;
        },
      );
  }
}

export const remoteCredentialHost = new RemoteCredentialHost();
