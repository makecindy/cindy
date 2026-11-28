import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AuthorizedKeysError,
  CLOUD_GUEST_FILE_MARKER,
  authorizedKeysTarget,
  readAuthorizedKeys,
  removeHeldCloudGuestFile,
  renderAuthorizedKeys,
  writeAuthorizedKeys,
  type AuthorizedKeyLine,
  type AuthorizedKeysTarget,
} from '../authorizedKeysFile.js';

// 测试价值
// - 生产入口与可观察结果：authorizedKeysFile.ts 的 read / render / write / removeHeld，在真实临时目录里断言磁盘上的字节、
//   权限位与拒写结果（用户的 authorized_keys 是 sshd 的授权正本，写坏或漏写都直接影响能否登录）。
// - Bug／规则依据：决定 9（用户行逐字节保留、冲突检查的原子写、0600、~/.ssh 0700）；决定 12 与 2026-11-26 补充（云电脑
//   文件首行必须是标记行；没有标记的文件是手工维护的）；同机两个 profile 互不覆盖。
// - 现有覆盖缺口：新模块。
// - 最小失败输入：没有末尾换行的用户文件；读写之间被改动的文件；另一个 profile 的块；没有标记的云电脑文件。
// - tier：unit（真实 fs 但只在 mkdtemp 目录，单文件约 0.1s）。
const KEY_A = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJfYPtO9L0UmsOJcs+BJ3iMNHFGtQIONiQHLRdZfuvr7';
const KEY_B = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMaGP9ZBWsUOAER5H5Zf4eYmzMBURk1Zj2heBDSMKSOi';
const KEY_C = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJKEt0idaTeuNCEMu+wXT8G+Y6mBJ+zDXpCTg20sfDgC';
const POSIX_MODES = process.platform !== 'win32';

