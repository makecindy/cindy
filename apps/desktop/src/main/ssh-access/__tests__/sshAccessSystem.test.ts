import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readCloudPublicIpv4 } from '../cloudComputer.js';
import { probeSshBanner, readLanAddresses, readMdnsName, readSshHostKeys, readSshdPort } from '../sshdProbe.js';

// 测试价值
// - 生产入口与可观察结果：sshdProbe.ts 与 cloudComputer.ts 读到的、被控端报给其它电脑的连接信息（端口、主机密钥、地址）以及
//   「Remote Login 关 / sshd 不可达」的判断。端口或地址错了，控制端写出的 SSH 配置就连不上。
// - Bug／规则依据：spec 决定 5（macOS Remote Login 关、Linux sshd 不可达要能判断出来）与决定 10（端口取 sshd_config、
//   Tencent 元数据的公网 IPv4 短超时、最多 6 个主机密钥）。
// - 现有覆盖缺口：新模块。
// - 最小失败输入：Ubuntu 的 `Include sshd_config.d/*.conf` 里才写的 Port；`Port=2222` 写法；不说 SSH 的端口；元数据返回 HTML。
// - tier：unit（只绑定 loopback 的 listen(0) 与 mkdtemp 目录，单文件 <1s）。
let root: string;
const servers: net.Server[] = [];
beforeAll(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-sshd-probe-')); });
afterAll(async () => {
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  await fs.rm(root, { recursive: true, force: true });
});

function listen(onConnection: (socket: net.Socket) => void): Promise<number> {
  const server = net.createServer(onConnection);
  servers.push(server);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)));
}

describe('sshd probe', () => {
  it('recognizes an SSH greeting on loopback and nothing else', async () => {
    const ssh = await listen((socket) => socket.end('SSH-2.0-OpenSSH_9.6p1 Ubuntu-3ubuntu13\r\n'));
    const http = await listen((socket) => socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'));
    const closed = await listen((socket) => socket.destroy());
    expect(await probeSshBanner(ssh)).toBe(true);
    expect(await probeSshBanner(http)).toBe(false);
    expect(await probeSshBanner(closed)).toBe(false);
  });

  it('reads the first Port, following Ubuntu-style includes and Keyword=value, and defaults to 22', async () => {
    await fs.mkdir(path.join(root, 'sshd_config.d'));
    await fs.writeFile(path.join(root, 'sshd_config.d', '10-cindy.conf'), 'PasswordAuthentication no\nPort=2222\n');
    await fs.writeFile(path.join(root, 'sshd_config'), `Include ${path.join(root, 'sshd_config.d')}/*.conf\n# Port 22\nPort 2200\n`);
    expect(await readSshdPort(path.join(root, 'sshd_config'))).toBe(2222);
    await fs.writeFile(path.join(root, 'plain_config'), 'Match User git\n  Port 9999\n');
    expect(await readSshdPort(path.join(root, 'plain_config'))).toBe(22);
    expect(await readSshdPort(path.join(root, 'missing'))).toBe(22);
  });

  it('lists host keys ed25519 first without comments, and only usable LAN addresses', async () => {
    const keys = path.join(root, 'keys');
    await fs.mkdir(keys);
    await fs.writeFile(path.join(keys, 'ssh_host_rsa_key.pub'), 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAAAgQDP863DXU2kt root@host\n');
    await fs.writeFile(path.join(keys, 'ssh_host_ed25519_key.pub'), 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJKEt0idaTeuNCEMu+wXT8G+Y6mBJ+zDXpCTg20sfDgC root@host\n');
    await fs.writeFile(path.join(keys, 'ssh_host_ecdsa_key.pub'), 'not a key\n');
    expect(await readSshHostKeys(keys)).toEqual([
      'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJKEt0idaTeuNCEMu+wXT8G+Y6mBJ+zDXpCTg20sfDgC',
      'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAAAgQDP863DXU2kt',
    ]);
    const row = (address: string, family: 'IPv4' | 'IPv6', internal = false) =>
      ({ address, family, internal, netmask: '', mac: '', cidr: null, ...(family === 'IPv6' ? { scopeid: 0 } : {}) }) as os.NetworkInterfaceInfo;
    expect(readLanAddresses({ lo0: [row('127.0.0.1', 'IPv4', true)], en0: [row('fe80::1', 'IPv6'), row('192.168.1.20', 'IPv4'),
      row('2001:db8::20', 'IPv6'), row('169.254.3.4', 'IPv4')] })).toEqual([
      { kind: 'lan', host: '192.168.1.20' }, { kind: 'lan', host: '2001:db8::20' }]);
    expect(readMdnsName('darwin', 'Dashs-MacBook-Pro.local')).toBe('Dashs-MacBook-Pro.local');
    expect(readMdnsName('linux', 'cloud-host')).toBeNull();
  });
});

describe('cloud guest public IPv4', () => {
  it('accepts only a plain IPv4 answer from the metadata service', async () => {
    const answer = (body: string, status = 200) => async () => new Response(body, { status });
    expect(await readCloudPublicIpv4(answer('203.0.113.7\n'))).toBe('203.0.113.7');
    expect(await readCloudPublicIpv4(answer('<html>not found</html>'))).toBeNull();
    expect(await readCloudPublicIpv4(answer('203.0.113.7', 404))).toBeNull();
    expect(await readCloudPublicIpv4(async () => { throw new Error('ETIMEDOUT'); })).toBeNull();
  });
});
