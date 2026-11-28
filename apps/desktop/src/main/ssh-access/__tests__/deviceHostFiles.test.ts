import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateOpenSshEd25519KeyPair } from '@cindy/maker-remote-ssh';
import { createDedicatedKey, loadDedicatedKey } from '../dedicatedKey.js';
import { chooseDeviceAlias, deviceAliasSlug, deviceHostKeyAlias, isDeviceHostKeyAlias } from '../deviceHostNames.js';
import { CINDY_KNOWN_HOSTS_HEADER, KnownHostsFileError, updateCindyKnownHosts } from '../knownHostsFile.js';

// 测试价值
// - 生产入口与可观察结果：chooseDeviceAlias / deviceHostKeyAlias（终端里输入的别名与固定主机密钥用的名字）、
//   updateCindyKnownHosts（真实临时 HOME 下的 ~/.ssh/cindy_known_hosts 字节、权限）、createDedicatedKey /
//   loadDedicatedKey（专用私钥文件与目录权限）。
// - Bug／规则依据：spec 决定 6（`cindy-<ascii slug>`，空或冲突时 `cindy-<deviceId 前缀>`）、7（0600、只在 Cindy
//   数据目录）、8（cindy_known_hosts 归 Cindy 所有，绝不碰 ~/.ssh/known_hosts）。
// - 现有覆盖缺口：新模块；控制端流程测试只走一条正常路径，不覆盖别名冲突、文件里已有他人行、符号链接与放宽的权限。
// - 最小失败输入：中文设备名得到空别名；两台同名设备拿到同一个别名；更新一台设备时删掉另一个 profile 的行或
//   用户自己的行；同样的主机密钥再写一次就重写文件；符号链接被替换；私钥 0644。
// - tier：unit（只在 mkdtemp 目录读写；生成一把 ed25519 密钥约数毫秒）。
const KEY_1 = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJKEt0idaTeuNCEMu+wXT8G+Y6mBJ+zDXpCTg20sfDgC';
const KEY_2 = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMaGP9ZBWsUOAER5H5Zf4eYmzMBURk1Zj2heBDSMKSOi';
const RSA = `ssh-rsa ${'A'.repeat(40)}`;

