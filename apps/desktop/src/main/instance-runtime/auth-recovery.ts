import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { z } from 'zod';

export const AUTH_RECOVERY_SOCKET = '/tmp/cindy-auth-recovery/control.sock';
export const authRecoveryRequest = z.strictObject({
  version: z.literal(1), requestId: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
  deviceId: z.string(), membershipId: z.string(),
  expiresAtMs: z.number().int().positive(), refreshToken: z.string().min(1).max(4096),
  /** The owner's explicit login access token (CIS sends it only to runtimes advertising
   * `explicit-access-token`); it lets a removed device register again with device-link. */
  accessToken: z.string().min(1).max(8192).optional(),
});
/** Advertised in the runtime status so CIS knows the optional `accessToken` is accepted. */
export const AUTH_RECOVERY_CAPABILITIES = ['explicit-access-token'] as const;
export type AuthRecoveryRequest = z.infer<typeof authRecoveryRequest>;

async function removeStaleSocket(socket: string): Promise<void> {
  let before: fs.Stats;
  try { before = fs.lstatSync(socket); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (!before.isSocket() || before.uid !== process.getuid?.()) throw new Error('INSTANCE_RECOVERY_SOCKET_INVALID');
  const stale = await new Promise<boolean>(resolve => {
    const probe = net.createConnection(socket);
    probe.setTimeout(1_000);
    probe.once('connect', () => { probe.destroy(); resolve(false); });
    probe.once('timeout', () => { probe.destroy(); resolve(false); });
    probe.once('error', error => resolve((error as NodeJS.ErrnoException).code === 'ECONNREFUSED'));
  });
  if (!stale) throw new Error('INSTANCE_RECOVERY_ALREADY_LISTENING');
  const after = fs.lstatSync(socket);
  if (after.ino !== before.ino || after.dev !== before.dev || !after.isSocket()
    || after.uid !== before.uid) throw new Error('INSTANCE_RECOVERY_SOCKET_CHANGED');
  fs.unlinkSync(socket);
}

/** Pod-local, owner-only control plane. No TCP listener, renderer IPC or URLs
 * containing secrets. Credential validation and atomic persistence stay in the
 * running auth manager, the sole writer of the instance profile. */
export async function startAuthRecoveryControl(options: {
  identity: { deviceId: string; membershipId: string };
  recover(input: AuthRecoveryRequest): Promise<void>;
  recovered(input: AuthRecoveryRequest): boolean;
}, socket = AUTH_RECOVERY_SOCKET): Promise<() => void> {
  const directory = path.dirname(socket);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const parent = fs.lstatSync(directory);
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid?.()
    || (parent.mode & 0o077) !== 0) throw new Error('INSTANCE_RECOVERY_DIRECTORY_INVALID');
  // An app crash can leave the socket in /tmp; never unlink a live listener.
  await removeStaleSocket(socket);
  let closing = false;
  let active: string | null = null;
  const server = http.createServer(async (req, res) => {
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    try {
      if (closing || req.method !== 'POST' || req.url !== '/v1/recover') {
        reply(409, { error: { code: 'INSTANCE_RECOVERY_UNAVAILABLE' } }); return;
      }
      let bytes = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 16384) throw new Error('INSTANCE_RECOVERY_REJECTED');
        chunks.push(Buffer.from(chunk));
      }
      const input = authRecoveryRequest.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      if (input.deviceId !== options.identity.deviceId || input.membershipId !== options.identity.membershipId
        || input.expiresAtMs <= Date.now() || input.expiresAtMs > Date.now() + 600_000)
        throw new Error('INSTANCE_RECOVERY_REJECTED');
      if (active) { reply(409, { error: { code: 'INSTANCE_RECOVERY_BUSY' } }); return; }
      active = input.requestId;
      try {
        if (!options.recovered(input)) await options.recover(input);
        if (!options.recovered(input)) throw new Error('INSTANCE_RECOVERY_UNVERIFIED');
        // Exactly the receipt CIS parses; the caller may pass its whole instance config as identity.
        reply(200, { version: 1, requestId: input.requestId, deviceId: options.identity.deviceId,
          membershipId: options.identity.membershipId, status: 'applied' });
      } finally { active = null; input.refreshToken = ''; if (input.accessToken) input.accessToken = ''; }
    } catch {
      // Never emit dependency errors (which may contain upstream credentials).
      reply(409, { error: { code: 'INSTANCE_RECOVERY_UNVERIFIED' } });
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socket, () => {
      try { fs.chmodSync(socket, 0o600); resolve(); }
      catch (error) { server.close(); reject(error); }
    });
  });
  return () => { closing = true; server.close(); };
}
