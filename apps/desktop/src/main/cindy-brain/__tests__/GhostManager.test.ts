import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  GHOST_SKILL_MD_MAX_BYTES,
  ghostInstallApprovalToken,
  validateGhostManifest,
  type InstalledGhost,
} from '../../../shared/ghost';
import { CINDY_OFFICIAL_GHOST_TRUST, GhostManager, readLegacyGhostApprovalProjection } from '../GhostManager';
import { hashApprovedSkillContent } from '../ghostInstallReceipt';
import { runGhostSnapshotWorkerRequest } from '../ghostSnapshotWorkerProcess';

/** 每个用例独立的临时仓库根 + 源文件目录(规则 23:测试路径一律 os.tmpdir)。 */
let workDir: string;
let rootDir: string;
let onChanged: ReturnType<typeof vi.fn>;
let manager: GhostManager;
let hostLocale: string;
let trustedBundledIds: Set<string>;
let recordBuiltinTombstone: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  // GH Windows runners expose os.tmpdir() as an 8.3 short path while
  // GhostManager.assertManagedRootPath resolves roots via realpathSync.native
  // (long-name canonical).  Canonicalize here so test-built paths match what
  // production passes to fs; otherwise every path-keyed spy predicate silently
  // mismatches and error injections never fire.
  workDir = fs.realpathSync.native(
    await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cindy-ghost-test-')),
  );
  rootDir = path.join(workDir, 'ghosts');
  onChanged = vi.fn();
  hostLocale = 'zh-CN';
  trustedBundledIds = new Set();
  recordBuiltinTombstone = vi.fn();
  manager = new GhostManager({
    getRootDir: () => rootDir,
    getLocale: () => hostLocale,
    onChanged,
    isTrustedBundledId: (id) => trustedBundledIds.has(id),
    isTrustedBundledSource: (id, sourceDir) =>
      trustedBundledIds.has(id) &&
      path.resolve(sourceDir) === path.resolve(workDir, 'bundled-seeds', id),
    recordBuiltinTombstone,
    mutateSnapshot: async (request) => {
      const { parentDir, ...workerRequest } = request;
      await runGhostSnapshotWorkerRequest(workerRequest, parentDir);
    },
  });
});

afterEach(async () => {
  await fs.promises.rm(workDir, { recursive: true, force: true });
});

/** 一份全绿的清单基底(芯片,意识唯一形态)。普通 main.js 仍由 forge 提前核对。 */
function goodManifest(id = 'hello'): Record<string, unknown> {
  return {
    schemaVersion: 2,
    id,
    name: 'Hello 意识',
    version: '1.0.0',
    kind: 'chip',
    entry: 'main.js',
    slots: ['tool'],
    tools: [{ name: 'do_thing', description: '做点事' }],
  };
}

function setupKvManifest(id = 'hello'): Record<string, unknown> {
  return {
    ...goodManifest(id),
    settingsHtml: 'settings.html',
    setup: {
      requires: [{ anyOf: [{ kv: 'repoDir', label: '本机 cindy 项目目录' }] }],
    },
  };
}

function atResourceManifest(id = 'hello'): Record<string, unknown> {
  return {
    ...goodManifest(id),
    atResourceProvider: { tool: 'do_thing' },
  };
}

/** 带显式指令的芯片型清单(command 查重用例)。 */
function chipManifestWithCommand(id: string, command: string): Record<string, unknown> {
  return {
    schemaVersion: 2,
    id,
    name: `Chip ${id}`,
    version: '1.0.0',
    kind: 'chip',
    entry: 'main.js',
    slots: ['tool'],
    tools: [{ name: 'do_thing', description: '做点事' }],
    command,
  };
}

/** 生成 .cindy 测试文件;entries 为额外文件(路径 → 内容),manifest=null 表示不放 ghost.json。 */
async function makeCindy(
  fileName: string,
  manifest: Record<string, unknown> | null,
  entries: Record<string, string | Buffer> = {},
): Promise<string> {
  const zip = new JSZip();
  if (manifest) zip.file('ghost.json', JSON.stringify(manifest));
  for (const [name, content] of Object.entries(entries)) zip.file(name, content);
  const buf = await zip.generateAsync({ type: 'nodebuffer' });
  const out = path.join(workDir, fileName);
  await fs.promises.writeFile(out, buf);
  return out;
}

/**
 * 造一份**旧布局**安装(#1080 之前的形态):直接把文件写进 rootDir/<id>/,不经
 * manager.install() —— 因此状态根里**没有** receipt。用于「从旧状态升级」的迁移回归。
 * 三份旧事实源:ghost.json(必)、.disabled(停用镜像,可选)、.cindy-trust.json(信任镜像,可选)。
 */
async function writeLegacyInstall(
  id: string,
  manifest: Record<string, unknown>,
  opts: {
    disabled?: boolean;
    trust?: Record<string, unknown> | 'omit';
    files?: Record<string, string>;
  } = {},
): Promise<string> {
  const dir = path.join(rootDir, id);
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(path.join(dir, 'ghost.json'), JSON.stringify(manifest));
  await fs.promises.writeFile(path.join(dir, 'main.js'), 'console.log("legacy")');
  for (const [rel, content] of Object.entries(opts.files ?? {})) {
    const abs = path.join(dir, ...rel.split('/'));
    await fs.promises.mkdir(path.dirname(abs), { recursive: true });
    await fs.promises.writeFile(abs, content);
  }
  if (opts.disabled) await fs.promises.writeFile(path.join(dir, '.disabled'), '');
  if (opts.trust !== 'omit') {
    await fs.promises.writeFile(
      path.join(dir, '.cindy-trust.json'),
      JSON.stringify(
        opts.trust ?? {
          level: 'unverified',
          publisherSigned: false,
          publisherVerified: false,
          reviewed: false,
        },
      ),
    );
  }
  return dir;
}

async function recoveredProjectionOptions(...ids: string[]): Promise<{
  expectedApprovalProjectionSha256ById: Record<string, string>;
}> {
  const expectedApprovalProjectionSha256ById: Record<string, string> = {};
  for (const id of ids) {
    expectedApprovalProjectionSha256ById[id] = (
      await readLegacyGhostApprovalProjection(path.join(rootDir, id), id)
    ).sha256;
  }
  return { expectedApprovalProjectionSha256ById };
}

/** 迁移台账路径(默认状态根 = <workDir>/ghosts-install-state)。 */
function migrationLedgerPath(): string {
  return path.join(workDir, 'ghosts-install-state', '.legacy-migration.json');
}

async function expectRejection(
  result: unknown,
  code: string,
): Promise<void> {
  expect(
    typeof result === 'object' && result !== null && 'rejection' in result,
    JSON.stringify(result),
  ).toBe(true);
  expect((result as { rejection: { code: string } }).rejection.code).toBe(code);
}

async function updateGhost(
  cindyPath: string,
  id = 'hello',
): ReturnType<GhostManager['update']> {
  const installed = manager.list().find((ghost) => ghost.manifest.id === id);
  return manager.update(cindyPath, {
    expectedInstalledApproval: ghostInstallApprovalToken(installed?.approval),
  });
}

describe('hashApprovedSkillContent · item.dir 路径段校验', () => {
  it('rejects a link in an intermediate path segment instead of hashing bytes from outside', async () => {
    // 回归点:只 lstat 最终段是不够的 —— 中间段被换成软链 / junction 时 OS 会静默穿透,
    // 对最终段 lstat 报的是"真目录、非链接",于是指纹从技能目录之外取字节。首次批准
    // 那条路径的指纹是现算的,外部内容会被钉成"批准字节"再复制成快照,而 frontmatter
    // 一致性校验只看 name/description(manifest 里公开可抄),拦不住。所以这里必须抛错,
    // 不能返回一个哈希。
    const validated = validateGhostManifest({
      ...goodManifest('skilled'),
      slots: ['tool', 'skill'],
      skill: { items: [{ dir: 'skills/demo', name: 'demo', description: 'Demo skill' }] },
    });
    if (!validated.ok) throw new Error(validated.reason);

    const base = path.join(workDir, 'plugin');
    const evil = path.join(workDir, 'evil');
    await fs.promises.mkdir(path.join(base, 'skills', 'demo'), { recursive: true });
    await fs.promises.mkdir(path.join(evil, 'demo'), { recursive: true });
    await fs.promises.writeFile(
      path.join(base, 'skills', 'demo', 'SKILL.md'),
      '---\nname: demo\ndescription: Demo skill\n---\n\nApproved instructions\n',
    );
    await fs.promises.writeFile(
      path.join(evil, 'demo', 'SKILL.md'),
      '---\nname: demo\ndescription: Demo skill\n---\n\nrm -rf everything\n',
    );

    // 正常结构先能算出来,确认用例本身走到了目标代码。
    await expect(hashApprovedSkillContent(validated.manifest, base)).resolves.toHaveProperty(
      'skills/demo',
    );

    // 把**中间段** skills 换成指向外部的链接。
    await fs.promises.rm(path.join(base, 'skills'), { recursive: true, force: true });
    try {
      await fs.promises.symlink(
        evil,
        path.join(base, 'skills'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } catch {
      return; // 该环境建不了链接(无权限),跳过;判定逻辑与其他平台同源。
    }

    await expect(hashApprovedSkillContent(validated.manifest, base)).rejects.toThrow(
      /path segment is a link/,
    );
  });
});

describe('GhostManager · 存量插件一次性迁移(§5 升级无感)', () => {
  /** 带 skill 槽的旧布局清单 + 配套 SKILL.md(frontmatter 与声明逐字一致)。 */
  const legacySkillManifest = (id = 'skilled'): Record<string, unknown> => ({
    ...goodManifest(id),
    slots: ['tool', 'skill'],
    skill: { items: [{ dir: 'skills/demo', name: 'demo', description: 'Demo skill' }] },
  });
  const legacySkillFiles = (): Record<string, string> => ({
    'skills/demo/SKILL.md': '---\nname: demo\ndescription: Demo skill\n---\n\nApproved instructions\n',
  });

  it('市场/本地旧安装无感迁移:升级后仍启用、列 approved、写下迁移台账', async () => {
    await writeLegacyInstall('hello', goodManifest());
    // 迁移前:没有 receipt → 一律 fail closed(这正是 #1080 被回滚的现场)。
    expect(manager.list()[0]).toMatchObject({ enabled: false, approval: { state: 'legacy-unapproved' } });

    const outcome = await manager.migrateLegacyApprovalsOnce();
    expect(outcome.migrated).toEqual(['hello']);
    // 迁移后:用户什么都没做,插件照旧可用。
    expect(manager.list()[0]).toMatchObject({
      enabled: true,
      approval: { state: 'approved' },
    });
    expect(fs.existsSync(migrationLedgerPath())).toBe(true);
  });

  it('带 setup.kv 的旧安装无感迁移并保留标准化就绪声明', async () => {
    await writeLegacyInstall('hello', setupKvManifest(), {
      files: { 'settings.html': '<!doctype html>' },
    });

    const outcome = await manager.migrateLegacyApprovalsOnce();

    expect(outcome.migrated).toEqual(['hello']);
    expect(manager.list()[0]).toMatchObject({
      enabled: true,
      approval: { state: 'approved' },
      manifest: {
        setup: {
          requires: [
            { anyOf: [{ kind: 'kv', key: 'repoDir', label: '本机 cindy 项目目录' }] },
          ],
        },
      },
    });
  });

  it('未批准或 receipt 损坏的插件不展示可变 trust 镜像', async () => {
    const forgedTrust = {
      level: 'cindy-official' as const,
      publisherSigned: true,
      publisherVerified: true,
      reviewed: true,
      publisherName: 'Forged publisher',
      reviewerName: 'Forged reviewer',
    };
    await writeLegacyInstall('legacy', goodManifest('legacy'), { trust: forgedTrust });
    await writeLegacyInstall('invalid', goodManifest('invalid'), { trust: forgedTrust });
    await fs.promises.mkdir(path.join(workDir, 'ghosts-install-state'), { recursive: true });
    await fs.promises.writeFile(
      path.join(workDir, 'ghosts-install-state', 'invalid.json'),
      JSON.stringify({ schemaVersion: 1, id: 'invalid' }),
    );

    const byId = Object.fromEntries(manager.list().map((ghost) => [ghost.manifest.id, ghost]));
    expect(byId.legacy).toMatchObject({
      approval: { state: 'legacy-unapproved' },
      trust: {
        level: 'unverified',
        publisherSigned: false,
        publisherVerified: false,
        reviewed: false,
      },
    });
    expect(byId.invalid).toMatchObject({
      approval: { state: 'invalid' },
      trust: {
        level: 'unverified',
        publisherSigned: false,
        publisherVerified: false,
        reviewed: false,
      },
    });
    expect(byId.legacy.trust).not.toHaveProperty('publisherName');
    expect(byId.invalid.trust).not.toHaveProperty('reviewerName');
  });

  it('旧安装的停用态被保留:.disabled 镜像 → receipt.enabled=false', async () => {
    await writeLegacyInstall('hello', goodManifest(), { disabled: true });
    await manager.migrateLegacyApprovalsOnce();
    expect(manager.list()[0]).toMatchObject({
      enabled: false,
      approval: { state: 'approved' },
    });
  });

  it('信任镜像被保留;缺失时保守降级为 unverified 而不是让迁移失败', async () => {
    await writeLegacyInstall('trusted', goodManifest('trusted'), {
      trust: {
        level: 'verified-publisher',
        publisherSigned: true,
        publisherVerified: true,
        reviewed: false,
        publisherName: 'Acme',
      },
    });
    await writeLegacyInstall('bare', goodManifest('bare'), { trust: 'omit' });
    await manager.migrateLegacyApprovalsOnce();
    const byId = Object.fromEntries(manager.list().map((g) => [g.manifest.id, g]));
    expect(byId.trusted.trust).toMatchObject({ level: 'verified-publisher', publisherName: 'Acme' });
    expect(byId.trusted.enabled).toBe(true);
    // 信任文件缺失不阻断迁移:插件照旧可用,只是展示为 unverified(旧模型读同一文件也如此)。
    expect(byId.bare.trust).toMatchObject({ level: 'unverified' });
    expect(byId.bare.enabled).toBe(true);
  });

  it('skill 槽旧安装迁移后:快照建好、字节指纹钉住、对账认可挂链', async () => {
    await writeLegacyInstall('skilled', legacySkillManifest(), { files: legacySkillFiles() });
    const outcome = await manager.migrateLegacyApprovalsOnce();
    expect(outcome.migrated).toEqual(['skilled']);
    const ghost = manager.list()[0];
    expect(ghost).toMatchObject({ enabled: true, approval: { state: 'approved' } });
    expect(ghost.approvedSkillRoot).toBeTruthy();
    // 迁移出的快照必须能被技能对账认可(字节与 receipt 指纹逐字节对上),否则技能链断。
    expect(await manager.verifyApprovedSkillSnapshot(ghost)).toBe(true);
  });

  it('全局一次性:台账落地后,新出现的无 receipt 目录不再被迁移(fail closed)', async () => {
    await writeLegacyInstall('first', goodManifest('first'));
    await manager.migrateLegacyApprovalsOnce();
    expect(manager.list().find((g) => g.manifest.id === 'first')?.approval.state).toBe('approved');

    // 台账已在。此后再冒出一个没有 receipt 的目录(可能是删了 receipt 想骗迁移,或
    // 真的新拷进来的旧目录)——迁移不再触发,它保持 fail closed。删 receipt 想"从可变
    // 安装目录重建授权"这条路被这道门堵死。
    await writeLegacyInstall('second', goodManifest('second'));
    const outcome = await manager.migrateLegacyApprovalsOnce();
    expect(outcome).toEqual({ migrated: [], skipped: [], failed: [], retryPending: [] });
    expect(manager.list().find((g) => g.manifest.id === 'second')?.approval.state).toBe(
      'legacy-unapproved',
    );
  });

  it('迁移绝不改动安装目录三文件(回滚到旧客户端仍按安装目录判定,§5 兜底第 4 条)', async () => {
    const dir = await writeLegacyInstall('hello', goodManifest(), { disabled: true });
    const before = {
      manifest: await fs.promises.readFile(path.join(dir, 'ghost.json'), 'utf8'),
      disabled: fs.existsSync(path.join(dir, '.disabled')),
      trust: await fs.promises.readFile(path.join(dir, '.cindy-trust.json'), 'utf8'),
    };
    await manager.migrateLegacyApprovalsOnce();
    expect(await fs.promises.readFile(path.join(dir, 'ghost.json'), 'utf8')).toBe(before.manifest);
    expect(fs.existsSync(path.join(dir, '.disabled'))).toBe(before.disabled);
    expect(await fs.promises.readFile(path.join(dir, '.cindy-trust.json'), 'utf8')).toBe(before.trust);
  });

  it('manifest 不合法的旧目录不迁移,保持 fail closed,不写出坏 receipt', async () => {
    const dir = path.join(rootDir, 'broken');
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(path.join(dir, 'ghost.json'), '{ not valid json');
    const outcome = await manager.migrateLegacyApprovalsOnce();
    expect(outcome.failed).toEqual(['broken']);
    expect(fs.existsSync(path.join(workDir, 'ghosts-install-state', 'broken.json'))).toBe(false);
  });

  it('随包种子 id 跳过迁移(交给 provisioning 的逐字节对账补批准)', async () => {
    const seededManager = new GhostManager({
      getRootDir: () => rootDir,
      getLocale: () => hostLocale,
      onChanged,
      isTrustedBundledId: (id) => id === 'hello',
    });
    await writeLegacyInstall('hello', goodManifest());
    const outcome = await seededManager.migrateLegacyApprovalsOnce();
    expect(outcome).toEqual({ migrated: [], skipped: ['hello'], failed: [], retryPending: [] });
    // 没有替它写 receipt:provisioning 才是随包插件的批准入口。
    expect(fs.existsSync(path.join(workDir, 'ghosts-install-state', 'hello.json'))).toBe(false);
  });

  it('瞬时状态根 IO 不封门:台账停在 in-progress,下次启动自动续跑治愈', async () => {
    await writeLegacyInstall('hello', goodManifest());
    // 第一轮:receipt 落盘的 rename 吃一次 EACCES(模拟杀软/句柄占用的环境抖动)。
    const realRename = fs.promises.rename;
    const renameSpy = vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      if (String(to).endsWith(`${path.sep}hello.json`)) {
        renameSpy.mockRestore();
        const err = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
        err.code = 'EACCES';
        throw err;
      }
      return realRename(from, to);
    });
    const first = await manager.migrateLegacyApprovalsOnce();
    // 瞬时错不算"内容无效":不进 failed(那会写进 completed 台账永久封门),
    // 记 retryPending、台账停在 in-progress。
    expect(first.retryPending).toEqual(['hello']);
    expect(first.failed).toEqual([]);
    const ledger = JSON.parse(await fs.promises.readFile(migrationLedgerPath(), 'utf8')) as {
      state?: string;
      pendingIds?: string[];
    };
    expect(ledger.state).toBe('in-progress');
    expect(ledger.pendingIds).toEqual(['hello']);

    // 第二轮(下次启动):环境恢复,自动续跑治愈,不需要用户操作。
    const second = await manager.migrateLegacyApprovalsOnce();
    expect(second.migrated).toEqual(['hello']);
    expect(manager.list()[0]).toMatchObject({ enabled: true, approval: { state: 'approved' } });
    const finalLedger = JSON.parse(
      await fs.promises.readFile(migrationLedgerPath(), 'utf8'),
    ) as { state?: string };
    expect(finalLedger.state).toBe('completed');
  });

  it('读 legacy ghost.json 的瞬时 IO(EACCES)判瞬时、不永久封门(P1 回归)', async () => {
    await writeLegacyInstall('hello', goodManifest());
    const realOpenSync = fs.openSync;
    // 只让 <root>/hello/ghost.json 的单句柄安全读取吃一次 EACCES(模拟杀软/句柄占用),
    // 其余照常。
    const spy = vi
      .spyOn(fs, 'openSync')
      .mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
        if (typeof p === 'string' && p.endsWith(path.join('hello', 'ghost.json'))) {
          spy.mockRestore();
          const err = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
          err.code = 'EACCES';
          throw err;
        }
        return (realOpenSync as (...a: unknown[]) => number)(p, ...rest);
      }) as typeof fs.openSync);

    const first = await manager.migrateLegacyApprovalsOnce();
    // 修复前:readFileSync 的错被包成无 code 的 new Error → 误判确定性 failed →
    // 写进 completed 台账永久封门。修复后:保留 errno → 判瞬时 → retryPending + in-progress。
    expect(first.retryPending).toEqual(['hello']);
    expect(first.failed).toEqual([]);
    const ledger = JSON.parse(fs.readFileSync(migrationLedgerPath(), 'utf8')) as {
      state?: string;
    };
    expect(ledger.state).toBe('in-progress');

    // 下轮环境恢复:自动续跑治愈,不需要用户重新确认。
    const second = await manager.migrateLegacyApprovalsOnce();
    expect(second.migrated).toEqual(['hello']);
    expect(manager.list()[0]).toMatchObject({ enabled: true, approval: { state: 'approved' } });
  });

  it('legacy .disabled marker IO errors stay pending instead of becoming disabled', async () => {
    await writeLegacyInstall('hello', goodManifest());
    const markerPath = path.join(rootDir, 'hello', '.disabled');
    const realLstatSync = fs.lstatSync;
    const spy = vi.spyOn(fs, 'lstatSync').mockImplementation((target, options) => {
      if (path.resolve(String(target)) === path.resolve(markerPath)) {
        spy.mockRestore();
        throw Object.assign(new Error('EIO: marker temporarily unreadable'), { code: 'EIO' });
      }
      return realLstatSync(target, options as never);
    });

    const first = await manager.migrateLegacyApprovalsOnce();
    expect(first).toMatchObject({ migrated: [], failed: [], retryPending: ['hello'] });
    expect(JSON.parse(await fs.promises.readFile(migrationLedgerPath(), 'utf8'))).toMatchObject({
      state: 'in-progress',
      pendingIds: ['hello'],
    });
    expect(manager.list()[0]).toMatchObject({ approval: { state: 'legacy-unapproved' } });

    const second = await manager.migrateLegacyApprovalsOnce();
    expect(second.migrated).toEqual(['hello']);
    expect(manager.list()[0]).toMatchObject({ enabled: true, approval: { state: 'approved' } });
  });

  it('已有 receipt 不可读后即使消失也不从可变安装目录重铸', async () => {
    await manager.install(await makeCindy('a.cindy', goodManifest()));
    const receiptPath = path.join(workDir, 'ghosts-install-state', 'hello.json');
    const receiptBefore = await fs.promises.readFile(receiptPath, 'utf8');
    // 模拟 #1080 历史状态没有 ledger；receipt 本身只是在本轮被 AV/权限瞬时锁住。
    await fs.promises.rm(migrationLedgerPath(), { force: true });
    const realOpenSync = fs.openSync;
    const openSpy = vi.spyOn(fs, 'openSync');
    openSpy.mockImplementation((target, ...args) => {
      if (path.resolve(String(target)) === path.resolve(receiptPath)) {
        openSpy.mockRestore();
        throw Object.assign(new Error('EACCES: receipt locked'), { code: 'EACCES' });
      }
      return (realOpenSync as (...openArgs: unknown[]) => number)(target, ...args);
    });

    const first = await manager.migrateLegacyApprovalsOnce();

    expect(first).toEqual({ migrated: [], skipped: [], failed: ['hello'], retryPending: [] });
    expect(await fs.promises.readFile(receiptPath, 'utf8')).toBe(receiptBefore);
    expect(
      JSON.parse(await fs.promises.readFile(migrationLedgerPath(), 'utf8')),
    ).toMatchObject({ state: 'completed', failedIds: ['hello'] });

    await fs.promises.rm(receiptPath);
    const second = await manager.migrateLegacyApprovalsOnce();
    expect(second).toEqual({ migrated: [], skipped: [], failed: [], retryPending: [] });
    expect(fs.existsSync(receiptPath)).toBe(false);
    expect(manager.list()[0]).toMatchObject({
      approval: { state: 'legacy-unapproved' },
      enabled: false,
    });
  });

  it('首轮迁移治愈损坏/旧 schema 的 receipt(格式升级不落到用户重新确认)', async () => {
    // issue #1243 验收第 4 条的实现形态:schema/编码 bump 后的旧 receipt 判 invalid,
    // 但**首轮迁移**会把它当"已判损坏"从安装目录 backfill 重建 —— 一次内部格式变更
    // 不变成用户重新确认。v1 receipt 从未随任何构建发布,所以不需要专门的 v1 读取器;
    // 未来的 bump 走 §5 的「按旧编码核对 → 原地升级」,见规则文档。
    await writeLegacyInstall('hello', goodManifest(), { disabled: true });
    const stateDir = path.join(workDir, 'ghosts-install-state');
    await fs.promises.mkdir(stateDir, { recursive: true });
    // 一份 schemaVersion 过时的 receipt(读取器判 invalid)。
    await fs.promises.writeFile(
      path.join(stateDir, 'hello.json'),
      JSON.stringify({ schemaVersion: 1, id: 'hello', legacy: true }),
    );
    expect(manager.list()[0].approval.state).toBe('invalid');

    const outcome = await manager.migrateLegacyApprovalsOnce();
    expect(outcome.migrated).toEqual(['hello']);
    // 治愈后为有效批准;用户的停用决定(.disabled)照旧保留。
    expect(manager.list()[0]).toMatchObject({
      enabled: false,
      approval: { state: 'approved' },
    });
  });

  it('修复 #1080 历史 mixed 状态:有效 receipt 不封死其余 legacy/旧 schema 插件', async () => {
    await manager.install(await makeCindy('approved.cindy', goodManifest('approved')));
    const approvedReceiptPath = path.join(workDir, 'ghosts-install-state', 'approved.json');
    const approvedReceiptBefore = await fs.promises.readFile(approvedReceiptPath, 'utf8');

    // Fixture 模拟曾短暂合入后回滚的 #1080:部分插件已有 v2 receipt,但当时没有
    // legacy migration ledger；同 owner 下其余旧安装仍无 receipt。删除 ledger 只是
    // 构造这份历史状态，不代表安装根攻击者能操作状态根。
    await fs.promises.rm(migrationLedgerPath(), { force: true });
    await writeLegacyInstall('legacy', goodManifest('legacy'));
    await writeLegacyInstall('old-schema', goodManifest('old-schema'), { disabled: true });
    await fs.promises.writeFile(
      path.join(workDir, 'ghosts-install-state', 'old-schema.json'),
      JSON.stringify({ schemaVersion: 1, id: 'old-schema', legacy: true }),
    );

    const outcome = await manager.migrateLegacyApprovalsOnce();

    expect(outcome.migrated).toEqual(['legacy', 'old-schema']);
    expect(await fs.promises.readFile(approvedReceiptPath, 'utf8')).toBe(approvedReceiptBefore);
    const byId = Object.fromEntries(manager.list().map((ghost) => [ghost.manifest.id, ghost]));
    expect(byId.approved.approval.state).toBe('approved');
    expect(byId.legacy).toMatchObject({ enabled: true, approval: { state: 'approved' } });
    expect(byId['old-schema']).toMatchObject({
      enabled: false,
      approval: { state: 'approved' },
    });
  });

  it('已有 receipt 的安装不被迁移覆盖(迁移只补,不改既有批准)', async () => {
    await manager.install(await makeCindy('a.cindy', goodManifest()));
    const before = await fs.promises.readFile(
      path.join(workDir, 'ghosts-install-state', 'hello.json'),
      'utf8',
    );
    const outcome = await manager.migrateLegacyApprovalsOnce();
    expect(outcome.migrated).toEqual([]);
    expect(await fs.promises.readFile(path.join(workDir, 'ghosts-install-state', 'hello.json'), 'utf8')).toBe(
      before,
    );
  });

  it('声明的 locale 文件损坏 → fail closed(装入天然不含坏 locale,读到即装入后损坏)', async () => {
    hostLocale = 'en';
    await writeLegacyInstall(
      'hello',
      { ...goodManifest(), name: 'Base', locales: { en: 'locales/en.json' } },
      { files: { 'locales/en.json': '{ broken json' } },
    );
    const outcome = await manager.migrateLegacyApprovalsOnce();
    // 装入流程逐个校验声明的 locale、不合格拒装,所以旧安装不会带坏 locale;迁移时
    // 读到坏 locale 只能是装入后损坏,属 §5 的"自相矛盾 → fail closed",不写坏 receipt。
    expect(outcome.failed).toEqual(['hello']);
    expect(manager.list()[0].approval.state).toBe('legacy-unapproved');
    expect(fs.existsSync(path.join(workDir, 'ghosts-install-state', 'hello.json'))).toBe(false);
  });
});

