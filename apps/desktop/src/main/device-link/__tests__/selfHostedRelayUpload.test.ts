/**
 * 测试价值：uploadRelayArtifacts 将公开材料通过 SSH stdin 搬运，目录只作为引用参数，校验失败或任务失效后停止。
 * 依据：credentials-and-local-storage 的凭证/日志边界；用户要求 Agent 自选运行环境，不能经固定 root 安装器。
 * 缺口：runtime 测试替换了上传器，无法观察实际 SSH 输入、校验与授权代次；因此单独隔离 SSH 模块。
 * 最小输入：含引号的目标目录、错误上传哈希、连接期间失效的任务。tier: unit，无进程/网络/磁盘。
 */
import { createHash } from 'node:crypto';
import { beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ ready: vi.fn(), exec: vi.fn(), available: true }));
vi.mock('../../remote-ssh/index.js', () => ({ ensureRemoteHostReady: h.ready, getRemoteSshPool: () => ({ get: () => h.available ? { exec: h.exec } : undefined }) }));
import { uploadRelayArtifacts } from '../selfHostedRelayUpload';

const input = () => ({ sshHostId: 'test-ssh', remoteDir: "/srv/user's relay", relayId: '00000000-0000-4000-8000-000000000001',
  bundle: Buffer.from('public test bundle'), init: Buffer.from('{"ownerPublicKey":"test-public-key"}'), assertCurrent: vi.fn(async () => {}) });

beforeEach(() => {
  vi.clearAllMocks();
  h.available = true;
  h.ready.mockResolvedValue(undefined);
  h.exec.mockImplementation(async (_command: string, options: { input: Buffer }) => ({ exitCode: 0, stdout: `${createHash('sha256').update(options.input).digest('hex')}\n`, stderr: '' }));
});

it('uploads content over stdin into independently quoted content-addressed files', async () => {
  const data = input();
  const result = await uploadRelayArtifacts(data);
  expect(h.exec).toHaveBeenCalledTimes(2);
  expect(h.exec.mock.calls.map((call) => call[1].input)).toEqual([data.bundle, data.init]);
  expect(h.exec.mock.calls[0][0]).toContain("'/srv/user'\\''s relay'");
  expect(h.exec.mock.calls[0][0]).not.toContain(data.bundle.toString());
  expect(result).toEqual({ bundlePath: `${data.remoteDir}/relay-${result.bundleSha256}.mjs`, initPath: `${data.remoteDir}/relay-init-${data.relayId}-${result.initSha256}.json`,
    bundleSha256: createHash('sha256').update(data.bundle).digest('hex'), initSha256: createHash('sha256').update(data.init).digest('hex') });
});

it('stops before initialization materials when bundle checksum verification fails', async () => {
  h.exec.mockResolvedValueOnce({ exitCode: 0, stdout: 'wrong-checksum', stderr: '' });
  await expect(uploadRelayArtifacts(input())).rejects.toThrow('UPLOAD_FAILED');
  expect(h.exec).toHaveBeenCalledTimes(1);
});

it('does not upload after task authority is withdrawn while connecting', async () => {
  const data = input();
  h.ready.mockImplementationOnce(async () => { data.assertCurrent.mockRejectedValue(new Error('revoked')); });
  await expect(uploadRelayArtifacts(data)).rejects.toThrow('revoked');
  expect(h.exec).not.toHaveBeenCalled();
});

it('reports an unavailable SSH connection without running remote commands', async () => {
  h.available = false;
  await expect(uploadRelayArtifacts(input())).rejects.toThrow('SSH_FAILED');
  expect(h.exec).not.toHaveBeenCalled();
});
