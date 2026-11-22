// Private Linux development build. A provisioner on this guest owns a Unix
// socket in the login user's runtime directory. Only the public PKCE challenge
// leaves this process before the buyer authorizes the allocated machine.
import { createHash, randomBytes } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { once } from 'node:events';
import path from 'node:path';
import { z } from 'zod';

const approval = z.object({
  code: z.string().min(1).max(256), membershipId: z.string().min(1).max(191),
}).strict();

export async function enrollTestCloudDesktop(
  socketPath: string, uid: number, deviceId: string,
  signIn: (code: string, verifier: string, membershipId: string) => Promise<void>,
): Promise<void> {
  const runtimeDir = '/run/user/' + uid;
  if (path.dirname(socketPath) !== runtimeDir || !/^cindy-cloud-test-[a-zA-Z0-9-]+\.sock$/.test(path.basename(socketPath))) {
    throw new Error('Invalid test provisioner socket path');
  }
  const [dir, file] = await Promise.all([lstat(runtimeDir), lstat(socketPath)]);
  if (!dir.isDirectory() || !file.isSocket() || file.uid !== uid || dir.uid !== uid || (dir.mode & 0o077)) {
    throw new Error('Test provisioner socket must belong to this login user');
  }
  const socket = createConnection(socketPath);
  const timeout = setTimeout(() => socket.destroy(new Error('Cloud desktop test authorization timed out')), 90_000);
  try {
    await once(socket, 'connect');
    const verifier = randomBytes(48).toString('base64url');
    const codeChallenge = createHash('sha256').update(verifier).digest('base64url');
    socket.write(JSON.stringify({ deviceId, codeChallenge }) + '\n');
    let buffer = '';
    for await (const chunk of socket.iterator({ destroyOnReturn: false })) {
      buffer += chunk.toString('utf8');
      if (buffer.length > 2048) throw new Error('Invalid test provisioner response');
      if (buffer.includes('\n')) {
        const grant = approval.parse(JSON.parse(buffer.trim()));
        await signIn(grant.code, verifier, grant.membershipId);
        socket.end(JSON.stringify({ authenticated: true, deviceId, membershipId: grant.membershipId }) + '\n');
        await once(socket, 'finish');
        return;
      }
    }
    throw new Error('Test provisioner disconnected');
  } finally {
    clearTimeout(timeout);
    socket.destroy();
  }
}
