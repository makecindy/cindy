import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { RemoteHost } from '@cindy/maker-remote-ssh';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readPiGlobalContext } from '../../../../../../packages/maker-core/src/agents/pi/global-context.js';
import { createRemotePiFileOps } from '../pi-remote-transport.js';

vi.mock('../pi-manager-client.js', () => ({ piManagerEnsure: vi.fn(), piManagerKill: vi.fn() }));

const execFileAsync = promisify(execFile);

// SSH execution targets POSIX hosts. Exercise the real generated shell/stat
// command locally with a synthetic remote HOME, without opening an SSH account.
// symlink-platform-skip: Windows cannot enforce POSIX directory search permissions or run the target host's native bash/stat filesystem semantics.
describe.skipIf(process.platform === 'win32')('remote Pi context filesystem errors (real shell)', () => {
  let root: string;
  let ops: ReturnType<typeof createRemotePiFileOps>;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(tmpdir(), 'pi-remote-stat-'));
    const host = {
      exec: async (command: string) => {
        try {
          const result = await execFileAsync('bash', ['-c', command], {
            env: { ...process.env, HOME: root }, timeout: 10_000,
          });
          return { ...result, exitCode: 0 };
        } catch (error) {
          const result = error as { code: number; stdout: string; stderr: string };
          if (typeof result.code !== 'number') throw error;
          return { exitCode: result.code, stdout: result.stdout, stderr: result.stderr };
        }
      },
    } as unknown as RemoteHost;
    ops = createRemotePiFileOps(host);
  });
  afterEach(async () => {
    await fs.chmod(path.join(root, 'denied'), 0o700).catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  });

  it('distinguishes missing files, directories and symlinks without interpreting path syntax', async () => {
    await expect(ops.stat('$HOME/absent/AGENTS.md')).resolves.toBeNull();
    await expect(ops.stat('$HOME/.')).resolves.toEqual({ isFile: false });
    const name = "rules '$() `literal` .md";
    await fs.writeFile(path.join(root, name), 'rules');
    await fs.symlink(path.join(root, name), path.join(root, 'AGENTS.md'));
    await expect(ops.stat(`$HOME/${name}`)).resolves.toEqual({ isFile: true });
    await expect(readPiGlobalContext('$HOME', ops)).resolves.toEqual([{ name: 'AGENTS.md', content: 'rules' }]);
    await fs.unlink(path.join(root, name));
    await expect(ops.stat('$HOME/AGENTS.md')).resolves.toBeNull();
    await fs.symlink(path.join(root, 'loop'), path.join(root, 'loop'));
    await expect(ops.stat('$HOME/loop')).rejects.toThrow('remote stat failed');
  });

  it('reads a bounded native history tail on the remote filesystem with literal paths', async () => {
    const name = "rollout '$() `literal`.jsonl";
    await fs.writeFile(path.join(root, name), 'old history\n'.repeat(100) + 'CURRENT RECEIPT');
    await expect(ops.readFile(`$HOME/${name}`, 11)).resolves.toBe('old history');
    await expect(ops.readFileTail!(`$HOME/${name}`, 15)).resolves.toBe('CURRENT RECEIPT');
    await expect(ops.readFileTail!('$HOME/missing.jsonl', 15)).rejects.toThrow('remote read failed');
  });

  it('propagates an unsearchable directory as EACCES, including through a symlink', async (ctx) => {
    const denied = path.join(root, 'denied');
    await fs.mkdir(denied);
    await fs.writeFile(path.join(denied, 'AGENTS.md'), 'must not disappear');
    await fs.symlink(path.join(denied, 'AGENTS.md'), path.join(root, 'AGENTS.md'));
    await fs.chmod(denied, 0);
    // Root/ACL-capable environments may bypass mode bits; unit tests still
    // verify errno propagation independently of the runner's identity.
    if (await fs.stat(path.join(denied, 'AGENTS.md')).then(() => true, () => false)) ctx.skip();
    await expect(readPiGlobalContext('$HOME/denied', ops)).rejects.toThrow('EACCES');
    await expect(readPiGlobalContext('$HOME', ops)).rejects.toThrow('EACCES');
  });

  it('propagates read denial for a file that can still be statted', async (ctx) => {
    const file = path.join(root, 'AGENTS.md');
    await fs.writeFile(file, 'private rules');
    await fs.chmod(file, 0);
    if (await fs.readFile(file).then(() => true, () => false)) ctx.skip();
    await expect(ops.stat('$HOME/AGENTS.md')).resolves.toEqual({ isFile: true });
    await expect(readPiGlobalContext('$HOME', ops)).rejects.toThrow('remote read failed');
  });
});