let home: string;
beforeEach(async () => { home = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-device-host-files-')); });
afterEach(async () => { await fs.rm(home, { recursive: true, force: true }); });

describe('device host names', () => {
  it.each([
    ['VM-4-7-ubuntu', 'vm-4-7-ubuntu'],
    ['Dash’s MacBook Pro', 'dash-s-macbook-pro'],
    ['Café Ünïcode', 'cafe-unicode'],
    ['云端 Cindy', 'cindy'],
    ['张三的电脑', ''],
    ['  --  ', ''],
    ['a'.repeat(60), 'a'.repeat(40)],
  ])('slugs %j as %j', (name, slug) => {
    expect(deviceAliasSlug(name)).toBe(slug);
  });

  it('falls back to a device id prefix when the slug is empty or taken, and never repeats a taken alias', () => {
    const id = '7f3a9c2e5b1d4f60a8b7c6d5e4f30211';
    expect(chooseDeviceAlias('Studio Mac', id, new Set())).toBe('cindy-studio-mac');
    expect(chooseDeviceAlias('张三的电脑', id, new Set())).toBe('cindy-7f3a9c2e');
    expect(chooseDeviceAlias(undefined, id, new Set())).toBe('cindy-7f3a9c2e');
    expect(chooseDeviceAlias('Studio Mac', id, new Set(['cindy-studio-mac']))).toBe('cindy-7f3a9c2e');
    expect(chooseDeviceAlias('Studio Mac', id, new Set(['cindy-studio-mac', 'cindy-7f3a9c2e']))).toBe('cindy-7f3a9c2e5b1d');
    // Every prefix taken: a numbered alias, still unique.
    const taken = new Set(['cindy-studio-mac', ...Array.from({ length: 7 }, (_, index) => `cindy-${id.slice(0, 8 + index * 4)}`)]);
    expect(chooseDeviceAlias('Studio Mac', id, taken)).toBe('cindy-7f3a9c2e-2');
    // Ids with other characters still give an alias and a HostKeyAlias OpenSSH accepts.
    expect(chooseDeviceAlias('', 'a:b', new Set())).toMatch(/^cindy-[0-9a-f]{8}$/);
    expect(deviceHostKeyAlias(id)).toBe(`cindy-device-${id}`);
    expect(isDeviceHostKeyAlias(deviceHostKeyAlias('a:b/c'))).toBe(true);
    expect(isDeviceHostKeyAlias('203.0.113.7:22')).toBe(false);
  });
});

describe('~/.ssh/cindy_known_hosts', () => {
  const file = () => path.join(home, '.ssh', 'cindy_known_hosts');

  it('creates the file 0600 in a 0700 ~/.ssh and never touches ~/.ssh/known_hosts', async () => {
    expect(await updateCindyKnownHosts(home, [{ hostKeyAlias: 'cindy-device-a1', hostKeys: [KEY_1, RSA] }])).toBe(true);
    expect(await fs.readFile(file(), 'utf8')).toBe(`${CINDY_KNOWN_HOSTS_HEADER}\ncindy-device-a1 ${KEY_1}\ncindy-device-a1 ${RSA}\n`);
    await expect(fs.stat(path.join(home, '.ssh', 'known_hosts'))).rejects.toMatchObject({ code: 'ENOENT' });
    if (process.platform !== 'win32') {
      expect((await fs.stat(file())).mode & 0o777).toBe(0o600);
      expect((await fs.stat(path.join(home, '.ssh'))).mode & 0o777).toBe(0o700);
    }
  });

  it('replaces only the named aliases in place and keeps every other line byte for byte', async () => {
    await fs.mkdir(path.join(home, '.ssh'), { recursive: true });
    const own = `# my notes\r\ncindy-device-other ${KEY_2}\n@revoked cindy-device-a1 ${KEY_2}\ncindy-device-a1 ${KEY_2}\nlast-line-without-newline ${KEY_1}`;
    await fs.writeFile(file(), own);
    await updateCindyKnownHosts(home, [{ hostKeyAlias: 'cindy-device-a1', hostKeys: [KEY_1] }]);
    expect(await fs.readFile(file(), 'utf8')).toBe(
      `# my notes\r\ncindy-device-other ${KEY_2}\ncindy-device-a1 ${KEY_1}\nlast-line-without-newline ${KEY_1}`,
    );
    // The same keys again: nothing to write. A new alias goes at the end; an empty list removes an alias.
    expect(await updateCindyKnownHosts(home, [{ hostKeyAlias: 'cindy-device-a1', hostKeys: [KEY_1] }])).toBe(false);
    await updateCindyKnownHosts(home, [{ hostKeyAlias: 'cindy-device-b2', hostKeys: [KEY_2] }, { hostKeyAlias: 'cindy-device-other', hostKeys: [] }]);
    expect(await fs.readFile(file(), 'utf8')).toBe(
      `# my notes\r\ncindy-device-a1 ${KEY_1}\nlast-line-without-newline ${KEY_1}\ncindy-device-b2 ${KEY_2}\n`,
    );
  });

  it('retains both device pins when two registrations write the same file together', async () => {
    await Promise.all([
      updateCindyKnownHosts(home, [{ hostKeyAlias: 'cindy-device-a1', hostKeys: [KEY_1] }]),
      updateCindyKnownHosts(home, [{ hostKeyAlias: 'cindy-device-b2', hostKeys: [KEY_2] }]),
    ]);
    const content = await fs.readFile(file(), 'utf8');
    expect(content).toContain(`cindy-device-a1 ${KEY_1}`);
    expect(content).toContain(`cindy-device-b2 ${KEY_2}`);
  });

  it('refuses a symlink or a malformed entry instead of writing', async ({ skip }) => {
    await expect(updateCindyKnownHosts(home, [{ hostKeyAlias: 'evil\nHost *', hostKeys: [KEY_1] }])).rejects.toThrow('invalid');
    await expect(updateCindyKnownHosts(home, [{ hostKeyAlias: 'cindy-device-a1', hostKeys: [`${KEY_1}\nHost *`] }])).rejects.toThrow('invalid');
    await fs.mkdir(path.join(home, '.ssh'), { recursive: true });
    const elsewhere = path.join(home, 'elsewhere');
    await fs.writeFile(elsewhere, 'keep\n');
    try {
      await fs.symlink(elsewhere, file());
    } catch {
      skip(); // symlink-platform-skip: creating symlinks needs a privilege on some Windows runners.
      return;
    }
    await expect(updateCindyKnownHosts(home, [{ hostKeyAlias: 'cindy-device-a1', hostKeys: [KEY_1] }]))
      .rejects.toBeInstanceOf(KnownHostsFileError);
    expect(await fs.readFile(elsewhere, 'utf8')).toBe('keep\n');
  });
});

describe('dedicated key', () => {
  it('is made 0600 in a 0700 directory, read back, and a loosened mode is tightened before use', async () => {
    const dir = path.join(home, 'owners', 'abc', 'ssh-access');
    expect(await loadDedicatedKey(dir)).toBeNull();
    const made = await createDedicatedKey(dir, generateOpenSshEd25519KeyPair, 'cindy-ssh-access');
    expect(made.publicKey).toMatch(/^ssh-ed25519 \S+$/);
    const header = '-----BEGIN OPENSSH ' + 'PRIVATE KEY-----\n';
    expect((await fs.readFile(made.privateKeyPath, 'utf8')).startsWith(header)).toBe(true);
    expect(await loadDedicatedKey(dir)).toEqual(made);
    if (process.platform === 'win32') return;
    expect((await fs.stat(made.privateKeyPath)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);
    await fs.chmod(made.privateKeyPath, 0o644);
    await loadDedicatedKey(dir);
    expect((await fs.stat(made.privateKeyPath)).mode & 0o777).toBe(0o600);
  });
});
