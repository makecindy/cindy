/**
 * fsSlot 单测:资格审 / 路径纪律 / data 三件套往返 / workdir 权限三档与
 * 确认记忆 / save 票据透传 / 远程工作区拒绝。全部走注入 deps + os.tmpdir
 * 临时目录(规则 23:凭证与生成物不落仓库工作区),零 Electron。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { GhostFsSlot, validateFsRelPath, workdirWriteVerdict, type FsSlotDeps, type FsSessionSnapshot } from '../fsSlot.js';
import { GHOST_FS_WRITE_MAX_BYTES, type InstalledGhost } from '../../../shared/ghost.js';

const GHOST_ID = 'test-ghost';

function makeGhost(slots: string[]): InstalledGhost {
  return {
    manifest: {
      schemaVersion: 2,
      id: GHOST_ID,
      name: '测试意识',
      version: '1.0.0',
      kind: 'chip',
      entry: 'main.js',
      slots: slots as InstalledGhost['manifest']['slots'],
    },
    dir: '/tmp/fake-install-dir',
    enabled: true,
  };
}

interface HarnessOverrides {
  slots?: string[];
  session?: FsSessionSnapshot | null;
  confirm?: (sessionId: string) => Promise<{ confirmed: boolean }>;
  saveWrite?: FsSlotDeps['writeSaveDeposit'];
  callSessionId?: string | null;
  callGhostId?: string;
  /** 脚本通道条目的落盘根(schedule.workingDir);undefined = 会话调用不带。 */
  callScriptWorkdir?: string | null;
  /** 脚本声明的唯一可写相对路径(out_file);非 null 时只放行该路径。 */
  callScriptWritePath?: string | null;
  /** 条目通道;缺省按 callSessionId 推导(null ⇒ script,否则 session)。 */
  callChannel?: 'session' | 'script';
  /** 严格在途查询结果:false = 模拟已交卷/已清扫(返回 null)。缺省 true。 */
  inFlight?: boolean;
}

function makeHarness(dataRoot: string, overrides: HarnessOverrides = {}) {
  const confirmCalls: string[] = [];
  const entryFor = (callId: string) =>
    callId === 'call-1'
      ? {
          ghostId: overrides.callGhostId ?? GHOST_ID,
          sessionId: overrides.callSessionId === undefined ? 'sess-1' : overrides.callSessionId,
          scriptWorkdir: overrides.callScriptWorkdir ?? null,
          scriptWritePath: overrides.callScriptWritePath ?? null,
          channel: overrides.callChannel ?? (overrides.callSessionId === null ? 'script' as const : 'session' as const),
        }
      : null;
  const deps: FsSlotDeps = {
    getGhost: (id) => (id === GHOST_ID ? makeGhost(overrides.slots ?? ['fs']) : null),
    dataRootDir: () => dataRoot,
    callInfo: entryFor,
    inFlightCallInfo: (callId) => (overrides.inFlight === false ? null : entryFor(callId)),
    getSessionSnapshot: async () => (overrides.session === undefined ? null : overrides.session),
    requestWriteConfirm: async (sessionId) => {
      confirmCalls.push(sessionId);
      const decision = overrides.confirm
        ? await overrides.confirm(sessionId)
        : { confirmed: true as const };
      return decision.confirmed
        ? { confirmed: true }
        : { confirmed: false, reason: 'cancelled' as const };
    },
    writeSaveDeposit:
      overrides.saveWrite ?? (async (_ghostId, _token, fileName) => ({ fileName })),
  };
  return { slot: new GhostFsSlot(deps), confirmCalls };
}