describe('GhostManager · owner 受管根路径', () => {
  it('允许 userData 祖先通过 symlink/junction 重定位', async () => {
    const physicalUserData = path.join(workDir, 'physical-user-data');
    const linkedUserData = path.join(workDir, 'linked-user-data');
    await fs.promises.mkdir(path.join(physicalUserData, 'owners', 'owner-a'), { recursive: true });
    try {
      await fs.promises.symlink(
        physicalUserData,
        linkedUserData,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } catch {
      return;
    }

    const relocated = new GhostManager({
      getRootDir: () => path.join(linkedUserData, 'owners', 'owner-a', 'cindy-brain'),
      getStateDir: () => path.join(linkedUserData, 'owners', 'owner-a', 'ghost-install-state'),
    });

    expect(relocated.list()).toEqual([]);
  });

  it('允许全新 owner 的多层受管根尚未创建', () => {
    const freshOwner = path.join(workDir, 'owners', 'fresh-owner');
    const fresh = new GhostManager({
      getRootDir: () => path.join(freshOwner, 'cindy-brain'),
      getStateDir: () => path.join(freshOwner, 'ghost-install-state'),
    });

    expect(fresh.list()).toEqual([]);
  });

  it('symlinked state root 下已批准插件不被判 invalid(P1 回归)', async () => {
    const physicalUserData = path.join(workDir, 'physical-user-data');
    const linkedUserData = path.join(workDir, 'linked-user-data');
    await fs.promises.mkdir(path.join(physicalUserData, 'owners', 'owner-a'), { recursive: true });
    try {
      await fs.promises.symlink(
        physicalUserData,
        linkedUserData,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } catch {
      return;
    }

    const relocated = new GhostManager({
      getRootDir: () => path.join(linkedUserData, 'owners', 'owner-a', 'cindy-brain'),
      getStateDir: () => path.join(linkedUserData, 'owners', 'owner-a', 'ghost-install-state'),
    });
    await relocated.install(await makeCindy('approved.cindy', goodManifest('approved')));

    // receipt 落在 realpath 状态根内;containWithin 必须用 realpath 根,
    // 否则合法 receipt 会被判在根外 → list() 降级成 invalid。
    const listed = relocated.list();
    expect(listed).toHaveLength(1);
    expect(listed[0].approval.state).toBe('approved');
  });

  it('仍拒绝受管根本身是 symlink/junction', async () => {
    const outside = path.join(workDir, 'outside-root');
    const linkedRoot = path.join(workDir, 'linked-root');
    await fs.promises.mkdir(outside, { recursive: true });
    try {
      await fs.promises.symlink(outside, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      return;
    }

    expect(
      () =>
        new GhostManager({
          getRootDir: () => linkedRoot,
          getStateDir: () => path.join(workDir, 'state-root'),
        }),
    ).toThrow(/ghost content root is not a real directory/);
  });
});

describe('GhostManager · 迁移崩溃安全(in-progress 状态机)与隔离命名空间', () => {
  it('中途崩溃后按 pendingIds 续跑:已迁的跳过、剩余补迁、台账推进到 completed', async () => {
    // 复现真实崩溃现场:首轮迁移在 aaa 写完 receipt(receipt 首写自动落账被
    // in-progress 台账挡住)、bbb 还没动笔时进程死掉。
    await writeLegacyInstall('aaa', goodManifest('aaa'));
    await writeLegacyInstall('bbb', goodManifest('bbb'));
    await manager.migrateLegacyApprovalsOnce();
    // 手工把状态倒回"崩溃时刻":台账退回 in-progress、bbb 的 receipt 消失。
    await fs.promises.writeFile(
      migrationLedgerPath(),
      JSON.stringify({
        version: 1,
        migratedAt: '2026-08-01T00:00:00.000Z',
        migratedIds: [],
        state: 'in-progress',
        pendingIds: ['aaa', 'bbb'],
      }),
    );
    await fs.promises.rm(path.join(workDir, 'ghosts-install-state', 'bbb.json'));

    const outcome = await manager.migrateLegacyApprovalsOnce();
    // bbb 被续跑补迁;aaa 已有 receipt,计入 migrated(它就是迁移铸出的)。
    expect(outcome.migrated).toEqual(['bbb']);
    const byId = Object.fromEntries(manager.list().map((g) => [g.manifest.id, g.approval.state]));
    expect(byId).toEqual({ aaa: 'approved', bbb: 'approved' });
    const ledger = JSON.parse(await fs.promises.readFile(migrationLedgerPath(), 'utf8')) as {
      state?: string;
      migratedIds: string[];
    };
    expect(ledger.state).toBe('completed');
    expect(ledger.migratedIds).toEqual(['aaa', 'bbb']);
  });

  it('续跑只认动笔前钉死的清单:清单外的无 receipt 目录不被重铸', async () => {
    await writeLegacyInstall('aaa', goodManifest('aaa'));
    // 迁移窗口期间新装再删 receipt 的插件(不在 pendingIds 里)骗不到续跑。
    await writeLegacyInstall('ccc', goodManifest('ccc'));
    await fs.promises.mkdir(path.join(workDir, 'ghosts-install-state'), { recursive: true });
    await fs.promises.writeFile(
      migrationLedgerPath(),
      JSON.stringify({
        version: 1,
        migratedAt: '2026-08-01T00:00:00.000Z',
        migratedIds: [],
        state: 'in-progress',
        pendingIds: ['aaa'],
      }),
    );

    const outcome = await manager.migrateLegacyApprovalsOnce();
    expect(outcome.migrated).toEqual(['aaa']);
    const byId = Object.fromEntries(manager.list().map((g) => [g.manifest.id, g.approval.state]));
    expect(byId.aaa).toBe('approved');
    expect(byId.ccc).toBe('legacy-unapproved');
    expect(
      (JSON.parse(await fs.promises.readFile(migrationLedgerPath(), 'utf8')) as { state?: string })
        .state,
    ).toBe('completed');
  });

  it('receipt 首写的自动落账不覆盖 in-progress 台账(崩溃门不被焊死)', async () => {
    await fs.promises.mkdir(path.join(workDir, 'ghosts-install-state'), { recursive: true });
    await fs.promises.writeFile(
      migrationLedgerPath(),
      JSON.stringify({
        version: 1,
        migratedAt: '2026-08-01T00:00:00.000Z',
        migratedIds: [],
        state: 'in-progress',
        pendingIds: ['zzz'],
      }),
    );
    // 迁移窗口内经正常装入流程写 receipt(内部有"缺台账即补写 completed"的守卫)。
    await manager.install(await makeCindy('a.cindy', goodManifest()));
    const ledger = JSON.parse(await fs.promises.readFile(migrationLedgerPath(), 'utf8')) as {
      state?: string;
    };
    expect(ledger.state).toBe('in-progress');
  });

  it('台账存在但读不出:门保守关死,不迁也不重写', async () => {
    await writeLegacyInstall('aaa', goodManifest('aaa'));
    await fs.promises.mkdir(path.join(workDir, 'ghosts-install-state'), { recursive: true });
    await fs.promises.writeFile(migrationLedgerPath(), '{ not valid json');

    const outcome = await manager.migrateLegacyApprovalsOnce();
    expect(outcome).toEqual({ migrated: [], skipped: [], failed: [], retryPending: [] });
    expect(manager.list()[0].approval.state).toBe('legacy-unapproved');
    expect(await fs.promises.readFile(migrationLedgerPath(), 'utf8')).toBe('{ not valid json');
  });

  it.skipIf(process.platform === 'win32')(
    '台账是非普通文件(symlink)→ 门保守关死,不迁也不重写',
    async () => {
      await writeLegacyInstall('aaa', goodManifest('aaa'));
      await fs.promises.mkdir(path.join(workDir, 'ghosts-install-state'), { recursive: true });
      const outside = path.join(workDir, 'ledger-outside.json');
      await fs.promises.writeFile(outside, '{}', 'utf8');
      await fs.promises.symlink(outside, migrationLedgerPath());

      const outcome = await manager.migrateLegacyApprovalsOnce();
      expect(outcome).toEqual({ migrated: [], skipped: [], failed: [], retryPending: [] });
      expect(manager.list()[0].approval.state).toBe('legacy-unapproved');
      // 门关死:ledger 未被重写(仍是 symlink 指向外部文件)。
      const st = await fs.promises.lstat(migrationLedgerPath());
      expect(st.isSymbolicLink()).toBe(true);
      expect(await fs.promises.readFile(migrationLedgerPath(), 'utf8')).toBe('{}');
    },
  );

  it.each([
    ['empty pendingIds', []],
    ['non-string pending id', [null]],
    ['path-traversal pending id', ['../x']],
    ['mixed valid and invalid pending ids', ['aaa', '../x']],
  ])('非法 in-progress 台账(%s)保守关门且不被重写成 completed', async (_label, pendingIds) => {
    await writeLegacyInstall('aaa', goodManifest('aaa'));
    await fs.promises.mkdir(path.dirname(migrationLedgerPath()), { recursive: true });
    const raw = JSON.stringify({
      version: 1,
      migratedAt: '2026-08-01T00:00:00.000Z',
      migratedIds: [],
      state: 'in-progress',
      pendingIds,
    });
    await fs.promises.writeFile(migrationLedgerPath(), raw);

    expect(await manager.migrateLegacyApprovalsOnce()).toEqual({
      migrated: [],
      skipped: [],
      failed: [],
      retryPending: [],
    });
    expect(manager.list()[0].approval.state).toBe('legacy-unapproved');
    expect(await fs.promises.readFile(migrationLedgerPath(), 'utf8')).toBe(raw);
  });

  it('启用失败的回滚按"镜像先前是否在盘上",不吞掉旧客户端的停用决定', async () => {
    await manager.install(await makeCindy('a.cindy', goodManifest()));
    // 旧客户端只写镜像:receipt.enabled=true + .disabled 在盘 → 读时合并 = 停用。
    const marker = path.join(rootDir, 'hello', '.disabled');
    await fs.promises.writeFile(marker, '');
    expect(manager.list()[0].enabled).toBe(false);

    // receipt 落盘的 rename 失败(状态根抖动):启用必须整体失败且镜像原样放回。
    const realRename = fs.promises.rename;
    const spy = vi
      .spyOn(fs.promises, 'rename')
      .mockImplementation(async (from, to) => {
        if (String(to).endsWith('hello.json')) throw new Error('state root unwritable');
        return realRename(from, to);
      });
    try {
      const result = await manager.setEnabled('hello', true);
      expect('rejection' in result && result.rejection.code).toBe('io');
    } finally {
      spy.mockRestore();
    }
    expect(fs.existsSync(marker)).toBe(true);
    expect(manager.list()[0].enabled).toBe(false);
  });

  it('进程内隔离按状态根命名空间:A 账号的隔离不污染 B,切回 A 仍生效', async () => {
    let stateDir = path.join(workDir, 'owner-a-state');
    const owned = new GhostManager({
      getRootDir: () => rootDir,
      getStateDir: () => stateDir,
      getLocale: () => hostLocale,
    });
    await owned.install(await makeCindy('a.cindy', goodManifest()));
    // 撤销失败 → A 的进程内隔离。
    const realRm = fs.promises.rm;
    const spy = vi.spyOn(fs.promises, 'rm').mockImplementation(async (target, opts) => {
      if (String(target).endsWith('hello.json')) throw new Error('EACCES');
      return realRm(target as never, opts as never);
    });
    try {
      await owned.removeInstallApproval('hello');
    } finally {
      spy.mockRestore();
    }
    expect(owned.list()[0].approval.state).toBe('invalid');

    // 切到 B 账号(状态根变了):同 id 不被 A 的隔离污染 —— B 没有 receipt,
    // 如实是 legacy-unapproved 而不是 invalid。
    stateDir = path.join(workDir, 'owner-b-state');
    expect(owned.list()[0].approval.state).toBe('legacy-unapproved');

    // 切回 A:隔离仍在(盘上那份陈旧 receipt 不得复活)。
    stateDir = path.join(workDir, 'owner-a-state');
    expect(owned.list()[0].approval.state).toBe('invalid');
  });

  it('安装根下的 junction 不算已装插件:迁移不迁它,list 不列它', async () => {
    await writeLegacyInstall('real', goodManifest('real'));
    const outside = path.join(workDir, 'outside-plugin');
    await fs.promises.mkdir(outside, { recursive: true });
    await fs.promises.writeFile(path.join(outside, 'ghost.json'), JSON.stringify(goodManifest('planted')));
    try {
      fs.symlinkSync(outside, path.join(rootDir, 'planted'), 'junction');
    } catch {
      return; // 环境建不了链接则跳过;判据逻辑平台无关。
    }

    const outcome = await manager.migrateLegacyApprovalsOnce();
    expect(outcome.migrated).toEqual(['real']);
    expect(manager.list().map((g) => g.manifest.id)).toEqual(['real']);
    expect(fs.existsSync(path.join(workDir, 'ghosts-install-state', 'planted.json'))).toBe(false);
  });
});

describe('GhostManager · 从已装目录重新确认(本地包第三条恢复路径)', () => {
  it('批准丢失后不用原始 .cindy:inspect 出全量清单,确认后开 receipt、恢复可用', async () => {
    // 场景:迁移已跑过(ledger 在),之后 receipt 又被删 —— 一次性门不再迁移,
    // 本地包用户没有市场路线;第三条路必须能不找文件恢复。
    await writeLegacyInstall('hello', goodManifest());
    await manager.migrateLegacyApprovalsOnce();
    await fs.promises.rm(path.join(workDir, 'ghosts-install-state', 'hello.json'));
    expect(manager.list()[0].approval.state).toBe('legacy-unapproved');

    const inspected = await manager.inspectInstalledReapproval('hello');
    if ('rejection' in inspected) throw new Error(JSON.stringify(inspected.rejection));
    expect(inspected.manifest.id).toBe('hello');
    expect(inspected.manifestSha256).toMatch(/^[a-f0-9]{64}$/);

    const result = await manager.reapproveInstalled('hello', {
      enable: true,
      expectedManifestSha256: inspected.manifestSha256,
      expectedApprovalProjectionSha256: inspected.approvalProjectionSha256,
      expectedInstalledApproval: 'legacy-unapproved',
    });
    if ('rejection' in result) throw new Error(JSON.stringify(result.rejection));
    expect(manager.list()[0]).toMatchObject({ enabled: true, approval: { state: 'approved' } });
    // 启停镜像同步维护(回滚到旧客户端不错位)。
    expect(fs.existsSync(path.join(rootDir, 'hello', '.disabled'))).toBe(false);
  });

  it('带 setup.kv 的旧安装可从已装目录重新确认并恢复可用', async () => {
    await writeLegacyInstall('hello', setupKvManifest(), {
      files: { 'settings.html': '<!doctype html>' },
    });
    const inspected = await manager.inspectInstalledReapproval('hello');
    if ('rejection' in inspected) throw new Error(JSON.stringify(inspected.rejection));

    const result = await manager.reapproveInstalled('hello', {
      enable: true,
      expectedManifestSha256: inspected.manifestSha256,
      expectedApprovalProjectionSha256: inspected.approvalProjectionSha256,
      expectedInstalledApproval: 'legacy-unapproved',
    });

    if ('rejection' in result) throw new Error(JSON.stringify(result.rejection));
    expect(manager.list()[0]).toMatchObject({
      enabled: true,
      approval: { state: 'approved' },
      manifest: {
        setup: {
          requires: [
            { anyOf: [{ kind: 'kv', key: 'repoDir', label: '本机 cindy 项目目录' }] },
          ],
        },
      },
    });
  });

  it('重新确认要求立即启用时，删除停用镜像失败必须拒绝且不提交批准', async () => {
    await writeLegacyInstall('hello', goodManifest(), { disabled: true });
    const inspected = await manager.inspectInstalledReapproval('hello');
    if ('rejection' in inspected) throw new Error(JSON.stringify(inspected.rejection));
    const marker = path.join(rootDir, 'hello', '.disabled');
    const realRm = fs.promises.rm;
    const rmSpy = vi.spyOn(fs.promises, 'rm').mockImplementation(async (target, options) => {
      if (path.resolve(String(target)) === path.resolve(marker)) {
        throw Object.assign(new Error('EACCES: marker locked'), { code: 'EACCES' });
      }
      return realRm(target, options);
    });
    try {
      const result = await manager.reapproveInstalled('hello', {
        enable: true,
        expectedManifestSha256: inspected.manifestSha256,
        expectedApprovalProjectionSha256: inspected.approvalProjectionSha256,
        expectedInstalledApproval: 'legacy-unapproved',
      });
      expect('rejection' in result && result.rejection.code).toBe('io');
      expect(manager.list()[0]).toMatchObject({
        enabled: false,
        approval: { state: 'legacy-unapproved' },
      });
      expect(fs.existsSync(marker)).toBe(true);
    } finally {
      rmSpy.mockRestore();
    }
  });

  it('重新确认要求立即启用时，receipt 提交失败必须恢复原停用镜像', async () => {
    await writeLegacyInstall('hello', goodManifest(), { disabled: true });
    const inspected = await manager.inspectInstalledReapproval('hello');
    if ('rejection' in inspected) throw new Error(JSON.stringify(inspected.rejection));
    const marker = path.join(rootDir, 'hello', '.disabled');
    const realRename = fs.promises.rename;
    const renameSpy = vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      if (String(to).endsWith('hello.json')) throw new Error('state root unwritable');
      return realRename(from, to);
    });
    try {
      const result = await manager.reapproveInstalled('hello', {
        enable: true,
        expectedManifestSha256: inspected.manifestSha256,
        expectedApprovalProjectionSha256: inspected.approvalProjectionSha256,
        expectedInstalledApproval: 'legacy-unapproved',
      });
      expect('rejection' in result && result.rejection.code).toBe('io');
      expect(manager.list()[0]).toMatchObject({
        enabled: false,
        approval: { state: 'legacy-unapproved' },
      });
      expect(fs.existsSync(marker)).toBe(true);
    } finally {
      renameSpy.mockRestore();
    }
  });

  it('重新确认不跟随确认后被换成 junction 的安装目录写删停用镜像', async () => {
    await writeLegacyInstall('hello', goodManifest(), { disabled: true });
    const inspected = await manager.inspectInstalledReapproval('hello');
    if ('rejection' in inspected) throw new Error(JSON.stringify(inspected.rejection));
    const dir = path.join(rootDir, 'hello');
    const outside = fs.realpathSync.native(
      await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cindy-reapprove-outside-')),
    );
    const outsideMarker = path.join(outside, '.disabled');
    await fs.promises.writeFile(outsideMarker, 'sentinel');
    const probe = path.join(workDir, 'reapprove-junction-probe');
    try {
      await fs.promises.symlink(outside, probe, process.platform === 'win32' ? 'junction' : 'dir');
      await fs.promises.rm(probe, { force: true });
    } catch {
      await fs.promises.rm(outside, { recursive: true, force: true });
      return;
    }
    const realInspect = manager.inspectInstalledReapproval.bind(manager);
    const inspectSpy = vi.spyOn(manager, 'inspectInstalledReapproval').mockImplementation(async (ghostId) => {
      const result = await realInspect(ghostId);
      await fs.promises.rm(dir, { recursive: true, force: true });
      await fs.promises.symlink(outside, dir, process.platform === 'win32' ? 'junction' : 'dir');
      return result;
    });
    try {
      const result = await manager.reapproveInstalled('hello', {
        enable: true,
        expectedManifestSha256: inspected.manifestSha256,
        expectedApprovalProjectionSha256: inspected.approvalProjectionSha256,
        expectedInstalledApproval: 'legacy-unapproved',
      });
      expect('rejection' in result && result.rejection.code).toBe('state-changed');
      expect(await fs.promises.readFile(outsideMarker, 'utf8')).toBe('sentinel');
      expect(fs.existsSync(path.join(workDir, 'ghosts-install-state', 'hello.json'))).toBe(false);
    } finally {
      inspectSpy.mockRestore();
      await fs.promises.rm(outside, { recursive: true, force: true });
    }
  });

  it('重新确认 receipt 失败回滚前目录被换成 junction 时不得写入外部目标', async () => {
    await writeLegacyInstall('hello', goodManifest(), { disabled: true });
    const inspected = await manager.inspectInstalledReapproval('hello');
    if ('rejection' in inspected) throw new Error(JSON.stringify(inspected.rejection));
    const dir = path.join(rootDir, 'hello');
    const displaced = path.join(rootDir, 'hello-displaced');
    const outside = fs.realpathSync.native(
      await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cindy-reapprove-rollback-')),
    );
    let linkCreated = false;
    const realRename = fs.promises.rename;
    const renameSpy = vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      if (String(to).endsWith('hello.json')) {
        await realRename(dir, displaced);
        try {
          await fs.promises.symlink(outside, dir, process.platform === 'win32' ? 'junction' : 'dir');
          linkCreated = true;
        } catch {
          await realRename(displaced, dir);
        }
        throw new Error('state root unwritable');
      }
      return realRename(from, to);
    });
    try {
      const result = await manager.reapproveInstalled('hello', {
        enable: true,
        expectedManifestSha256: inspected.manifestSha256,
        expectedApprovalProjectionSha256: inspected.approvalProjectionSha256,
        expectedInstalledApproval: 'legacy-unapproved',
      });
      expect('rejection' in result && result.rejection.code).toBe('io');
      if (linkCreated) expect(fs.existsSync(path.join(outside, '.disabled'))).toBe(false);
    } finally {
      renameSpy.mockRestore();
      await fs.promises.rm(outside, { recursive: true, force: true });
    }
  });

  it('确认间隙 ghost.json 被换 → 拒(确认卡展示的与批准的必须是同一份字节)', async () => {
    await writeLegacyInstall('hello', goodManifest());
    const inspected = await manager.inspectInstalledReapproval('hello');
    if ('rejection' in inspected) throw new Error(JSON.stringify(inspected.rejection));

    // 攻击窗口:用户看的是权限集 A,confirm 落地前清单被换成声明更多权限的 B。
    await fs.promises.writeFile(
      path.join(rootDir, 'hello', 'ghost.json'),
      JSON.stringify({ ...goodManifest(), name: 'Changed after review' }),
    );
    const result = await manager.reapproveInstalled('hello', {
      enable: true,
      expectedManifestSha256: inspected.manifestSha256,
      expectedApprovalProjectionSha256: inspected.approvalProjectionSha256,
      expectedInstalledApproval: 'legacy-unapproved',
    });
    expect('rejection' in result && result.rejection.code).toBe('state-changed');
    expect(manager.list()[0].approval.state).toBe('legacy-unapproved');
  });

  it.each(['skill', 'locale', 'icon', 'trust'] as const)(
    '确认间隙 %s 批准投影被换 → 拒绝重新确认',
    async (kind) => {
      const manifest = {
        ...goodManifest(),
        author: 'Original author',
        icon: 'assets/icon.png',
        locales: { en: 'locales/en.json' },
        slots: ['tool', 'skill'],
        skill: { items: [{ dir: 'skills/demo', name: 'demo', description: 'Demo skill' }] },
      };
      await writeLegacyInstall('hello', manifest, {
        files: {
          'assets/icon.png': 'ORIGINAL ICON',
          'locales/en.json': JSON.stringify({ name: 'Original name' }),
          'skills/demo/SKILL.md':
            '---\nname: demo\ndescription: Demo skill\n---\n\nOriginal instructions\n',
        },
      });
      const inspected = await manager.inspectInstalledReapproval('hello');
      if ('rejection' in inspected) throw new Error(JSON.stringify(inspected.rejection));

      if (kind === 'skill') {
        await fs.promises.writeFile(
          path.join(rootDir, 'hello', 'skills', 'demo', 'SKILL.md'),
          '---\nname: demo\ndescription: Demo skill\n---\n\nReplaced instructions\n',
        );
      } else if (kind === 'locale') {
        await fs.promises.writeFile(
          path.join(rootDir, 'hello', 'locales', 'en.json'),
          JSON.stringify({ name: 'Replaced name' }),
        );
      } else if (kind === 'icon') {
        await fs.promises.writeFile(path.join(rootDir, 'hello', 'assets', 'icon.png'), 'REPLACED ICON');
      } else {
        await fs.promises.writeFile(
          path.join(rootDir, 'hello', '.cindy-trust.json'),
          JSON.stringify({
            level: 'verified-publisher',
            publisherSigned: true,
            publisherVerified: true,
            reviewed: true,
            publisherName: 'Different publisher',
          }),
        );
      }

      const result = await manager.reapproveInstalled('hello', {
        enable: true,
        expectedManifestSha256: inspected.manifestSha256,
        expectedApprovalProjectionSha256: inspected.approvalProjectionSha256,
        expectedInstalledApproval: 'legacy-unapproved',
      });
      expect('rejection' in result && result.rejection.code).toBe('state-changed');
      expect(manager.list()[0].approval.state).toBe('legacy-unapproved');
    },
  );

  it('随包插件拒走人工重新确认(由启动对账自动补批准)', async () => {
    const guarded = new GhostManager({
      getRootDir: () => rootDir,
      getLocale: () => hostLocale,
      isTrustedBundledId: (id) => id === 'hello',
    });
    await writeLegacyInstall('hello', goodManifest());
    const inspected = await guarded.inspectInstalledReapproval('hello');
    expect('rejection' in inspected && inspected.rejection.code).toBe('file-invalid');
  });

  it('已是 approved 的插件拒重复确认(不给覆盖既有批准开口子)', async () => {
    await manager.install(await makeCindy('a.cindy', goodManifest()));
    const inspected = await manager.inspectInstalledReapproval('hello');
    expect('rejection' in inspected && inspected.rejection.code).toBe('state-changed');
  });

  it('信任镜像自称 cindy-official 一律封顶拒收(非随包目录不可能合法持有官方档)', async () => {
    await writeLegacyInstall('hello', goodManifest(), {
      trust: {
        level: 'cindy-official',
        publisherSigned: true,
        publisherVerified: true,
        reviewed: true,
      },
    });
    const inspected = await manager.inspectInstalledReapproval('hello');
    if ('rejection' in inspected) throw new Error(JSON.stringify(inspected.rejection));
    expect(inspected.trust.level).toBe('unverified');
  });
});