let home: string;
beforeEach(async () => { home = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-ssh-keys-')); });
afterEach(async () => { await fs.rm(home, { recursive: true, force: true }); });

async function apply(target: AuthorizedKeysTarget, profileKey: string, lines: AuthorizedKeyLine[], takeOver = false) {
  const snapshot = await readAuthorizedKeys(target, profileKey);
  const next = renderAuthorizedKeys(snapshot, lines, { takeOver });
  if (next !== null) await writeAuthorizedKeys(snapshot, next);
  return { snapshot, next };
}
const read = (target: AuthorizedKeysTarget) => fs.readFile(target.filePath, 'latin1');
const device = (publicKey: string, id: string): AuthorizedKeyLine => ({ publicKey, comment: `cindy-device:${id}` });

describe('user authorized_keys block', () => {
  it('keeps the person\'s bytes exactly (no final newline, non-ASCII) and restores them when the block goes away', async () => {
    const target = authorizedKeysTarget(home, 'user');
    await fs.mkdir(target.sshDir, { mode: 0o700 });
    const own = `# mine\r\n${KEY_C} caféÿ`;
    await fs.writeFile(target.filePath, Buffer.from(own, 'latin1'), { mode: 0o644 });

    await apply(target, 'profileA', [device(KEY_A, 'laptop')]);
    const written = await read(target);
    expect(written).toBe(`# >>> Cindy SSH access profileA >>>\n${KEY_A} cindy-device:laptop\n# <<< Cindy SSH access profileA <<<\n${own}`);
    if (POSIX_MODES) expect((await fs.stat(target.filePath)).mode & 0o777).toBe(0o600);
    expect((await readAuthorizedKeys(target, 'profileA')).current).toEqual([KEY_A]);

    // Unchanged lines → nothing to write.
    expect((await apply(target, 'profileA', [device(KEY_A, 'laptop')])).next).toBeNull();
    await apply(target, 'profileA', []);
    expect(await read(target)).toBe(own);
  });

  it('creates ~/.ssh as 0700 and the file as 0600 when neither exists', async () => {
    const target = authorizedKeysTarget(home, 'user');
    await apply(target, 'p1', [device(KEY_A, 'laptop')]);
    if (POSIX_MODES) {
      expect((await fs.stat(target.sshDir)).mode & 0o777).toBe(0o700);
      expect((await fs.stat(target.filePath)).mode & 0o777).toBe(0o600);
    }
    // No keys and no block: the person's (absent) file is not created.
    const other = authorizedKeysTarget(path.join(home, 'other'), 'user');
    expect((await apply(other, 'p1', [])).next).toBeNull();
    await expect(fs.stat(other.filePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses to write when the file changed after it was read, leaving the newer content', async () => {
    const target = authorizedKeysTarget(home, 'user');
    await fs.mkdir(target.sshDir, { recursive: true });
    await fs.writeFile(target.filePath, `${KEY_C}\n`);
    const snapshot = await readAuthorizedKeys(target, 'p1');
    const next = renderAuthorizedKeys(snapshot, [device(KEY_A, 'laptop')])!;
    await fs.appendFile(target.filePath, `${KEY_B} added-by-ssh-copy-id\n`);
    await expect(writeAuthorizedKeys(snapshot, next)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await read(target)).toBe(`${KEY_C}\n${KEY_B} added-by-ssh-copy-id\n`);
    expect((await fs.readdir(target.sshDir)).filter((name) => name.includes('.cindy-'))).toEqual([]);
  });

  it('lets two profiles keep separate blocks without overwriting each other', async () => {
    const target = authorizedKeysTarget(home, 'user');
    await apply(target, 'release', [device(KEY_A, 'laptop')]);
    await apply(target, 'dev', [device(KEY_B, 'studio')]);
    await apply(target, 'release', [device(KEY_A, 'laptop'), { publicKey: KEY_C, comment: 'cindy-manual:work' }]);
    const content = await read(target);
    expect(content).toContain(`${KEY_B} cindy-device:studio`);
    expect((await readAuthorizedKeys(target, 'release')).current).toEqual([KEY_A, KEY_C]);
    expect((await readAuthorizedKeys(target, 'dev')).current).toEqual([KEY_B]);
    await apply(target, 'dev', []);
    expect((await readAuthorizedKeys(target, 'release')).current).toEqual([KEY_A, KEY_C]);
    expect(await read(target)).not.toContain('Cindy SSH access dev');
  });

  it('refuses a damaged Cindy block and a symlinked file instead of rewriting them', async () => {
    const target = authorizedKeysTarget(home, 'user');
    await fs.mkdir(target.sshDir, { recursive: true });
    await fs.writeFile(target.filePath, `# >>> Cindy SSH access p1 >>>\n${KEY_A} cindy-device:x\n`);
    await expect(readAuthorizedKeys(target, 'p1')).rejects.toBeInstanceOf(AuthorizedKeysError);
    await fs.rm(target.filePath);
    const elsewhere = path.join(home, 'dotfiles-authorized_keys');
    await fs.writeFile(elsewhere, `${KEY_C}\n`);
    await fs.symlink(elsewhere, target.filePath);
    await expect(readAuthorizedKeys(target, 'p1')).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  });
});

describe('cloud guest authorized keys file', () => {
  it('starts with the exact marker line, even with no keys, and drops hand edits on the next write', async () => {
    const target = authorizedKeysTarget(home, 'cloud-guest');
    await apply(target, 'host', []);
    expect(await read(target)).toBe(`${CLOUD_GUEST_FILE_MARKER}\n`);
    await apply(target, 'host', [device(KEY_A, 'laptop')]);
    await fs.appendFile(target.filePath, `${KEY_C} hand-added\n`);
    await apply(target, 'desktop', [device(KEY_B, 'studio')]);
    const content = await read(target);
    expect(content.split('\n')[0]).toBe(CLOUD_GUEST_FILE_MARKER);
    expect(content).toContain(`${KEY_A} cindy-device:laptop`);
    expect(content).toContain(`${KEY_B} cindy-device:studio`);
    expect(content).not.toContain('hand-added');
  });

  it('leaves a hand-maintained file alone unless it is taken over, and reports what it can import', async () => {
    const target = authorizedKeysTarget(home, 'cloud-guest');
    await fs.mkdir(target.sshDir, { recursive: true });
    const handMade = `# my keys\n${KEY_C} me@home\n`;
    await fs.writeFile(target.filePath, handMade);
    const snapshot = await readAuthorizedKeys(target, 'host');
    expect(snapshot).toMatchObject({ unmanaged: true, unimportable: 0, importable: [{ publicKey: KEY_C, comment: 'me@home' }] });
    expect(renderAuthorizedKeys(snapshot, [device(KEY_A, 'laptop')])).toBeNull();
    const { next } = await apply(target, 'host', [device(KEY_A, 'laptop'), { publicKey: KEY_C, comment: 'cindy-manual:imported' }], true);
    expect(next).toBe(`${CLOUD_GUEST_FILE_MARKER}\n# >>> Cindy SSH access host >>>\n${KEY_A} cindy-device:laptop\n${KEY_C} cindy-manual:imported\n# <<< Cindy SSH access host <<<\n`);

    await fs.writeFile(target.filePath, `ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAAAgQDP863DXU2kt+JxGl4OIGkm5niIiGGWywhJGTjR7FoN rsa\n${KEY_C}\n`);
    expect(await readAuthorizedKeys(target, 'host')).toMatchObject({ unmanaged: true, unimportable: 1 });
  });

  it('removes the held copy only when it is Cindy\'s', async () => {
    const target = authorizedKeysTarget(home, 'cloud-guest');
    await fs.mkdir(target.sshDir, { recursive: true });
    const held = `${target.filePath}.held`;
    await fs.writeFile(held, `${KEY_C} not-cindy\n`);
    expect(await removeHeldCloudGuestFile(home)).toBe(false);
    await fs.writeFile(held, `${CLOUD_GUEST_FILE_MARKER}\n`);
    expect(await removeHeldCloudGuestFile(home)).toBe(true);
    await expect(fs.stat(held)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await removeHeldCloudGuestFile(home)).toBe(false);
  });
});
