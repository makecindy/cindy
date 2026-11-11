/**
 * 测试价值
 * - 生产入口与可观察结果：readRelayConfig / writeRelayConfig 读写账号目录下的 config.json；
 *   升级后旧版本写的单条部署记录仍在列表里，新版本写出的文件里旧字段 `deployment` 仍有一条，装回旧版本不丢失。
 * - Bug／规则依据：用户 2026-10-30 要求能部署多台服务器，部署记录由单个 `deployment` 改为 `deployments` 列表
 *   （docs/self-hosted-relay-plan.md §15.5）；格式变化不能让已部署用户的记录消失。
 * - 现有覆盖缺口：selfHostedRelayRuntime.test.ts 把本模块整个替换成内存 fake，没有经过真实的解析与写入。
 * - 最小失败输入：只有旧字段 `deployment` 的 config.json；写入两条记录且第二条正在使用。
 * - tier：unit；fs 与 Electron 为进程内 fake，无磁盘与钥匙串。单独成文件：运行时测试 mock 了本模块，不能共用。
 * - 实测耗时：0.86 秒（1 例，测试体 3ms，Windows）。
 */
import { beforeEach, expect, it, vi } from 'vitest';

const files = vi.hoisted(() => new Map<string, string>());

vi.mock('node:fs', () => ({
  default: {
    readFileSync: (file: string) => {
      const content = files.get(file);
      if (content === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return content;
    },
    writeFileSync: (file: string, content: string) => { files.set(file, content); },
    renameSync: (from: string, to: string) => { files.set(to, files.get(from)!); files.delete(from); },
    mkdirSync: vi.fn(),
    rmSync: (file: string) => { files.delete(file); },
  },
}));
vi.mock('electron', () => ({ safeStorage: { isEncryptionAvailable: () => true } }));
vi.mock('../../appSessionState.js', () => ({
  activeOwnerScopeKey: () => 'account-a',
  getActiveAppSession: () => ({ dataOwnerId: 'account-a' }),
  ownerScopedUserDataPath: (...parts: string[]) => parts.join('/'),
}));
vi.mock('../../logger.js', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));
vi.mock('../../plugin-oauth/identityStore.js', () => ({ oauthSecureStorageAvailable: () => true }));
vi.mock('../selfHostedRelayRouting.js', () => ({ setSelfHostedRelaySource: vi.fn() }));

import { invalidateRelayConfigCache, readRelayConfig, writeRelayConfig, type RelayDeployment } from '../selfHostedRelayConfig';

const CONFIG = 'device-link-relay/config.json';
const KEY = 'A'.repeat(43);

function deployment(index: number): RelayDeployment {
  return {
    sshHostId: `server-${index}`, address: `203.0.113.${index}`, baseUrl: `https://203.0.113.${index}`,
    relayId: `0000000${index}-0000-4000-8000-000000000000`, name: `Relay ${index}`, ownerPublicKey: KEY,
    relayVersion: '0.3.1', deployedAt: '2026-10-29T00:00:00.000Z', complete: true,
  };
}

const host = { enabled: false, port: 47820, listenAll: false, externalUrl: null, relayId: null };

beforeEach(() => {
  files.clear();
  invalidateRelayConfigCache();
});

it('reads a legacy single deployment and writes the list with a legacy copy older versions can read', () => {
  files.set(CONFIG, JSON.stringify({ version: 2, active: null, host, deployment: deployment(1) }));
  expect(readRelayConfig().deployments).toEqual([deployment(1)]);

  const second = deployment(2);
  writeRelayConfig({
    version: 2,
    host,
    active: { relayId: second.relayId, name: second.name, baseUrl: second.baseUrl, role: 'owner', origin: 'server', deviceId: 'device', ownerPublicKey: KEY },
    // 同一台服务器重复的记录只留第一条。
    deployments: [deployment(1), second, { ...deployment(3), sshHostId: 'server-1' }],
  });
  const written = JSON.parse(files.get(CONFIG)!);
  // 旧版本只认 `deployment`:写正在用的那一条。
  expect(written.deployment).toEqual(second);
  invalidateRelayConfigCache();
  expect(readRelayConfig().deployments).toEqual([deployment(1), second]);
});
