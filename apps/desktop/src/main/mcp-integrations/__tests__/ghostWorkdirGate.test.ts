/**
 * ghostWorkdirGate.test.ts — 目录级禁用的**生效链路**测试(规则 14)。
 *
 * 用真实 ghostWorkdirPrefs(electron userData mock 到 os.tmpdir 临时目录,
 * 规则 23:测试路径不落仓库工作区)+ mock 掉 ghost.ts 的重依赖,覆盖:
 *   1. 写路径 roundtrip:set → 生效;清最后一条 → 键删除、文件删除(reset);
 *      Windows 两种写法(正/反斜杠、大小写)归一同键;
 *   2. getRosterItems / listAwakeGhosts 按会话 workdir 过滤被禁用的意识;
 *   3. callGhostTool 兜底拒绝(GHOST_DISABLED_IN_WORKDIR),派发器零触碰;
 *      未禁用的意识照常派发。
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  GhostSetupEnsureRequest,
  GhostSetupEnsureResult,
} from '../../cindy-brain/ghostSetupCoordinator';

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-workdir-gate-'));
const prefsFile = () => path.join(tmpUserData, 'ghost-workdir-prefs.json');
const logWarnMock = vi.fn();
const grantAttachmentsMock = vi.fn();

vi.mock('electron', () => ({ app: { getPath: () => tmpUserData } }));
vi.mock('../../appSessionState.js', () => ({
  ownerScopedUserDataPath: (...parts: string[]) => path.join(tmpUserData, ...parts),
}));
vi.mock('../../maker-host/logger-adapter.js', () => ({
  desktopMakerLogger: { child: () => ({ info: () => {}, warn: () => {}, error: () => {} }) },
}));
vi.mock('../../logger.js', () => ({
  createLogger: () => ({ info: () => {}, warn: logWarnMock, error: () => {}, debug: () => {} }),
}));
// ALS 语境:恒缺省 → resolveSessionContext 走建线闭包 ctx(claude 路径同款)。
vi.mock('@cindy/mcps', () => ({ getLiziMcpSessionContext: () => undefined }));

const listMock = vi.fn<() => unknown[]>(() => []);
const dispatchMock = vi.fn(async () => ({ ok: true as const, result: 'done' }));
const setupAssessmentMock = vi.fn((_ghostId: string) => ({
  state: 'ready' as const,
  revision: 0,
  groups: [],
}));
const ensureReadyMock = vi.fn(
  async (_request: GhostSetupEnsureRequest): Promise<GhostSetupEnsureResult> => ({
    ok: true as const,
    assessment: { state: 'ready' as const, revision: 0, groups: [] },
  }),
);
vi.mock('../../cindy-brain/index.js', () => ({
  getGhostManager: () => ({ list: listMock }),
  getGhostPipeDispatcher: () => ({ callGhostTool: dispatchMock }),
  getGhostCardService: () => ({ registerCall: () => {}, finalizeCall: () => null }),
  getGhostSetupAssessment: setupAssessmentMock,
  isGhostAvailableForActiveSession: () => true,
}));
vi.mock('../../cindy-brain/ghostSetupCoordinator.js', () => ({
  getGhostSetupCoordinator: () => ({
    ensureReady: ensureReadyMock,
  }),
}));
// 以下依赖在本测试路径上不会被触达,但 import 副作用重,一律断开。
vi.mock('../../cindy-brain/attachmentGrant.js', () => ({
  GrantPolicyError: class extends Error {},
  grantAttachmentsToGhost: grantAttachmentsMock,
  MAX_GRANT_ATTACHMENTS: 4,
  MAX_GRANT_ONLY_ATTACHMENTS: 32,
}));
vi.mock('../../cindy-brain/dirDeposit.js', () => ({
  collectDirFiles: vi.fn(),
  getDirDepositVault: vi.fn(),
  getSaveDepositVault: vi.fn(),
  isPathInsideDir: () => false,
}));
vi.mock('../../cindy-brain/ghostGrantConfirmBridge.js', () => ({ getGhostGrantConfirmBridge: vi.fn() }));
vi.mock('../../cindy-brain/ghostLocalPathGrant.js', () => ({ classifyLocalAttachmentPath: vi.fn() }));
vi.mock('../../cindy-brain/cardService.js', () => ({ withCardToken: (r: unknown) => r }));
vi.mock('../../cindy-brain/forge.js', () => ({ FORGE_GUIDE: 'guide', packGhostDir: vi.fn() }));
vi.mock('../../cindy-brain/openFileInstall.js', () => ({ handleIncomingCindyFile: vi.fn() }));
vi.mock('../../cindy-media/blobStore.js', () => ({}));
vi.mock('../../cindy-media/ledger.js', () => ({}));
vi.mock('../../cindy-media/attachmentGrantGate.js', () => ({ chatAttachmentOrigin: vi.fn() }));
vi.mock('../ghostAttachmentResolve.js', () => ({ resolveGhostAttachmentUrl: vi.fn() }));

const { getCindyGhostsMcpDeps } = await import('../ghost');
const { setGhostDisabledForWorkdir, listDisabledGhostIdsForWorkdir, isGhostDisabledForWorkdir } =
  await import('../../cindy-brain/ghostWorkdirPrefs');
import type { LiziMcpSessionContext } from '@cindy/mcps';

const WORKDIR = '/proj/alpha';

function chipGhost(id: string): unknown {
  return {
    enabled: true,
    manifest: { id, name: `Ghost ${id}`, kind: 'chip', tools: [{ name: 'run', description: 'd' }] },
  };
}

function makeDeps() {
  const ctx = {
    agentKind: 'claude-code',
    workingDir: WORKDIR,
    vendorOptions: {},
    sessionId: 's1',
  } as unknown as LiziMcpSessionContext;
  return getCindyGhostsMcpDeps(ctx);
}

function clearAllPrefs(): void {
  // 把测试涉及的目录 × id 全部清一遍(幂等;清空后 store 自动删文件)。
  for (const dir of [WORKDIR, '/proj/beta', 'E:/Repo']) {
    for (const id of ['art', 'other']) setGhostDisabledForWorkdir(dir, id, false);
  }
}

beforeEach(() => {
  listMock.mockReset();
  listMock.mockReturnValue([chipGhost('art'), chipGhost('other')]);
  dispatchMock.mockClear();
  setupAssessmentMock.mockReset();
  setupAssessmentMock.mockReturnValue({ state: 'ready', revision: 0, groups: [] });
  ensureReadyMock.mockReset();
  ensureReadyMock.mockResolvedValue({
    ok: true,
    assessment: { state: 'ready', revision: 0, groups: [] },
  });
  grantAttachmentsMock.mockReset();
  logWarnMock.mockClear();
  clearAllPrefs();
});

afterAll(() => {
  fs.rmSync(tmpUserData, { recursive: true, force: true });
});

describe('写路径 roundtrip(真实存储,tmp userData)', () => {
  it('set → 生效;清最后一条 → 键与文件一并删除(reset 语义)', () => {
    expect(setGhostDisabledForWorkdir(WORKDIR, 'art', true)).toEqual(['art']);
    expect(fs.existsSync(prefsFile())).toBe(true);
    expect(listDisabledGhostIdsForWorkdir(WORKDIR)).toEqual(['art']);
    expect(isGhostDisabledForWorkdir('art', WORKDIR)).toBe(true);
    expect(isGhostDisabledForWorkdir('art', '/proj/beta')).toBe(false);

    expect(setGhostDisabledForWorkdir(WORKDIR, 'art', false)).toEqual([]);
    expect(listDisabledGhostIdsForWorkdir(WORKDIR)).toEqual([]);
    // 全空 → writeOverrides 走 reset,文件删除(恢复默认 = 无 override 文件)。
    expect(fs.existsSync(prefsFile())).toBe(false);
  });

  it('Windows 正/反斜杠与大小写写法归一到同一键', () => {
    setGhostDisabledForWorkdir('E:/Repo', 'art', true);
    expect(isGhostDisabledForWorkdir('art', 'E:\\REPO\\')).toBe(true);
    setGhostDisabledForWorkdir('E:\\REPO\\', 'art', false);
    expect(isGhostDisabledForWorkdir('art', 'E:/Repo')).toBe(false);
  });
});

describe('花名册 / ghost_list 过滤', () => {
  it('被禁用的意识不进花名册与现查清单;其余照常', async () => {
    setGhostDisabledForWorkdir(WORKDIR, 'art', true);
    const deps = makeDeps();
    expect((deps.getRosterItems?.() ?? []).map((r) => r.id)).toEqual(['other']);
    expect((await deps.listAwakeGhosts()).map((g) => g.id)).toEqual(['other']);
  });

  it('无禁用时全量在列(基线不受影响)', async () => {
    const deps = makeDeps();
    expect((deps.getRosterItems?.() ?? []).map((r) => r.id)).toEqual(['art', 'other']);
    expect((await deps.listAwakeGhosts()).map((g) => g.id)).toEqual(['art', 'other']);
  });

  it('单插件 setup assessment 失败只省略该 setup，不拖垮健康清单', async () => {
    setupAssessmentMock.mockImplementation((ghostId) => {
      if (ghostId === 'art') throw new SyntaxError('malformed setup storage');
      return { state: 'ready', revision: 0, groups: [] };
    });

    const ghosts = await makeDeps().listAwakeGhosts();

    expect(ghosts.map((ghost) => ghost.id)).toEqual(['art', 'other']);
    expect(ghosts[0]?.setup).toBeUndefined();
    expect(ghosts[1]?.setup).toEqual({ state: 'ready', revision: 0, groups: [] });
    expect(logWarnMock).toHaveBeenCalledWith('ghost setup assessment omitted from roster', {
      ghostId: 'art',
      errorType: 'SyntaxError',
    });
    expect(JSON.stringify(ghosts)).not.toContain('malformed setup storage');
  });
});

describe('ghost_call 兜底拒绝', () => {
  it('禁用 → GHOST_DISABLED_IN_WORKDIR,派发器零触碰', async () => {
    setGhostDisabledForWorkdir(WORKDIR, 'art', true);
    const deps = makeDeps();
    const r = await deps.callGhostTool({ ghostId: 'art', tool: 'run', args: {} });
    expect(r).toMatchObject({ ok: false, errorCode: 'GHOST_DISABLED_IN_WORKDIR' });
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it('未禁用的意识照常派发;别的目录的禁用不误伤', async () => {
    setGhostDisabledForWorkdir('/proj/beta', 'art', true);
    const deps = makeDeps();
    const r = await deps.callGhostTool({ ghostId: 'art', tool: 'run', args: {} });
    expect(r).toMatchObject({ ok: true, result: 'done' });
    expect(dispatchMock).toHaveBeenCalledTimes(1);
  });

  it('清单 assessment 隔离不放宽 ghost_call 的 strict setup gate', async () => {
    ensureReadyMock.mockResolvedValueOnce({
      ok: false,
      errorCode: 'INTERNAL',
      message: '插件配置状态读取失败',
    });

    const result = await makeDeps().callGhostTool({
      ghostId: 'art',
      tool: 'run',
      args: {},
    });

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'INTERNAL',
      message: '插件配置状态读取失败',
    });
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it('grant_only 在任何附件授权副作用前完成 setup gate，且忽略 tool', async () => {
    ensureReadyMock.mockResolvedValueOnce({
      ok: false,
      errorCode: 'SETUP_REQUIRED',
      message: '插件尚未完成设置',
      setup: {
        state: 'required',
        revision: 1,
        groups: [],
      },
    });

    const result = await makeDeps().callGhostTool({
      ghostId: 'art',
      tool: 'not-a-real-tool',
      args: {},
      attachments: ['/tmp/unconfigured.png'],
      grantOnly: true,
    });

    expect(result).toMatchObject({ ok: false, errorCode: 'SETUP_REQUIRED' });
    expect(ensureReadyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 's1',
        ghostId: 'art',
        workingDir: WORKDIR,
      }),
    );
    expect(ensureReadyMock.mock.calls[0]?.[0]).not.toHaveProperty('tool');
    expect(grantAttachmentsMock).not.toHaveBeenCalled();
    expect(dispatchMock).not.toHaveBeenCalled();
  });
});