describe('workdirWriteVerdict(权限映射表)', () => {
  it('免批模式直写,逐条模式确认,plan 拒,未知模式保守确认', () => {
    expect(workdirWriteVerdict('acceptEdits', false)).toBe('allow');
    expect(workdirWriteVerdict('bypassPermissions', false)).toBe('allow');
    expect(workdirWriteVerdict('auto', false)).toBe('allow');
    expect(workdirWriteVerdict('ask', false)).toBe('confirm');
    expect(workdirWriteVerdict('default', false)).toBe('confirm');
    expect(workdirWriteVerdict('plan', false)).toBe('deny');
    expect(workdirWriteVerdict('future-unknown-mode', false)).toBe('confirm');
    // plan 开关正交:任何模式下开着都拒。
    expect(workdirWriteVerdict('bypassPermissions', true)).toBe('deny');
  });
});

describe('validateFsRelPath(路径纪律)', () => {
  it('放行 a/b/c.ext 形态,拒穿越/绝对/反斜杠/隐藏段/保留名/超长', () => {
    expect(validateFsRelPath('reports/result.json')).toBeNull();
    expect(validateFsRelPath('a.txt')).toBeNull();
    expect(validateFsRelPath('../escape.txt')).not.toBeNull();
    expect(validateFsRelPath('a/../b.txt')).not.toBeNull();
    expect(validateFsRelPath('/abs/path.txt')).not.toBeNull();
    expect(validateFsRelPath('a\\b.txt')).not.toBeNull();
    expect(validateFsRelPath('.git/hooks/pre-commit')).not.toBeNull();
    expect(validateFsRelPath('dir/.env')).not.toBeNull();
    expect(validateFsRelPath('NUL.txt')).not.toBeNull();
    expect(validateFsRelPath('logs/con')).not.toBeNull();
    expect(validateFsRelPath(`a/${'x'.repeat(300)}.txt`)).not.toBeNull();
    expect(validateFsRelPath('')).not.toBeNull();
    expect(validateFsRelPath(undefined)).not.toBeNull();
    // 尾点段(Windows 静默剥尾点,回执名与真身不一致)与深链(配额扫描攻击向量)拒。
    expect(validateFsRelPath('report./a.txt')).not.toBeNull();
    expect(validateFsRelPath('a.txt.')).not.toBeNull();
    expect(validateFsRelPath(Array.from({ length: 17 }, (_v, i) => `d${i}`).join('/'))).not.toBeNull();
    expect(validateFsRelPath(Array.from({ length: 16 }, (_v, i) => `d${i}`).join('/'))).toBeNull();
  });
});

