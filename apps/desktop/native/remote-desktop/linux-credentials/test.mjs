// Independent JOSE implementation, generated fake identities, no real OS secrets.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import {
  CompactSign,
  compactVerify,
  CompactEncrypt,
  compactDecrypt,
  exportJWK,
  generateKeyPair,
  importJWK,
} from 'jose';

const directory = path.dirname(fileURLToPath(import.meta.url));
const python = process.argv[2] ?? '/usr/bin/python3';
const unit = spawnSync(python, ['-I', '-B', path.join(directory, 'test_credentials.py')], {
  stdio: 'inherit',
});
assert.equal(unit.status, 0);
const child = spawn(python, ['-I', '-B', path.join(directory, 'test_interop.py')], {
  stdio: ['pipe', 'pipe', 'inherit'],
});
const waiting = new Map();
const lines = createInterface({ input: child.stdout });
lines.on('line', (line) => {
  const value = JSON.parse(line),
    pending = waiting.get(value.id);
  assert.ok(pending);
  waiting.delete(value.id);
  value.error ? pending.reject(new Error(value.error)) : pending.resolve(value.result);
});
const exited = new Promise((resolve) => child.once('exit', resolve));
child.on('exit', () => {
  for (const p of waiting.values()) p.reject(new Error('helper exited'));
});
const call = (method, args = {}) =>
  new Promise((resolve, reject) => {
    const id = randomUUID();
    waiting.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ id, method, ...args }) + '\n');
  });
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}
const bytes = (v) => Buffer.from(JSON.stringify(v));
const keys = await generateKeyPair('ES256', { extractable: true });
const ephemeral = await generateKeyPair('ECDH-ES', { crv: 'P-256', extractable: true });
const local = {
  version: 1,
  device: 'phone',
  membership: 'test-account',
  realm: 'global',
  publicKey: await exportJWK(keys.publicKey),
};
const timer = setTimeout(() => child.kill(), 15000);
try {
  const host = JSON.parse(
    await call('configure', { realm: 'global', membership: 'test-account', authDevice: 'host' }),
  );
  const hostKey = await importJWK(host.publicKey, 'ES256');
  const offer = {
    domain: 'cindy.remote-desktop.offer.v1',
    realm: 'global',
    membership: 'test-account',
    from: 'phone',
    to: 'host',
    nonce: randomUUID(),
    ephemeral: await exportJWK(ephemeral.publicKey),
    expiresAt: Date.now() + 60000,
  };
  const signedOffer = await new CompactSign(bytes(offer))
    .setProtectedHeader({ alg: 'ES256', typ: 'cindy-remote-desktop-offer-v1' })
    .sign(keys.privateKey);
  const opened = await call('begin', {
    peer: 'phone',
    offer: signedOffer,
    descriptor: JSON.stringify(local),
  });
  const remote = JSON.parse(Buffer.from((await compactVerify(opened.offer, hostKey)).payload));
  const session = createHash('sha256')
    .update(bytes(canonical([offer, remote].sort((a, b) => a.from.localeCompare(b.from)))))
    .digest('base64url');
  const recipient = await importJWK(remote.ephemeral, 'ECDH-ES');
  let sequence = 0;
  async function packet(purpose, body) {
    const plaintext = bytes({
      domain: 'cindy.remote-desktop.packet.v1',
      session,
      from: 'phone',
      to: 'host',
      sequence: ++sequence,
      purpose,
      body: bytes(body).toString('base64'),
    });
    const ciphertext = await new CompactEncrypt(plaintext)
      .setProtectedHeader({ alg: 'ECDH-ES', enc: 'A256GCM', typ: 'cindy-remote-desktop-v1' })
      .encrypt(recipient);
    return new CompactSign(Buffer.from(ciphertext))
      .setProtectedHeader({ alg: 'ES256', typ: 'cindy-remote-desktop-v1', cty: 'JWE' })
      .sign(keys.privateKey);
  }
  async function receive(ciphertext) {
    const signed = await compactVerify(ciphertext, hostKey, { algorithms: ['ES256'] });
    const encrypted = await compactDecrypt(
      Buffer.from(signed.payload).toString(),
      ephemeral.privateKey,
      { keyManagementAlgorithms: ['ECDH-ES'], contentEncryptionAlgorithms: ['A256GCM'] },
    );
    const value = JSON.parse(Buffer.from(encrypted.plaintext));
    assert.equal(value.session, session);
    assert.equal(value.from, 'host');
    assert.equal(value.to, 'phone');
    return { purpose: value.purpose, body: JSON.parse(Buffer.from(value.body, 'base64')) };
  }
  const exchange = async (ciphertext) =>
    call('receive', { peer: 'phone', handle: opened.handle, ciphertext });
  const readyPacket = await packet('ready', {});
  const ready = await receive((await exchange(readyPacket)).ciphertext);
  assert.equal(ready.purpose, 'ready');
  await assert.rejects(exchange(readyPacket));
  const authentication = await packet('authenticate', {
    id: randomUUID(),
    account: ready.body,
    password: Buffer.from('fake-interop-password').toString('base64'),
  });
  const accepted = await receive((await exchange(authentication)).ciphertext);
  assert.equal(accepted.body.accepted, true);
  const command = await exchange(
    await packet('request', {
      id: 'request-1',
      payload: Buffer.from('{"op":"capabilities"}').toString('base64'),
    }),
  );
  assert.equal(command.kind, 'command');
  const response = await call('response', {
    peer: 'phone',
    handle: opened.handle,
    requestId: 'request-1',
    body: '{"ok":true}',
    success: true,
  });
  const decoded = await receive(response);
  assert.equal(decoded.purpose, 'response');
  assert.equal(Buffer.from(decoded.body.payload, 'base64').toString(), '{"ok":true}');
  console.log(
    'Independent JOSE handshake, encrypted password, response and replay rejection passed',
  );
} finally {
  clearTimeout(timer);
  lines.close();
  child.stdin.end();
  await exited;
}