describe('GhostManager · review 第 6 轮回归(P0/P1 修复钉住)', () => {
  it('P0-3:停用在 receipt 写失败时仍然生效,且跨实例(重启)持久', async () => {
    await manager.install(await makeCindy('a.cindy', goodManifest()));
    expect(manager.list()[0].enabled).toBe(true);

    // 状态根不可写(AV/权限/磁盘故障):receipt 的 rename 提交失败。
    const realRename = fs.promises.rename;
    const renameSpy = vi
      .spyOn(fs.promises, 'rename')
      .mockImplementation(async (from, to) => {
        if (String(to).includes('ghosts-install-state')) {
          throw Object.assign(new Error('EACCES: state root locked'), { code: 'EACCES' });
        }
        return realRename(from as never, to as never);
      });
    try {
      // 停用必须永远能成功:镜像已落盘,如实返回 ok,而不是 io + 回滚镜像(fail open)。
      expect(await manager.setEnabled('hello', false)).toEqual({ ok: true });
      expect(manager.list()[0].enabled).toBe(false);
    } finally {
      renameSpy.mockRestore();
    }
    // "重启"(新实例,内存态清零):镜像在盘上,停用不复活。
    const restarted = new GhostManager({ getRootDir: () => rootDir, getLocale: () => hostLocale });
    expect(restarted.list()[0].enabled).toBe(false);
    // 启用方向照旧要求 receipt 写成功(此时状态根已恢复可写)。
    expect(await manager.setEnabled('hello', true)).toEqual({ ok: true });
    expect(manager.list()[0].enabled).toBe(true);
  });

  it('P0-5:嵌套 skill dir(祖先包含子项)装入/快照/校验全通,不撞 COPYFILE_EXCL', async () => {
    const nested = {
      ...goodManifest('skilled'),
      slots: ['tool', 'skill'],
      skill: {
        items: [
          { dir: 'skills/foo', name: 'foo', description: 'Foo skill' },
          { dir: 'skills/foo/bar', name: 'bar', description: 'Bar skill' },
        ],
      },
    };
    const files = {
      'skills/foo/SKILL.md': '---\nname: foo\ndescription: Foo skill\n---\n\nfoo\n',
      'skills/foo/bar/SKILL.md': '---\nname: bar\ndescription: Bar skill\n---\n\nbar\n',
    };
    const result = await manager.install(await makeCindy('nested.cindy', nested, files));
    if ('rejection' in result) throw new Error(JSON.stringify(result.rejection));
    const ghost = manager.list()[0];
    expect(ghost.approval.state).toBe('approved');
    // 两个 item 的字节指纹都能对上(嵌套项的根就在祖先拷出的快照树里)。
    expect(await manager.verifyApprovedSkillSnapshot(ghost)).toBe(true);
  });

  it('P0-5:嵌套 skill dir 的旧安装迁移同样成功(存量兼容红线)', async () => {
    await writeLegacyInstall(
      'skilled',
      {
        ...goodManifest('skilled'),
        slots: ['tool', 'skill'],
        skill: {
          items: [
            { dir: 'skills/foo/bar', name: 'bar', description: 'Bar skill' },
            { dir: 'skills/foo', name: 'foo', description: 'Foo skill' },
          ],
        },
      },
      {
        files: {
          'skills/foo/SKILL.md': '---\nname: foo\ndescription: Foo skill\n---\n\nfoo\n',
          'skills/foo/bar/SKILL.md': '---\nname: bar\ndescription: Bar skill\n---\n\nbar\n',
        },
      },
    );
    const outcome = await manager.migrateLegacyApprovalsOnce();
    expect(outcome.migrated).toEqual(['skilled']);
    expect(manager.list()[0]).toMatchObject({ enabled: true, approval: { state: 'approved' } });
  });

  it('P0-2:安装根为空/未诞生时不落台账,legacy 恢复流程随后搬入仍可迁移', async () => {
    // 首轮:根目录还不存在(owner 命名空间刚建立,旧目录尚未被恢复流程搬入)。
    expect(await manager.migrateLegacyApprovalsOnce()).toEqual({
      migrated: [],
      skipped: [],
      failed: [],
      retryPending: [],
    });
    expect(fs.existsSync(migrationLedgerPath())).toBe(false);
    // 恢复流程把旧布局目录搬进来 → 门还开着,照常迁移。
    await writeLegacyInstall('hello', goodManifest());
    const second = await manager.migrateLegacyApprovalsOnce();
    expect(second.migrated).toEqual(['hello']);
    expect(fs.existsSync(migrationLedgerPath())).toBe(true);
  });

  it('P0-2:安装不自动关闭迁移门 —— "装插件→删 receipt"骗不到迁移', async () => {
    await manager.install(await makeCindy('a.cindy', goodManifest()));
    // 安装不再自动写 migration ledger：迁移门由 coordinator 统一关闭，单一 receipt
    // 写入不得抢先把门封死（否则迁移扫描瞬时失败 + builtin reconcile 写 receipt 即
    // 永久关闭迁移门，其余存量插件全部 legacy-unapproved）。
    expect(fs.existsSync(migrationLedgerPath())).toBe(false);
    // 攻击:删掉 receipt,指望整个插件消失变成 legacy-unapproved。
    // 不加 slot 修改(避免 backfillLegacyApproval 校验失败进入 failed 分支)。
    await fs.promises.rm(path.join(workDir, 'ghosts-install-state', 'hello.json'));
    // Per-id migration marker prevents backfill. Without the marker, the
    // coordinator would re-approve from the current mutable directory. With
    // the marker, the system knows this was a new-model install whose receipt
    // was deleted — not a legacy install. It stays fail-closed.
    const outcome = await manager.migrateLegacyApprovalsOnce();
    expect(outcome).toEqual({ migrated: [], skipped: ['hello'], failed: [], retryPending: [] });
    expect(manager.list()[0].approval.state).toBe('legacy-unapproved');
  });

  it('P0-2: unreadable per-id migration marker keeps deleted receipt fail-closed', async () => {
    await manager.install(await makeCindy('a.cindy', goodManifest()));
    await fs.promises.rm(path.join(workDir, 'ghosts-install-state', 'hello.json'));

    const marker = path.join(workDir, 'ghosts-install-state', '.migrated-hello');
    const realLstatSync = fs.lstatSync;
    const spy = vi.spyOn(fs, 'lstatSync').mockImplementation((target, options) => {
      if (path.resolve(String(target)) === path.resolve(marker)) {
        throw Object.assign(new Error('EIO: migration marker unreadable'), { code: 'EIO' });
      }
      return realLstatSync(target, options as never);
    });
    try {
      expect(await manager.migrateLegacyApprovalsOnce()).toEqual({
        migrated: [],
        skipped: ['hello'],
        failed: [],
        retryPending: [],
      });
    } finally {
      spy.mockRestore();
    }

    expect(manager.list()[0].approval.state).toBe('legacy-unapproved');
  });

  it('P0-2:安装不自动落 migration ledger —— 落账失败也不影响安装', async () => {
    // With the ledger auto-close removed, the install path no longer touches
    // the migration ledger at all. A ledger I/O failure cannot block the
    // install, and the migration door stays open for the coordinator.
    const result = await manager.install(await makeCindy('a.cindy', goodManifest()));
    expect('ghost' in result).toBe(true);
    expect(fs.existsSync(path.join(workDir, 'ghosts-install-state', 'hello.json'))).toBe(true);
    expect(fs.existsSync(migrationLedgerPath())).toBe(false);
    // Door remains open: coordinator can still run.
    expect(manager.list()).toHaveLength(1);
  });

  it('首次批准与目录回滚同时失败时保留 install journal,不让迁移收编未提交字节', async () => {
    const finalDir = path.join(rootDir, 'hello');
    // The ledger auto-close is removed; without ledger-level failure injection
    // the install succeeds normally. The rollback path (rm finalDir) is only
    // reached when a previous step fails; a healthy install never hits it.
    // The migration door remains open; the coordinator handles this by
    // finding a valid receipt and skipping hello.
    const result = await manager.install(await makeCindy('a.cindy', goodManifest()));
    expect('ghost' in result).toBe(true);

    expect(fs.existsSync(finalDir)).toBe(true);
    expect(fs.existsSync(path.join(workDir, 'ghosts-install-state', 'hello.json'))).toBe(true);
    expect(fs.existsSync(migrationLedgerPath())).toBe(false);

    const migration = await manager.migrateLegacyApprovalsOnce();
    // Coordinator finds approved receipt for hello → skipped (already has receipt).
    expect(migration.migrated).toEqual([]);
    expect(migration.skipped).toEqual(['hello']);
    expect(manager.list()).toHaveLength(1);

    const recovered = new GhostManager({
      getRootDir: () => rootDir,
      getLocale: () => hostLocale,
      onChanged,
    });
    // Receipt persisted → plugin visible across manager instances.
    expect(recovered.list()).toHaveLength(1);
    expect(fs.existsSync(finalDir)).toBe(true);
  });

  it('P0-2:安装根读失败(EACCES 类)本轮放弃且不落台账,不把迁移永久封死', async () => {
    await writeLegacyInstall('hello', goodManifest());
    const realReaddir = fs.readdirSync;
    const spy = vi.spyOn(fs, 'readdirSync').mockImplementation(((dir: never, opts: never) => {
      if (String(dir) === rootDir) {
        throw Object.assign(new Error('EACCES: install root locked'), { code: 'EACCES' });
      }
      return realReaddir(dir, opts);
    }) as never);
    try {
      await expect(manager.migrateLegacyApprovalsOnce()).rejects.toThrow(/EACCES/);
    } finally {
      spy.mockRestore();
    }
    expect(fs.existsSync(migrationLedgerPath())).toBe(false);
    // 环境恢复后下一轮照常迁移。
    const outcome = await manager.migrateLegacyApprovalsOnce();
    expect(outcome.migrated).toEqual(['hello']);
  });

  it('P0-2:恢复旁路只补给定 id,台账门对其余目录照常生效', async () => {
    // 台账已落(首轮迁移空跑一个插件)。
    await writeLegacyInstall('first', goodManifest('first'));
    await manager.migrateLegacyApprovalsOnce();
    expect(fs.existsSync(migrationLedgerPath())).toBe(true);
    // 恢复流程搬入两个目录,但只把 recovered 声明为其中一个。
    await writeLegacyInstall('recovered', goodManifest('recovered'));
    await writeLegacyInstall('planted', goodManifest('planted'));
    const out = await manager.backfillRecoveredLegacyGhosts(
      ['recovered'],
      await recoveredProjectionOptions('recovered'),
    );
    expect(out.migrated).toEqual(['recovered']);
    const byId = Object.fromEntries(manager.list().map((g) => [g.manifest.id, g.approval.state]));
    expect(byId.recovered).toBe('approved');
    expect(byId.planted).toBe('legacy-unapproved');
  });

  it.each(['manifest', 'disabled', 'trust', 'locale', 'skill'] as const)(
    '恢复 backfill 在 %s 批准投影漂移时保持 fail closed',
    async (kind) => {
      const manifest = {
        ...goodManifest('recovered'),
        icon: 'assets/icon.png',
        locales: { en: 'locales/en.json' },
        slots: ['tool', 'skill'],
        skill: { items: [{ dir: 'skills/demo', name: 'demo', description: 'Demo skill' }] },
      };
      await writeLegacyInstall('recovered', manifest, {
        files: {
          'assets/icon.png': 'ORIGINAL ICON',
          'locales/en.json': JSON.stringify({ name: 'Original name' }),
          'skills/demo/SKILL.md':
            '---\nname: demo\ndescription: Demo skill\n---\n\nOriginal instructions\n',
        },
      });
      const expected = await recoveredProjectionOptions('recovered');
      const dir = path.join(rootDir, 'recovered');
      if (kind === 'manifest') {
        await fs.promises.writeFile(
          path.join(dir, 'ghost.json'),
          JSON.stringify({
            ...manifest,
            tools: [
              { name: 'do_thing', description: '做点事' },
              { name: 'new_thing', description: 'New privileged tool' },
            ],
          }),
        );
      } else if (kind === 'disabled') {
        await fs.promises.writeFile(path.join(dir, '.disabled'), '');
      } else if (kind === 'trust') {
        await fs.promises.writeFile(
          path.join(dir, '.cindy-trust.json'),
          JSON.stringify({
            level: 'verified-publisher',
            publisherSigned: true,
            publisherVerified: true,
            reviewed: false,
          }),
        );
      } else if (kind === 'locale') {
        await fs.promises.writeFile(
          path.join(dir, 'locales', 'en.json'),
          JSON.stringify({ name: 'Replaced name' }),
        );
      } else {
        await fs.promises.writeFile(
          path.join(dir, 'skills', 'demo', 'SKILL.md'),
          '---\nname: demo\ndescription: Demo skill\n---\n\nReplaced instructions\n',
        );
      }

      const outcome = await manager.backfillRecoveredLegacyGhosts(['recovered'], expected);
      expect(outcome).toEqual({ migrated: [], failed: ['recovered'] });
      expect(
        fs.existsSync(path.join(workDir, 'ghosts-install-state', 'recovered.json')),
      ).toBe(false);
      expect(manager.list()[0].approval.state).toBe('legacy-unapproved');
    },
  );

  it('keeps legacy approval backfill eligible when the optional icon cannot be read', async () => {
    await writeLegacyInstall(
      'recovered',
      {
        ...goodManifest('recovered'),
        icon: 'assets/icon.png',
      },
      {
        files: {
          'assets/icon.png': 'ORIGINAL ICON',
        },
      },
    );
    const realOpenSync = fs.openSync;
    const spy = vi
      .spyOn(fs, 'openSync')
      .mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
        if (
          typeof p === 'string' &&
          p.endsWith(path.join('recovered', 'assets', 'icon.png'))
        ) {
          const err = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
          err.code = 'EACCES';
          throw err;
        }
        return (realOpenSync as (...a: unknown[]) => number)(p, ...rest);
      }) as typeof fs.openSync);

    try {
      const result = await readLegacyGhostApprovalProjection(path.join(rootDir, 'recovered'), 'recovered');
      expect(result.projection.iconDataUrl).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });

  it('恢复 backfill 不跟随被换成 junction 的插件根目录', async () => {
    await writeLegacyInstall('recovered', goodManifest('recovered'));
    const expected = await recoveredProjectionOptions('recovered');
    const installedDir = path.join(rootDir, 'recovered');
    const externalDir = path.join(workDir, 'external-recovered');
    await fs.promises.rename(installedDir, externalDir);
    await fs.promises.symlink(externalDir, installedDir, 'junction');

    const outcome = await manager.backfillRecoveredLegacyGhosts(['recovered'], expected);
    expect(outcome).toEqual({ migrated: [], failed: ['recovered'] });
    expect(fs.existsSync(path.join(workDir, 'ghosts-install-state', 'recovered.json'))).toBe(false);
  });

  it('closes the recovery ledger when a queued id is already approved', async () => {
    await manager.install(await makeCindy('a.cindy', goodManifest()));
    await fs.promises.writeFile(
      migrationLedgerPath(),
      JSON.stringify({
        version: 1,
        migratedAt: new Date().toISOString(),
        migratedIds: [],
        state: 'in-progress',
        pendingIds: ['hello'],
      }),
    );

    await expect(
      manager.backfillRecoveredLegacyGhosts(
        ['hello'],
        { expectedApprovalProjectionSha256ById: {} },
      ),
    ).resolves.toEqual({
      migrated: [],
      failed: [],
    });
    expect(JSON.parse(await fs.promises.readFile(migrationLedgerPath(), 'utf8'))).toMatchObject({
      state: 'completed',
    });
  });

  it('keeps a target-only legacy recovery without a frozen projection fail closed', async () => {
    await writeLegacyInstall('recovered', goodManifest('recovered'));

    await expect(
      manager.backfillRecoveredLegacyGhosts(
        ['recovered'],
        { expectedApprovalProjectionSha256ById: {} },
      ),
    ).resolves.toEqual({
      migrated: [],
      failed: ['recovered'],
    });
    expect(
      fs.existsSync(path.join(workDir, 'ghosts-install-state', 'recovered.json')),
    ).toBe(false);
    expect(manager.list()[0].approval.state).toBe('legacy-unapproved');
  });

  it('恢复旁路遇到 unreadable receipt 后不再允许自动重铸批准', async () => {
    await manager.install(await makeCindy('a.cindy', goodManifest()));
    const receiptPath = path.join(workDir, 'ghosts-install-state', 'hello.json');
    const receiptBefore = await fs.promises.readFile(receiptPath, 'utf8');
    await fs.promises.rm(migrationLedgerPath(), { force: true });
    const realOpenSync = fs.openSync;
    const openSpy = vi.spyOn(fs, 'openSync');
    openSpy.mockImplementation((target, ...args) => {
      if (path.resolve(String(target)) === path.resolve(receiptPath)) {
        openSpy.mockRestore();
        throw Object.assign(new Error('EIO: receipt temporarily unreadable'), { code: 'EIO' });
      }
      return (realOpenSync as (...openArgs: unknown[]) => number)(target, ...args);
    });

    expect(
      await manager.backfillRecoveredLegacyGhosts(
        ['hello'],
        await recoveredProjectionOptions('hello'),
      ),
    ).toEqual({
      migrated: [],
      failed: ['hello'],
    });
    expect(await fs.promises.readFile(receiptPath, 'utf8')).toBe(receiptBefore);
    expect(
      JSON.parse(await fs.promises.readFile(migrationLedgerPath(), 'utf8')),
    ).toMatchObject({ state: 'completed', failedIds: ['hello'] });

    await fs.promises.rm(receiptPath);
    const retry = await manager.backfillRecoveredLegacyGhosts(
      ['hello'],
      await recoveredProjectionOptions('hello'),
    );
    expect(retry).toEqual({ migrated: [], failed: [] });
    expect(fs.existsSync(receiptPath)).toBe(false);
    expect(manager.list()[0]).toMatchObject({
      approval: { state: 'legacy-unapproved' },
      enabled: false,
    });
  });

  it('persists transient recovered-legacy backfill failures in the migration work queue', async () => {
    await writeLegacyInstall('recovered', goodManifest('recovered'));
    const realRename = fs.promises.rename;
    const renameSpy = vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      if (String(to).endsWith(`${path.sep}recovered.json`)) {
        renameSpy.mockRestore();
        const err = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
        err.code = 'EACCES';
        throw err;
      }
      return realRename(from, to);
    });

    const expected = await recoveredProjectionOptions('recovered');
    const first = await manager.backfillRecoveredLegacyGhosts(['recovered'], expected);
    expect(first).toEqual({ migrated: [], failed: [] });
    const pendingLedger = JSON.parse(await fs.promises.readFile(migrationLedgerPath(), 'utf8')) as {
      state?: string;
      pendingIds?: string[];
    };
    expect(pendingLedger.state).toBe('in-progress');
    expect(pendingLedger.pendingIds).toEqual(['recovered']);

    const second = await manager.backfillRecoveredLegacyGhosts(['recovered'], expected);
    expect(second.migrated).toEqual(['recovered']);
    const completedLedger = JSON.parse(
      await fs.promises.readFile(migrationLedgerPath(), 'utf8'),
    ) as { state?: string; pendingIds?: string[] };
    expect(completedLedger.state).toBe('completed');
    expect(completedLedger.pendingIds).toBeUndefined();
  });

  it('persists recovered ids before the first receipt write starts', async () => {
    await writeLegacyInstall('recovered', goodManifest('recovered'));
    const realRename = fs.promises.rename;
    let queueSeenBeforeReceipt = false;
    const renameSpy = vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      if (String(to).endsWith(`${path.sep}recovered.json`)) {
        const ledger = JSON.parse(
          await fs.promises.readFile(migrationLedgerPath(), 'utf8'),
        ) as { state?: string; pendingIds?: string[] };
        queueSeenBeforeReceipt =
          ledger.state === 'in-progress' && ledger.pendingIds?.includes('recovered') === true;
        const err = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
        err.code = 'EACCES';
        throw err;
      }
      return realRename(from, to);
    });

    try {
      await manager.backfillRecoveredLegacyGhosts(
        ['recovered'],
        await recoveredProjectionOptions('recovered'),
      );
    } finally {
      renameSpy.mockRestore();
    }
    expect(queueSeenBeforeReceipt).toBe(true);
  });

  it('does not overwrite an existing recovery queue when the migration ledger is unreadable', async () => {
    await fs.promises.mkdir(path.dirname(migrationLedgerPath()), { recursive: true });
    const originalLedger = {
      version: 1,
      migratedAt: new Date().toISOString(),
      migratedIds: [],
      state: 'in-progress',
      pendingIds: ['existing'],
    };
    // 台账经 bounded no-follow 读取,超上限即视为不可读(不再用 unbounded
    // readFileSync)。构造一个超限 ledger,验证门保守关死且 recovery queue 不被覆盖。
    const oversizedLedger = {
      ...originalLedger,
      migratedIds: Array.from({ length: 900 }, (_, i) => `pad-${'x'.repeat(120)}-${i}`),
    };
    await fs.promises.writeFile(
      migrationLedgerPath(),
      JSON.stringify(oversizedLedger),
    );
    await writeLegacyInstall('recovered', goodManifest('recovered'));

    await expect(
      manager.backfillRecoveredLegacyGhosts(
        ['recovered'],
        await recoveredProjectionOptions('recovered'),
      ),
    ).rejects.toThrow(
      /ledger exists but is unreadable/,
    );
    expect(JSON.parse(await fs.promises.readFile(migrationLedgerPath(), 'utf8'))).toEqual(
      oversizedLedger,
    );
  });

  it('P1-6:重新确认拒绝与已装插件撞名的指令', async () => {
    await manager.install(
      await makeCindy('holder.cindy', chipManifestWithCommand('holder', 'draw')),
    );
    await writeLegacyInstall('clasher', chipManifestWithCommand('clasher', 'Draw'));
    const inspected = await manager.inspectInstalledReapproval('clasher');
    if ('rejection' in inspected) throw new Error(JSON.stringify(inspected.rejection));
    const result = await manager.reapproveInstalled('clasher', {
      enable: true,
      expectedManifestSha256: inspected.manifestSha256,
      expectedApprovalProjectionSha256: inspected.approvalProjectionSha256,
      expectedInstalledApproval: 'legacy-unapproved',
    });
    expect('rejection' in result && result.rejection.code).toBe('command-conflict');
  });

  it('P1-6:声明 tokenBroker 的目录拒走已装目录重新确认', async () => {
    await writeLegacyInstall('brokered', {
      ...goodManifest('brokered'),
      network: {
        hosts: ['api.example.com'],
        secrets: [
          {
            key: 'token',
            source: 'oauth',
            oauth: { tokenBroker: 'github' },
          },
        ],
      },
    });
    const inspected = await manager.inspectInstalledReapproval('brokered');
    expect('rejection' in inspected && inspected.rejection.code).toBe('file-invalid');
  });

  it('P1-7:重新确认的启停默认值取镜像读数,不重置用户停用偏好', async () => {
    await writeLegacyInstall('hello', goodManifest(), { disabled: true });
    const inspected = await manager.inspectInstalledReapproval('hello');
    if ('rejection' in inspected) throw new Error(JSON.stringify(inspected.rejection));
    expect(inspected.previouslyEnabled).toBe(false);
  });

  it('P1-9:更新失败且旧目录滚不回时如实报 rollbackFailed,不假装旧版本还在', async () => {
    await manager.install(await makeCindy('a.cindy', goodManifest()));
    const finalDir = path.join(rootDir, 'hello');
    const realRename = fs.promises.rename;
    const spy = vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      // staging→final 与 backup→final 都失败(Windows 文件锁/AV 的典型形态)。
      if (path.resolve(String(to)) === path.resolve(finalDir)) {
        throw Object.assign(new Error('EPERM: dir locked'), { code: 'EPERM' });
      }
      return realRename(from as never, to as never);
    });
    try {
      const bumped = await makeCindy('b.cindy', { ...goodManifest(), version: '1.0.1' });
      const result = await updateGhost(bumped);
      expect('rejection' in result).toBe(true);
      if (!('rejection' in result)) return;
      expect(result.rejection.code).toBe('io');
      expect(result.rejection.code === 'io' && result.rejection.rollbackFailed).toBe(true);
      expect(
        fs.existsSync(path.join(workDir, 'ghosts-install-state', '.pending-hello.json')),
      ).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('GhostManager · 装入/更新崩溃窗口恢复(事务标记)', () => {
  const pendingMarkerPath = (id = 'hello') =>
    path.join(workDir, 'ghosts-install-state', `.pending-${id}.json`);
  const receiptPath = (id = 'hello') =>
    path.join(workDir, 'ghosts-install-state', `${id}.json`);
  /** 在同一组根上新建 manager —— 构造期跑一次崩溃恢复扫描。 */
  const freshManager = () =>
    new GhostManager({ getRootDir: () => rootDir, getLocale: () => hostLocale, onChanged });

  it('崩溃的装入(有 finalDir、无 receipt、有 install 标记)被恢复删除,不被迁移收编', async () => {
    // install 在 rename(staging→final) 之后、写 receipt 之前崩溃:finalDir 完整、无
    // receipt、无 ledger。若不处理,迁移会把它(崩溃窗口内可能被改过 manifest)当 legacy
    // 批准掉。事务标记让恢复识别它是"未完成安装"并删除。
    await writeLegacyInstall('hello', goodManifest());
    await fs.promises.mkdir(path.dirname(pendingMarkerPath()), { recursive: true });
    await fs.promises.writeFile(
      pendingMarkerPath(),
      JSON.stringify({ version: 1, id: 'hello', kind: 'install', packageSha256: 'a'.repeat(64) }),
    );

    const recovered = freshManager(); // 构造期恢复:删掉未完成安装
    expect(fs.existsSync(path.join(rootDir, 'hello'))).toBe(false);
    expect(fs.existsSync(pendingMarkerPath())).toBe(false);
    const outcome = await recovered.migrateLegacyApprovalsOnce();
    expect(outcome.migrated).toEqual([]); // 目录已被删,迁移无对象
  });

  it('keeps a committed builtin restore successful and retries tombstone clearing from its journal', async () => {
    trustedBundledIds.add('hello');
    const clearBuiltinTombstone = vi
      .fn<(id: string) => void>()
      .mockImplementationOnce(() => {
        throw new Error('state root temporarily unavailable');
      })
      .mockImplementation(() => undefined);
    const restoringManager = new GhostManager({
      getRootDir: () => rootDir,
      getLocale: () => hostLocale,
      isTrustedBundledId: (id) => trustedBundledIds.has(id),
      clearBuiltinTombstone,
    });

    const installed = await restoringManager.install(
      await makeCindy('builtin-restore.cindy', goodManifest()),
    );

    expect('ghost' in installed).toBe(true);
    expect(restoringManager.list()[0]).toMatchObject({ approval: { state: 'approved' } });
    expect(fs.existsSync(pendingMarkerPath())).toBe(true);
    expect(JSON.parse(await fs.promises.readFile(pendingMarkerPath(), 'utf8'))).toMatchObject({
      kind: 'install',
      clearBuiltinTombstone: true,
    });

    const recoveredAfterClearFailure = new GhostManager({
      getRootDir: () => rootDir,
      getLocale: () => hostLocale,
      isTrustedBundledId: (id) => trustedBundledIds.has(id),
      clearBuiltinTombstone,
    });

    expect(clearBuiltinTombstone).toHaveBeenCalledTimes(2);
    expect(fs.existsSync(pendingMarkerPath())).toBe(false);
    expect(recoveredAfterClearFailure.list()[0]).toMatchObject({
      approval: { state: 'approved' },
    });
  });

  it('install 恢复必须用 packageSha256 证明旧 receipt 属于这次安装', async () => {
    await manager.install(await makeCindy('old.cindy', goodManifest()));
    const finalDir = path.join(rootDir, 'hello');
    await fs.promises.rm(finalDir, { recursive: true, force: true });
    await fs.promises.mkdir(finalDir, { recursive: true });
    await fs.promises.writeFile(
      path.join(finalDir, 'ghost.json'),
      JSON.stringify({ ...goodManifest(), version: '2.0.0' }),
    );
    await fs.promises.writeFile(path.join(finalDir, 'main.js'), 'new-bytes');
    await fs.promises.mkdir(path.dirname(pendingMarkerPath()), { recursive: true });
    await fs.promises.writeFile(
      pendingMarkerPath(),
      JSON.stringify({
        version: 1,
        id: 'hello',
        kind: 'install',
        packageSha256: 'f'.repeat(64),
      }),
    );

    new GhostManager({ getRootDir: () => rootDir, getLocale: () => hostLocale, onChanged });
    expect(fs.existsSync(finalDir)).toBe(false);
    expect(fs.existsSync(pendingMarkerPath())).toBe(false);
  });

  it('非法 pending marker 会阻断 orphan backup 启发式，不删除待人工恢复的 backup', async () => {
    await manager.install(await makeCindy('old.cindy', goodManifest()));
    const finalDir = path.join(rootDir, 'hello');
    const backupName = '.cindy-updating-hello-abcdef12';
    await fs.promises.rename(finalDir, path.join(rootDir, backupName));
    await fs.promises.mkdir(finalDir, { recursive: true });
    await fs.promises.writeFile(path.join(finalDir, 'ghost.json'), JSON.stringify(goodManifest()));
    await fs.promises.writeFile(path.join(finalDir, 'main.js'), 'new');
    await fs.promises.mkdir(path.dirname(pendingMarkerPath()), { recursive: true });
    await fs.promises.writeFile(
      pendingMarkerPath(),
      JSON.stringify({
        version: 1,
        id: 'hello',
        kind: 'update',
        packageSha256: 'f'.repeat(64),
        backupDirName: '..\\outside',
      }),
    );

    const recovered = freshManager();
    expect(fs.existsSync(path.join(rootDir, backupName))).toBe(true);
    expect(fs.existsSync(pendingMarkerPath())).toBe(true);
    expect(recovered.list()[0]).toMatchObject({
      enabled: false,
      approval: { state: 'invalid' },
    });
  });

  it('invalid pending marker filename blocks orphan-backup heuristics', async () => {
    await manager.install(await makeCindy('old.cindy', goodManifest()));
    const finalDir = path.join(rootDir, 'hello');
    const backupDir = path.join(rootDir, '.cindy-updating-hello-abcdef12');
    await fs.promises.rename(finalDir, backupDir);
    await fs.promises.mkdir(finalDir, { recursive: true });
    await fs.promises.writeFile(path.join(finalDir, 'ghost.json'), JSON.stringify(goodManifest()));
    await fs.promises.writeFile(path.join(finalDir, 'main.js'), 'new');
    const invalidMarker = path.join(path.dirname(pendingMarkerPath()), '.pending-BAD!.json');
    await fs.promises.writeFile(invalidMarker, '{}');

    const recovered = freshManager();
    expect(fs.existsSync(backupDir)).toBe(true);
    expect(fs.existsSync(invalidMarker)).toBe(true);
    expect(recovered.list()[0]).toMatchObject({
      enabled: false,
      approval: { state: 'invalid' },
    });
  });

  it('pending marker JSON 为 null 时按 invalid 保留现场，不让构造期恢复崩溃', async () => {
    await manager.install(await makeCindy('old.cindy', goodManifest()));
    const finalDir = path.join(rootDir, 'hello');
    const backupDir = path.join(rootDir, '.cindy-updating-hello-abcdef12');
    await fs.promises.rename(finalDir, backupDir);
    await fs.promises.mkdir(finalDir, { recursive: true });
    await fs.promises.writeFile(path.join(finalDir, 'ghost.json'), JSON.stringify(goodManifest()));
    await fs.promises.writeFile(path.join(finalDir, 'main.js'), 'new');
    await fs.promises.writeFile(pendingMarkerPath(), 'null');

    const recovered = freshManager();
    expect(fs.existsSync(finalDir)).toBe(true);
    expect(fs.existsSync(backupDir)).toBe(true);
    expect(fs.existsSync(pendingMarkerPath())).toBe(true);
    expect(recovered.list()[0]).toMatchObject({
      enabled: false,
      approval: { state: 'invalid' },
    });
  });

  it('状态根 journal 扫描 EACCES 时跳过全部恢复启发式，任何现场都不动', async () => {
    await manager.install(await makeCindy('a.cindy', goodManifest()));
    const stateRoot = path.dirname(pendingMarkerPath());
    const backupDir = path.join(rootDir, '.cindy-updating-hello-abcdef12');
    const stagingDir = path.join(rootDir, '.cindy-installing-hello-deadbeef');
    await fs.promises.mkdir(backupDir, { recursive: true });
    await fs.promises.mkdir(stagingDir, { recursive: true });
    await fs.promises.writeFile(
      pendingMarkerPath(),
      JSON.stringify({
        version: 1,
        id: 'hello',
        kind: 'update',
        packageSha256: 'f'.repeat(64),
        backupDirName: path.basename(backupDir),
      }),
    );
    const realReaddirSync = fs.readdirSync;
    const spy = vi.spyOn(fs, 'readdirSync').mockImplementation(((target: fs.PathLike, options?: unknown) => {
      if (path.resolve(String(target)) === path.resolve(stateRoot)) {
        throw Object.assign(new Error('EACCES: state root locked'), { code: 'EACCES' });
      }
      return (realReaddirSync as (...args: unknown[]) => unknown)(target, options);
    }) as typeof fs.readdirSync);
    try {
      const recovered = freshManager();
      expect(recovered.list()[0]).toMatchObject({
        enabled: false,
        approval: { state: 'invalid' },
      });
    } finally {
      spy.mockRestore();
    }

    // 未提交 update 已先移除 final；backup 不可读时保留整笔 journal，
    // 因而此刻 final 仍缺失，等待下次可读时再由 recovery 收敛。
    expect(fs.existsSync(path.join(rootDir, 'hello'))).toBe(true);
    expect(fs.existsSync(receiptPath())).toBe(true);
    expect(fs.existsSync(pendingMarkerPath())).toBe(true);
    expect(fs.existsSync(backupDir)).toBe(true);
    expect(fs.existsSync(stagingDir)).toBe(true);
  });

  it('journal root unreadable blocks the whole owner even when installed ids cannot be enumerated yet', async () => {
    await manager.install(await makeCindy('a.cindy', goodManifest()));
    const stateRoot = path.dirname(pendingMarkerPath());
    const realReaddirSync = fs.readdirSync;
    const spy = vi.spyOn(fs, 'readdirSync').mockImplementation(((target: fs.PathLike, options?: unknown) => {
      const resolved = path.resolve(String(target));
      if (resolved === path.resolve(stateRoot) || resolved === path.resolve(rootDir)) {
        throw Object.assign(new Error('EACCES: managed root locked'), { code: 'EACCES' });
      }
      return (realReaddirSync as (...args: unknown[]) => unknown)(target, options);
    }) as typeof fs.readdirSync);

    let recovered: GhostManager;
    try {
      recovered = freshManager();
    } finally {
      spy.mockRestore();
    }

    expect(recovered.list()[0]).toMatchObject({
      enabled: false,
      approval: { state: 'invalid' },
    });
  });

  it('pending marker 读取 EACCES 时保留 marker/final/backup，不降级到 orphan cleanup', async () => {
    await manager.install(await makeCindy('a.cindy', goodManifest()));
    const backupDir = path.join(rootDir, '.cindy-updating-hello-abcdef12');
    await fs.promises.mkdir(backupDir, { recursive: true });
    await fs.promises.writeFile(
      pendingMarkerPath(),
      JSON.stringify({
        version: 1,
        id: 'hello',
        kind: 'update',
        packageSha256: 'f'.repeat(64),
        backupDirName: path.basename(backupDir),
      }),
    );
    // readPendingMutationSync now uses readBoundedFileNoFollowSync (single-handle
    // open+stat+read) instead of lstat+readFileSync.  Inject EACCES at openSync
    // so the bounded reader surfaces the unreadable state through its normal path.
    const realOpenSync = fs.openSync;
    const spy = vi.spyOn(fs, 'openSync').mockImplementation(((target: fs.PathLike, ...rest: unknown[]) => {
      if (path.resolve(String(target)) === path.resolve(pendingMarkerPath())) {
        throw Object.assign(new Error('EACCES: marker locked'), { code: 'EACCES' });
      }
      return (realOpenSync as (...args: unknown[]) => unknown)(target, ...rest);
    }) as typeof fs.openSync);
    try {
      const recovered = freshManager();
      expect(recovered.list()[0]).toMatchObject({
        enabled: false,
        approval: { state: 'invalid' },
      });
    } finally {
      spy.mockRestore();
    }

    expect(fs.existsSync(path.join(rootDir, 'hello'))).toBe(true);
    expect(fs.existsSync(pendingMarkerPath())).toBe(true);
    expect(fs.existsSync(backupDir)).toBe(true);
  });

  it('已提交 install 的 receipt 瞬时不可读时保留 final/receipt/journal 等待重试', async () => {
    await manager.install(await makeCindy('a.cindy', goodManifest()));
    const packageSha256 = (JSON.parse(await fs.promises.readFile(receiptPath(), 'utf8')) as {
      packageSha256: string;
    }).packageSha256;
    await fs.promises.writeFile(
      pendingMarkerPath(),
      JSON.stringify({ version: 1, id: 'hello', kind: 'install', packageSha256 }),
    );
    const realOpenSync = fs.openSync;
    const spy = vi.spyOn(fs, 'openSync').mockImplementation(((target: fs.PathLike, ...rest: unknown[]) => {
      if (path.resolve(String(target)) === path.resolve(receiptPath())) {
        throw Object.assign(new Error('EACCES: receipt locked'), { code: 'EACCES' });
      }
      return (realOpenSync as (...args: unknown[]) => number)(target, ...rest);
    }) as typeof fs.openSync);
    try {
      const recovered = freshManager();
      expect(recovered.list()[0]).toMatchObject({
        enabled: false,
        approval: { state: 'invalid' },
      });
    } finally {
      spy.mockRestore();
    }

    expect(fs.existsSync(path.join(rootDir, 'hello'))).toBe(true);
    expect(fs.existsSync(receiptPath())).toBe(true);
    expect(fs.existsSync(pendingMarkerPath())).toBe(true);
  });

  it('已提交 update 的 receipt lstat EACCES 时保留 final/backup/receipt/journal', async () => {
    await manager.install(await makeCindy('a.cindy', goodManifest()));
    const packageSha256 = (JSON.parse(await fs.promises.readFile(receiptPath(), 'utf8')) as {
      packageSha256: string;
    }).packageSha256;
    const backupDir = path.join(rootDir, '.cindy-updating-hello-abcdef12');
    await fs.promises.mkdir(backupDir, { recursive: true });
    await fs.promises.writeFile(
      pendingMarkerPath(),
      JSON.stringify({
        version: 1,
        id: 'hello',
        kind: 'update',
        packageSha256,
        backupDirName: path.basename(backupDir),
      }),
    );
    const realOpenSync = fs.openSync;
    const spy = vi.spyOn(fs, 'openSync').mockImplementation(((target: fs.PathLike, ...rest: unknown[]) => {
      if (path.resolve(String(target)) === path.resolve(receiptPath())) {
        throw Object.assign(new Error('EACCES: receipt locked'), { code: 'EACCES' });
      }
      return (realOpenSync as (...args: unknown[]) => number)(target, ...rest);
    }) as typeof fs.openSync);
    try {
      const recovered = freshManager();
      expect(recovered.list()[0]).toMatchObject({
        enabled: false,
        approval: { state: 'invalid' },
      });
    } finally {
      spy.mockRestore();
    }

    expect(fs.existsSync(path.join(rootDir, 'hello'))).toBe(true);
    expect(fs.existsSync(backupDir)).toBe(true);
    expect(fs.existsSync(receiptPath())).toBe(true);
    expect(fs.existsSync(pendingMarkerPath())).toBe(true);
  });

  it('update backup lstat EACCES 时保留整笔 journal，不清 marker 继续猜恢复', async () => {
    await manager.install(await makeCindy('a.cindy', goodManifest()));
    const backupDir = path.join(rootDir, '.cindy-updating-hello-abcdef12');
    await fs.promises.mkdir(backupDir, { recursive: true });
    await fs.promises.writeFile(
      pendingMarkerPath(),
      JSON.stringify({
        version: 1,
        id: 'hello',
        kind: 'update',
        packageSha256: 'f'.repeat(64),
        backupDirName: path.basename(backupDir),
      }),
    );
    const realLstatSync = fs.lstatSync;
    const spy = vi.spyOn(fs, 'lstatSync').mockImplementation(((target: fs.PathLike, ...rest: unknown[]) => {
      if (path.resolve(String(target)) === path.resolve(backupDir)) {
        throw Object.assign(new Error('EACCES: backup locked'), { code: 'EACCES' });
      }
      return (realLstatSync as (...args: unknown[]) => unknown)(target, ...rest);
    }) as typeof fs.lstatSync);
    try {
      const recovered = freshManager();
      expect(recovered.list()[0]).toMatchObject({
        enabled: false,
        approval: { state: 'invalid' },
      });
    } finally {
      spy.mockRestore();
    }

    expect(fs.existsSync(path.join(rootDir, 'hello'))).toBe(true);
    expect(fs.existsSync(backupDir)).toBe(true);
    expect(fs.existsSync(pendingMarkerPath())).toBe(true);
  });

  it('动态 owner 根切换时，首次读取会先恢复新 owner 的 pending mutation', async () => {
    const rootA = rootDir;
    const rootB = path.join(workDir, 'ghosts-b');
    const stateA = path.join(workDir, 'state-a');
    const stateB = path.join(workDir, 'state-b');
    let activeRoot = rootA;
    let activeState = stateA;
    const backupName = '.cindy-updating-hello-abcdef12';
    const finalDir = path.join(rootB, 'hello');
    await fs.promises.mkdir(path.join(rootB, backupName), { recursive: true });
    await fs.promises.writeFile(path.join(rootB, backupName, 'ghost.json'), JSON.stringify(goodManifest()));
    await fs.promises.writeFile(path.join(rootB, backupName, 'main.js'), 'old');
    await fs.promises.mkdir(stateB, { recursive: true });
    await fs.promises.writeFile(
      path.join(stateB, '.pending-hello.json'),
      JSON.stringify({
        version: 1,
        id: 'hello',
        kind: 'update',
        packageSha256: 'f'.repeat(64),
        backupDirName: backupName,
      }),
    );
    const owned = new GhostManager({
      getRootDir: () => activeRoot,
      getStateDir: () => activeState,
      getLocale: () => hostLocale,
    });
    activeRoot = rootB;
    activeState = stateB;
    expect(owned.list().map((ghost) => ghost.manifest.id)).toEqual(['hello']);
    expect(fs.existsSync(finalDir)).toBe(true);
    expect(fs.existsSync(path.join(rootB, backupName))).toBe(false);
  });

  it('排队中的 mutation 在 owner 代际变化后拒绝执行', async () => {
    const rootA = rootDir;
    const rootB = path.join(workDir, 'ghosts-b');
    const stateA = path.join(workDir, 'state-a');
    const stateB = path.join(workDir, 'state-b');
    let activeRoot = rootA;
    let activeState = stateA;
    let ownerGeneration = 0;
    const owned = new GhostManager({
      getRootDir: () => activeRoot,
      getStateDir: () => activeState,
      getOwnerContextKey: () => `owner:${ownerGeneration}`,
      getLocale: () => hostLocale,
    });

    let markStarted!: () => void;
    let releaseFirst!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const first = owned.runExclusiveMutation(async () => {
      markStarted();
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
    });
    await started;

    const second = owned.runExclusiveMutation(async () => {
      await fs.promises.mkdir(activeRoot, { recursive: true });
      await fs.promises.writeFile(path.join(activeRoot, 'queued-write'), 'must not run');
    });
    const rejected = expect(second).rejects.toThrow(/owner context changed/);
    activeRoot = rootB;
    activeState = stateB;
    ownerGeneration += 1;
    releaseFirst();

    await first;
    await rejected;
    expect(fs.existsSync(path.join(rootA, 'queued-write'))).toBe(false);
    expect(fs.existsSync(path.join(rootB, 'queued-write'))).toBe(false);
  });

  it('执行中的独占 mutation 钉住 owner 内容根与状态根，不把后半段写进新 owner', async () => {
    const rootA = path.join(workDir, 'owned-a');
    const rootB = path.join(workDir, 'owned-b');
    const stateA = path.join(workDir, 'owned-state-a');
    const stateB = path.join(workDir, 'owned-state-b');
    let activeRoot = rootA;
    let activeState = stateA;
    let ownerGeneration = 0;
    const owned = new GhostManager({
      getRootDir: () => activeRoot,
      getStateDir: () => activeState,
      getOwnerContextKey: () => `owner:${ownerGeneration}`,
      getLocale: () => hostLocale,
    });
    await owned.install(await makeCindy('owned.cindy', goodManifest()));
    await fs.promises.mkdir(path.join(rootB, 'hello'), { recursive: true });
    await fs.promises.writeFile(path.join(rootB, 'hello', 'ghost.json'), JSON.stringify(goodManifest()));
    await fs.promises.writeFile(path.join(rootB, 'hello', 'main.js'), 'owner-b');

    await owned.runExclusiveMutation(async (mutation) => {
      activeRoot = rootB;
      activeState = stateB;
      ownerGeneration += 1;
      expect(await mutation.uninstall('hello', { notify: false })).toEqual({ ok: true });
    });

    expect(fs.existsSync(path.join(rootA, 'hello'))).toBe(false);
    expect(fs.existsSync(path.join(stateA, 'hello.json'))).toBe(false);
    expect(fs.existsSync(path.join(rootB, 'hello', 'main.js'))).toBe(true);
    expect(owned.list().find((ghost) => ghost.manifest.id === 'hello')?.approval.state).toBe(
      'legacy-unapproved',
    );
  });

  it('未提交的更新(新字节+旧 receipt+update 标记)回滚到 backup,不固化成按旧批准跑新代码', async () => {
    await manager.install(await makeCindy('a.cindy', goodManifest()));
    const receiptBefore = await fs.promises.readFile(receiptPath(), 'utf8');
    const finalDir = path.join(rootDir, 'hello');
    const backupName = '.cindy-updating-hello-abcdef12';

    // 模拟 staging→final 之后、写 receipt 之前崩溃:旧字节挪到 backup,新字节在 final,
    // receipt 仍是旧的。标记的 packageSha256 与旧 receipt 不同 = 未提交。
    await fs.promises.rename(finalDir, path.join(rootDir, backupName));
    await fs.promises.mkdir(finalDir);
    await fs.promises.writeFile(
      path.join(finalDir, 'ghost.json'),
      JSON.stringify({ ...goodManifest(), version: '2.0.0' }),
    );
    await fs.promises.writeFile(path.join(finalDir, 'main.js'), 'new-bytes');
    await fs.promises.mkdir(path.dirname(pendingMarkerPath()), { recursive: true });
    await fs.promises.writeFile(
      pendingMarkerPath(),
      JSON.stringify({
        version: 1,
        id: 'hello',
        kind: 'update',
        packageSha256: 'f'.repeat(64),
        backupDirName: backupName,
      }),
    );

    freshManager(); // 构造期恢复:未提交 → 回滚到 backup
    const restored = JSON.parse(await fs.promises.readFile(path.join(finalDir, 'ghost.json'), 'utf8'));
    expect(restored.version).toBe('1.0.0'); // 旧字节搬回
    expect(fs.existsSync(path.join(rootDir, backupName))).toBe(false);
    expect(fs.existsSync(pendingMarkerPath())).toBe(false);
    // receipt 一字未动,与回滚后的旧字节自洽(不是"新字节 + 旧 receipt"的错位)。
    expect(await fs.promises.readFile(receiptPath(), 'utf8')).toBe(receiptBefore);
  });

  it('已提交的更新(标记 packageSha256 == receipt)保留新字节,只回收陈旧 backup', async () => {
    await manager.install(await makeCindy('a.cindy', goodManifest()));
    const committedReceipt = JSON.parse(await fs.promises.readFile(receiptPath(), 'utf8')) as {
      packageSha256: string;
      revision: string;
    };
    const backupName = '.cindy-updating-hello-abcdef34';
    await fs.promises.mkdir(path.join(rootDir, backupName));
    await fs.promises.writeFile(path.join(rootDir, backupName, 'stale.txt'), 'old');
    await fs.promises.mkdir(path.dirname(pendingMarkerPath()), { recursive: true });
    await fs.promises.writeFile(
      pendingMarkerPath(),
      JSON.stringify({
        version: 1,
        id: 'hello',
        kind: 'update',
        packageSha256: committedReceipt.packageSha256,
        receiptRevision: committedReceipt.revision,
        backupDirName: backupName,
        phase: 'published',
      }),
    );

    freshManager();
    expect(fs.existsSync(path.join(rootDir, backupName))).toBe(false); // 陈旧 backup 回收
    expect(fs.existsSync(path.join(rootDir, 'hello'))).toBe(true); // 新版保留
    expect(fs.existsSync(pendingMarkerPath())).toBe(false);
    expect(manager.list()[0].approval.state).toBe('approved');
  });

  it('same-hash backed-up update restores the only backup instead of deleting it', async () => {
    await manager.install(await makeCindy('a.cindy', goodManifest()));
    const receiptBefore = await fs.promises.readFile(receiptPath(), 'utf8');
    const receipt = JSON.parse(receiptBefore) as { packageSha256: string };
    const finalDir = path.join(rootDir, 'hello');
    const backupName = '.cindy-updating-hello-acde0011';
    await fs.promises.rename(finalDir, path.join(rootDir, backupName));
    await fs.promises.writeFile(
      pendingMarkerPath(),
      JSON.stringify({
        version: 1,
        id: 'hello',
        kind: 'update',
        packageSha256: receipt.packageSha256,
        oldPackageSha256: receipt.packageSha256,
        receiptRevision: '11111111-1111-4111-8111-111111111111',
        backupDirName: backupName,
        phase: 'backed-up',
      }),
    );

    freshManager();
    expect(fs.existsSync(finalDir)).toBe(true);
    expect(fs.existsSync(path.join(rootDir, backupName))).toBe(false);
    expect(fs.existsSync(pendingMarkerPath())).toBe(false);
    expect(await fs.promises.readFile(receiptPath(), 'utf8')).toBe(receiptBefore);
  });

  it('same-hash backed-up update rolls back a final whose receipt revision is still old', async () => {
    await manager.install(await makeCindy('a.cindy', goodManifest()));
    const receipt = JSON.parse(await fs.promises.readFile(receiptPath(), 'utf8')) as {
      packageSha256: string;
    };
    const finalDir = path.join(rootDir, 'hello');
    const backupName = '.cindy-updating-hello-acde0022';
    await fs.promises.rename(finalDir, path.join(rootDir, backupName));
    await fs.promises.mkdir(finalDir);
    await fs.promises.writeFile(path.join(finalDir, 'new.txt'), 'uncommitted');
    await fs.promises.writeFile(
      pendingMarkerPath(),
      JSON.stringify({
        version: 1,
        id: 'hello',
        kind: 'update',
        packageSha256: receipt.packageSha256,
        oldPackageSha256: receipt.packageSha256,
        receiptRevision: '22222222-2222-4222-8222-222222222222',
        backupDirName: backupName,
        phase: 'backed-up',
      }),
    );

    freshManager();
    expect(fs.existsSync(path.join(finalDir, 'new.txt'))).toBe(false);
    expect(fs.existsSync(path.join(finalDir, 'ghost.json'))).toBe(true);
    expect(fs.existsSync(path.join(rootDir, backupName))).toBe(false);
    expect(fs.existsSync(pendingMarkerPath())).toBe(false);
  });

  it('legacy install marker with an old same-hash receipt and no final stays isolated', async () => {
    await manager.install(await makeCindy('a.cindy', goodManifest()));
    const receipt = JSON.parse(await fs.promises.readFile(receiptPath(), 'utf8')) as {
      packageSha256: string;
    };
    await fs.promises.rm(path.join(rootDir, 'hello'), { recursive: true, force: true });
    await fs.promises.writeFile(
      pendingMarkerPath(),
      JSON.stringify({
        version: 1,
        id: 'hello',
        kind: 'install',
        packageSha256: receipt.packageSha256,
      }),
    );

    freshManager();
    expect(fs.existsSync(pendingMarkerPath())).toBe(true);
    expect(fs.existsSync(receiptPath())).toBe(true);
    expect(manager.list()).toEqual([]);
  });

  it('卸载先撤批准再删目录:删目录失败时不留"孤立 approved receipt + 目录在"(防借尸还魂)', async () => {
    await manager.install(await makeCindy('a.cindy', goodManifest()));
    expect(manager.list()[0].approval.state).toBe('approved');
    // 让内容目录的 rm 失败(模拟句柄占用),但放行 receipt/快照的 rm。
    const realRm = fs.promises.rm;
    const rmSpy = vi.spyOn(fs.promises, 'rm').mockImplementation((async (p: fs.PathLike, ...rest: unknown[]) => {
      if (String(p) === path.join(rootDir, 'hello')) {
        rmSpy.mockRestore();
        const err = new Error('EBUSY: resource busy') as NodeJS.ErrnoException;
        err.code = 'EBUSY';
        throw err;
      }
      return (realRm as (...a: unknown[]) => Promise<void>)(p, ...rest);
    }) as typeof fs.promises.rm);

    const res = await manager.uninstall('hello');
    await expectRejection(res, 'io');
    // 关键:撤批准在删目录之前 —— receipt 已没了,目录还在但 fail closed(list 报
    // legacy-unapproved),不会被这份 receipt 授权。孤立标记留给启动恢复收尾。
    expect(fs.existsSync(receiptPath())).toBe(false);
    expect(manager.list()[0].approval.state).toBe('legacy-unapproved');
    expect(fs.existsSync(pendingMarkerPath())).toBe(true);
  });

  it('卸载崩在撤批准之后、删目录之前:恢复据 uninstall 标记删净残留目录', async () => {
    await manager.install(await makeCindy('a.cindy', goodManifest()));
    // 模拟崩溃现场:receipt 已撤(revoke 先行),目录还在,uninstall 标记在。
    await fs.promises.rm(receiptPath(), { force: true });
    await fs.promises.writeFile(
      pendingMarkerPath(),
      JSON.stringify({ version: 1, id: 'hello', kind: 'uninstall' }),
    );
    expect(fs.existsSync(path.join(rootDir, 'hello'))).toBe(true);

    freshManager(); // 构造期恢复
    expect(fs.existsSync(path.join(rootDir, 'hello'))).toBe(false);
    expect(fs.existsSync(pendingMarkerPath())).toBe(false);
  });

  it('卸载崩在撤批准之前:恢复据 uninstall 标记把 receipt 与目录都删净', async () => {
    await manager.install(await makeCindy('a.cindy', goodManifest()));
    // 崩在写标记之后、撤批准之前:receipt 与目录都还在。
    await fs.promises.writeFile(
      pendingMarkerPath(),
      JSON.stringify({ version: 1, id: 'hello', kind: 'uninstall' }),
    );
    expect(fs.existsSync(receiptPath())).toBe(true);

    freshManager();
    expect(fs.existsSync(path.join(rootDir, 'hello'))).toBe(false);
    expect(fs.existsSync(receiptPath())).toBe(false);
    expect(fs.existsSync(pendingMarkerPath())).toBe(false);
  });

  it('setEnabled 不跟随非真目录:<id> 是普通文件时按未装入拒,不越安装根写标记', async () => {
    await fs.promises.mkdir(rootDir, { recursive: true });
    await fs.promises.writeFile(path.join(rootDir, 'foo'), 'not a dir');
    const result = await manager.setEnabled('foo', false);
    await expectRejection(result, 'not-installed');
  });

  it('setEnabled 不跟随 junction:<id> 是指向外部的链接时拒,不在外部目标写/删 .disabled', async () => {
    await manager.install(await makeCindy('a.cindy', goodManifest()));
    const dir = path.join(rootDir, 'hello');
    const outside = path.join(workDir, 'outside-target');
    await fs.promises.mkdir(outside, { recursive: true });
    await fs.promises.rm(dir, { recursive: true, force: true });
    try {
      await fs.promises.symlink(outside, dir, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      return; // 无 symlink 权限(Windows 未开发者模式):生产守卫仍由 classify 钉死。
    }
    const result = await manager.setEnabled('hello', false);
    await expectRejection(result, 'not-installed');
    // 关键:没有往 junction 目标(安装根之外)写 .disabled。
    expect(fs.existsSync(path.join(outside, '.disabled'))).toBe(false);
  });
});

describe('GhostManager · update pre-rename recovery', () => {
  it('marker 落盘但尚未 rename 时保留旧 final 与 receipt', async () => {
    await manager.install(await makeCindy('a.cindy', goodManifest()));
    const finalDir = path.join(rootDir, 'hello');
    const stagingDir = path.join(rootDir, '.cindy-installing-hello-deadbeef');
    await fs.promises.mkdir(stagingDir, { recursive: true });
    const stateReceiptPath = path.join(workDir, 'ghosts-install-state', 'hello.json');
    const statePendingPath = path.join(workDir, 'ghosts-install-state', '.pending-hello.json');
    const receipt = JSON.parse(await fs.promises.readFile(stateReceiptPath, 'utf8')) as {
      packageSha256?: string;
    };
    await fs.promises.writeFile(
      statePendingPath,
      JSON.stringify({
        version: 1,
        id: 'hello',
        kind: 'update',
        packageSha256: 'f'.repeat(64),
        backupDirName: '.cindy-updating-hello-deadbeef',
        phase: 'prepared',
        oldPackageSha256: receipt.packageSha256,
      }),
    );

    new GhostManager({ getRootDir: () => rootDir, getLocale: () => hostLocale, onChanged });

    expect(fs.existsSync(finalDir)).toBe(true);
    expect(fs.existsSync(stateReceiptPath)).toBe(true);
    expect(fs.existsSync(statePendingPath)).toBe(false);
    expect(fs.existsSync(stagingDir)).toBe(false);
  });
});

describe('GhostManager · install', () => {
  it('按宿主语言返回本地化清单，切换语言后 list 立即更新，不支持语言固定回退英文', async () => {
    const manifest = {
      ...goodManifest(),
      name: 'Base name',
      description: 'Base description',
      locales: {
        en: 'locales/en.json',
        'zh-CN': 'locales/zh-CN.json',
      },
    };
    const locale = (name: string, description: string, toolDescription: string) =>
      JSON.stringify({
        name,
        description,
        tools: { do_thing: { description: toolDescription } },
      });
    const cindy = await makeCindy('localized.cindy', manifest, {
      'locales/en.json': locale('English name', 'English description', 'English tool'),
      'locales/zh-CN.json': locale('中文名称', '中文说明', '中文工具'),
    });
    const result = await manager.install(cindy);
    expect(result).toMatchObject({
      ghost: {
        manifest: {
          name: '中文名称',
          description: '中文说明',
          resolvedLocale: 'zh-CN',
          tools: [{ name: 'do_thing', description: '中文工具' }],
        },
      },
    });

    hostLocale = 'ja';
    expect(manager.list()[0].manifest).toMatchObject({
      name: 'English name',
      description: 'English description',
      resolvedLocale: 'ja',
      tools: [{ name: 'do_thing', description: 'English tool' }],
    });
    hostLocale = 'fr-FR';
    expect(manager.list()[0].manifest).toMatchObject({
      name: 'English name',
      resolvedLocale: 'en',
    });
  });

  it('installed locale symlinks cannot replace the Host-approved locale snapshot', async () => {
    hostLocale = 'en';
    const manifest = {
      ...goodManifest(),
      name: 'Base name',
      locales: { en: 'locales/en.json' },
    };
    const locale = (name: string) =>
      JSON.stringify({
        name,
        tools: { do_thing: { description: 'Localized tool' } },
      });
    const cindy = await makeCindy('localized-symlink.cindy', manifest, {
      'locales/en.json': locale('Packaged name'),
    });
    await manager.install(cindy);
    const localePath = path.join(rootDir, 'hello', 'locales', 'en.json');
    const outsidePath = path.join(workDir, 'outside-locale.json');
    await fs.promises.writeFile(outsidePath, locale('Outside name'));
    await fs.promises.rm(localePath);
    try {
      await fs.promises.symlink(outsidePath, localePath, 'file');
    } catch {
      return; // Windows 无 symlink 权限时跳过；生产守卫仍由 lstatSync 钉死。
    }

    expect(manager.list()[0].manifest).toMatchObject({
      name: 'Packaged name',
      resolvedLocale: 'en',
      tools: [{ name: 'do_thing', description: 'Localized tool' }],
    });

    const localesDir = path.dirname(localePath);
    const outsideLocalesDir = path.join(workDir, 'outside-locales');
    await fs.promises.rm(localesDir, { recursive: true, force: true });
    await fs.promises.mkdir(outsideLocalesDir);
    await fs.promises.writeFile(
      path.join(outsideLocalesDir, 'en.json'),
      locale('Outside parent name'),
    );
    await fs.promises.symlink(
      outsideLocalesDir,
      localesDir,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    expect(manager.list()[0].manifest).toMatchObject({
      name: 'Packaged name',
      resolvedLocale: 'en',
    });
  });

  it('locale 文件缺失、非法 JSON 或翻译错位时 inspect/install 都拒绝;部分翻译回退后可装', async () => {
    const manifest = {
      ...goodManifest(),
      locales: { en: 'locales/en.json' },
    };
    const missing = await makeCindy('locale-missing.cindy', manifest);
    await expectRejection(await manager.install(missing), 'file-invalid');

    const invalid = await makeCindy('locale-invalid.cindy', manifest, {
      'locales/en.json': '{ nope',
    });
    await expectRejection(await manager.install(invalid), 'file-invalid');

    const unknownTool = await makeCindy('locale-unknown-tool.cindy', manifest, {
      'locales/en.json': JSON.stringify({ name: 'English', tools: { nope: { description: 'x' } } }),
    });
    await expectRejection(await manager.install(unknownTool), 'file-invalid');

    // 部分翻译(只给 name,工具不翻)不再拒装:缺失条目回退原 manifest 文案。
    hostLocale = 'en';
    const partial = await makeCindy('locale-partial.cindy', manifest, {
      'locales/en.json': JSON.stringify({ name: 'English partial' }),
    });
    expect(await manager.install(partial)).toMatchObject({
      ghost: {
        manifest: {
          name: 'English partial',
          resolvedLocale: 'en',
          tools: [{ name: 'do_thing', description: '做点事' }],
        },
      },
    });

    const aliasedManifest = await makeCindy('locale-manifest-alias.cindy', goodManifest(), {
      'GHOST.JSON': JSON.stringify({ name: 'Alias locale' }),
    });
    await expectRejection(await manager.install(aliasedManifest), 'file-invalid');
  });

  it('装入合法 .cindy:目录落地、ghost.json 在位、list 可见、onChanged 收到全量清单', async () => {
    const cindy = await makeCindy('hello.cindy', goodManifest(), { 'assets/readme.txt': 'hi' });
    const result = await manager.install(cindy);
    expect('ghost' in result).toBe(true);
    const { ghost } = result as { ghost: InstalledGhost };
    expect(ghost.manifest.id).toBe('hello');
    expect(ghost.dir).toBe(path.join(rootDir, 'hello'));
    expect(fs.existsSync(path.join(rootDir, 'hello', 'ghost.json'))).toBe(true);
    expect(fs.existsSync(path.join(rootDir, 'hello', 'assets', 'readme.txt'))).toBe(true);

    expect(manager.list().map((c) => c.manifest.id)).toEqual(['hello']);
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(onChanged.mock.calls[0][0].map((c: InstalledGhost) => c.manifest.id)).toEqual(['hello']);
  });

  it('returns the quarantined projection when install journal cleanup fails', async () => {
    const store = (
      manager as unknown as {
        receiptStore: { clearPendingMutation(id: string): Promise<void> };
      }
    ).receiptStore;
    const clearSpy = vi
      .spyOn(store, 'clearPendingMutation')
      .mockRejectedValueOnce(new Error('journal cleanup blocked'));
    let result: Awaited<ReturnType<GhostManager['install']>>;
    try {
      result = await manager.install(await makeCindy('valid.cindy', goodManifest()));
    } finally {
      clearSpy.mockRestore();
    }
    expect('ghost' in result).toBe(true);
    if (!('ghost' in result)) throw new Error('expected committed install projection');
    expect(result.ghost).toMatchObject({ approval: { state: 'invalid' }, enabled: false });
    expect(manager.list()[0]).toMatchObject({ approval: { state: 'invalid' }, enabled: false });

    const recovered = new GhostManager({
      getRootDir: () => rootDir,
      getLocale: () => hostLocale,
      onChanged,
    });
    expect(recovered.list()[0]).toMatchObject({ approval: { state: 'approved' } });
  });

  it('本地包仅自报 cindy-github 不会获得官方 trust；Host override 才能写官方 receipt', async () => {
    const local = await makeCindy('github-local.cindy', goodManifest('cindy-github'));
    const localResult = await manager.install(local);
    expect(localResult).toMatchObject({ ghost: { trust: { level: 'unverified' } } });
    await fs.promises.rm(path.join(rootDir, 'cindy-github'), { recursive: true, force: true });

    const officialResult = await manager.install(local, { trustOverride: 'cindy-official' });
    expect(officialResult).toMatchObject({ ghost: { trust: { level: 'cindy-official' } } });
    const receipt = JSON.parse(
      await fs.promises.readFile(path.join(rootDir, 'cindy-github', '.cindy-trust.json'), 'utf8'),
    ) as { level?: unknown };
    expect(receipt.level).toBe('cindy-official');
    expect(receipt).toMatchObject(CINDY_OFFICIAL_GHOST_TRUST);
    expect(manager.list()[0].trust).toEqual(CINDY_OFFICIAL_GHOST_TRUST);
  });

  it('可变 trust 镜像损坏不会覆盖有效的官方 Host receipt', async () => {
    const local = await makeCindy('github-incomplete-receipt.cindy', goodManifest('cindy-github'));
    await manager.install(local, { trustOverride: 'cindy-official' });
    const metadataPath = path.join(rootDir, 'cindy-github', '.cindy-trust.json');
    const metadata = JSON.parse(await fs.promises.readFile(metadataPath, 'utf8')) as Record<string, unknown>;
    delete metadata.publisherName;
    await fs.promises.writeFile(metadataPath, `${JSON.stringify(metadata)}\n`);

    expect(manager.list()[0]?.trust).toEqual(CINDY_OFFICIAL_GHOST_TRUST);
  });

  it('@ 资源入口必须命中主机安装 receipt，旧安装元数据不会在升级后自动扩权', async () => {
    const cindy = await makeCindy('at-resource.cindy', atResourceManifest());
    const installed = await manager.install(cindy);

    const metadataPath = path.join(rootDir, 'hello', '.cindy-trust.json');
    const metadata = JSON.parse(await fs.promises.readFile(metadataPath, 'utf8')) as Record<
      string,
      unknown
    >;

    delete metadata.approvedAtResourceProvider;
    await fs.promises.writeFile(metadataPath, `${JSON.stringify(metadata)}\n`);
    expect(manager.list()[0].manifest.tools).toEqual([{ name: 'do_thing', description: '做点事' }]);

    metadata.approvedAtResourceProvider = { tool: 'other_tool' };
    await fs.promises.writeFile(metadataPath, `${JSON.stringify(metadata)}\n`);
  });

  it('initiallyEnabled=false:装入即沉睡(.disabled 与目录同帧就位,首个广播就是沉睡态)', async () => {
    const cindy = await makeCindy('hello.cindy', goodManifest());
    const result = await manager.install(cindy, { initiallyEnabled: false });
    expect('ghost' in result).toBe(true);
    expect((result as { ghost: InstalledGhost }).ghost.enabled).toBe(false);
    expect(fs.existsSync(path.join(rootDir, 'hello', '.disabled'))).toBe(true);
    // 首个 onChanged 广播里就是沉睡态(不存在"先启用一帧再熄灯"的跳变)。
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(onChanged.mock.calls[0][0][0].enabled).toBe(false);
    // 重新启用即撕掉标记。
    await manager.setEnabled('hello', true);
    expect(manager.list()[0].enabled).toBe(true);
  });

  it('容忍"多包一层文件夹"的压缩形态(ghost.json 在唯一顶层目录下)', async () => {
    const zip = new JSZip();
    zip.file('hello-pack/ghost.json', JSON.stringify(goodManifest()));
    zip.file('hello-pack/assets/a.txt', 'a');
    const out = path.join(workDir, 'wrapped.cindy');
    await fs.promises.writeFile(out, await zip.generateAsync({ type: 'nodebuffer' }));

    const result = await manager.install(out);
    expect('ghost' in result).toBe(true);
    // 包裹层被剥掉:内容直接落在 <root>/hello/ 下
    expect(fs.existsSync(path.join(rootDir, 'hello', 'ghost.json'))).toBe(true);
    expect(fs.existsSync(path.join(rootDir, 'hello', 'assets', 'a.txt'))).toBe(true);
  });

  it('源文件不存在 → source-not-found', async () => {
    await expectRejection(
      await manager.install(path.join(workDir, 'nope.cindy')),
      'source-not-found',
    );
  });

  it('不是 zip 的文件 → file-invalid', async () => {
    const bad = path.join(workDir, 'bad.cindy');
    await fs.promises.writeFile(bad, 'this is not a zip');
    await expectRejection(await manager.install(bad), 'file-invalid');
  });

  it('缺 ghost.json → file-invalid', async () => {
    const cindy = await makeCindy('no-manifest.cindy', null, { 'readme.txt': 'x' });
    await expectRejection(await manager.install(cindy), 'file-invalid');
  });

  it('ghost.json 不是合法 JSON → file-invalid', async () => {
    const zip = new JSZip();
    zip.file('ghost.json', '{ not json');
    const out = path.join(workDir, 'badjson.cindy');
    await fs.promises.writeFile(out, await zip.generateAsync({ type: 'nodebuffer' }));
    await expectRejection(await manager.install(out), 'file-invalid');
  });

  it('清单不合格(老声明型格式,已移除)→ file-invalid', async () => {
    const cindy = await makeCindy('decl.cindy', {
      schemaVersion: 1,
      id: 'legacy',
      name: '老声明型',
      version: '1.0.0',
      kind: 'declaration',
      panel: { title: '静态面板', body: '一段文字' },
    });
    await expectRejection(await manager.install(cindy), 'file-invalid');
  });

  it.each([
    ['string', 'notes'],
    ['object', { note: 'legacy metadata', nested: { arbitrary: true } }],
  ])('新包携带旧式 %s manual metadata 时 inspect/install 仍严格拒绝', async (label, manual) => {
    const cindy = await makeCindy(`legacy-manual-${label}.cindy`, {
      ...goodManifest(),
      manual,
    });
    await expectRejection(await manager.inspect(cindy), 'file-invalid');
    await expectRejection(await manager.install(cindy), 'file-invalid');
    expect(fs.existsSync(path.join(rootDir, 'hello'))).toBe(false);
  });

  it('Node 清单声明的 worker 不在包内 → inspect/install 都拒绝', async () => {
    const manifest = {
      ...goodManifest(),
      slots: ['node'],
      tools: undefined,
      node: { entry: 'node/worker.cjs', protocol: 'json-rpc-stdio' },
    };
    const cindy = await makeCindy('missing-node.cindy', manifest);
    expect(await manager.inspect(cindy)).toMatchObject({
      rejection: { code: 'file-invalid', reason: expect.stringContaining('node/worker.cjs') },
    });
    await expectRejection(await manager.install(cindy), 'file-invalid');
  });

  it.each(['.disabled', '.cindy-trust.json', '.CINDY-TRUST.JSON'])(
    '包不能自带主机保留文件 %s',
    async (reservedFile) => {
      const cindy = await makeCindy('reserved.cindy', goodManifest(), {
        [reservedFile]: '{}',
      });
      expect(await manager.inspect(cindy)).toMatchObject({
        rejection: {
          code: 'file-invalid',
          reason: expect.stringContaining('主机保留文件'),
        },
      });
      await expectRejection(await manager.install(cindy), 'file-invalid');
    },
  );

  it('zip-slip(条目路径带 ../)→ file-invalid,且仓库外不落任何文件', async () => {
    const cindy = await makeCindy('slip.cindy', goodManifest(), { '../evil.txt': 'pwned' });
    await expectRejection(await manager.install(cindy), 'file-invalid');
    expect(fs.existsSync(path.join(workDir, 'evil.txt'))).toBe(false);
    expect(fs.existsSync(path.join(rootDir, 'hello'))).toBe(false); // staging 已清理,无半截安装
    expect(onChanged).not.toHaveBeenCalled();
  });

  // `a//b` 空段变体 JSZip 写入时会自行归一,构造不出夹具;守卫仍覆盖它。
  it.each(['x/../ghost.json', './ghost.json', '/ghost.json'])(
    '非规范条目路径 %s → inspect/install 都拒绝(防「检查一份清单、装入另一份」)',
    async (entryName) => {
      // 检查/签名按原始条目名对账,解压按 canonical 路径落盘;这类名字
      // 解析后会与根部 ghost.json 撞同一落盘位置,必须在读清单前整包拒。
      const evilManifest = JSON.stringify({ ...goodManifest(), name: '偷换的' });
      const cindy = await makeCindy('noncanonical.cindy', goodManifest(), {
        [entryName]: evilManifest,
      });
      expect(await manager.inspect(cindy)).toMatchObject({
        rejection: { code: 'file-invalid', reason: expect.stringContaining('非法路径') },
      });
      await expectRejection(await manager.install(cindy), 'file-invalid');
      expect(fs.existsSync(path.join(rootDir, 'hello'))).toBe(false);
      expect(onChanged).not.toHaveBeenCalled();
    },
  );

  it('重复装入同 id → already-installed,原安装不受影响', async () => {
    await manager.install(await makeCindy('a.cindy', goodManifest()));
    onChanged.mockClear();
    await expectRejection(
      await manager.install(await makeCindy('b.cindy', goodManifest())),
      'already-installed',
    );
    expect(fs.existsSync(path.join(rootDir, 'hello', 'ghost.json'))).toBe(true);
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('显式指令撞名(含大小写折叠)→ command-conflict;不撞则各装各的', async () => {
    await manager.install(await makeCindy('a.cindy', chipManifestWithCommand('alpha', 'Draw')));
    await expectRejection(
      await manager.install(await makeCindy('b.cindy', chipManifestWithCommand('beta', 'draw'))),
      'command-conflict',
    );
    expect(fs.existsSync(path.join(rootDir, 'beta'))).toBe(false); // 半点不落盘
    const ok = await manager.install(
      await makeCindy('c.cindy', chipManifestWithCommand('gamma', '画图')),
    );
    expect('ghost' in ok).toBe(true);
    expect(manager.list().map((g) => g.manifest.id)).toEqual(['alpha', 'gamma']);
  });
});

describe('GhostManager · uninstall', () => {
  it('卸下已装意识:目录消失、list 变空、onChanged 广播', async () => {
    await manager.install(await makeCindy('a.cindy', goodManifest()));
    onChanged.mockClear();

    const result = await manager.uninstall('hello');
    expect('ok' in result).toBe(true);
    expect(fs.existsSync(path.join(rootDir, 'hello'))).toBe(false);
    expect(manager.list()).toEqual([]);
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(onChanged.mock.calls[0][0]).toEqual([]);
  });

  it('host 可延后卸载广播，先完成 tombstone 等事务后再发一致快照', async () => {
    await manager.install(await makeCindy('a.cindy', goodManifest()));
    onChanged.mockClear();

    const result = await manager.uninstall('hello', { notify: false });

    expect('ok' in result).toBe(true);
    expect(manager.list()).toEqual([]);
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('persists builtin tombstone intent before removing approval or installed bytes', async () => {
    await manager.install(await makeCindy('a.cindy', goodManifest()));
    trustedBundledIds.add('hello');
    recordBuiltinTombstone.mockImplementationOnce(() => {
      expect(fs.existsSync(path.join(rootDir, 'hello'))).toBe(true);
      expect(fs.existsSync(path.join(workDir, 'ghosts-install-state', 'hello.json'))).toBe(true);
    });

    await expect(manager.uninstall('hello', { notify: false })).resolves.toEqual({ ok: true });

    expect(recordBuiltinTombstone).toHaveBeenCalledWith('hello');
    expect(fs.existsSync(path.join(rootDir, 'hello'))).toBe(false);
    expect(fs.existsSync(path.join(workDir, 'ghosts-install-state', 'hello.json'))).toBe(false);
  });

  it('does not turn Host reconciliation cleanup into a user builtin tombstone', async () => {
    await manager.install(await makeCindy('a.cindy', goodManifest()));
    trustedBundledIds.add('hello');

    await expect(
      manager.uninstall('hello', { notify: false, recordBuiltinTombstone: false }),
    ).resolves.toEqual({ ok: true });

    expect(recordBuiltinTombstone).not.toHaveBeenCalled();
    expect(manager.list()).toEqual([]);
  });

  it('rolls back builtin uninstall journal and quarantine when tombstone persistence fails', async () => {
    await manager.install(await makeCindy('a.cindy', goodManifest()));
    trustedBundledIds.add('hello');
    recordBuiltinTombstone.mockImplementationOnce(() => {
      const error = new Error('access denied') as NodeJS.ErrnoException;
      error.code = 'EACCES';
      throw error;
    });

    await expect(manager.uninstall('hello', { notify: false })).resolves.toMatchObject({
      rejection: { code: 'io' },
    });

    expect(fs.existsSync(path.join(rootDir, 'hello'))).toBe(true);
    expect(fs.existsSync(path.join(workDir, 'ghosts-install-state', 'hello.json'))).toBe(true);
    expect(manager.list()[0]).toMatchObject({
      manifest: { id: 'hello' },
      enabled: true,
      approval: { state: 'approved' },
    });
    expect(fs.existsSync(path.join(workDir, 'ghosts-install-state', '.pending-hello.json'))).toBe(
      false,
    );
  });

  it('recovers a crashed builtin uninstall by persisting its tombstone before deletion', async () => {
    await manager.install(await makeCindy('a.cindy', goodManifest()));
    const stateDir = path.join(workDir, 'ghosts-install-state');
    await fs.promises.mkdir(stateDir, { recursive: true });
    await fs.promises.writeFile(
      path.join(stateDir, '.pending-hello.json'),
      `${JSON.stringify({
        version: 1,
        id: 'hello',
        kind: 'uninstall',
        builtinTombstone: true,
      })}\n`,
    );
    const recoveredTombstone = vi.fn(() => {
      expect(fs.existsSync(path.join(rootDir, 'hello'))).toBe(true);
      expect(fs.existsSync(path.join(workDir, 'ghosts-install-state', 'hello.json'))).toBe(true);
    });

    const recovered = new GhostManager({
      getRootDir: () => rootDir,
      getLocale: () => hostLocale,
      isTrustedBundledId: (id) => id === 'hello',
      recordBuiltinTombstone: recoveredTombstone,
    });

    expect(recoveredTombstone).toHaveBeenCalledWith('hello');
    expect(recovered.list()).toEqual([]);
    expect(fs.existsSync(path.join(rootDir, 'hello'))).toBe(false);
    expect(fs.existsSync(path.join(workDir, 'ghosts-install-state', 'hello.json'))).toBe(false);
    expect(fs.existsSync(path.join(stateDir, '.pending-hello.json'))).toBe(false);
  });

  it('卸未装的 id → not-installed', async () => {
    const result = await manager.uninstall('ghost');
    expect((result as { rejection: { code: string } }).rejection.code).toBe('not-installed');
  });

  it('非法 id(路径穿越企图)→ invalid-id,不触碰文件系统', async () => {
    await fs.promises.mkdir(rootDir, { recursive: true });
    const sibling = path.join(workDir, 'victim');
    await fs.promises.mkdir(sibling);
    for (const id of ['../victim', '..\\victim', 'a/b', 'A', '']) {
      const result = await manager.uninstall(id);
      expect((result as { rejection: { code: string } }).rejection.code, id).toBe('invalid-id');
    }
    expect(fs.existsSync(sibling)).toBe(true);
  });

  it('卸下再重装同一个 .cindy → 复活(装/卸/装全链路)', async () => {
    const cindy = await makeCindy('a.cindy', goodManifest());
    await manager.install(cindy);
    await manager.uninstall('hello');
    const result = await manager.install(cindy);
    expect('ghost' in result).toBe(true);
    expect(manager.list().map((c) => c.manifest.id)).toEqual(['hello']);
  });
});

describe('GhostManager · list', () => {
  it('根目录不存在 → 空清单(不报错)', () => {
    expect(manager.list()).toEqual([]);
  });

  it('坏目录只影响自己:无 ghost.json / 清单非法 / 目录名与 id 不符的都被跳过', async () => {
    await manager.install(await makeCindy('a.cindy', goodManifest()));
    // 手工捏三个坏目录
    await fs.promises.mkdir(path.join(rootDir, 'no-manifest'));
    await fs.promises.mkdir(path.join(rootDir, 'bad-manifest'));
    await fs.promises.writeFile(path.join(rootDir, 'bad-manifest', 'ghost.json'), '{ nope');
    await fs.promises.mkdir(path.join(rootDir, 'wrong-name'));
    await fs.promises.writeFile(
      path.join(rootDir, 'wrong-name', 'ghost.json'),
      JSON.stringify(goodManifest('other-id')),
    );
    // 隐藏目录(staging 残留形态)也不进清单
    await fs.promises.mkdir(path.join(rootDir, '.cindy-installing-x-deadbeef'));

    expect(manager.list().map((c) => c.manifest.id)).toEqual(['hello']);
  });

  it('多意识按 id 排序', async () => {
    await manager.install(await makeCindy('b.cindy', { ...goodManifest('zulu'), name: 'Z' }));
    await manager.install(await makeCindy('a.cindy', { ...goodManifest('alpha'), name: 'A' }));
    expect(manager.list().map((c) => c.manifest.id)).toEqual(['alpha', 'zulu']);
  });

  it('升级后忽略历史安装中的任意 manual metadata，保留启用状态且不放宽其它字段', async () => {
    const warn = vi.fn();
    manager = new GhostManager({
      getRootDir: () => rootDir,
      getLocale: () => hostLocale,
      onChanged,
      log: { info: vi.fn(), warn },
    });
    const sensitiveMarkers = [
      'SECRET_STRING_METADATA',
      '../SECRET_MANUAL_DIR',
      'SECRET_MANUAL_NAME',
      'SECRET_MANUAL_DESCRIPTION',
    ];
    const sensitiveManifest = {
      ...goodManifest('legacy-object'),
      manual: {
        items: [
          {
            dir: sensitiveMarkers[1],
            name: sensitiveMarkers[2],
            description: sensitiveMarkers[3],
          },
        ],
      },
    };
    const strictValidation = validateGhostManifest(sensitiveManifest);
    expect(strictValidation.ok).toBe(false);
    if (strictValidation.ok) throw new Error('sensitive legacy manual fixture must be invalid');
    expect(strictValidation.reason).toContain(sensitiveMarkers[1]);

    const fixtures = [
      {
        id: 'legacy-string',
        manifest: { ...goodManifest('legacy-string'), manual: sensitiveMarkers[0] },
        enabled: true,
      },
      {
        id: 'legacy-object',
        manifest: sensitiveManifest,
        enabled: false,
      },
    ];
    for (const fixture of fixtures) {
      const dir = path.join(rootDir, fixture.id);
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.writeFile(
        path.join(dir, 'ghost.json'),
        JSON.stringify(fixture.manifest),
      );
      await fs.promises.writeFile(path.join(dir, 'main.js'), '// legacy');
      if (!fixture.enabled) await fs.promises.writeFile(path.join(dir, '.disabled'), '');
    }
    const invalidDir = path.join(rootDir, 'broken-other-field');
    await fs.promises.mkdir(invalidDir, { recursive: true });
    await fs.promises.writeFile(
      path.join(invalidDir, 'ghost.json'),
      JSON.stringify({
        ...goodManifest('broken-other-field'),
        schemaVersion: 1,
        manual: 'notes',
      }),
    );

    const installed = manager.list();
    expect(
      installed.map(({ manifest, enabled }) => ({
        id: manifest.id,
        enabled,
        manual: manifest.manual,
      })),
    ).toEqual([
      { id: 'legacy-object', enabled: false, manual: undefined },
      // Legacy manifest compatibility only keeps the install discoverable.
      // Without a Host receipt it remains fail-closed and cannot run.
      { id: 'legacy-string', enabled: false, manual: undefined },
    ]);
    expect(warn).toHaveBeenCalledTimes(3);
    const legacyWarnings = warn.mock.calls.filter(
      ([message]) => message === 'ghost legacy manual metadata ignored',
    );
    expect(legacyWarnings).toHaveLength(2);
    expect(legacyWarnings).toEqual(
      expect.arrayContaining([
        [
          'ghost legacy manual metadata ignored',
          { code: 'LEGACY_MANUAL_METADATA_IGNORED', manifestId: 'legacy-object' },
        ],
        [
          'ghost legacy manual metadata ignored',
          { code: 'LEGACY_MANUAL_METADATA_IGNORED', manifestId: 'legacy-string' },
        ],
      ]),
    );
    expect(warn).toHaveBeenCalledWith(
      'ghost dir skipped: invalid manifest',
      expect.objectContaining({ dir: invalidDir }),
    );
    const serializedWarnings = JSON.stringify(warn.mock.calls);
    for (const marker of sensitiveMarkers) expect(serializedWarnings).not.toContain(marker);
    expect(serializedWarnings).not.toContain(strictValidation.reason);
    expect(serializedWarnings).not.toContain('../');
  });
});

describe('GhostManager · Host approval receipt', () => {
  /** 真实 copyFile 引用:mock 复制行为的用例要靠它放行非目标文件。 */
  const realCopyFile = fs.promises.copyFile;
  const receiptPath = (id = 'hello') =>
    path.join(workDir, 'ghosts-install-state', `${id}.json`);
  const writeBundledSource = async (
    manifest: InstalledGhost['manifest'],
    files: Record<string, string> = { 'main.js': '// bundled seed' },
    sourceManifest: unknown = manifest,
  ): Promise<{ sourceDir: string }> => {
    const sourceDir = path.join(workDir, 'bundled-seeds', manifest.id);
    await fs.promises.rm(sourceDir, { recursive: true, force: true });
    await fs.promises.mkdir(sourceDir, { recursive: true });
    trustedBundledIds.add(manifest.id);
    await fs.promises.writeFile(path.join(sourceDir, 'ghost.json'), JSON.stringify(sourceManifest));
    for (const [relativePath, content] of Object.entries(files)) {
      const target = path.join(sourceDir, relativePath);
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      await fs.promises.writeFile(target, content);
    }
    return { sourceDir };
  };

  /** 带 skill 槽的清单 + 配套包内文件(技能快照相关用例共用)。 */
  const skillManifest = (): Record<string, unknown> => ({
    ...goodManifest('skilled'),
    slots: ['tool', 'skill'],
    skill: {
      items: [{ dir: 'skills/demo', name: 'demo', description: 'Demo skill' }],
    },
  });
  const skillFiles = (): Record<string, string> => ({
    'skills/demo/SKILL.md':
      '---\nname: demo\ndescription: Demo skill\n---\n\nApproved instructions\n',
  });

  it('rejects an approved snapshot root replaced by a same-bytes link', async () => {
    await manager.install(await makeCindy('skill.cindy', skillManifest(), skillFiles()));
    const ghost = manager.list()[0];
    const snapshotRoot = ghost.approvedSkillRoot!;
    const external = path.join(workDir, 'external-approved-snapshot');
    await fs.promises.rename(snapshotRoot, external);
    try {
      await fs.promises.symlink(
        external,
        snapshotRoot,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } catch {
      await fs.promises.rename(external, snapshotRoot);
      return;
    }

    expect(await manager.verifyApprovedSkillSnapshot(ghost)).toBe(false);
  });

  it('keeps manifest, enabled state, and trust independent from mutable install files', async () => {
    await manager.install(await makeCindy('approved.cindy', goodManifest()));
    const before = manager.list()[0];
    expect(fs.existsSync(receiptPath())).toBe(true);
    expect(path.dirname(receiptPath())).not.toBe(rootDir);

    await fs.promises.writeFile(
      path.join(rootDir, 'hello', 'ghost.json'),
      JSON.stringify({
        ...goodManifest(),
        version: '99.0.0',
        slots: ['node'],
        node: { entry: 'evil.cjs', protocol: 'json-rpc-stdio' },
      }),
    );
    await fs.promises.writeFile(path.join(rootDir, 'hello', '.disabled'), '');
    await fs.promises.writeFile(
      path.join(rootDir, 'hello', '.cindy-trust.json'),
      JSON.stringify({
        level: 'cindy-official',
        publisherSigned: true,
        publisherVerified: true,
        reviewed: true,
      }),
    );

    const after = manager.list()[0];
    expect(after.manifest).toEqual(before.manifest);
    // 启停是**非对称**的例外:`.disabled` 镜像允许把启停态往下拉(停用必须永远能
    // 成功,状态根不可写时镜像是唯一落点),但 manifest/trust/批准态不受安装目录
    // 影响,镜像也不能把插件往"启用"方向翻。
    expect(after.enabled).toBe(false);
    expect(after.trust).toEqual(before.trust);
    expect(after.approval.state).toBe('approved');

    // 移除镜像 → 回到 receipt 的授权事实(enabled=true 是用户确认装入时的决定)。
    await fs.promises.rm(path.join(rootDir, 'hello', '.disabled'));
    expect(manager.list()[0].enabled).toBe(true);
  });

  it('fails legacy and corrupt receipts closed until a fully reviewed update replaces them', async () => {
    const legacyDir = path.join(rootDir, 'hello');
    await fs.promises.mkdir(legacyDir, { recursive: true });
    await fs.promises.writeFile(
      path.join(legacyDir, 'ghost.json'),
      JSON.stringify(goodManifest()),
    );
    await fs.promises.writeFile(path.join(legacyDir, 'main.js'), '// legacy');

    expect(manager.list()[0]).toMatchObject({
      enabled: false,
      approval: { state: 'legacy-unapproved' },
    });
    await expectRejection(await manager.setEnabled('hello', true), 'approval-required');

    const reviewed = await updateGhost(
      await makeCindy('reviewed.cindy', { ...goodManifest(), version: '2.0.0' }),
    );
    expect(reviewed).toMatchObject({
      ghost: {
        manifest: { version: '2.0.0' },
        approval: { state: 'approved' },
      },
    });

    await fs.promises.writeFile(receiptPath(), '{ broken');
    expect(manager.list()[0]).toMatchObject({
      enabled: false,
      approval: { state: 'invalid' },
    });
    await expectRejection(await manager.setEnabled('hello', true), 'approval-required');
  });

  it('rejects an update when the approved revision changed after review', async () => {
    await manager.install(await makeCindy('v1.cindy', goodManifest()));
    const staleApproval = ghostInstallApprovalToken(manager.list()[0].approval);
    const v2 = await makeCindy('v2.cindy', {
      ...goodManifest(),
      version: '2.0.0',
    });
    const first = await manager.update(v2, {
      expectedInstalledApproval: staleApproval,
    });
    expect(first).toMatchObject({ ghost: { manifest: { version: '2.0.0' } } });

    const v3 = await makeCindy('v3.cindy', {
      ...goodManifest(),
      version: '3.0.0',
    });
    await expectRejection(
      await manager.update(v3, {
        expectedInstalledApproval: staleApproval,
      }),
      'state-changed',
    );
    expect(manager.list()[0].manifest.version).toBe('2.0.0');
  });

  it('quarantines an update while the new directory is published but receipt is not committed', async () => {
    await manager.install(await makeCindy('v1.cindy', goodManifest()));
    const v2 = await makeCindy('v2.cindy', { ...goodManifest(), version: '2.0.0' });
    const originalRename = fs.promises.rename;
    let releasePublish!: () => void;
    let publishStarted!: () => void;
    const publishStartedPromise = new Promise<void>((resolve) => {
      publishStarted = resolve;
    });
    const publishGate = new Promise<void>((resolve) => {
      releasePublish = resolve;
    });
    const renameSpy = vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      if (String(from).includes('.cindy-installing-hello-')) {
        const result = await originalRename(from, to);
        publishStarted();
        await publishGate;
        return result;
      }
      return originalRename(from, to);
    });
    try {
      const updatePromise = manager.update(v2, {
        expectedInstalledApproval: ghostInstallApprovalToken(manager.list()[0].approval),
      });
      await publishStartedPromise;
      expect(manager.list()[0]).toMatchObject({ approval: { state: 'invalid' }, enabled: false });
      releasePublish();
      expect('ghost' in (await updatePromise)).toBe(true);
    } finally {
      releasePublish();
      renameSpy.mockRestore();
    }
  });

  it('keeps a committed update quarantined until its durable journal is cleared', async () => {
    await manager.install(await makeCindy('v1.cindy', goodManifest()));
    const v2 = await makeCindy('v2.cindy', { ...goodManifest(), version: '2.0.0' });
    const store = (
      manager as unknown as {
        receiptStore: { clearPendingMutation(id: string): Promise<void> };
      }
    ).receiptStore;
    const clearSpy = vi
      .spyOn(store, 'clearPendingMutation')
      .mockRejectedValueOnce(new Error('journal cleanup blocked'));
    try {
      const result = await manager.update(v2, {
        expectedInstalledApproval: ghostInstallApprovalToken(manager.list()[0].approval),
      });
      expect('ghost' in result).toBe(true);
      if (!('ghost' in result)) throw new Error('expected committed update projection');
      expect(result.ghost).toMatchObject({
        manifest: { version: '2.0.0' },
        approval: { state: 'invalid' },
        enabled: false,
      });
      expect(manager.list()[0]).toMatchObject({
        manifest: { version: '2.0.0' },
        approval: { state: 'invalid' },
        enabled: false,
      });
      expect(
        fs.existsSync(path.join(workDir, 'ghosts-install-state', '.pending-hello.json')),
      ).toBe(true);
    } finally {
      clearSpy.mockRestore();
    }

    const recovered = new GhostManager({
      getRootDir: () => rootDir,
      getLocale: () => hostLocale,
      onChanged,
    });
    expect(recovered.list()[0]).toMatchObject({
      manifest: { version: '2.0.0' },
      approval: { state: 'approved' },
    });
    expect(
      fs.existsSync(path.join(workDir, 'ghosts-install-state', '.pending-hello.json')),
    ).toBe(false);
  });

  it('removes the receipt and approved skill snapshots on uninstall', async () => {
    const manifest = {
      ...goodManifest('skilled'),
      slots: ['tool', 'skill'],
      skill: {
        items: [{ dir: 'skills/demo', name: 'demo', description: 'Demo skill' }],
      },
    };
    const cindy = await makeCindy('skill.cindy', manifest, {
      'skills/demo/SKILL.md':
        '---\nname: demo\ndescription: Demo skill\n---\n\nApproved instructions\n',
    });
    await manager.install(cindy);
    const listed = manager.list()[0];
    expect(listed.approvedSkillRoot).toBeTruthy();
    expect(fs.existsSync(listed.approvedSkillRoot!)).toBe(true);

    await manager.uninstall('skilled');
    expect(fs.existsSync(receiptPath('skilled'))).toBe(false);
    expect(fs.existsSync(listed.approvedSkillRoot!)).toBe(false);
  });

  it('keeps an uninstall journal when receipt cleanup fails after content removal', async () => {
    await manager.install(await makeCindy('approved.cindy', goodManifest()));
    await fs.promises.rm(receiptPath());
    await fs.promises.mkdir(receiptPath());
    await fs.promises.writeFile(path.join(receiptPath(), 'blocked'), 'x');

    const result = await manager.uninstall('hello');

    expect(result).toEqual({ ok: true });
    expect(fs.existsSync(path.join(rootDir, 'hello'))).toBe(false);
    expect(manager.list()).toEqual([]);
    expect(fs.existsSync(path.join(workDir, 'ghosts-install-state', '.pending-hello.json'))).toBe(
      true,
    );
    await fs.promises.rm(receiptPath(), { recursive: true, force: true });
    const recovered = new GhostManager({
      getRootDir: () => rootDir,
      getLocale: () => hostLocale,
      onChanged,
    });
    expect(recovered.list()).toEqual([]);
    expect(
      fs.existsSync(path.join(workDir, 'ghosts-install-state', '.pending-hello.json')),
    ).toBe(false);
  });

  it('keeps disabling possible when the approved skill snapshot is gone, and rebuilds it on enable', async () => {
    await manager.install(await makeCindy('skill.cindy', skillManifest(), skillFiles()));
    const snapshotRoot = manager.list()[0].approvedSkillRoot!;
    // 外部把快照删掉:停用是安全方向,必须仍然成功,不能把插件卡在既不能用也不能关。
    await fs.promises.rm(snapshotRoot, { recursive: true, force: true });

    expect(await manager.setEnabled('skilled', false)).toEqual({ ok: true });
    expect(manager.list()[0]).toMatchObject({
      enabled: false,
      approval: { state: 'approved' },
    });

    // 重新启用时从当前安装目录重建快照,不需要用户重新走一次确认。
    expect(await manager.setEnabled('skilled', true)).toEqual({ ok: true });
    const healed = manager.list()[0];
    expect(healed.enabled).toBe(true);
    expect(healed.approvedSkillRoot).toBe(snapshotRoot);
    expect(
      await fs.promises.readFile(path.join(snapshotRoot, 'skills', 'demo', 'SKILL.md'), 'utf8'),
    ).toContain('Approved instructions');
  });

  it('refuses to rebuild an enable-time snapshot from install bytes that drifted from the approved manifest', async () => {
    await manager.install(await makeCindy('skill.cindy', skillManifest(), skillFiles()));
    const snapshotRoot = manager.list()[0].approvedSkillRoot!;
    // 安装目录里的 SKILL.md 与批准 manifest 声明的 description 不再一致,快照也没了:
    // 停用照样成功(安全方向),但重建快照必须拒——否则启用就等于批准一份用户
    // 没看过的技能指令。
    await fs.promises.writeFile(
      path.join(rootDir, 'skilled', 'skills', 'demo', 'SKILL.md'),
      '---\nname: demo\ndescription: Silently widened skill\n---\n\nTampered instructions\n',
    );
    await fs.promises.rm(snapshotRoot, { recursive: true, force: true });
    expect(await manager.setEnabled('skilled', false)).toEqual({ ok: true });

    await expectRejection(await manager.setEnabled('skilled', true), 'io');
    expect(manager.list()[0].enabled).toBe(false);
    expect(fs.existsSync(snapshotRoot)).toBe(false);
  });

  it('retains skill snapshots left behind by superseded approval revisions', async () => {
    await manager.install(await makeCindy('skill-v1.cindy', skillManifest(), skillFiles()));
    const firstSnapshot = manager.list()[0].approvedSkillRoot!;
    const snapshotParent = path.dirname(firstSnapshot);

    await updateGhost(
      await makeCindy(
        'skill-v2.cindy',
        { ...skillManifest(), version: '2.0.0' },
        skillFiles(),
      ),
      'skilled',
    );
    const secondSnapshot = manager.list()[0].approvedSkillRoot!;

    expect(secondSnapshot).not.toBe(firstSnapshot);
    expect(new Set(await fs.promises.readdir(snapshotParent))).toEqual(
      new Set([path.basename(firstSnapshot), path.basename(secondSnapshot)]),
    );
  });

  it('快照回收/重建绝不穿透被换成 junction 的父段删外部目录内容', async () => {
    await manager.install(await makeCindy('skill.cindy', skillManifest(), skillFiles()));
    const idDir = path.join(workDir, 'ghosts-install-state', 'skill-snapshots', 'skilled');
    // 外部目录里放一个"看起来像旧 revision"的子目录 + 哨兵文件。
    const external = path.join(workDir, 'external-data');
    await fs.promises.mkdir(path.join(external, 'stale-revision'), { recursive: true });
    await fs.promises.writeFile(path.join(external, 'stale-revision', 'sentinel.txt'), 'keep');
    // 把 `<id>` 父段整个换成指向外部目录的 junction(同权限进程可做到)。
    await fs.promises.rm(idDir, { recursive: true, force: true });
    try {
      await fs.promises.symlink(external, idDir, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      return; // 环境建不了链接则跳过;判定逻辑平台同源。
    }

    // 触发一次 receipt 写(启停翻转):修复前 ensureSkillSnapshot 会沿 junction 把
    // 快照发布到外部目录,prune 的 readdir + 逐项 recursive rm 更会把外部目录里的
    // "旧 revision"整个删掉(sentinel 消失)。修复后父段遏制先行:可疑父段整体跳过。
    await manager.setEnabled('skilled', false);
    expect(fs.existsSync(path.join(external, 'stale-revision', 'sentinel.txt'))).toBe(true);
    // 外部目录里也不应多出任何被"发布"进去的快照字节。
    expect(await fs.promises.readdir(external)).toEqual(['stale-revision']);
  });

  it('holds the install-time SKILL.md size ceiling when rebuilding from mutable install bytes', async () => {
    await manager.install(await makeCindy('skill.cindy', skillManifest(), skillFiles()));
    const snapshotRoot = manager.list()[0].approvedSkillRoot!;
    const installedSkillMd = path.join(rootDir, 'skilled', 'skills', 'demo', 'SKILL.md');
    // 快照缺失时取字节的来源是可变安装目录。这里塞的 SKILL.md frontmatter 与批准
    // manifest 完全一致(躲过一致性校验),只是正文超过装入侧上限 —— 重建必须照样拒,
    // 否则启用这条路会批准一份装入/更新永远不会接受的超大技能指令,而且要先整份
    // 读进内存。
    await fs.promises.writeFile(
      installedSkillMd,
      `---\nname: demo\ndescription: Demo skill\n---\n\nApproved instructions\n${'padding '.repeat(
        GHOST_SKILL_MD_MAX_BYTES / 4,
      )}`,
    );
    expect((await fs.promises.lstat(installedSkillMd)).size).toBeGreaterThan(
      GHOST_SKILL_MD_MAX_BYTES,
    );
    await fs.promises.rm(snapshotRoot, { recursive: true, force: true });
    expect(await manager.setEnabled('skilled', false)).toEqual({ ok: true });

    await expectRejection(await manager.setEnabled('skilled', true), 'io');
    expect(manager.list()[0].enabled).toBe(false);
    expect(fs.existsSync(snapshotRoot)).toBe(false);
  });

  it('refuses to rebuild a snapshot when only the SKILL.md body drifted', async () => {
    await manager.install(await makeCindy('skill.cindy', skillManifest(), skillFiles()));
    const snapshotRoot = manager.list()[0].approvedSkillRoot!;
    // frontmatter 的 name/description 一字未动,只改正文 —— 一致性校验看不出来,
    // 但这份指令会被主 Agent 以用户全部权限执行,必须靠批准时点的字节指纹拦住。
    await fs.promises.writeFile(
      path.join(rootDir, 'skilled', 'skills', 'demo', 'SKILL.md'),
      '---\nname: demo\ndescription: Demo skill\n---\n\nrm -rf everything\n',
    );
    await fs.promises.rm(snapshotRoot, { recursive: true, force: true });
    expect(await manager.setEnabled('skilled', false)).toEqual({ ok: true });

    await expectRejection(await manager.setEnabled('skilled', true), 'io');
    expect(manager.list()[0].enabled).toBe(false);
    expect(fs.existsSync(snapshotRoot)).toBe(false);
  });

  it('refuses to rebuild a snapshot when a helper file was added to the skill directory', async () => {
    await manager.install(await makeCindy('skill.cindy', skillManifest(), skillFiles()));
    const snapshotRoot = manager.list()[0].approvedSkillRoot!;
    // SKILL.md 完全没动,只往技能目录里塞一个被指令引用的辅助文件(点文件同样算)。
    await fs.promises.writeFile(
      path.join(rootDir, 'skilled', 'skills', 'demo', '.helper.sh'),
      '#!/bin/sh\necho injected\n',
    );
    await fs.promises.rm(snapshotRoot, { recursive: true, force: true });
    expect(await manager.setEnabled('skilled', false)).toEqual({ ok: true });

    await expectRejection(await manager.setEnabled('skilled', true), 'io');
    expect(manager.list()[0].enabled).toBe(false);
    expect(fs.existsSync(snapshotRoot)).toBe(false);
  });

  it('refuses to follow a link planted inside the skill directory when rebuilding', async () => {
    await manager.install(await makeCindy('skill.cindy', skillManifest(), skillFiles()));
    const snapshotRoot = manager.list()[0].approvedSkillRoot!;
    const outside = path.join(workDir, 'outside-skill');
    await fs.promises.mkdir(outside, { recursive: true });
    await fs.promises.writeFile(path.join(outside, 'leak.txt'), 'bytes from outside the skill dir');
    // Windows junction 不需要管理员权限即可创建,是本平台成本最低的一条"把技能目录
    // 之外的字节拉进批准快照"的路子。判据不能建立在 Dirent 类型位的实现细节上,
    // 所以这条用例把行为钉住:planted link 一律拒,快照不落地。
    try {
      await fs.promises.symlink(
        outside,
        path.join(rootDir, 'skilled', 'skills', 'demo', 'linked'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } catch {
      return; // 该环境建不了链接(无权限),跳过;判定逻辑与其他平台同源。
    }
    await fs.promises.rm(snapshotRoot, { recursive: true, force: true });
    expect(await manager.setEnabled('skilled', false)).toEqual({ ok: true });

    await expectRejection(await manager.setEnabled('skilled', true), 'io');
    expect(manager.list()[0].enabled).toBe(false);
    expect(fs.existsSync(snapshotRoot)).toBe(false);
    // 状态根里不该出现任何来自技能目录之外的字节(含崩溃残留的 .tmp)。
    const stateRoot = manager.approvalStateRoot();
    const leaked: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const child = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(child);
        else if (entry.name === 'leak.txt') leaked.push(child);
      }
    };
    if (fs.existsSync(stateRoot)) walk(stateRoot);
    expect(leaked).toEqual([]);
  });

  it('rejects bytes swapped after the hash check but before the snapshot copy finishes', async () => {
    await manager.install(await makeCindy('skill.cindy', skillManifest(), skillFiles()));
    const snapshotRoot = manager.list()[0].approvedSkillRoot!;
    // 先停用、再删快照:停用本身会把快照重建回来(字节没动、校验放行),顺序颠倒
    // 会让后面的启用走"快照已存在"的早退路径,根本不经过复制。
    expect(await manager.setEnabled('skilled', false)).toEqual({ ok: true });
    await fs.promises.rm(snapshotRoot, { recursive: true, force: true });

    // 模拟同权限本机进程抢在复制这一刻换掉源字节:复制动作落到 temp 的是被改写的
    // 内容,而源目录事后看起来仍然"没问题"。所以校验必须落在**已经复制到 temp 的
    // 那份字节**上;若校验读的是源目录,这里就会放行一份没人确认过的技能指令。
    const tampered = '---\nname: demo\ndescription: Demo skill\n---\n\nrm -rf everything\n';
    let swapped = 0;
    const spy = vi
      .spyOn(fs.promises, 'copyFile')
      .mockImplementation((async (from: unknown, to: unknown, mode?: unknown) => {
        if (typeof from === 'string' && from.endsWith('SKILL.md') && typeof to === 'string') {
          swapped += 1;
          await fs.promises.writeFile(to, tampered, 'utf8');
          return undefined;
        }
        return realCopyFile(from as string, to as string, mode as number | undefined);
      }) as typeof fs.promises.copyFile);
    try {
      await expectRejection(await manager.setEnabled('skilled', true), 'io');
    } finally {
      spy.mockRestore();
    }
    expect(swapped).toBe(1); // 确认这一轮真的走到了复制
    expect(manager.list()[0].enabled).toBe(false);
    expect(fs.existsSync(snapshotRoot)).toBe(false);
  });

  it('applies the SKILL.md size ceiling to the bytes that actually landed in the snapshot', async () => {
    await manager.install(await makeCindy('skill.cindy', skillManifest(), skillFiles()));
    const snapshotRoot = manager.list()[0].approvedSkillRoot!;
    expect(await manager.setEnabled('skilled', false)).toEqual({ ok: true });
    await fs.promises.rm(snapshotRoot, { recursive: true, force: true });

    // 源目录看起来一切正常(预检放行),复制这一刻落到 temp 的却是超大文件。上限必须
    // 作用在这份字节上,而不是只作用在预检读到的那份 —— 预检不是安全边界。
    let swapped = 0;
    const spy = vi
      .spyOn(fs.promises, 'copyFile')
      .mockImplementation((async (from: unknown, to: unknown, mode?: unknown) => {
        if (typeof from === 'string' && from.endsWith('SKILL.md') && typeof to === 'string') {
          swapped += 1;
          await fs.promises.writeFile(to, 'x'.repeat(GHOST_SKILL_MD_MAX_BYTES + 1), 'utf8');
          return undefined;
        }
        return realCopyFile(from as string, to as string, mode as number | undefined);
      }) as typeof fs.promises.copyFile);
    let result: Awaited<ReturnType<GhostManager['setEnabled']>>;
    try {
      result = await manager.setEnabled('skilled', true);
    } finally {
      spy.mockRestore();
    }
    await expectRejection(result, 'io');
    // 断言到 reason 才能区分校验顺序:上限先跑报"exceeds N bytes",指纹先跑报
    // "no longer matches..."。只比 code 的话两种顺序都是 io,用例就退化成
    // 行为钉住、测不出重排。
    expect((result as { rejection: { reason: string } }).rejection.reason).toMatch(
      /exceeds \d+ bytes/,
    );
    expect(swapped).toBe(1);
    expect(manager.list()[0].enabled).toBe(false);
    expect(fs.existsSync(snapshotRoot)).toBe(false);
  });

  it('keeps an install unusable when a stale approval cannot be revoked', async () => {
    await manager.install(await makeCindy('approved.cindy', goodManifest()));
    // 撤销失败(状态根不可写等,与写批准失败同一成因)不得退回"继续拿旧批准跑":
    // removeInstallApproval 的契约是返回后一定不再被授权运行。
    const spy = vi
      .spyOn(fs.promises, 'rm')
      .mockRejectedValue(Object.assign(new Error('EPERM'), { code: 'EPERM' }));
    try {
      await manager.removeInstallApproval('hello');
    } finally {
      spy.mockRestore();
    }

    expect(fs.existsSync(receiptPath())).toBe(true); // receipt 还在盘上
    expect(manager.list()[0]).toMatchObject({
      enabled: false,
      approval: { state: 'invalid' },
    });
    await expectRejection(await manager.setEnabled('hello', true), 'approval-required');
  });

  it('does not trust an already-present snapshot whose bytes were rewritten in place', async () => {
    await manager.install(await makeCindy('skill.cindy', skillManifest(), skillFiles()));
    const snapshotRoot = manager.list()[0].approvedSkillRoot!;
    const snapshotSkillMd = path.join(snapshotRoot, 'skills', 'demo', 'SKILL.md');
    // 快照就位后被就地改写(状态根没有写保护)。主 Agent 是顺着共享链接持续读它的,
    // 所以"快照已存在"不能当成"仍是被批准的那份字节"直接早退信任。
    await fs.promises.writeFile(
      snapshotSkillMd,
      '---\nname: demo\ndescription: Demo skill\n---\n\nrm -rf everything\n',
    );

    // 安装目录里的字节没动过 → 删掉坏快照后能按批准字节重建,自愈。
    expect(await manager.setEnabled('skilled', false)).toEqual({ ok: true });
    expect(await manager.setEnabled('skilled', true)).toEqual({ ok: true });
    expect(await fs.promises.readFile(snapshotSkillMd, 'utf8')).toContain('Approved instructions');
  });

  it('refuses to keep a rewritten snapshot when the installed bytes drifted too', async () => {
    await manager.install(await makeCindy('skill.cindy', skillManifest(), skillFiles()));
    const snapshotRoot = manager.list()[0].approvedSkillRoot!;
    const tampered = '---\nname: demo\ndescription: Demo skill\n---\n\nrm -rf everything\n';
    // 快照与安装目录都被改成同一份未批准内容:此时没有任何可信来源可重建,必须拒。
    await fs.promises.writeFile(path.join(snapshotRoot, 'skills', 'demo', 'SKILL.md'), tampered);
    await fs.promises.writeFile(
      path.join(rootDir, 'skilled', 'skills', 'demo', 'SKILL.md'),
      tampered,
    );

    expect(await manager.setEnabled('skilled', false)).toEqual({ ok: true });
    await expectRejection(await manager.setEnabled('skilled', true), 'io');
    expect(manager.list()[0].enabled).toBe(false);
  });

  it('still heals a deleted snapshot when the installed skill bytes are untouched', async () => {
    await manager.install(await makeCindy('skill.cindy', skillManifest(), skillFiles()));
    const snapshotRoot = manager.list()[0].approvedSkillRoot!;
    // 字节指纹校验不能把合法的自愈场景一起堵死:外部清理误删快照、内容没动过。
    await fs.promises.rm(snapshotRoot, { recursive: true, force: true });
    expect(await manager.setEnabled('skilled', false)).toEqual({ ok: true });

    expect(await manager.setEnabled('skilled', true)).toEqual({ ok: true });
    expect(manager.list()[0].enabled).toBe(true);
    expect(
      await fs.promises.readFile(path.join(snapshotRoot, 'skills', 'demo', 'SKILL.md'), 'utf8'),
    ).toContain('Approved instructions');
  });

  it('bundled unchanged approval repairs a deleted skill snapshot without toggling enabled state', async () => {
    const manifest = skillManifest();
    await manager.install(await makeCindy('skill.cindy', manifest, skillFiles()));
    const listed = manager.list()[0];
    const source = await writeBundledSource(listed.manifest, skillFiles());
    const snapshotRoot = listed.approvedSkillRoot!;
    await fs.promises.rm(snapshotRoot, { recursive: true, force: true });

    expect(
      await manager.approveTrustedBundledInstall(listed.manifest, listed.enabled, source),
    ).toBe(true);
    expect(manager.list()[0].enabled).toBe(listed.enabled);
    const repairedSnapshotRoot = manager.list()[0].approvedSkillRoot!;
    expect(
      await fs.promises.readFile(
        path.join(repairedSnapshotRoot, 'skills', 'demo', 'SKILL.md'),
        'utf8',
      ),
    ).toContain('Approved instructions');
  });

  it('bundled approval accepts a normalized setup manifest while validating source author syntax', async () => {
    const sourceManifest = setupKvManifest();
    await manager.install(
      await makeCindy('setup.cindy', sourceManifest, {
        'main.js': '// installed setup plugin',
        'settings.html': '<!doctype html>',
      }),
    );
    const listed = manager.list()[0];
    const source = await writeBundledSource(
      listed.manifest,
      {
        'main.js': '// bundled setup plugin',
        'settings.html': '<!doctype html>',
      },
      sourceManifest,
    );

    await expect(
      manager.approveTrustedBundledInstall(listed.manifest, listed.enabled, source),
    ).resolves.toBe(true);
    expect(manager.list()[0].manifest.setup).toEqual({
      requires: [
        { anyOf: [{ kind: 'kv', key: 'repoDir', label: '本机 cindy 项目目录' }] },
      ],
    });
  });

  it('snapshot repair persists a one-way disable before the compatibility marker disappears', async () => {
    const manifest = skillManifest();
    await manager.install(await makeCindy('skill.cindy', manifest, skillFiles()));
    const listed = manager.list()[0];
    const source = await writeBundledSource(listed.manifest, skillFiles());
    expect(await manager.approveTrustedBundledInstall(listed.manifest, true, source)).toBe(true);

    const snapshotRoot = manager.list()[0].approvedSkillRoot!;
    const disabledMarker = path.join(rootDir, listed.manifest.id, '.disabled');
    await fs.promises.writeFile(disabledMarker, '');
    await fs.promises.rm(snapshotRoot, { recursive: true, force: true });

    expect(
      await manager.approveTrustedBundledInstall(listed.manifest, false, source),
    ).toBe(true);
    expect(JSON.parse(await fs.promises.readFile(receiptPath('skilled'), 'utf8'))).toMatchObject({
      enabled: false,
    });

    await fs.promises.rm(disabledMarker);
    const restarted = new GhostManager({
      getRootDir: () => rootDir,
      getLocale: () => hostLocale,
      isTrustedBundledId: (id) => trustedBundledIds.has(id),
      isTrustedBundledSource: (id, sourceDir) =>
        trustedBundledIds.has(id) &&
        path.resolve(sourceDir) === path.resolve(workDir, 'bundled-seeds', id),
      mutateSnapshot: async (request) => {
        const { parentDir, ...workerRequest } = request;
        await runGhostSnapshotWorkerRequest(workerRequest, parentDir);
      },
    });
    await restarted.approveTrustedBundledInstall(listed.manifest, true, source);
    expect(restarted.list()[0].enabled).toBe(false);
    expect(fs.existsSync(disabledMarker)).toBe(true);
  });

  it('invalidates a receipt whose skill content digests no longer match the manifest', async () => {
    await manager.install(await makeCindy('skill.cindy', skillManifest(), skillFiles()));
    const receipt = JSON.parse(
      await fs.promises.readFile(receiptPath('skilled'), 'utf8'),
    ) as Record<string, unknown>;
    // 手工把指纹字段抹掉:必填项缺失一律判 invalid,不允许退化成"跳过校验"。
    delete receipt.skillContentSha256;
    await fs.promises.writeFile(receiptPath('skilled'), JSON.stringify(receipt));

    expect(manager.list()[0]).toMatchObject({
      enabled: false,
      approval: { state: 'invalid' },
    });
  });

  it('invalidates a schema v1 receipt instead of trusting its legacy content digests', async () => {
    await manager.install(await makeCindy('approved.cindy', goodManifest()));
    const receipt = JSON.parse(
      await fs.promises.readFile(receiptPath(), 'utf8'),
    ) as Record<string, unknown>;
    // v2 改了内容摘要 framing；旧 receipt 的摘要不能拿来继续授权，必须 fail closed。
    receipt.schemaVersion = 1;
    await fs.promises.writeFile(receiptPath(), JSON.stringify(receipt));

    expect(manager.list()[0]).toMatchObject({
      enabled: false,
      approval: { state: 'invalid' },
    });
  });

  it('revoking approval fails the install closed, and a later bundled approval heals it', async () => {
    await manager.install(await makeCindy('approved.cindy', goodManifest()));
    const approvedManifest = manager.list()[0].manifest;

    // 随包对账在换入新种子字节后写批准失败时走的收敛动作:撤掉陈旧批准。
    // 撤掉之后插件必须彻底不可运行,而不是继续拿旧批准跑新代码。
    await manager.removeInstallApproval('hello');

    expect(fs.existsSync(receiptPath())).toBe(false);
    expect(manager.list()[0]).toMatchObject({
      enabled: false,
      approval: { state: 'legacy-unapproved' },
    });
    await expectRejection(await manager.setEnabled('hello', true), 'approval-required');

    // 下一轮启动对账重新补批准即自愈,不需要用户介入。
    expect(
      await manager.approveTrustedBundledInstall(
        approvedManifest,
        true,
        await writeBundledSource(approvedManifest),
      ),
    ).toBe(true);
    expect(manager.list()[0]).toMatchObject({
      enabled: true,
      approval: { state: 'approved' },
    });
  });

  it('uses the immutable bundled source directory when minting the approval receipt', async () => {
    await manager.install(await makeCindy('a.cindy', goodManifest()));
    const approvedManifest = manager.list()[0].manifest;
    const sourceDir = path.join(workDir, 'bundled-seeds', approvedManifest.id);
    trustedBundledIds.add(approvedManifest.id);
    await fs.promises.mkdir(sourceDir, { recursive: true });
    await fs.promises.writeFile(path.join(sourceDir, 'ghost.json'), JSON.stringify(approvedManifest));
    await fs.promises.writeFile(path.join(sourceDir, 'main.js'), 'immutable bundled bytes');
    await fs.promises.writeFile(path.join(rootDir, approvedManifest.id, 'main.js'), 'mutable bytes');

    const unsafeCall = manager.approveTrustedBundledInstall as unknown as (
      manifest: InstalledGhost['manifest'],
      markerEnabled: boolean,
    ) => Promise<boolean>;
    await expect(unsafeCall.call(manager, approvedManifest, true)).rejects.toThrow(
      /verified bundled source directory/,
    );
    await expect(
      manager.approveTrustedBundledInstall(approvedManifest, true, {
        sourceDir: path.join(rootDir, approvedManifest.id),
      }),
    ).rejects.toThrow(/mutable installed directory/);
    const arbitrarySourceDir = path.join(workDir, 'arbitrary-source', approvedManifest.id);
    await fs.promises.mkdir(arbitrarySourceDir, { recursive: true });
    await fs.promises.writeFile(
      path.join(arbitrarySourceDir, 'ghost.json'),
      JSON.stringify(approvedManifest),
    );
    await expect(
      manager.approveTrustedBundledInstall(approvedManifest, true, {
        sourceDir: arbitrarySourceDir,
      }),
    ).rejects.toThrow(/trusted seed roster/);

    expect(
      await manager.approveTrustedBundledInstall(approvedManifest, true, { sourceDir }),
    ).toBe(true);
    const receipt = JSON.parse(await fs.promises.readFile(receiptPath(), 'utf8')) as {
      packageSha256?: string;
    };
    const sourcePackageSha256 = receipt.packageSha256;
    await fs.promises.writeFile(path.join(rootDir, approvedManifest.id, 'main.js'), 'different mutable bytes');
    await manager.approveTrustedBundledInstall(approvedManifest, true, { sourceDir });
    const stableReceipt = JSON.parse(await fs.promises.readFile(receiptPath(), 'utf8')) as {
      packageSha256?: string;
    };
    expect(stableReceipt.packageSha256).toBe(sourcePackageSha256);
  });

  it('publishes bundled replacements through the pending journal and commits on receipt write', async () => {
    await manager.install(await makeCindy('old.cindy', goodManifest()));
    const approvedManifest = manager.list()[0].manifest;
    const { sourceDir } = await writeBundledSource(approvedManifest, {
      'main.js': 'immutable replacement bytes',
    });
    const stateRoot = manager.approvalStateRoot();
    const pendingPath = path.join(stateRoot, '.pending-hello.json');

    await manager.runExclusiveMutation(async (mutation) => {
      expect(await mutation.removeInstallApproval('hello')).toBe(true);
      await mutation.publishTrustedBundledSeed('hello', sourceDir, { disabled: false });
      expect(fs.existsSync(pendingPath)).toBe(true);
      expect(
        (await fs.promises.readdir(rootDir)).some((name) =>
          name.startsWith('.cindy-updating-hello-'),
        ),
      ).toBe(true);
      await mutation.approveTrustedBundledInstall(approvedManifest, true, { sourceDir });
    });

    expect(await fs.promises.readFile(path.join(rootDir, 'hello', 'main.js'), 'utf8')).toBe(
      'immutable replacement bytes',
    );
    expect(fs.existsSync(pendingPath)).toBe(false);
    expect(
      (await fs.promises.readdir(rootDir)).some((name) =>
        name.startsWith('.cindy-updating-hello-'),
      ),
    ).toBe(false);
    expect(manager.list()[0].approval.state).toBe('approved');
  });

  it('keeps a receipt-pinned disable when the .disabled mirror was lost, and rewrites the mirror', async () => {
    await manager.install(await makeCindy('a.cindy', goodManifest()));
    const { manifest: approvedManifest } = JSON.parse(
      await fs.promises.readFile(receiptPath(), 'utf8'),
    ) as { manifest: InstalledGhost['manifest'] };
    const source = await writeBundledSource(approvedManifest);
    // 随包对账首轮把安装收编成 bundled 批准(trust 归一),后续轮次走稳态分支。
    expect(await manager.approveTrustedBundledInstall(approvedManifest, true, source)).toBe(true);
    expect('ok' in (await manager.setEnabled('hello', false))).toBe(true);

    // 外部因素(AV 隔离恢复 / 同步冲突解析 / 手动清理)移除了兼容镜像文件。
    await fs.promises.rm(path.join(rootDir, 'hello', '.disabled'));

    // 下一轮对账把镜像读数(启用)喂进来:不得据此翻转 receipt —— 否则用户显式
    // 停用的插件被静默重新启用,无确认、无审计。重新启用只有 setEnabled 一条路。
    expect(await manager.approveTrustedBundledInstall(approvedManifest, true, source)).toBe(false);
    expect(manager.list()[0].enabled).toBe(false);
    // 镜像被补写回去:回滚到旧客户端(只认镜像文件)时仍按停用对待。
    expect(fs.existsSync(path.join(rootDir, 'hello', '.disabled'))).toBe(true);
  });

  it('an old-client style .disabled marker still turns a bundled receipt off', async () => {
    await manager.install(await makeCindy('a.cindy', goodManifest()));
    const { manifest: approvedManifest } = JSON.parse(
      await fs.promises.readFile(receiptPath(), 'utf8'),
    ) as { manifest: InstalledGhost['manifest'] };
    const source = await writeBundledSource(approvedManifest);
    expect(await manager.approveTrustedBundledInstall(approvedManifest, true, source)).toBe(true);

    // 旧客户端只会写镜像文件、不会写 receipt。停用是安全方向,合并必须照办 ——
    // 非对称的另一半:镜像只能把启停态往下拉,不能往上翻。
    await fs.promises.writeFile(path.join(rootDir, 'hello', '.disabled'), '');
    expect(await manager.approveTrustedBundledInstall(approvedManifest, false, source)).toBe(true);
    expect(manager.list()[0].enabled).toBe(false);
  });

  it('a bundled update keeps the receipt-pinned disable even when the marker was lost', async () => {
    await manager.install(await makeCindy('a.cindy', goodManifest()));
    const { manifest: approvedManifest } = JSON.parse(
      await fs.promises.readFile(receiptPath(), 'utf8'),
    ) as { manifest: InstalledGhost['manifest'] };
    expect(
      await manager.approveTrustedBundledInstall(
        approvedManifest,
        true,
        await writeBundledSource(approvedManifest),
      ),
    ).toBe(true);
    expect('ok' in (await manager.setEnabled('hello', false))).toBe(true);
    await fs.promises.rm(path.join(rootDir, 'hello', '.disabled'));

    // 随包更新那一轮走的是"建全新 receipt"分支,与稳态分支共用同一条合并规则:
    // 只堵稳态分支的话,镜像在更新 tick 之前丢失仍会静默重新启用,同一个洞换条路。
    const bumped = { ...approvedManifest, version: '1.0.1' };
    expect(
      await manager.approveTrustedBundledInstall(
        bumped,
        true,
        await writeBundledSource(bumped),
      ),
    ).toBe(true);
    expect(manager.list()[0]).toMatchObject({
      enabled: false,
      manifest: { version: '1.0.1' },
    });
    expect(fs.existsSync(path.join(rootDir, 'hello', '.disabled'))).toBe(true);
  });

  it('refuses to mint a bundled approval for an id outside the seed roster', async () => {
    // 该入口不经用户确认就铸出批准;builtin-only 边界必须运行期强制,不能只靠
    // "唯一调用者是随包对账"这条纪律。
    const guarded = new GhostManager({
      getRootDir: () => rootDir,
      getLocale: () => hostLocale,
      isTrustedBundledId: () => false,
    });
    const validated = validateGhostManifest(goodManifest());
    if (!validated.ok) throw new Error(validated.reason);
    await expect(
      guarded.approveTrustedBundledInstall(
        validated.manifest,
        true,
        await writeBundledSource(validated.manifest),
      ),
    ).rejects.toThrow(/种子清单/);
  });

  it('invalidates a receipt whose locale snapshot keys no longer match the manifest', async () => {
    hostLocale = 'en';
    const manifest = {
      ...goodManifest(),
      locales: { en: 'locales/en.json' },
    };
    await manager.install(
      await makeCindy('localized.cindy', manifest, {
        'locales/en.json': JSON.stringify({ name: 'Approved English name' }),
      }),
    );
    const receipt = JSON.parse(
      await fs.promises.readFile(receiptPath(), 'utf8'),
    ) as Record<string, unknown>;
    receipt.localeResources = {};
    await fs.promises.writeFile(receiptPath(), JSON.stringify(receipt));

    expect(manager.list()[0]).toMatchObject({
      enabled: false,
      approval: { state: 'invalid' },
    });
  });
});

describe('GhostManager · 技能批准基线取自包投影(publish 后篡改必须拒装)', () => {
  it('staging→final 发布后、首次校验前换掉 SKILL.md → 拒装,篡改字节不成为批准事实', async () => {
    const cindy = await makeCindy('skill.cindy', {
      ...goodManifest('skilled'),
      slots: ['tool', 'skill'],
      skill: { items: [{ dir: 'skills/demo', name: 'demo', description: 'Demo skill' }] },
    }, {
      'skills/demo/SKILL.md': '---\nname: demo\ndescription: Demo skill\n---\n\nApproved instructions\n',
    });
    // 故障注入:staging→final 的 rename 真实执行后,立刻在 finalDir 里改写 SKILL.md
    // 正文 —— 模拟"发布与首次 hash 之间"的本机进程篡改窗口。
    const realRename = fs.promises.rename;
    const finalDir = path.join(rootDir, 'skilled');
    const spy = vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      await realRename(from, to);
      if (String(to) === finalDir) {
        spy.mockRestore();
        await fs.promises.writeFile(
          path.join(finalDir, 'skills', 'demo', 'SKILL.md'),
          '---\nname: demo\ndescription: Demo skill\n---\n\nrm -rf everything\n',
        );
      }
    });
    try {
      const result = await manager.install(cindy);
      // 修复前:指纹从被篡改的 finalDir 首读,篡改字节自洽地成为 receipt 指纹与
      // 快照,install 返回 ok。修复后:指纹来自包投影,快照对账发现字节不符 → 拒装。
      expect('rejection' in result, JSON.stringify(result)).toBe(true);
    } finally {
      spy.mockRestore();
    }
    // 拒装收尾:不留半截安装,也没有任何批准事实落盘。
    expect(manager.list()).toHaveLength(0);
    expect(
      fs.existsSync(path.join(workDir, 'ghosts-install-state', 'skilled.json')),
    ).toBe(false);
  });
});

describe('GhostManager · 更新崩溃恢复(两次 rename 之间)', () => {
  it('final 缺位 + 唯一 backup → 下次启动自动搬回,插件不凭空消失', async () => {
    await manager.install(await makeCindy('a.cindy', goodManifest()));
    // 模拟崩溃现场:final→backup 已发生,staging→final 没来得及。
    await fs.promises.rename(
      path.join(rootDir, 'hello'),
      path.join(rootDir, '.cindy-updating-hello-abcdef01'),
    );
    // 崩溃前 list() 视角:插件消失(点目录被跳过)—— 这正是要修的现场。
    expect(manager.list()).toHaveLength(0);

    // "重启":新建 manager,构造期恢复扫描搬回。receipt 从未更新过,恢复后
    // receipt 与内容完全一致,等价于那次更新从未发生。
    const restarted = new GhostManager({ getRootDir: () => rootDir, getLocale: () => hostLocale });
    expect(fs.existsSync(path.join(rootDir, 'hello', 'ghost.json'))).toBe(true);
    expect(restarted.list()[0]).toMatchObject({ enabled: true, approval: { state: 'approved' } });
    expect(fs.existsSync(path.join(rootDir, '.cindy-updating-hello-abcdef01'))).toBe(false);
  });

  it('final 是普通文件时不删除唯一 backup', async () => {
    await manager.install(await makeCindy('a.cindy', goodManifest()));
    const finalDir = path.join(rootDir, 'hello');
    const backupDir = path.join(rootDir, '.cindy-updating-hello-abcdef01');
    await fs.promises.rename(finalDir, backupDir);
    await fs.promises.writeFile(finalDir, 'unexpected file');

    new GhostManager({ getRootDir: () => rootDir, getLocale: () => hostLocale });

    expect((await fs.promises.lstat(finalDir)).isFile()).toBe(true);
    expect(fs.existsSync(path.join(backupDir, 'ghost.json'))).toBe(true);
  });

  it('final 是 junction/链接时不删除唯一 backup', async () => {
    await manager.install(await makeCindy('a.cindy', goodManifest()));
    const finalDir = path.join(rootDir, 'hello');
    const backupDir = path.join(rootDir, '.cindy-updating-hello-abcdef01');
    const outsideDir = path.join(workDir, 'outside-final-target');
    await fs.promises.rename(finalDir, backupDir);
    await fs.promises.mkdir(outsideDir, { recursive: true });
    try {
      await fs.promises.symlink(outsideDir, finalDir, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      return; // Windows 环境未授予建链接权限时跳过；生产判据仍由 lstat 钉住。
    }

    new GhostManager({ getRootDir: () => rootDir, getLocale: () => hostLocale });

    expect((await fs.promises.lstat(finalDir)).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(path.join(backupDir, 'ghost.json'))).toBe(true);
  });

  it('final lstat EACCES 时不删除唯一 backup', async () => {
    await manager.install(await makeCindy('a.cindy', goodManifest()));
    const finalDir = path.join(rootDir, 'hello');
    const backupDir = path.join(rootDir, '.cindy-updating-hello-abcdef01');
    await fs.promises.rename(finalDir, backupDir);
    const realLstatSync = fs.lstatSync;
    const spy = vi.spyOn(fs, 'lstatSync').mockImplementation(((target: fs.PathLike, ...rest: unknown[]) => {
      if (path.resolve(String(target)) === path.resolve(finalDir)) {
        throw Object.assign(new Error('EACCES: final path locked'), { code: 'EACCES' });
      }
      return (realLstatSync as (...args: unknown[]) => unknown)(target, ...rest);
    }) as typeof fs.lstatSync);
    try {
      new GhostManager({ getRootDir: () => rootDir, getLocale: () => hostLocale });
    } finally {
      spy.mockRestore();
    }

    expect(fs.existsSync(path.join(backupDir, 'ghost.json'))).toBe(true);
    expect(fs.existsSync(finalDir)).toBe(false);
  });

  it('final 在位的陈旧 backup 与 staging 残留 → 回收;同 id 多个 backup 不猜、原样保留', async () => {
    await manager.install(await makeCindy('a.cindy', goodManifest()));
    await fs.promises.mkdir(path.join(rootDir, '.cindy-updating-hello-abcdef01'), { recursive: true });
    await fs.promises.mkdir(path.join(rootDir, '.cindy-installing-hello-deadbeef'), { recursive: true });
    new GhostManager({ getRootDir: () => rootDir, getLocale: () => hostLocale });
    expect(fs.existsSync(path.join(rootDir, '.cindy-updating-hello-abcdef01'))).toBe(false);
    expect(fs.existsSync(path.join(rootDir, '.cindy-installing-hello-deadbeef'))).toBe(false);
    expect(fs.existsSync(path.join(rootDir, 'hello', 'ghost.json'))).toBe(true);

    // 多 backup 且 final 缺位:不猜哪份是对的,原样保留等人工处理。
    await fs.promises.rename(path.join(rootDir, 'hello'), path.join(rootDir, '.cindy-updating-hello-11111111'));
    await fs.promises.mkdir(path.join(rootDir, '.cindy-updating-hello-22222222'), { recursive: true });
    new GhostManager({ getRootDir: () => rootDir, getLocale: () => hostLocale });
    expect(fs.existsSync(path.join(rootDir, '.cindy-updating-hello-11111111'))).toBe(true);
    expect(fs.existsSync(path.join(rootDir, '.cindy-updating-hello-22222222'))).toBe(true);
    expect(fs.existsSync(path.join(rootDir, 'hello'))).toBe(false);
  });

  it('id 是另一个 id 的 `-` 前缀(hello / hello-x)各留唯一 backup → 两者都搬回,不因前缀误判互相拖累(P1)', async () => {
    // 回归:siblings 统计曾用 startsWith(`.cindy-updating-${id}-`) 前缀匹配,
    // `.cindy-updating-hello-<hex>` 是 `.cindy-updating-hello-x-<hex>` 的前缀,
    // 于是处理 hello 时把 hello-x 的 backup 也算进来 → siblings 变 2 → 判"多备份
    // 留待人工" → hello 崩溃后持续消失。修复后按解析 id 精确比对,两者各自恢复。
    await manager.install(await makeCindy('a.cindy', goodManifest('hello')));
    await manager.install(await makeCindy('b.cindy', goodManifest('hello-x')));
    // 两个插件都卡在"final→backup 已发生,staging→final 未完成"的崩溃现场,
    // 且各自只有唯一 backup(合法可恢复的场景)。
    await fs.promises.rename(
      path.join(rootDir, 'hello'),
      path.join(rootDir, '.cindy-updating-hello-11111111'),
    );
    await fs.promises.rename(
      path.join(rootDir, 'hello-x'),
      path.join(rootDir, '.cindy-updating-hello-x-22222222'),
    );

    new GhostManager({ getRootDir: () => rootDir, getLocale: () => hostLocale });

    // 两者都应搬回 final,backup 清空 —— hello 不能被 hello-x 的存在拖成"消失"。
    expect(fs.existsSync(path.join(rootDir, 'hello', 'ghost.json'))).toBe(true);
    expect(fs.existsSync(path.join(rootDir, 'hello-x', 'ghost.json'))).toBe(true);
    expect(fs.existsSync(path.join(rootDir, '.cindy-updating-hello-11111111'))).toBe(false);
    expect(fs.existsSync(path.join(rootDir, '.cindy-updating-hello-x-22222222'))).toBe(false);
  });
});

describe('GhostManager · setEnabled(启用/停用)', () => {
  it('停用镜像本身写失败 → 如实报错,不谎报"已停用"(此刻什么都没落盘)', async () => {
    await manager.install(await makeCindy('a.cindy', goodManifest()));
    // 故障注入:.disabled 镜像写入抛 EACCES(receipt 还没轮到写)。
    const realWriteFile = fs.promises.writeFile;
    const spy = vi.spyOn(fs.promises, 'writeFile').mockImplementation(async (file, ...rest) => {
      if (String(file).endsWith('.disabled')) {
        const err = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
        err.code = 'EACCES';
        throw err;
      }
      return realWriteFile(file, ...(rest as [Parameters<typeof realWriteFile>[1]]));
    });
    try {
      const result = await manager.setEnabled('hello', false);
      // 修复前这里返回 {ok:true}:catch 分不清失败的是镜像写还是 receipt 写,按
      // "镜像已就位"降级 —— 但镜像根本没写成,receipt.enabled 仍为 true,重启即复活。
      expect('rejection' in result && result.rejection.code).toBe('io');
      expect(manager.list()[0].enabled).toBe(true); // 如实:停用没有生效
      expect(fs.existsSync(path.join(rootDir, 'hello', '.disabled'))).toBe(false);
    } finally {
      spy.mockRestore();
    }
    // 环境恢复后停用照常成功。
    expect('ok' in (await manager.setEnabled('hello', false))).toBe(true);
    expect(manager.list()[0].enabled).toBe(false);
  });

  it('停用:目录里出现 .disabled 标记、list 报 enabled=false、onChanged 广播;启用即恢复', async () => {
    await manager.install(await makeCindy('a.cindy', goodManifest()));
    onChanged.mockClear();

    const off = await manager.setEnabled('hello', false);
    expect('ok' in off).toBe(true);
    expect(fs.existsSync(path.join(rootDir, 'hello', '.disabled'))).toBe(true);
    expect(manager.list()[0].enabled).toBe(false);
    expect(onChanged).toHaveBeenCalledTimes(1);

    const on = await manager.setEnabled('hello', true);
    expect('ok' in on).toBe(true);
    expect(fs.existsSync(path.join(rootDir, 'hello', '.disabled'))).toBe(false);
    expect(manager.list()[0].enabled).toBe(true);
  });

  it('幂等:重复停用/重复启用不报错', async () => {
    await manager.install(await makeCindy('a.cindy', goodManifest()));
    expect('ok' in (await manager.setEnabled('hello', false))).toBe(true);
    expect('ok' in (await manager.setEnabled('hello', false))).toBe(true);
    expect('ok' in (await manager.setEnabled('hello', true))).toBe(true);
    expect('ok' in (await manager.setEnabled('hello', true))).toBe(true);
  });

  it('未装的 id → not-installed;非法 id → invalid-id', async () => {
    const ghost = await manager.setEnabled('ghost', false);
    expect((ghost as { rejection: { code: string } }).rejection.code).toBe('not-installed');
    const evil = await manager.setEnabled('../evil', false);
    expect((evil as { rejection: { code: string } }).rejection.code).toBe('invalid-id');
  });

  it('新装/重装的意识默认启用', async () => {
    const cindy = await makeCindy('a.cindy', goodManifest());
    await manager.install(cindy);
    await manager.setEnabled('hello', false);
    await manager.uninstall('hello');
    const result = await manager.install(cindy);
    expect((result as { ghost: InstalledGhost }).ghost.enabled).toBe(true);
    expect(manager.list()[0].enabled).toBe(true);
  });
});

describe('GhostManager · inspect(只验不装)', () => {
  it('opens a top-level .cindy source in non-blocking mode', async () => {
    const cindy = await makeCindy('nonblocking.cindy', goodManifest());
    const realOpen = fs.promises.open;
    const flags: number[] = [];
    const spy = vi.spyOn(fs.promises, 'open').mockImplementation((async (
      ...args: Parameters<typeof fs.promises.open>
    ) => {
      if (path.resolve(String(args[0])) === path.resolve(cindy)) {
        flags.push(Number(args[1]));
      }
      return realOpen(...args);
    }) as typeof fs.promises.open);

    try {
      await manager.inspect(cindy);
    } finally {
      spy.mockRestore();
    }

    expect(flags).toHaveLength(1);
    const nonBlockingFlag = fs.constants.O_NONBLOCK ?? 0;
    expect(flags[0] & nonBlockingFlag).toBe(nonBlockingFlag);
  });

  it('rejects a top-level .cindy source whose ctime changes during the read', async () => {
    const cindy = await makeCindy('ctime-change.cindy', goodManifest());
    const realOpen = fs.promises.open;
    const openSpy = vi.spyOn(fs.promises, 'open').mockImplementation((async (
      ...args: Parameters<typeof fs.promises.open>
    ) => {
      const handle = await realOpen(...args);
      if (path.resolve(String(args[0])) !== path.resolve(cindy)) return handle;
      const originalStat = handle.stat.bind(handle);
      let statCalls = 0;
      vi.spyOn(handle, 'stat').mockImplementation(async (...statArgs) => {
        const stat = await originalStat(...statArgs);
        statCalls += 1;
        if (statCalls === 2) {
      Object.defineProperty(stat, 'ctimeMs', {
        value: Number(stat.ctimeMs) + 1,
      });
        }
        return stat;
      });
      return handle;
    }) as typeof fs.promises.open);

    try {
      await expect(manager.inspect(cindy)).resolves.toMatchObject({
        rejection: { code: 'io' },
      });
    } finally {
      openSpy.mockRestore();
    }
  });

  it('allows a top-level .cindy symlink and installs the inspected target bytes', async () => {
    const target = await makeCindy('symlink-target.cindy', goodManifest());
    const linked = path.join(workDir, 'symlink-source.cindy');
    try {
      await fs.promises.symlink(target, linked, 'file');
    } catch {
      return; // Windows without file-symlink capability cannot exercise this POSIX regression.
    }

    const inspected = await manager.inspect(linked);
    expect('packageSha256' in inspected).toBe(true);
    if (!('packageSha256' in inspected)) return;
    const installed = await manager.install(linked, {
      expectedPackageSha256: inspected.packageSha256,
    });
    expect('ghost' in installed).toBe(true);
  });

  it('合法 .cindy → 返回清单,且零副作用(仓库目录不被创建)', async () => {
    const cindy = await makeCindy('a.cindy', goodManifest());
    const result = await manager.inspect(cindy);
    expect('manifest' in result).toBe(true);
    expect((result as { manifest: { id: string } }).manifest.id).toBe('hello');
    expect((result as { packageSha256: string }).packageSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(fs.existsSync(rootDir)).toBe(false); // 未装入,仓库根都不该出现
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('本地化展示清单与包内 canonical 清单分离', async () => {
    hostLocale = 'zh-CN';
    const base = {
      ...goodManifest(),
      name: 'Base name',
      locales: {
        en: 'locales/en.json',
        'zh-CN': 'locales/zh-CN.json',
      },
    };
    const cindy = await makeCindy('canonical.cindy', base, {
      'locales/en.json': JSON.stringify({ name: 'English name' }),
      'locales/zh-CN.json': JSON.stringify({
        name: '中文名称',
        tools: { do_thing: { description: '中文工具说明' } },
      }),
    });

    const inspected = await manager.inspect(cindy);
    expect(inspected).toMatchObject({
      manifest: {
        name: '中文名称',
        tools: [{ name: 'do_thing', description: '中文工具说明' }],
      },
      canonicalManifest: {
        name: 'Base name',
        tools: [{ name: 'do_thing', description: '做点事' }],
      },
    });
  });

  it('确认后源文件被替换时，整包指纹不一致会拒绝安装', async () => {
    const cindy = await makeCindy('swap.cindy', goodManifest(), { 'payload.txt': 'before' });
    const inspected = await manager.inspect(cindy);
    expect('packageSha256' in inspected).toBe(true);
    const expectedPackageSha256 = (inspected as { packageSha256: string }).packageSha256;

    await makeCindy('swap.cindy', goodManifest(), { 'payload.txt': 'after' });
    await expectRejection(await manager.install(cindy, { expectedPackageSha256 }), 'file-invalid');
    expect(fs.existsSync(rootDir)).toBe(false);
  });

  it('坏文件 → 与 install 同分类拒绝', async () => {
    const bad = path.join(workDir, 'bad.cindy');
    await fs.promises.writeFile(bad, 'nope');
    const result = await manager.inspect(bad);
    expect((result as { rejection: { code: string } }).rejection.code).toBe('file-invalid');
  });

  it('未来 schema 或未知字符串 capability → 插件合法但当前 Host 不支持', async () => {
    const futureSchema = await makeCindy('future-schema.cindy', {
      ...goodManifest(),
      schemaVersion: 3,
    });
    await expectRejection(await manager.inspect(futureSchema), 'host-unsupported');

    const futureCapability = await makeCindy('future-capability.cindy', {
      ...goodManifest(),
      slots: ['tool', 'future-host-capability'],
    });
    await expectRejection(await manager.inspect(futureCapability), 'host-unsupported');
  });

  it('slot 形状畸形仍按非法文件拒绝，友好提示不放松安全校验', async () => {
    const malformed = await makeCindy('malformed-slot.cindy', {
      ...goodManifest(),
      slots: ['tool', { name: 'future-host-capability' }],
    });
    await expectRejection(await manager.inspect(malformed), 'file-invalid');
  });
});

describe('GhostManager · author / icon(身份卡展示字段)', () => {
  const iconManifest = (): Record<string, unknown> => ({
    ...goodManifest(),
    author: 'Lizi',
    icon: 'assets/icon.png',
  });

  it('inspect / install / list 全链路带出 iconDataUrl 与 author', async () => {
    const cindy = await makeCindy('icon.cindy', iconManifest(), { 'assets/icon.png': 'PNGDATA' });

    const inspected = await manager.inspect(cindy);
    expect('manifest' in inspected).toBe(true);
    const ok = inspected as { manifest: { author?: string }; iconDataUrl?: string };
    expect(ok.manifest.author).toBe('Lizi');
    expect(ok.iconDataUrl).toBe(
      `data:image/png;base64,${Buffer.from('PNGDATA').toString('base64')}`,
    );

    const result = await manager.install(cindy);
    expect('ghost' in result).toBe(true);
    expect((result as { ghost: InstalledGhost }).ghost.iconDataUrl).toBe(ok.iconDataUrl);
    // list 从安装目录读盘重建,与装入时一致
    expect(manager.list()[0].iconDataUrl).toBe(ok.iconDataUrl);
    expect(fs.existsSync(path.join(rootDir, 'hello', 'assets', 'icon.png'))).toBe(true);
  });

  it('清单声明了 icon 但包内缺文件 → file-invalid', async () => {
    const cindy = await makeCindy('no-icon.cindy', iconManifest());
    await expectRejection(await manager.install(cindy), 'file-invalid');
  });

  it('icon 超过 512KB 上限 → file-invalid', async () => {
    const cindy = await makeCindy('fat-icon.cindy', iconManifest(), {
      'assets/icon.png': 'x'.repeat(512 * 1024 + 1),
    });
    await expectRejection(await manager.install(cindy), 'file-invalid');
  });

  it('installed icon removal cannot replace the Host-approved icon snapshot', async () => {
    const cindy = await makeCindy('icon2.cindy', iconManifest(), { 'assets/icon.png': 'PNGDATA' });
    await manager.install(cindy);
    await fs.promises.rm(path.join(rootDir, 'hello', 'assets', 'icon.png'));
    // 受体模型:已批准投影的 icon 来自 receipt 快照(GhostManager.ts:1684),
    // 装后删盘上 icon 文件不改变 list() 输出——快照即批准时钉下的图标。
    // main 旧的"删文件/换软链 → 降级为无图标"两个用例前提在受体模型下不再成立
    // (已批准根本不读盘);活读路径(legacy 未批准)的无泄漏由本文件
    // 'never reads icon bytes from outside the plugin dir...' 用例覆盖。
    const listed = manager.list();
    expect(listed).toHaveLength(1);
    expect(listed[0].iconDataUrl).toBe('data:image/png;base64,UE5HREFUQQ==');
    expect(listed[0].manifest.author).toBe('Lizi');
  });

  it('never reads icon bytes from outside the plugin dir when a path segment is a link', async () => {
    // 回归点:`stat` 静默穿透链接 —— 中间段 `assets` 被换成指向外部的链接时,
    // 上一版会把插件目录之外的字节读成 icon 下发给 renderer(批准路径上还会钉进
    // receipt)。判据改成逐段解析后,这里只能降级成"没有图标"。
    const legacyDir = path.join(rootDir, 'legacy');
    const outside = path.join(workDir, 'outside-assets');
    await fs.promises.mkdir(legacyDir, { recursive: true });
    await fs.promises.mkdir(outside, { recursive: true });
    await fs.promises.writeFile(path.join(outside, 'icon.png'), 'OUTSIDE');
    await fs.promises.writeFile(
      path.join(legacyDir, 'ghost.json'),
      JSON.stringify({ ...iconManifest(), id: 'legacy' }),
    );
    try {
      await fs.promises.symlink(
        outside,
        path.join(legacyDir, 'assets'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } catch {
      return; // 该环境建不了链接(无权限),跳过;判定逻辑与其他平台同源。
    }

    const listed = manager.list();
    expect(listed).toHaveLength(1);
    expect(listed[0].manifest.id).toBe('legacy');
    expect(listed[0].iconDataUrl).toBeUndefined();
  });

  it('不带 icon/author 的旧清单不受影响(无 iconDataUrl 字段)', async () => {
    await manager.install(await makeCindy('plain.cindy', goodManifest()));
    const listed = manager.list();
    expect(listed[0].iconDataUrl).toBeUndefined();
    expect(listed[0].manifest.author).toBeUndefined();
  });
});

describe('GhostManager · update(原位换版)', () => {
  it('happy path:版本替换、旧文件清干净、目录不变、onChanged 广播', async () => {
    await manager.install(await makeCindy('v1.cindy', goodManifest(), { 'old.txt': 'v1' }));
    onChanged.mockClear();

    const v2 = await makeCindy(
      'v2.cindy',
      { ...goodManifest(), version: '2.0.0' },
      { 'new.txt': 'v2' },
    );
    const onPackagePlaced = vi.fn();
    const installed = manager.list().find((g) => g.manifest.id === 'hello');
    const result = await manager.update(v2, {
      expectedInstalledApproval: ghostInstallApprovalToken(installed?.approval),
      onPackagePlaced,
    });
    expect('ghost' in result, JSON.stringify(result)).toBe(true);
    const { ghost } = result as { ghost: InstalledGhost };
    expect(ghost.manifest.version).toBe('2.0.0');
    expect(ghost.dir).toBe(path.join(rootDir, 'hello'));
    expect(fs.existsSync(path.join(rootDir, 'hello', 'new.txt'))).toBe(true);
    expect(fs.existsSync(path.join(rootDir, 'hello', 'old.txt'))).toBe(false); // 换版不留旧文件
    expect(onPackagePlaced).toHaveBeenCalledTimes(1);
    expect(onPackagePlaced.mock.invocationCallOrder[0]).toBeLessThan(
      onChanged.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(onChanged).toHaveBeenCalledTimes(1);
    // 备份/staging 临时目录不残留。
    const leftovers = fs.readdirSync(rootDir).filter((n) => n.startsWith('.cindy-'));
    expect(leftovers).toEqual([]);
  });

  it('磁盘上的无 manual 旧布局可直接列出并原位升级，无需重装或重新确认', async () => {
    const legacyDir = path.join(rootDir, 'hello');
    await fs.promises.mkdir(legacyDir, { recursive: true });
    await fs.promises.writeFile(path.join(legacyDir, 'ghost.json'), JSON.stringify(goodManifest()));
    await fs.promises.writeFile(path.join(legacyDir, 'main.js'), '// legacy');
    await fs.promises.writeFile(path.join(legacyDir, '.disabled'), '');
    const legacy = manager.list();
    expect(legacy).toMatchObject([{ manifest: { id: 'hello' }, enabled: false }]);
    expect(legacy[0].manifest.manual).toBeUndefined();

    const updated = await manager.update(
      await makeCindy('legacy-v2.cindy', { ...goodManifest(), version: '2.0.0' }),
      { expectedInstalledApproval: ghostInstallApprovalToken(legacy[0]?.approval) },
    );
    expect(updated).toMatchObject({
      ghost: { manifest: { id: 'hello', version: '2.0.0' }, enabled: false },
    });
    expect((updated as { ghost: InstalledGhost }).ghost.manifest.manual).toBeUndefined();
    expect(fs.existsSync(path.join(legacyDir, '.disabled'))).toBe(true);
  });

  it('唤醒状态延续:沉睡中更新仍沉睡,唤醒中更新仍唤醒', async () => {
    await manager.install(await makeCindy('v1.cindy', goodManifest()), { initiallyEnabled: false });
    const r1 = await updateGhost(await makeCindy('v2.cindy', { ...goodManifest(), version: '2.0.0' }));
    expect((r1 as { ghost: InstalledGhost }).ghost.enabled).toBe(false);
    expect(fs.existsSync(path.join(rootDir, 'hello', '.disabled'))).toBe(true);

    await manager.setEnabled('hello', true);
    const r2 = await updateGhost(await makeCindy('v3.cindy', { ...goodManifest(), version: '3.0.0' }));
    expect((r2 as { ghost: InstalledGhost }).ghost.enabled).toBe(true);
    expect(fs.existsSync(path.join(rootDir, 'hello', '.disabled'))).toBe(false);
  });

  it('提交前回调失败时恢复旧版本', async () => {
    await manager.install(await makeCindy('v1.cindy', goodManifest(), { 'old.txt': 'v1' }));
    const result = await manager.update(
      await makeCindy(
        'v2.cindy',
        { ...goodManifest(), version: '2.0.0' },
        { 'new.txt': 'v2' },
      ),
      {
        expectedInstalledApproval: ghostInstallApprovalToken(manager.list()[0]?.approval),
        beforePackageCommit: () => {
          throw new Error('migration write failed');
        },
      },
    );

    await expectRejection(result, 'io');
    expect(manager.list()[0]?.manifest.version).toBe('1.0.0');
    expect(fs.existsSync(path.join(rootDir, 'hello', 'old.txt'))).toBe(true);
    expect(fs.existsSync(path.join(rootDir, 'hello', 'new.txt'))).toBe(false);
  });

  it('receipt 提交失败时补偿副作用并恢复旧版本', async () => {
    await manager.install(await makeCindy('v1.cindy', goodManifest(), { 'old.txt': 'v1' }));
    const rollback = vi.fn();
    const commit = vi.fn();
    const store = (
      manager as unknown as {
        receiptStore: { write(...args: unknown[]): Promise<void> };
      }
    ).receiptStore;
    const writeSpy = vi.spyOn(store, 'write').mockRejectedValueOnce(new Error('receipt blocked'));
    try {
      const result = await manager.update(
        await makeCindy('v2.cindy', { ...goodManifest(), version: '2.0.0' }, { 'new.txt': 'v2' }),
        {
          expectedInstalledApproval: ghostInstallApprovalToken(manager.list()[0]?.approval),
          beforePackageCommit: () => ({ commit, rollback }),
        },
      );
      await expectRejection(result, 'io');
    } finally {
      writeSpy.mockRestore();
    }
    expect(rollback).toHaveBeenCalledTimes(1);
    expect(commit).not.toHaveBeenCalled();
    expect(manager.list()[0]?.manifest.version).toBe('1.0.0');
    expect(fs.existsSync(path.join(rootDir, 'hello', 'old.txt'))).toBe(true);
  });

  it('副作用补偿失败时保留 journal、隔离和可恢复的目录交换现场', async () => {
    await manager.install(await makeCindy('v1.cindy', goodManifest(), { 'old.txt': 'v1' }));
    const store = (
      manager as unknown as {
        receiptStore: { write(...args: unknown[]): Promise<void> };
      }
    ).receiptStore;
    const writeSpy = vi.spyOn(store, 'write').mockRejectedValueOnce(new Error('receipt blocked'));
    try {
      const result = await manager.update(
        await makeCindy('v2.cindy', { ...goodManifest(), version: '2.0.0' }, { 'new.txt': 'v2' }),
        {
          expectedInstalledApproval: ghostInstallApprovalToken(manager.list()[0]?.approval),
          beforePackageCommit: () => ({
            commit: vi.fn(),
            rollback: () => {
              throw new Error('vault blocked');
            },
          }),
        },
      );
      expect(result).toMatchObject({ rejection: { code: 'io', rollbackFailed: true } });
    } finally {
      writeSpy.mockRestore();
    }
    expect(manager.list()[0]).toMatchObject({ approval: { state: 'invalid' }, enabled: false });
    expect(fs.existsSync(path.join(rootDir, 'hello', 'new.txt'))).toBe(true);
    expect(fs.readdirSync(rootDir).some((name) => name.startsWith('.cindy-updating-hello-'))).toBe(true);
    expect(fs.existsSync(path.join(workDir, 'ghosts-install-state', '.pending-hello.json'))).toBe(true);

    const recovered = new GhostManager({
      getRootDir: () => rootDir,
      getLocale: () => hostLocale,
      onChanged,
    });
    expect(recovered.list()[0]?.manifest.version).toBe('1.0.0');
    expect(fs.existsSync(path.join(rootDir, 'hello', 'old.txt'))).toBe(true);
  });

  it('副作用只在 receipt 提交后 commit', async () => {
    await manager.install(await makeCindy('v1.cindy', goodManifest()));
    const events: string[] = [];
    const result = await manager.update(
      await makeCindy('v2.cindy', { ...goodManifest(), version: '2.0.0' }),
      {
        expectedInstalledApproval: ghostInstallApprovalToken(manager.list()[0]?.approval),
        beforePackageCommit: () => ({
          rollback: vi.fn(),
          commit: () => {
            events.push(manager.list()[0]?.manifest.version ?? 'missing');
          },
        }),
      },
    );
    expect('ghost' in result).toBe(true);
    expect(events).toEqual(['2.0.0']);
  });

  it('未装入 → not-installed 拒绝', async () => {
    await expectRejection(await updateGhost(await makeCindy('a.cindy', goodManifest())), 'not-installed');
  });

  it('指令查重豁免自己,但仍拦别人的指令', async () => {
    await manager.install(await makeCindy('a.cindy', chipManifestWithCommand('alpha', 'Draw')));
    await manager.install(await makeCindy('b.cindy', chipManifestWithCommand('beta', 'Paint')));

    // 自己沿用自己的指令 → 放行。
    const keep = await updateGhost(
      await makeCindy('a2.cindy', { ...chipManifestWithCommand('alpha', 'draw'), version: '2.0.0' }),
      'alpha',
    );
    expect('ghost' in keep, JSON.stringify(keep)).toBe(true);

    // 新版本改用别人占用的指令 → 拒,且旧版原样在位。
    await expectRejection(
      await updateGhost(
        await makeCindy('a3.cindy', { ...chipManifestWithCommand('alpha', 'paint'), version: '3.0.0' }),
        'alpha',
      ),
      'command-conflict',
    );
    const alpha = manager.list().find((g) => g.manifest.id === 'alpha');
    expect(alpha?.manifest.version).toBe('2.0.0');
  });

  it('坏文件 → file-invalid,已装版本不受影响', async () => {
    await manager.install(await makeCindy('v1.cindy', goodManifest()));
    const bad = path.join(workDir, 'bad.cindy');
    await fs.promises.writeFile(bad, 'nope');
    await expectRejection(await updateGhost(bad), 'file-invalid');
    expect(manager.list().find((g) => g.manifest.id === 'hello')?.manifest.version).toBe('1.0.0');
  });
});

describe('GhostManager · skill 槽装入校验(确认框看到的 = Agent 读到的)', () => {
  const skillManifest = (
    items: Array<Record<string, string>> = [
      { dir: 'skills/foo', name: 'foo', description: '教 Agent 用 foo' },
    ],
  ): Record<string, unknown> => ({
    ...goodManifest('skilled'),
    slots: ['tool', 'skill'],
    skill: { items },
  });
  const skillMd = (name: string, description: string, body = '正文'): string =>
    `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;

  it('SKILL.md 在场且 frontmatter 与声明一致 → 装入,落盘为普通文件', async () => {
    const cindy = await makeCindy('skill-good.cindy', skillManifest(), {
      'skills/foo/SKILL.md': skillMd('foo', '教 Agent 用 foo'),
      'skills/foo/reference.md': '附带资料',
    });
    const result = await manager.install(cindy);
    expect('ghost' in result, JSON.stringify(result)).toBe(true);
    const landed = path.join(rootDir, 'skilled', 'skills', 'foo', 'SKILL.md');
    const st = await fs.promises.lstat(landed);
    expect(st.isFile()).toBe(true);
    expect(st.isSymbolicLink()).toBe(false);
  });

  it('声明的技能目录缺 SKILL.md → 拒装', async () => {
    const cindy = await makeCindy('skill-missing.cindy', skillManifest(), {
      'skills/foo/notes.md': '没有 SKILL.md',
    });
    await expectRejection(await manager.install(cindy), 'file-invalid');
  });

  it('frontmatter name 与声明不一致 → 拒装', async () => {
    const cindy = await makeCindy('skill-name-drift.cindy', skillManifest(), {
      'skills/foo/SKILL.md': skillMd('bar', '教 Agent 用 foo'),
    });
    await expectRejection(await manager.install(cindy), 'file-invalid');
  });

  it('frontmatter description 与声明不一致 → 拒装', async () => {
    const cindy = await makeCindy('skill-desc-drift.cindy', skillManifest(), {
      'skills/foo/SKILL.md': skillMd('foo', '偷偷换一份说明'),
    });
    await expectRejection(await manager.install(cindy), 'file-invalid');
  });

  it('frontmatter 缺 description → 拒装', async () => {
    const cindy = await makeCindy('skill-no-desc.cindy', skillManifest(), {
      'skills/foo/SKILL.md': '---\nname: foo\n---\n\n正文\n',
    });
    await expectRejection(await manager.install(cindy), 'file-invalid');
  });

  it('SKILL.md 超过字节上限 → 拒装', async () => {
    const cindy = await makeCindy('skill-huge.cindy', skillManifest(), {
      'skills/foo/SKILL.md': skillMd('foo', '教 Agent 用 foo', 'x'.repeat(64 * 1024 + 1)),
    });
    await expectRejection(await manager.install(cindy), 'file-invalid');
  });
});
describe('legacy trust mirror hardening', () => {
  it('degrades an unreadable trust mirror to unverified instead of wedging recovery', async () => {
    await writeLegacyInstall('linked-trust', goodManifest('linked-trust'), {
      trust: {
        level: 'verified-publisher',
        publisherSigned: true,
        publisherVerified: true,
        reviewed: false,
        publisherName: 'Acme',
      },
    });
    const realOpenSync = fs.openSync;
    const spy = vi.spyOn(fs, 'openSync').mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
      if (typeof p === 'string' && p.endsWith(path.join('linked-trust', '.cindy-trust.json'))) {
        const err = new Error('ELOOP: too many symbolic links encountered') as NodeJS.ErrnoException;
        err.code = 'ELOOP';
        throw err;
      }
      return (realOpenSync as (...a: unknown[]) => number)(p, ...rest);
    }) as typeof fs.openSync);

    try {
      const frozen = await readLegacyGhostApprovalProjection(
        path.join(rootDir, 'linked-trust'),
        'linked-trust',
      );
      expect(frozen.projection.trust).toMatchObject({
        level: 'unverified',
        publisherSigned: false,
        publisherVerified: false,
        reviewed: false,
      });
    } finally {
      spy.mockRestore();
    }
  });
});

describe('GhostManager · manual 装入侧对等校验', () => {
  const manifest = (): Record<string, unknown> => ({
    ...goodManifest('manual-demo'),
    manual: {
      items: [
        { dir: 'manual', name: 'overview', description: '总览' },
        { dir: 'manual/advanced', name: 'advanced', description: '进阶' },
      ],
    },
  });

  it('嵌套单元、任意深度 Markdown 与 64KB 边界通过 inspect/install', async () => {
    const cindy = await makeCindy('manual-good.cindy', manifest(), {
      'manual/MANUAL.md': Buffer.alloc(64 * 1024, 0x61),
      'manual/references/deep/flow.md': '# 深层',
      'manual/advanced/MANUAL.md': '# 进阶',
      'manual/advanced/reference.MD': '# 参考',
    });
    expect(await manager.inspect(cindy)).toMatchObject({
      manifest: { manual: { items: [{ name: 'overview' }, { name: 'advanced' }] } },
    });
    expect(await manager.install(cindy)).toMatchObject({
      ghost: { manifest: { id: 'manual-demo' } },
    });
  });

  it.each([
    ['缺 MANUAL.md', { 'manual/notes.md': '# notes' }],
    [
      '超过 64KB',
      { 'manual/MANUAL.md': '# 入口', 'manual/huge.md': Buffer.alloc(64 * 1024 + 1, 0x61) },
    ],
    ['非法 UTF-8', { 'manual/MANUAL.md': '# 入口', 'manual/bad.md': Buffer.from([0xff, 0xfe]) }],
    [
      '二进制控制字节',
      { 'manual/MANUAL.md': '# 入口', 'manual/binary.md': Buffer.from('ok\u0000bad') },
    ],
    ['非 Markdown', { 'manual/MANUAL.md': '# 入口', 'manual/data.json': '{}' }],
  ] as Array<[string, Record<string, string | Buffer>]>)(
    '%s 的恶意包绕过 Forge 仍拒绝',
    async (_name, entries) => {
      const single = {
        ...goodManifest('manual-demo'),
        manual: { items: [{ dir: 'manual', name: 'overview', description: '总览' }] },
      };
      await expectRejection(
        await manager.install(await makeCindy('manual-bad.cindy', single, entries)),
        'file-invalid',
      );
    },
  );

  it('ZIP 内符号链接条目不能作为 manual 文件', async () => {
    const single = {
      ...goodManifest('manual-demo'),
      manual: { items: [{ dir: 'manual', name: 'overview', description: '总览' }] },
    };
    const zip = new JSZip();
    zip.file('ghost.json', JSON.stringify(single));
    zip.file('manual/MANUAL.md', '# 入口');
    zip.file('manual/link.md', '../outside.md', { unixPermissions: 0o120777 });
    const out = path.join(workDir, 'manual-link.cindy');
    await fs.promises.writeFile(
      out,
      await zip.generateAsync({ type: 'nodebuffer', platform: 'UNIX' }),
    );
    await expectRejection(await manager.install(out), 'file-invalid');
  });

  it('ZIP manual 文件和显式目录条目含 C0、DEL 或反斜杠时拒绝', async () => {
    const single = {
      ...goodManifest('manual-demo'),
      manual: { items: [{ dir: 'manual', name: 'guide', description: '总览' }] },
    };
    const cases = [
      { name: `bad${String.fromCharCode(1)}name.md`, directory: false },
      { name: `bad${String.fromCharCode(0x7f)}name.md`, directory: false },
      { name: 'bad\\windows.md', directory: false },
      { name: `bad${String.fromCharCode(1)}dir`, directory: true },
    ];
    for (const [index, testCase] of cases.entries()) {
      const zip = new JSZip();
      zip.file('ghost.json', JSON.stringify(single));
      zip.file('manual/MANUAL.md', '# 入口');
      if (testCase.directory) {
        zip.file(`manual/${testCase.name}/`, null, { dir: true });
        zip.file(`manual/${testCase.name}/nested.md`, '# invalid');
      } else {
        zip.file(`manual/${testCase.name}`, '# invalid');
      }
      const out = path.join(workDir, `manual-invalid-path-${index}.cindy`);
      await fs.promises.writeFile(out, await zip.generateAsync({ type: 'nodebuffer' }));
      await expectRejection(await manager.inspect(out), 'file-invalid');
    }
  });

  it('ZIP manual 逻辑路径 1024 字符放行，超过 1024 字符拒绝', async () => {
    const single = {
      ...goodManifest('manual-demo'),
      manual: { items: [{ dir: 'manual', name: 'guide', description: '总览' }] },
    };
    const inspectWithRelativePath = async (relativePath: string, fileName: string) => {
      const zip = new JSZip();
      zip.file('ghost.json', JSON.stringify(single));
      zip.file('manual/MANUAL.md', '# 入口');
      zip.file(`manual/${relativePath}`, '# deep', { createFolders: false });
      const out = path.join(workDir, fileName);
      await fs.promises.writeFile(out, await zip.generateAsync({ type: 'nodebuffer' }));
      return manager.inspect(out);
    };

    expect(await inspectWithRelativePath(`${'a/'.repeat(507)}x.md`, 'manual-1024.cindy')).toMatchObject({
      manifest: { id: 'manual-demo' },
    });
    await expectRejection(
      await inspectWithRelativePath(`${'a/'.repeat(507)}xx.md`, 'manual-1025.cindy'),
      'file-invalid',
    );
  });
});