describe('GhostFsSlot', () => {
  let tmpRoot: string;
  let dataRoot: string;
  let workdir: string;

  beforeEach(async () => {
    tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'fs-slot-test-'));
    dataRoot = path.join(tmpRoot, 'ghost-fs');
    workdir = path.join(tmpRoot, 'workdir');
    await fs.promises.mkdir(workdir, { recursive: true });
  });

  afterEach(async () => {
    await fs.promises.rm(tmpRoot, { recursive: true, force: true });
  });

  it('未声明 fs 卡槽一律拒', async () => {
    const { slot } = makeHarness(dataRoot, { slots: ['tool'] });
    const r = await slot.handleFsRequest(GHOST_ID, {
      type: 'fs-request', op: 'write', root: 'data', path: 'a.txt', content: 'hi',
    });
    expect(r).toMatchObject({ ok: false });
    expect((r as { message: string }).message).toContain('fs');
  });

  it('未知 op / root 拒', async () => {
    const { slot } = makeHarness(dataRoot);
    expect(await slot.handleFsRequest(GHOST_ID, { type: 'fs-request', op: 'chmod', root: 'data' })).toMatchObject({ ok: false });
    expect(await slot.handleFsRequest(GHOST_ID, { type: 'fs-request', op: 'write', root: 'home' })).toMatchObject({ ok: false });
  });

  it('data:write → read → list → delete 全链路(含子目录与 base64)', async () => {
    const { slot } = makeHarness(dataRoot);
    const w = await slot.handleFsRequest(GHOST_ID, {
      type: 'fs-request', op: 'write', root: 'data', path: 'reports/result.json', content: '{"n":1}',
    });
    expect(w).toMatchObject({ ok: true, op: 'write', path: 'reports/result.json', bytes: 7 });
    // 字节真身落在 <dataRoot>/<ghostId>/ 下
    const onDisk = await fs.promises.readFile(path.join(dataRoot, GHOST_ID, 'reports', 'result.json'), 'utf8');
    expect(onDisk).toBe('{"n":1}');

    const binary = Buffer.from([0, 1, 2, 250]);
    const wb = await slot.handleFsRequest(GHOST_ID, {
      type: 'fs-request', op: 'write', root: 'data', path: 'bin/blob.bin',
      content: binary.toString('base64'), encoding: 'base64',
    });
    expect(wb).toMatchObject({ ok: true, bytes: 4 });

    const r = await slot.handleFsRequest(GHOST_ID, {
      type: 'fs-request', op: 'read', root: 'data', path: 'bin/blob.bin', encoding: 'base64',
    });
    expect(r).toMatchObject({ ok: true, op: 'read', encoding: 'base64', bytes: 4 });
    expect(Buffer.from((r as { content: string }).content, 'base64')).toEqual(binary);

    const l = await slot.handleFsRequest(GHOST_ID, { type: 'fs-request', op: 'list', root: 'data' });
    expect(l).toMatchObject({ ok: true, op: 'list' });
    const paths = (l as { entries: Array<{ path: string }> }).entries.map((e) => e.path).sort();
    expect(paths).toEqual(['bin/blob.bin', 'reports/result.json']);

    const d = await slot.handleFsRequest(GHOST_ID, {
      type: 'fs-request', op: 'delete', root: 'data', path: 'bin/blob.bin',
    });
    expect(d).toMatchObject({ ok: true, op: 'delete', existed: true });
    // 空目录剪枝:bin/ 独占目录随最后一个文件删除被回收(reports/ 仍有文件,保留)。
    expect(fs.existsSync(path.join(dataRoot, GHOST_ID, 'bin'))).toBe(false);
    expect(fs.existsSync(path.join(dataRoot, GHOST_ID, 'reports'))).toBe(true);
    // 幂等:再删同名回 existed:false,不报错。
    const d2 = await slot.handleFsRequest(GHOST_ID, {
      type: 'fs-request', op: 'delete', root: 'data', path: 'bin/blob.bin',
    });
    expect(d2).toMatchObject({ ok: true, existed: false });
  });

  it('data:覆盖写生效(create/modify 语义)', async () => {
    const { slot } = makeHarness(dataRoot);
    await slot.handleFsRequest(GHOST_ID, { type: 'fs-request', op: 'write', root: 'data', path: 'a.txt', content: 'v1' });
    const w2 = await slot.handleFsRequest(GHOST_ID, { type: 'fs-request', op: 'write', root: 'data', path: 'a.txt', content: 'v2-longer' });
    expect(w2).toMatchObject({ ok: true });
    expect(await fs.promises.readFile(path.join(dataRoot, GHOST_ID, 'a.txt'), 'utf8')).toBe('v2-longer');
  });

  it('data:穿越/隐藏段/保留名路径拒;读不存在的文件拒;list 空储物柜回空清单', async () => {
    const { slot } = makeHarness(dataRoot);
    for (const bad of ['../out.txt', '.git/x', 'NUL.txt']) {
      expect(await slot.handleFsRequest(GHOST_ID, {
        type: 'fs-request', op: 'write', root: 'data', path: bad, content: 'x',
      })).toMatchObject({ ok: false });
    }
    expect(await slot.handleFsRequest(GHOST_ID, {
      type: 'fs-request', op: 'read', root: 'data', path: 'ghost.txt',
    })).toMatchObject({ ok: false });
    const l = await slot.handleFsRequest(GHOST_ID, { type: 'fs-request', op: 'list', root: 'data' });
    expect(l).toMatchObject({ ok: true, entries: [] });
  });

  it('单次写入超 GHOST_FS_WRITE_MAX_BYTES 拒', async () => {
    const { slot } = makeHarness(dataRoot);
    const r = await slot.handleFsRequest(GHOST_ID, {
      type: 'fs-request', op: 'write', root: 'data', path: 'big.txt',
      content: 'a'.repeat(GHOST_FS_WRITE_MAX_BYTES + 1),
    });
    expect(r).toMatchObject({ ok: false });
    expect((r as { message: string }).message).toContain('超限');
  });

  it('workdir:免批模式(acceptEdits)直写,不弹确认', async () => {
    const { slot, confirmCalls } = makeHarness(dataRoot, {
      session: { workingDir: workdir, permissionMode: 'acceptEdits', planModeEnabled: false, remoteHostId: null },
    });
    const r = await slot.handleFsRequest(GHOST_ID, {
      type: 'fs-request', op: 'write', root: 'workdir', path: 'out/summary.md', content: '# hi', callId: 'call-1',
    });
    expect(r).toMatchObject({ ok: true, op: 'write', path: 'out/summary.md' });
    expect(confirmCalls).toHaveLength(0);
    expect(await fs.promises.readFile(path.join(workdir, 'out', 'summary.md'), 'utf8')).toBe('# hi');
  });

  it('workdir:逐条模式(default)先确认;同目录本会话批一次;拒绝则不写', async () => {
    let allow = true;
    const { slot, confirmCalls } = makeHarness(dataRoot, {
      session: { workingDir: workdir, permissionMode: 'default', planModeEnabled: false, remoteHostId: null },
      confirm: async () => ({ confirmed: allow }),
    });
    const w1 = await slot.handleFsRequest(GHOST_ID, {
      type: 'fs-request', op: 'write', root: 'workdir', path: 'docs/a.md', content: 'a', callId: 'call-1',
    });
    expect(w1).toMatchObject({ ok: true });
    expect(confirmCalls).toHaveLength(1);
    // 同目录第二笔:免弹。
    const w2 = await slot.handleFsRequest(GHOST_ID, {
      type: 'fs-request', op: 'write', root: 'workdir', path: 'docs/b.md', content: 'b', callId: 'call-1',
    });
    expect(w2).toMatchObject({ ok: true });
    expect(confirmCalls).toHaveLength(1);
    // 换目录:再弹;用户拒 → 不写盘。
    allow = false;
    const w3 = await slot.handleFsRequest(GHOST_ID, {
      type: 'fs-request', op: 'write', root: 'workdir', path: 'other/c.md', content: 'c', callId: 'call-1',
    });
    expect(w3).toMatchObject({ ok: false });
    expect(confirmCalls).toHaveLength(2);
    expect(fs.existsSync(path.join(workdir, 'other', 'c.md'))).toBe(false);
    // 会话清理后记忆失效:同 docs/ 目录重新弹。
    allow = true;
    slot.cleanupForSession('sess-1');
    const w4 = await slot.handleFsRequest(GHOST_ID, {
      type: 'fs-request', op: 'write', root: 'workdir', path: 'docs/d.md', content: 'd', callId: 'call-1',
    });
    expect(w4).toMatchObject({ ok: true });
    expect(confirmCalls).toHaveLength(3);
  });

  it('workdir:plan / planModeEnabled 拒', async () => {
    for (const session of [
      { workingDir: workdir, permissionMode: 'plan', planModeEnabled: false, remoteHostId: null },
      { workingDir: workdir, permissionMode: 'acceptEdits', planModeEnabled: true, remoteHostId: null },
    ]) {
      const { slot } = makeHarness(dataRoot, { session });
      expect(await slot.handleFsRequest(GHOST_ID, {
        type: 'fs-request', op: 'write', root: 'workdir', path: 'x.md', content: 'x', callId: 'call-1',
      })).toMatchObject({ ok: false });
    }
  });

  it('workdir:远程工作区(remoteHostId 非空)明确拒', async () => {
    const { slot } = makeHarness(dataRoot, {
      session: { workingDir: workdir, permissionMode: 'acceptEdits', planModeEnabled: false, remoteHostId: 'host-9' },
    });
    const r = await slot.handleFsRequest(GHOST_ID, {
      type: 'fs-request', op: 'write', root: 'workdir', path: 'x.md', content: 'x', callId: 'call-1',
    });
    expect(r).toMatchObject({ ok: false });
    expect((r as { message: string }).message).toContain('远程');
  });

  it('workdir:callId 缺失/查无/归属不符拒(不认自报身份)', async () => {
    const { slot } = makeHarness(dataRoot, {
      session: { workingDir: workdir, permissionMode: 'acceptEdits', planModeEnabled: false, remoteHostId: null },
    });
    expect(await slot.handleFsRequest(GHOST_ID, {
      type: 'fs-request', op: 'write', root: 'workdir', path: 'x.md', content: 'x',
    })).toMatchObject({ ok: false });
    expect(await slot.handleFsRequest(GHOST_ID, {
      type: 'fs-request', op: 'write', root: 'workdir', path: 'x.md', content: 'x', callId: 'call-unknown',
    })).toMatchObject({ ok: false });
    const forged = makeHarness(dataRoot, {
      session: { workingDir: workdir, permissionMode: 'acceptEdits', planModeEnabled: false, remoteHostId: null },
      callGhostId: 'another-ghost',
    });
    expect(await forged.slot.handleFsRequest(GHOST_ID, {
      type: 'fs-request', op: 'write', root: 'workdir', path: 'x.md', content: 'x', callId: 'call-1',
    })).toMatchObject({ ok: false });
  });

  it('workdir:read/list/delete 一律拒(仅 write)', async () => {
    const { slot } = makeHarness(dataRoot, {
      session: { workingDir: workdir, permissionMode: 'bypassPermissions', planModeEnabled: false, remoteHostId: null },
    });
    for (const op of ['read', 'list', 'delete']) {
      expect(await slot.handleFsRequest(GHOST_ID, {
        type: 'fs-request', op, root: 'workdir', path: 'x.md', callId: 'call-1',
      })).toMatchObject({ ok: false });
    }
  });

  it('save:凭票写入,文件名取 basename 语义;缺 token 拒;票据无效拒', async () => {
    const saveCalls: Array<{ fileName: string; bytes: number }> = [];
    const { slot } = makeHarness(dataRoot, {
      saveWrite: async (_g, token, fileName, bytes) => {
        if (token !== 'ticket-1') return null;
        saveCalls.push({ fileName, bytes: bytes.byteLength });
        return { fileName: `${fileName}` };
      },
    });
    const ok = await slot.handleFsRequest(GHOST_ID, {
      type: 'fs-request', op: 'write', root: 'save', path: 'sub/report.json', content: '{}', token: 'ticket-1',
    });
    expect(ok).toMatchObject({ ok: true, op: 'write', path: 'report.json', bytes: 2 });
    expect(saveCalls).toEqual([{ fileName: 'report.json', bytes: 2 }]);
    expect(await slot.handleFsRequest(GHOST_ID, {
      type: 'fs-request', op: 'write', root: 'save', path: 'a.txt', content: 'x',
    })).toMatchObject({ ok: false });
    expect(await slot.handleFsRequest(GHOST_ID, {
      type: 'fs-request', op: 'write', root: 'save', path: 'a.txt', content: 'x', token: 'expired',
    })).toMatchObject({ ok: false });
  });

  // symlink 逃逸:Windows 上普通用户建 symlink 需要开发者模式,建不出来就跳过
  //(路径纪律与 realpath 收敛在两端共用同一段代码,POSIX 端覆盖即可)。
  it('workdir:经 symlink 目录逃逸拒', async () => {
    const outside = path.join(tmpRoot, 'outside');
    await fs.promises.mkdir(outside, { recursive: true });
    const linkPath = path.join(workdir, 'link');
    try {
      await fs.promises.symlink(outside, linkPath, 'dir');
    } catch {
      return; // 无权限建 symlink(Windows 非开发者模式),跳过
    }
    const { slot } = makeHarness(dataRoot, {
      session: { workingDir: workdir, permissionMode: 'bypassPermissions', planModeEnabled: false, remoteHostId: null },
    });
    const r = await slot.handleFsRequest(GHOST_ID, {
      type: 'fs-request', op: 'write', root: 'workdir', path: 'link/escape.txt', content: 'x', callId: 'call-1',
    });
    expect(r).toMatchObject({ ok: false });
    expect(fs.existsSync(path.join(outside, 'escape.txt'))).toBe(false);
  });

  it('workdir(脚本通道):无会话但带 scriptWorkdir 的调用直写落盘、不弹确认卡', async () => {
    const { slot, confirmCalls } = makeHarness(dataRoot, {
      callSessionId: null,
      callScriptWorkdir: workdir,
    });
    const r = await slot.handleFsRequest(GHOST_ID, {
      type: 'fs-request', op: 'write', root: 'workdir', path: 'reports/result.json', content: '{"n":1}', callId: 'call-1',
    });
    expect(r).toMatchObject({ ok: true, op: 'write', path: 'reports/result.json' });
    // 脚本通道无会话可弹确认卡:直写,确认桥零调用。
    expect(confirmCalls).toHaveLength(0);
    expect(await fs.promises.readFile(path.join(workdir, 'reports', 'result.json'), 'utf8')).toBe('{"n":1}');
  });

  it('workdir(脚本通道):无会话且无 scriptWorkdir 仍拒(无上下文不落盘的回归)', async () => {
    const { slot } = makeHarness(dataRoot, { callSessionId: null });
    const r = await slot.handleFsRequest(GHOST_ID, {
      type: 'fs-request', op: 'write', root: 'workdir', path: 'x.md', content: 'x', callId: 'call-1',
    });
    expect(r).toMatchObject({ ok: false });
    expect((r as { message: string }).message).toContain('未配置有效的工作目录');
  });

  it('workdir:会话通道的无会话调用(sessionId null)报「无会话上下文」,不冒名脚本通道(review nit)', async () => {
    // resolveSessionContext 查无时会登记 channel:'session' + sessionId:null——
    // 照拒,但话术必须保住「无会话上下文」,不能误报「脚本通道」。
    const { slot } = makeHarness(dataRoot, { callSessionId: null, callChannel: 'session' });
    const r = await slot.handleFsRequest(GHOST_ID, {
      type: 'fs-request', op: 'write', root: 'workdir', path: 'x.md', content: 'x', callId: 'call-1',
    });
    expect(r).toMatchObject({ ok: false });
    expect((r as { message: string }).message).toContain('无会话上下文');
  });

  it('workdir(脚本通道):已交卷/已清扫的 callId 立即失效(用完即废,review M1)', async () => {
    // inFlight:false 模拟条目已 settle/回收——即使归属账(宽限窗)里还查得到,
    // 目录授权也必须在交卷时点失效,不等懒清扫。
    const { slot } = makeHarness(dataRoot, {
      callSessionId: null,
      callScriptWorkdir: workdir,
      inFlight: false,
    });
    const r = await slot.handleFsRequest(GHOST_ID, {
      type: 'fs-request', op: 'write', root: 'workdir', path: 'late/poison.json', content: 'x', callId: 'call-1',
    });
    expect(r).toMatchObject({ ok: false });
    expect((r as { message: string }).message).toContain('授权已失效');
    expect(fs.existsSync(path.join(workdir, 'late', 'poison.json'))).toBe(false);
  });

  it('workdir(脚本通道):越界路径/不存在的根/非绝对根都拒', async () => {
    const { slot } = makeHarness(dataRoot, { callSessionId: null, callScriptWorkdir: workdir });
    // 越界相对路径:全套路径纪律对脚本通道同样生效。
    expect(await slot.handleFsRequest(GHOST_ID, {
      type: 'fs-request', op: 'write', root: 'workdir', path: '../escape.txt', content: 'x', callId: 'call-1',
    })).toMatchObject({ ok: false });
    expect(fs.existsSync(path.join(tmpRoot, 'escape.txt'))).toBe(false);
    // 根不存在:fail-closed,不为脚本通道自动 mkdir 根目录。
    const missing = makeHarness(dataRoot, {
      callSessionId: null,
      callScriptWorkdir: path.join(tmpRoot, 'no-such-dir'),
    });
    const rMissing = await missing.slot.handleFsRequest(GHOST_ID, {
      type: 'fs-request', op: 'write', root: 'workdir', path: 'x.md', content: 'x', callId: 'call-1',
    });
    expect(rMissing).toMatchObject({ ok: false });
    expect((rMissing as { message: string }).message).toContain('脚本工作目录不存在');
    // 失败必须无副作用:根目录没有被顺手建出来。
    expect(fs.existsSync(path.join(tmpRoot, 'no-such-dir'))).toBe(false);
    // 非绝对根:登记侧只应放绝对路径,这里防御性拒。
    const relative = makeHarness(dataRoot, { callSessionId: null, callScriptWorkdir: 'relative/dir' });
    expect(await relative.slot.handleFsRequest(GHOST_ID, {
      type: 'fs-request', op: 'write', root: 'workdir', path: 'x.md', content: 'x', callId: 'call-1',
    })).toMatchObject({ ok: false });
  });

  it('workdir(脚本通道):登记后工作目录被删 → realpath fail-closed,不自动重建根目录', async () => {
    const doomed = path.join(tmpRoot, 'doomed-workdir');
    await fs.promises.mkdir(doomed, { recursive: true });
    const { slot } = makeHarness(dataRoot, { callSessionId: null, callScriptWorkdir: doomed });
    await fs.promises.rm(doomed, { recursive: true, force: true });
    const r = await slot.handleFsRequest(GHOST_ID, {
      type: 'fs-request', op: 'write', root: 'workdir', path: 'x.md', content: 'x', callId: 'call-1',
    });
    expect(r).toMatchObject({ ok: false });
    expect((r as { message: string }).message).toContain('脚本工作目录不存在');
    expect(fs.existsSync(doomed)).toBe(false);
  });

  it('workdir(脚本通道):路径白名单——只放行恰好等于 out_file 的写入(review P1 第五轮)', async () => {
    const { slot } = makeHarness(dataRoot, {
      callSessionId: null,
      callScriptWorkdir: workdir,
      callScriptWritePath: 'reports/result.json',
    });
    // 声明路径:放行。
    const ok = await slot.handleFsRequest(GHOST_ID, {
      type: 'fs-request', op: 'write', root: 'workdir', path: 'reports/result.json', content: '{}', callId: 'call-1',
    });
    expect(ok).toMatchObject({ ok: true });
    // 根内其它路径(合法相对路径但未声明):拒——在途插件写不了 src/ 等无关文件。
    const denied = await slot.handleFsRequest(GHOST_ID, {
      type: 'fs-request', op: 'write', root: 'workdir', path: 'src/evil.ts', content: 'x', callId: 'call-1',
    });
    expect(denied).toMatchObject({ ok: false });
    expect((denied as { message: string }).message).toContain('仅授权写入');
    expect(fs.existsSync(path.join(workdir, 'src', 'evil.ts'))).toBe(false);
  });
});
