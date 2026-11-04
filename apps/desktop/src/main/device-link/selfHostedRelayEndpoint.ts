import { createHash, timingSafeEqual } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import type { ClientRequest } from 'node:http';
import { isIP } from 'node:net';
import { checkServerIdentity, type TLSSocket } from 'node:tls';
import { ensureRemoteHostReady, getRemoteSshPool } from '../remote-ssh/index.js';

const TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 128 * 1024;
const failure = () => new Error('RELAY_ENDPOINT_VERIFICATION_FAILED');
const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

// The authenticated SSH connection is the trust anchor. Only loopback TLS is probed;
// SNI selects the installed certificate without making any public DNS connection.
// No relay credential, private key or HTTP request is sent over SSH.
const PROBE = `const tls = require('node:tls');
const { createHash } = require('node:crypto');
let socket, done = false;
const timer = setTimeout(() => finish(), 8000);
function finish(raw) {
  if (done) return;
  done = true;
  clearTimeout(timer);
  if (socket) socket.destroy();
  if (raw && Buffer.isBuffer(raw) && raw.length) {
    process.stdout.write(createHash('sha256').update(raw).digest('hex') + '\\n');
    process.exitCode = 0;
  } else process.exitCode = 1;
}
try {
  socket = tls.connect({ host: '127.0.0.1', port: Number(process.argv[1]),
    servername: process.argv[2] || undefined, rejectUnauthorized: false });
  socket.once('secureConnect', () => finish(socket.getPeerCertificate().raw));
  socket.once('error', () => finish());
  socket.once('close', () => finish());
} catch { finish(); }
`;

export type AgentRelayRequest = (
  endpoint: 'info' | 'admin/status', credential?: string,
) => Promise<Record<string, unknown> | null>;

/** Bind registration to an SSH-observed TLS endpoint, without persisting a certificate pin. */
export async function verifyAgentRelayEndpoint(input: {
  sshHostId: string;
  baseUrl: string;
  tlsPort: number;
  nodePath?: string;
  assertCurrent: () => Promise<void>;
}): Promise<AgentRelayRequest> {
  await input.assertCurrent();
  const nodePath = input.nodePath ?? 'node';
  let base: URL;
  try { base = new URL(input.baseUrl); } catch { throw failure(); }
  if (typeof input.sshHostId !== 'string' || !input.sshHostId.trim() || input.sshHostId.length > 200 ||
    /[\x00-\x1f\x7f]/.test(input.sshHostId) || typeof input.baseUrl !== 'string' || input.baseUrl.length > 4096 ||
    base.protocol !== 'https:' || !base.hostname || base.username || base.password || base.search || base.hash ||
    !Number.isInteger(input.tlsPort) || input.tlsPort < 1 || input.tlsPort > 65535 ||
    typeof nodePath !== 'string' || !nodePath || nodePath.length > 4096 || /[\x00-\x1f\x7f]/.test(nodePath) ||
    !(nodePath.startsWith('/') || /^[A-Za-z0-9_][A-Za-z0-9_.+-]*$/.test(nodePath))) throw failure();
  const hostname = base.hostname.replace(/^\[|\]$/g, '');
  const servername = isIP(hostname) ? '' : hostname;
  try { await ensureRemoteHostReady(input.sshHostId); }
  catch { await input.assertCurrent(); throw failure(); }
  await input.assertCurrent();
  const host = getRemoteSshPool().get(input.sshHostId);
  if (!host) throw failure();
  const command = `${quote(nodePath)} -e ${quote(PROBE)} -- ${quote(String(input.tlsPort))} ${quote(servername)}`;
  let fingerprint: string;
  try {
    const result = await host.exec(command, {
      timeoutMs: TIMEOUT_MS, maxOutputBytes: 1024, label: 'relay-agent-verify-endpoint',
    });
    await input.assertCurrent();
    fingerprint = result.stdout.trim();
    if (result.exitCode !== 0 || result.truncated || !/^[a-f0-9]{64}$/.test(fingerprint)) throw failure();
  } catch { await input.assertCurrent(); throw failure(); }
  const expected = Buffer.from(fingerprint, 'hex');

  return async (endpoint, credential) => {
    await input.assertCurrent();
    if ((endpoint !== 'info' && endpoint !== 'admin/status') ||
      (credential !== undefined && (typeof credential !== 'string' || !credential || credential.length > 4096 || /[\x00-\x1f\x7f]/.test(credential)))) {
      return null;
    }
    const target = new URL(base.href);
    target.pathname = `${base.pathname.replace(/\/+$/, '')}/api/device-link/relay/${endpoint}`;
    const result = await new Promise<Record<string, unknown> | null>((resolve) => {
      let request: ClientRequest | undefined;
      let settled = false;
      let pinMatched = false;
      const finish = (value: Record<string, unknown> | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const abort = () => { request?.destroy(); finish(null); };
      const timer = setTimeout(abort, TIMEOUT_MS);
      try {
        request = httpsRequest(target, {
          method: 'GET', agent: false, rejectUnauthorized: true, servername,
          maxHeaderSize: 8192, headers: { accept: 'application/json' },
          checkServerIdentity: (name, certificate) => {
            const identityError = checkServerIdentity(name, certificate);
            if (identityError) return identityError;
            if (!certificate.raw?.length) return failure();
            const actual = createHash('sha256').update(certificate.raw).digest();
            pinMatched = timingSafeEqual(expected, actual);
            return pinMatched ? undefined : failure();
          },
        }, (response) => {
          // node:https does not follow redirects; every non-success response is terminal.
          if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
            response.destroy(); abort(); return;
          }
          const chunks: Buffer[] = [];
          let bytes = 0;
          response.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > MAX_BODY_BYTES) { response.destroy(); abort(); }
            else chunks.push(chunk);
          });
          response.once('end', () => {
            try {
              const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              finish(body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null);
            } catch { finish(null); }
          });
          response.once('aborted', abort);
          response.once('error', abort);
        });
        request.once('error', abort);
        request.once('socket', (socket) => {
          const tlsSocket = socket as TLSSocket;
          tlsSocket.once('secureConnect', () => {
            // A fresh agent prevents session reuse bypassing checkServerIdentity. Check again
            // here and delay even constructing Authorization until this exact socket is trusted.
            if (!tlsSocket.authorized || !pinMatched || tlsSocket.isSessionReused()) { abort(); return; }
            void (async () => {
              await input.assertCurrent();
              if (settled) return;
              if (credential) request!.setHeader('authorization', `CindyRelay ${credential}`);
              request!.end();
            })().catch(abort);
          });
        });
      } catch { abort(); }
    });
    await input.assertCurrent();
    return result;
  };
}
