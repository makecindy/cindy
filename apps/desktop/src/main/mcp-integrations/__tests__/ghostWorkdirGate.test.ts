/**
 * ghostWorkdirGate.test.ts — ghost_call 的 workdir / 过户授权生效链路测试(规则 14)。
 *
 * 用真实 ghostWorkdirPrefs(electron userData mock 到 os.tmpdir 临时目录,
 * 规则 23:测试路径不落仓库工作区)+ mock 掉 ghost.ts 的重依赖,覆盖:
 *   1. 写路径 roundtrip:set → 生效;清最后一条 → 键删除、文件删除(reset);
 *      Windows 两种写法(正/反斜杠、大小写)归一同键;
 *   2. getRosterItems / listAwakeGhosts 按会话 workdir 过滤被禁用的意识;
 *   3. callGhostTool 兜底拒绝(GHOST_DISABLED_IN_WORKDIR),派发器零触碰;
 *      未禁用的意识照常派发。
 *   4. Claude Code / Codex / Pi 的 Full Access 对 attachments / dir / save_dir
 *      自动过户，降档恢复确认；缺会话、查询失败、远程会话 fail closed。
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  GhostSetupEnsureRequest,
  GhostSetupEnsureResult,
} from '../../cindy-brain/ghostSetupCoordinator';

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-workdir-gate-'));
const prefsFile = () => path.join(tmpUserData, 'ghost-workdir-prefs.json');
const outsideDir = path.join(tmpUserData, 'outside');
const logWarnMock = vi.fn();
const logInfoMock = vi.fn();
const grantAttachmentsMock = vi.fn();
const { packGhostDirMock } = vi.hoisted(() => ({ packGhostDirMock: vi.fn() }));
const releaseMutationMock = vi.fn();
const captureMutationOwnerMock = vi.fn(() => ({
  mode: 'local' as const,
  dataOwnerId: 'test',
  generation: 0,
}));
const acquireMutationLeaseMock = vi.fn(() => releaseMutationMock);
const confirmRequestMock = vi.fn(async () => ({ confirmed: true, allowDirs: false }));
const classifyLocalAttachmentPathMock = vi.fn();
const resolveGhostAttachmentUrlMock = vi.fn();
type TestLedgerRef = {
  hash: string;
  refKind: string;
  refId: string;
  originKind?: 'user' | 'tool';
};
const ledgerRefs: TestLedgerRef[] = [];
const ledgerHasRefMock = vi.fn(async (params: TestLedgerRef) =>
  ledgerRefs.some(
    (ref) =>
      ref.hash === params.hash &&
      ref.refKind === params.refKind &&
      ref.refId === params.refId &&
      (params.originKind === undefined || ref.originKind === params.originKind),
  ),
);
const ledgerHasGhostToolGrantMock = vi.fn(
  async (params: { hash: string; ghostId: string }) =>
    ledgerRefs.some(
      (ref) =>
        ref.hash === params.hash &&
        ref.refId === params.ghostId &&
        ref.originKind === 'tool' &&
        (ref.refKind === 'ghost-tool-grant' || ref.refKind === 'ghost-grant'),
    ),
);
const ledgerAddRefMock = vi.fn(async (params: TestLedgerRef) => {
  ledgerRefs.push({ ...params });
  return `ref-${ledgerRefs.length}`;
});
const dirDepositMock = vi.fn(() => ({ ok: true, receipt: { token: 'dir-ticket' } }));
const saveDepositMock = vi.fn(() => ({ ok: true, receipt: { token: 'save-ticket' } }));
const liveGrantStateMock = vi.fn();
const alsSessionContextMock = vi.fn();
const resolvedAttachmentOrigins: Array<'user' | 'tool' | undefined> = [];

vi.mock('electron', () => ({ app: { getPath: () => tmpUserData } }));
vi.mock('../../appSessionState.js', () => ({
  ownerScopedUserDataPath: (...parts: string[]) => path.join(tmpUserData, ...parts),
}));
vi.mock('../../maker-host/logger-adapter.js', () => ({
  desktopMakerLogger: { child: () => ({ info: () => {}, warn: () => {}, error: () => {} }) },
}));
vi.mock('../../logger.js', () => ({
  createLogger: () => ({ info: logInfoMock, warn: logWarnMock, error: () => {}, debug: () => {} }),
}));
// Claude 走建线闭包 ctx；Codex / Pi 用此 mock 模拟 HTTP bridge 的 ALS 恢复。
vi.mock('@cindy/mcps', () => ({ getLiziMcpSessionContext: () => alsSessionContextMock() }));

const WORKDIR = '/proj/alpha';
const listMock = vi.fn<() => unknown[]>(() => []);
const dispatchMock = vi.fn(async () => ({ ok: true as const, result: 'done' }));
const setupAssessmentMock = vi.fn((_ghostId: string) => {
  void _ghostId;
  return {
    state: 'ready' as const,
    revision: 0,
    groups: [],
  };
});
const ensureReadyMock = vi.fn(
  async (_request: GhostSetupEnsureRequest): Promise<GhostSetupEnsureResult> => {
    void _request;
    return {
      ok: true as const,
      assessment: { state: 'ready' as const, revision: 0, groups: [] },
    };
  },
);
const sessionSnapshotMock = vi.fn(async (): Promise<{
  workingDir: string;
  permissionMode: string;
  planModeEnabled: boolean;
  remoteHostId: string | null;
}> => ({
  workingDir: WORKDIR,
  permissionMode: 'auto',
  planModeEnabled: false,
  remoteHostId: null,
}));
vi.mock('../../cindy-brain/index.js', () => ({
  getGhostManager: () => ({ list: listMock, managedRootDirs: () => [] }),
  ghostForgeForbiddenRootDirs: () => [],
  listAvailableGhostsForAuthorization: () => listMock(),
  findAvailableGhostForAuthorization: (id: string) =>
    listMock().find((ghost: any) => ghost.manifest?.id === id) ?? null,
  captureGhostMutationOwnerForMcp: captureMutationOwnerMock,
  acquireGhostMutationLeaseForMcp: acquireMutationLeaseMock,
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
  collectDirFiles: () => ({ ok: true, files: [], totalBytes: 0 }),
  getDirDepositVault: () => ({ deposit: dirDepositMock }),
  getSaveDepositVault: () => ({ deposit: saveDepositMock }),
  isPathInsideDir: () => false,
}));
vi.mock('../../cindy-brain/ghostGrantConfirmBridge.js', () => ({
  getGhostGrantConfirmBridge: () => ({ request: confirmRequestMock }),
}));
vi.mock('../../cindy-brain/ghostLocalPathGrant.js', () => ({
  classifyLocalAttachmentPath: classifyLocalAttachmentPathMock,
}));
vi.mock('../../cindy-brain/cardService.js', () => ({ withCardToken: (r: unknown) => r }));
vi.mock('../../cindy-brain/forge.js', () => ({
  FORGE_GUIDE: 'guide',
  packGhostDir: packGhostDirMock,
  scaffoldGhostDir: vi.fn(),
}));
vi.mock('../../cindy-brain/openFileInstall.js', () => ({ handleIncomingCindyFile: vi.fn() }));
vi.mock('../../localDb/ipc/sessions.js', () => ({
  getSessionFsSnapshot: sessionSnapshotMock,
}));
vi.mock('../../cindy-media/blobStore.js', () => ({ mimeForExt: () => 'image/png' }));
vi.mock('../../cindy-media/ledger.js', () => ({
  hasRef: ledgerHasRefMock,
  hasGhostToolGrant: ledgerHasGhostToolGrantMock,
  addRef: ledgerAddRefMock,
}));
vi.mock('../../cindy-media/attachmentGrantGate.js', () => ({ chatAttachmentOrigin: vi.fn() }));
vi.mock('../ghostAttachmentResolve.js', () => ({
  resolveGhostAttachmentUrl: resolveGhostAttachmentUrlMock,
}));

const { getCindyGhostsMcpDeps } = await import('../ghost');
const { setGhostDisabledForWorkdir, listDisabledGhostIdsForWorkdir, isGhostDisabledForWorkdir } =
  await import('../../cindy-brain/ghostWorkdirPrefs');
import type { LiziMcpSessionContext } from '@cindy/mcps';

function chipGhost(id: string, slots: string[] = ['tool']): unknown {
  return {
    enabled: true,
    manifest: {
      id,
      name: `Ghost ${id}`,
      kind: 'chip',
      slots,
      tools: [{ name: 'run', description: 'd' }],
    },
  };
}

type TestAgentKind = 'claude-code' | 'codex' | 'pi';

function makeDeps(
  agentKind: TestAgentKind = 'claude-code',
  sessionId: string | null = 's1',
  sessionInstanceId: string | null = sessionId ? `${sessionId}-instance` : null,
) {
  const ctx = {
    agentKind,
    workingDir: WORKDIR,
    vendorOptions: {},
    ...(sessionId ? { sessionId } : {}),
    ...(sessionInstanceId ? { sessionInstanceId } : {}),
  } as unknown as LiziMcpSessionContext;
  // Claude 的 in-process server 闭包 session ctx；Codex/Pi 的共享 HTTP bridge
  // 在 tool-call 时从 ALS 恢复真实 ctx。
  alsSessionContextMock.mockReturnValue(agentKind === 'claude-code' ? undefined : ctx);
  return getCindyGhostsMcpDeps(agentKind === 'claude-code' ? ctx : undefined, {
    getLiveSessionGrantState: liveGrantStateMock,
  });
}

function clearAllPrefs(): void {
  // 把测试涉及的目录 × id 全部清一遍(幂等;清空后 store 自动删文件)。
  for (const dir of [WORKDIR, '/proj/beta', 'E:/Repo']) {
    for (const id of ['art', 'other']) setGhostDisabledForWorkdir(dir, id, false);
  }
}

beforeEach(() => {
  fs.mkdirSync(outsideDir, { recursive: true });
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
  grantAttachmentsMock.mockImplementation(
    async (
      deps: {
        resolveImageUrl: (url: string) => Promise<{
          absPath: string;
          originKind?: 'user' | 'tool';
          buffer?: Uint8Array;
        }>;
        addRef: (params: TestLedgerRef) => Promise<string>;
      },
      params: { urls: string[]; ghostId: string; maxCount?: number },
    ) => {
      if (params.urls.length > (params.maxCount ?? 4)) {
        return { ok: false, message: `附件过多(单次上限 ${params.maxCount ?? 4} 张)` };
      }
      const hashes: string[] = [];
      for (const url of params.urls) {
        const resolved = await deps.resolveImageUrl(url);
        resolvedAttachmentOrigins.push(resolved.originKind);
        const buffer = resolved.buffer ?? (await fs.promises.readFile(resolved.absPath));
        const hash = createHash('sha256').update(buffer).digest('hex');
        const originKind = resolved.originKind ?? 'user';
        await deps.addRef({
          hash,
          refKind: originKind === 'user' ? 'ghost-grant' : 'ghost-tool-grant',
          refId: params.ghostId,
          originKind,
        });
        hashes.push(hash);
      }
      return { ok: true, hashes };
    },
  );
  resolvedAttachmentOrigins.length = 0;
  confirmRequestMock.mockReset();
  confirmRequestMock.mockResolvedValue({ confirmed: true, allowDirs: false });
  classifyLocalAttachmentPathMock.mockReset();
  classifyLocalAttachmentPathMock.mockImplementation((url: string) => {
    const stat = fs.statSync(url);
    return {
      kind: 'outside-workdir',
      absPath: url,
      mimeType: 'image/png',
      size: stat.size,
      name: path.basename(url),
    };
  });
  resolveGhostAttachmentUrlMock.mockReset();
  resolveGhostAttachmentUrlMock.mockImplementation(() => {
    throw new Error('not a managed media URL');
  });
  ledgerHasRefMock.mockReset();
  ledgerHasRefMock.mockImplementation(async (params: TestLedgerRef) =>
    ledgerRefs.some(
      (ref) =>
        ref.hash === params.hash &&
        ref.refKind === params.refKind &&
        ref.refId === params.refId &&
        (params.originKind === undefined || ref.originKind === params.originKind),
    ),
  );
  ledgerHasGhostToolGrantMock.mockReset();
  ledgerHasGhostToolGrantMock.mockImplementation(
    async (params: { hash: string; ghostId: string }) =>
      ledgerRefs.some(
        (ref) =>
          ref.hash === params.hash &&
          ref.refId === params.ghostId &&
          ref.originKind === 'tool' &&
          (ref.refKind === 'ghost-tool-grant' || ref.refKind === 'ghost-grant'),
      ),
  );
  ledgerAddRefMock.mockReset();
  ledgerAddRefMock.mockImplementation(async (params: TestLedgerRef) => {
    ledgerRefs.push({ ...params });
    return `ref-${ledgerRefs.length}`;
  });
  ledgerRefs.length = 0;
  dirDepositMock.mockClear();
  saveDepositMock.mockClear();
  liveGrantStateMock.mockReset();
  liveGrantStateMock.mockReturnValue({ permissionMode: 'auto', remoteHostId: null });
  alsSessionContextMock.mockReset();
  logWarnMock.mockClear();
  logInfoMock.mockClear();
  releaseMutationMock.mockClear();
  captureMutationOwnerMock.mockClear();
  acquireMutationLeaseMock.mockClear();
  sessionSnapshotMock.mockReset();
  sessionSnapshotMock.mockResolvedValue({
    workingDir: WORKDIR,
    permissionMode: 'auto',
    planModeEnabled: false,
    remoteHostId: null,
  });
  packGhostDirMock.mockReset();
  packGhostDirMock.mockResolvedValue({
    ok: false,
    errorCode: 'MANIFEST_INVALID',
    message: 'stop after gate assertion',
  });
  clearAllPrefs();
});

describe('Forge session workdir gate', () => {
  it('holds the owner mutation lease across the Forge operation', async () => {
    const operation = makeDeps().forgePack({ dir: path.join(WORKDIR, 'plugin-src') });
    expect(captureMutationOwnerMock).toHaveBeenCalledTimes(1);
    expect(acquireMutationLeaseMock).toHaveBeenCalledTimes(1);
    expect(releaseMutationMock).not.toHaveBeenCalled();
    await operation;
    expect(releaseMutationMock).toHaveBeenCalledTimes(1);
  });

  it('passes the active session workdir into packGhostDir', async () => {
    await makeDeps().forgePack({ dir: path.join(WORKDIR, 'plugin-src') });
    expect(packGhostDirMock).toHaveBeenCalledWith(path.join(WORKDIR, 'plugin-src'), {
      sessionWorkdir: WORKDIR,
      forbiddenRootDirs: [],
    });
  });

  it('rejects remote workdirs before touching local Forge fs', async () => {
    sessionSnapshotMock.mockResolvedValueOnce({
      workingDir: '/remote/project',
      permissionMode: 'auto',
      planModeEnabled: false,
      remoteHostId: 'ssh-1',
    });
    const deps = makeDeps();
    await expect(deps.forgePack({ dir: '/remote/project/plugin-src' })).resolves.toMatchObject({
      ok: false,
      errorCode: 'WORKDIR_NOT_LOCAL',
    });
    expect(packGhostDirMock).not.toHaveBeenCalled();
  });

  it('rejects Forge writes in read-only or plan sessions', async () => {
    sessionSnapshotMock.mockResolvedValueOnce({
      workingDir: WORKDIR,
      permissionMode: 'ask',
      planModeEnabled: true,
      remoteHostId: null,
    });
    const deps = makeDeps();
    await expect(
      deps.forgeScaffold({ dir: path.join(WORKDIR, 'new-plugin'), template: 'plain', id: 'x', name: 'X' }),
    ).resolves.toMatchObject({ ok: false, errorCode: 'WORKDIR_READ_ONLY' });
  });
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
    expect(r).not.toHaveProperty('setup');
    expect(dispatchMock).toHaveBeenCalledTimes(1);
  });

  it('ready + scope stale 时成功 envelope 附非阻塞 reauthSuggest', async () => {
    const assessment = {
      state: 'ready' as const,
      revision: 3,
      groups: [],
      reauthSuggest: {
        ghostId: 'art',
        secretKey: 'account',
        missingScopes: ['scope.new'],
        missingScopeCount: 1,
        requirement: {
          ref: 'secret:account',
          kind: 'oauth' as const,
          label: 'Account',
          action: {
            id: 'oauth_connect:secret:account',
            kind: 'oauth_connect' as const,
          },
        },
      },
    };
    setupAssessmentMock.mockReturnValue(assessment);

    const result = await makeDeps().callGhostTool({ ghostId: 'art', tool: 'run', args: {} });

    expect(result).toMatchObject({
      ok: true,
      result: 'done',
      setup: { state: 'ready', reauthSuggest: { secretKey: 'account' } },
    });
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

  it('grant_only 在 Full Access 下自动交接，降档后恢复确认并保留 provenance', async () => {
    const file = path.join(outsideDir, 'grant-only-full-access.png');
    fs.writeFileSync(file, 'grant-only-bytes');
    let permissionMode = 'bypassPermissions';
    liveGrantStateMock.mockImplementation(() => ({ permissionMode, remoteHostId: null }));
    const deps = makeDeps('codex', 'grant-only-full-access');

    const fullAccessResult = await deps.callGhostTool({
      ghostId: 'art',
      tool: 'ignored-tool',
      args: {},
      attachments: [file],
      grantOnly: true,
    });

    expect(fullAccessResult).toMatchObject({
      ok: true,
      result: expect.objectContaining({ granted_count: 1 }),
    });
    expect(confirmRequestMock).not.toHaveBeenCalled();
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(resolvedAttachmentOrigins).toEqual(['tool']);
    expect(ledgerRefs).toEqual([
      expect.objectContaining({
        refKind: 'ghost-tool-grant',
        refId: 'art',
        originKind: 'tool',
      }),
    ]);

    permissionMode = 'ask';
    const downgradedResult = await deps.callGhostTool({
      ghostId: 'art',
      tool: 'ignored-tool',
      args: {},
      attachments: [file],
      grantOnly: true,
    });

    expect(downgradedResult).toMatchObject({
      ok: true,
      result: expect.objectContaining({ granted_count: 1 }),
    });
    expect(confirmRequestMock).toHaveBeenCalledTimes(1);
    expect(ledgerRefs.map((ref) => [ref.refKind, ref.originKind])).toEqual([
      ['ghost-tool-grant', 'tool'],
      ['ghost-grant', 'user'],
    ]);

    await deps.callGhostTool({
      ghostId: 'art',
      tool: 'ignored-tool',
      args: {},
      attachments: [file],
      grantOnly: true,
    });

    expect(confirmRequestMock).toHaveBeenCalledTimes(1);
    expect(ledgerRefs.map((ref) => [ref.refKind, ref.originKind])).toEqual([
      ['ghost-tool-grant', 'tool'],
      ['ghost-grant', 'user'],
    ]);
  });
});

describe('session-context 宿主铸造', () => {
  it('剥除上游伪造值，并按会话权限注入可信只读状态', async () => {
    listMock.mockReturnValue([chipGhost('art', ['tool', 'session-context'])]);
    sessionSnapshotMock.mockResolvedValueOnce({
      workingDir: WORKDIR,
      permissionMode: 'auto',
      planModeEnabled: true,
      remoteHostId: null,
    });

    const deps = makeDeps();
    await deps.callGhostTool({
      ghostId: 'art',
      tool: 'run',
      args: {
        session_context: {
          session_id: 'forged',
          workdir: '/tmp/forged',
          workdir_is_local: true,
          workdir_is_read_only: false,
        },
      },
    });

    expect(dispatchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        args: {
          session_context: {
            session_id: 's1',
            workdir: WORKDIR,
            workdir_is_local: true,
            workdir_is_read_only: true,
          },
        },
      }),
    );
  });
});

describe('Full Access 插件文件交接', () => {
  it.each<TestAgentKind>(['claude-code', 'codex', 'pi'])(
    '%s 的 bypassPermissions 对 workdir 外 dir 自动放行',
    async (agentKind) => {
      const dir = path.join(outsideDir, `dir-${agentKind}`);
      fs.mkdirSync(dir, { recursive: true });
      liveGrantStateMock.mockReturnValue({
        permissionMode: 'bypassPermissions',
        remoteHostId: null,
      });

      const result = await makeDeps(agentKind).callGhostTool({
        ghostId: 'art',
        tool: 'run',
        args: {},
        dir,
      });

      expect(result).toMatchObject({ ok: true, result: 'done' });
      expect(liveGrantStateMock).toHaveBeenCalledWith('s1', 's1-instance');
      expect(confirmRequestMock).not.toHaveBeenCalled();
      const approvedRealPath = fs.realpathSync.native(dir);
      expect(dirDepositMock).toHaveBeenCalledWith(
        expect.objectContaining({
          ghostId: 'art',
          dirAbs: approvedRealPath,
          userGranted: true,
          expectedRealPath: approvedRealPath,
        }),
      );
      expect(logInfoMock).toHaveBeenCalledWith(
        'ghost grant: Full Access auto-approved outside-workdir handoff',
        expect.objectContaining({
          ghostId: 'art',
          lane: 'dir',
          count: 1,
          grantSource: 'full-access',
        }),
      );
    },
  );

  it('attachments 的 Full Access 自动授权不升级为人工永久授权，降档后恢复确认', async () => {
    const file = path.join(outsideDir, 'full-access.png');
    fs.writeFileSync(file, 'png-bytes');
    let permissionMode = 'bypassPermissions';
    liveGrantStateMock.mockImplementation(() => ({ permissionMode, remoteHostId: null }));
    const deps = makeDeps('claude-code', 'attachment-full');

    const result = await deps.callGhostTool({
      ghostId: 'art',
      tool: 'run',
      args: {},
      attachments: [file],
    });

    expect(result).toMatchObject({ ok: true, result: 'done' });
    expect(confirmRequestMock).not.toHaveBeenCalled();
    expect(resolvedAttachmentOrigins).toEqual(['tool']);
    expect(ledgerRefs).toEqual([
      expect.objectContaining({
        refKind: 'ghost-tool-grant',
        refId: 'art',
        originKind: 'tool',
      }),
    ]);
    expect(logInfoMock).toHaveBeenCalledWith(
      'ghost grant: Full Access auto-approved outside-workdir handoff',
      expect.objectContaining({ lane: 'attachments', grantSource: 'full-access' }),
    );
    expect(logInfoMock).not.toHaveBeenCalledWith(
      'ghost grant confirm: user approved outside-workdir attachments',
      expect.anything(),
    );

    permissionMode = 'ask';
    await deps.callGhostTool({
      ghostId: 'art',
      tool: 'run',
      args: {},
      attachments: [file],
    });

    expect(confirmRequestMock).toHaveBeenCalledTimes(1);
    expect(ledgerHasRefMock).toHaveBeenCalledWith(
      expect.objectContaining({
        refKind: 'ghost-grant',
        refId: 'art',
        originKind: 'user',
      }),
    );
    expect(ledgerRefs.map((ref) => [ref.refKind, ref.originKind])).toEqual([
      ['ghost-tool-grant', 'tool'],
      ['ghost-grant', 'user'],
    ]);

    await deps.callGhostTool({
      ghostId: 'art',
      tool: 'run',
      args: {},
      attachments: [file],
    });

    expect(confirmRequestMock).toHaveBeenCalledTimes(1);
    expect(ledgerRefs.map((ref) => [ref.refKind, ref.originKind])).toEqual([
      ['ghost-tool-grant', 'tool'],
      ['ghost-grant', 'user'],
    ]);
  });

  it('同一 Full Access attachment 重复交接只保留一条工具授权引用', async () => {
    const file = path.join(outsideDir, 'full-access-repeat.png');
    fs.writeFileSync(file, 'repeat-bytes');
    liveGrantStateMock.mockReturnValue({
      permissionMode: 'bypassPermissions',
      remoteHostId: null,
    });
    const deps = makeDeps('pi', 'attachment-repeat');

    await deps.callGhostTool({
      ghostId: 'art',
      tool: 'run',
      args: {},
      attachments: [file],
    });
    await deps.callGhostTool({
      ghostId: 'art',
      tool: 'run',
      args: {},
      attachments: [file],
    });

    expect(confirmRequestMock).not.toHaveBeenCalled();
    expect(ledgerRefs).toEqual([
      expect.objectContaining({
        refKind: 'ghost-tool-grant',
        refId: 'art',
        originKind: 'tool',
      }),
    ]);
    expect(ledgerAddRefMock).toHaveBeenCalledTimes(1);
  });

  it('总仓 blob 可复用既有人工 ghost-grant provenance，不再询问', async () => {
    const file = path.join(outsideDir, 'managed-user.png');
    const bytes = Buffer.from('managed-user');
    fs.writeFileSync(file, bytes);
    const hash = createHash('sha256').update(bytes).digest('hex');
    ledgerRefs.push({ hash, refKind: 'ghost-grant', refId: 'art', originKind: 'user' });
    resolveGhostAttachmentUrlMock.mockReturnValue({
      absPath: file,
      mimeType: 'image/png',
      blobHash: hash,
    });

    const result = await makeDeps('codex', 'managed-user').callGhostTool({
      ghostId: 'art',
      tool: 'run',
      args: {},
      attachments: [`xdt-media://blob/${hash}`],
    });

    expect(result).toMatchObject({ ok: true, result: 'done' });
    expect(confirmRequestMock).not.toHaveBeenCalled();
    expect(resolvedAttachmentOrigins).toEqual(['user']);
    expect(ledgerRefs).toEqual([
      { hash, refKind: 'ghost-grant', refId: 'art', originKind: 'user' },
    ]);
    expect(ledgerAddRefMock).not.toHaveBeenCalled();
  });

  it('总仓 blob 的工具 provenance 只在当前 Full Access 下复用，降档后回到用户确认', async () => {
    const file = path.join(outsideDir, 'managed-tool.png');
    const bytes = Buffer.from('managed-tool');
    fs.writeFileSync(file, bytes);
    const hash = createHash('sha256').update(bytes).digest('hex');
    ledgerRefs.push({ hash, refKind: 'ghost-tool-grant', refId: 'art', originKind: 'tool' });
    resolveGhostAttachmentUrlMock.mockReturnValue({
      absPath: file,
      mimeType: 'image/png',
      blobHash: hash,
    });
    liveGrantStateMock.mockReturnValue({ permissionMode: 'bypassPermissions', remoteHostId: null });
    const deps = makeDeps('codex', 'managed-tool');
    const blobUrl = `xdt-media://blob/${hash}`;

    const fullAccessResult = await deps.callGhostTool({
      ghostId: 'art',
      tool: 'run',
      args: {},
      attachments: [blobUrl],
    });

    expect(fullAccessResult).toMatchObject({ ok: true, result: 'done' });
    expect(confirmRequestMock).not.toHaveBeenCalled();
    expect(resolvedAttachmentOrigins).toEqual(['tool']);
    expect(ledgerRefs).toEqual([
      { hash, refKind: 'ghost-tool-grant', refId: 'art', originKind: 'tool' },
    ]);

    liveGrantStateMock.mockReturnValue({ permissionMode: 'ask', remoteHostId: null });
    const downgradedResult = await deps.callGhostTool({
      ghostId: 'art',
      tool: 'run',
      args: {},
      attachments: [blobUrl],
    });

    expect(downgradedResult).toMatchObject({ ok: true, result: 'done' });
    expect(confirmRequestMock).toHaveBeenCalledTimes(1);
    expect(confirmRequestMock).toHaveBeenCalledWith(
      'managed-tool',
      expect.objectContaining({
        lane: 'attachments',
        items: [expect.objectContaining({ name: 'managed-tool.png' })],
      }),
    );
    expect(resolvedAttachmentOrigins).toEqual(['tool', 'user']);
    expect(ledgerRefs).toEqual([
      { hash, refKind: 'ghost-tool-grant', refId: 'art', originKind: 'tool' },
      { hash, refKind: 'ghost-grant', refId: 'art', originKind: 'user' },
    ]);

    await deps.callGhostTool({
      ghostId: 'art',
      tool: 'run',
      args: {},
      attachments: [blobUrl],
    });
    expect(confirmRequestMock).toHaveBeenCalledTimes(1);
  });

  it('旧版 ghost-grant/tool 在 Full Access 下兼容交接，降档后仍只走用户确认', async () => {
    const file = path.join(outsideDir, 'legacy-managed-tool.png');
    const bytes = Buffer.from('legacy-managed-tool');
    fs.writeFileSync(file, bytes);
    const hash = createHash('sha256').update(bytes).digest('hex');
    ledgerRefs.push({ hash, refKind: 'ghost-grant', refId: 'art', originKind: 'tool' });
    resolveGhostAttachmentUrlMock.mockReturnValue({
      absPath: file,
      mimeType: 'image/png',
      blobHash: hash,
    });
    liveGrantStateMock.mockReturnValue({ permissionMode: 'bypassPermissions', remoteHostId: null });
    const deps = makeDeps('pi', 'legacy-managed-tool');
    const blobUrl = `xdt-media://blob/${hash}`;

    const fullAccessResult = await deps.callGhostTool({
      ghostId: 'art',
      tool: 'run',
      args: {},
      attachments: [blobUrl],
    });

    expect(fullAccessResult).toMatchObject({ ok: true, result: 'done' });
    expect(confirmRequestMock).not.toHaveBeenCalled();
    expect(resolvedAttachmentOrigins).toEqual(['tool']);
    expect(ledgerRefs).toEqual(
      expect.arrayContaining([
        { hash, refKind: 'ghost-grant', refId: 'art', originKind: 'tool' },
        { hash, refKind: 'ghost-tool-grant', refId: 'art', originKind: 'tool' },
      ]),
    );
    expect(ledgerRefs).not.toContainEqual({ hash, refKind: 'ghost-grant', refId: 'art', originKind: 'user' });

    liveGrantStateMock.mockReturnValue({ permissionMode: 'auto', remoteHostId: null });
    const downgradedResult = await deps.callGhostTool({
      ghostId: 'art',
      tool: 'run',
      args: {},
      attachments: [blobUrl],
    });

    expect(downgradedResult).toMatchObject({ ok: true, result: 'done' });
    expect(confirmRequestMock).toHaveBeenCalledTimes(1);
    expect(resolvedAttachmentOrigins).toEqual(['tool', 'user']);
    expect(ledgerRefs).toContainEqual({ hash, refKind: 'ghost-grant', refId: 'art', originKind: 'user' });

    await deps.callGhostTool({
      ghostId: 'art',
      tool: 'run',
      args: {},
      attachments: [blobUrl],
    });
    expect(confirmRequestMock).toHaveBeenCalledTimes(1);
  });

  it('grant_only 对多个既有工具 provenance 在降档下只弹一张确认卡', async () => {
    const entries = ['batch-a', 'batch-b'].map((label) => {
      const file = path.join(outsideDir, `${label}.png`);
      const bytes = Buffer.from(label);
      fs.writeFileSync(file, bytes);
      const hash = createHash('sha256').update(bytes).digest('hex');
      return { file, hash, url: `xdt-media://blob/${hash}` };
    });
    const byUrl = new Map(
      entries.map((entry) => [
        entry.url,
        { absPath: entry.file, mimeType: 'image/png', blobHash: entry.hash },
      ]),
    );
    for (const entry of entries) {
      ledgerRefs.push({
        hash: entry.hash,
        refKind: 'ghost-tool-grant',
        refId: 'art',
        originKind: 'tool',
      });
    }
    resolveGhostAttachmentUrlMock.mockImplementation((url: string) => {
      const resolved = byUrl.get(url);
      if (!resolved) throw new Error('not a managed media URL');
      return resolved;
    });
    liveGrantStateMock.mockReturnValue({ permissionMode: 'ask', remoteHostId: null });

    const result = await makeDeps('pi', 'managed-tool-batch').callGhostTool({
      ghostId: 'art',
      tool: 'ignored-tool',
      args: {},
      attachments: entries.map((entry) => entry.url),
      grantOnly: true,
    });

    expect(result).toMatchObject({
      ok: true,
      result: expect.objectContaining({ granted_count: 2 }),
    });
    expect(confirmRequestMock).toHaveBeenCalledTimes(1);
    expect(confirmRequestMock).toHaveBeenCalledWith(
      'managed-tool-batch',
      expect.objectContaining({
        lane: 'attachments',
        items: [
          expect.objectContaining({ name: 'batch-a.png' }),
          expect.objectContaining({ name: 'batch-b.png' }),
        ],
      }),
    );
    expect(resolvedAttachmentOrigins).toEqual(['user', 'user']);
    expect(ledgerRefs).toHaveLength(4);
    expect(ledgerRefs.filter((ref) => ref.refKind === 'ghost-grant')).toHaveLength(2);
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it('managed 工具 provenance 在批量预读前受总字节上限保护', async () => {
    const file = path.join(outsideDir, 'managed-too-large.png');
    fs.writeFileSync(file, 'sparse-placeholder');
    const descriptor = fs.openSync(file, 'r+');
    try {
      fs.ftruncateSync(descriptor, 1024 * 1024 * 1024 + 1);
    } finally {
      fs.closeSync(descriptor);
    }
    const hash = createHash('sha256').update('sparse-placeholder').digest('hex');
    ledgerRefs.push({ hash, refKind: 'ghost-tool-grant', refId: 'art', originKind: 'tool' });
    resolveGhostAttachmentUrlMock.mockReturnValue({
      absPath: file,
      mimeType: 'image/png',
      blobHash: hash,
    });
    liveGrantStateMock.mockReturnValue({ permissionMode: 'bypassPermissions', remoteHostId: null });

    const result = await makeDeps('codex', 'managed-too-large').callGhostTool({
      ghostId: 'art',
      tool: 'run',
      args: {},
      attachments: [`xdt-media://blob/${hash}`],
    });

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'ATTACHMENT_INVALID',
      message: expect.stringContaining('总体积过大'),
    });
    expect(confirmRequestMock).not.toHaveBeenCalled();
    expect(grantAttachmentsMock).not.toHaveBeenCalled();
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it('超出附件张数上限时不触发 managed provenance 预读或确认', async () => {
    const entries = Array.from({ length: 5 }, (_, index) => {
      const file = path.join(outsideDir, `over-limit-${index}.png`);
      const bytes = Buffer.from(`over-limit-${index}`);
      fs.writeFileSync(file, bytes);
      const hash = createHash('sha256').update(bytes).digest('hex');
      return { file, hash, url: `xdt-media://blob/${hash}` };
    });
    const byUrl = new Map(
      entries.map((entry) => [
        entry.url,
        { absPath: entry.file, mimeType: 'image/png', blobHash: entry.hash },
      ]),
    );
    for (const entry of entries) {
      ledgerRefs.push({
        hash: entry.hash,
        refKind: 'ghost-tool-grant',
        refId: 'art',
        originKind: 'tool',
      });
    }
    resolveGhostAttachmentUrlMock.mockImplementation((url: string) => {
      const resolved = byUrl.get(url);
      if (!resolved) throw new Error('not a managed media URL');
      return resolved;
    });
    liveGrantStateMock.mockReturnValue({ permissionMode: 'ask', remoteHostId: null });

    const result = await makeDeps('pi', 'managed-tool-over-limit').callGhostTool({
      ghostId: 'art',
      tool: 'run',
      args: {},
      attachments: entries.map((entry) => entry.url),
    });

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'ATTACHMENT_INVALID',
      message: expect.stringContaining('附件过多'),
    });
    expect(confirmRequestMock).not.toHaveBeenCalled();
    expect(grantAttachmentsMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ maxCount: 4 }),
    );
    expect(resolvedAttachmentOrigins).toEqual([]);
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: '远程 Full Access',
      configure: () =>
        liveGrantStateMock.mockReturnValue({
          permissionMode: 'bypassPermissions',
          remoteHostId: 'remote-1',
        }),
      sessionInstanceId: 'remote-instance',
    },
    {
      name: 'live session 缺失',
      configure: () => liveGrantStateMock.mockReturnValue(null),
      sessionInstanceId: 'missing-instance',
    },
    {
      name: 'live permission 查询失败',
      configure: () =>
        liveGrantStateMock.mockImplementation(() => {
          throw new Error('runtime registry unavailable');
        }),
      sessionInstanceId: 'failed-instance',
    },
    {
      name: 'instance 缺失',
      configure: () =>
        liveGrantStateMock.mockReturnValue({
          permissionMode: 'bypassPermissions',
          remoteHostId: null,
        }),
      sessionInstanceId: null,
    },
  ] as const)(
    '$name 下工具 provenance fail closed 到用户确认',
    async ({ configure, sessionInstanceId }) => {
      const file = path.join(outsideDir, 'managed-tool-fail-closed.png');
      const bytes = Buffer.from('managed-tool-fail-closed');
      fs.writeFileSync(file, bytes);
      const hash = createHash('sha256').update(bytes).digest('hex');
      ledgerRefs.push({ hash, refKind: 'ghost-tool-grant', refId: 'art', originKind: 'tool' });
      resolveGhostAttachmentUrlMock.mockReturnValue({
        absPath: file,
        mimeType: 'image/png',
        blobHash: hash,
      });
      configure();

      const result = await makeDeps(
        'pi',
        'managed-tool-fail-closed',
        sessionInstanceId,
      ).callGhostTool({
        ghostId: 'art',
        tool: 'run',
        args: {},
        attachments: [`xdt-media://blob/${hash}`],
      });

      expect(result).toMatchObject({ ok: true, result: 'done' });
      expect(confirmRequestMock).toHaveBeenCalledTimes(1);
      expect(resolvedAttachmentOrigins).toEqual(['user']);
      expect(ledgerRefs).toEqual([
        { hash, refKind: 'ghost-tool-grant', refId: 'art', originKind: 'tool' },
        { hash, refKind: 'ghost-grant', refId: 'art', originKind: 'user' },
      ]);
    },
  );

  it('save_dir 在 Full Access 下不弹卡并继续签发票据', async () => {
    const dir = path.join(outsideDir, 'save-full-access');
    fs.mkdirSync(dir, { recursive: true });
    liveGrantStateMock.mockReturnValue({
      permissionMode: 'bypassPermissions',
      remoteHostId: null,
    });

    const result = await makeDeps('pi', 'save-full').callGhostTool({
      ghostId: 'art',
      tool: 'run',
      args: {},
      saveDir: dir,
    });

    expect(result).toMatchObject({ ok: true, result: 'done' });
    expect(confirmRequestMock).not.toHaveBeenCalled();
    const approvedRealPath = fs.realpathSync.native(dir);
    expect(saveDepositMock).toHaveBeenCalledWith(
      expect.objectContaining({
        ghostId: 'art',
        dirAbs: approvedRealPath,
        userGranted: true,
        expectedRealPath: approvedRealPath,
      }),
    );
    expect(logInfoMock).toHaveBeenCalledWith(
      'ghost grant: Full Access auto-approved outside-workdir handoff',
      expect.objectContaining({ lane: 'save_dir', grantSource: 'full-access' }),
    );
  });

  it('save_dir 从 Full Access 热切回 ask 后立即恢复确认', async () => {
    const dir = path.join(outsideDir, 'save-hot-switch');
    fs.mkdirSync(dir, { recursive: true });
    let permissionMode = 'bypassPermissions';
    liveGrantStateMock.mockImplementation(() => ({ permissionMode, remoteHostId: null }));
    const deps = makeDeps('pi', 'save-hot-switch-session');

    await deps.callGhostTool({ ghostId: 'art', tool: 'run', args: {}, saveDir: dir });
    expect(confirmRequestMock).not.toHaveBeenCalled();

    permissionMode = 'ask';
    await deps.callGhostTool({ ghostId: 'art', tool: 'run', args: {}, saveDir: dir });

    expect(confirmRequestMock).toHaveBeenCalledTimes(1);
    expect(confirmRequestMock).toHaveBeenCalledWith(
      'save-hot-switch-session',
      expect.objectContaining({ ghostId: 'art', lane: 'save_dir' }),
    );
  });

  it('从 Full Access 热切回 ask 后，同一路径立即恢复确认', async () => {
    const dir = path.join(outsideDir, 'hot-switch');
    fs.mkdirSync(dir, { recursive: true });
    let permissionMode = 'bypassPermissions';
    liveGrantStateMock.mockImplementation(() => ({ permissionMode, remoteHostId: null }));
    const deps = makeDeps('codex', 'hot-switch-session');

    await deps.callGhostTool({ ghostId: 'art', tool: 'run', args: {}, dir });
    expect(confirmRequestMock).not.toHaveBeenCalled();

    permissionMode = 'ask';
    await deps.callGhostTool({ ghostId: 'art', tool: 'run', args: {}, dir });

    expect(confirmRequestMock).toHaveBeenCalledTimes(1);
    expect(confirmRequestMock).toHaveBeenCalledWith(
      'hot-switch-session',
      expect.objectContaining({ ghostId: 'art', lane: 'dir' }),
    );
  });

  it('同 business sessionId 的旧 MCP context 不能借用新 Session 实例权限', async () => {
    const dir = path.join(outsideDir, 'same-id-replacement');
    fs.mkdirSync(dir, { recursive: true });
    liveGrantStateMock.mockImplementation((_sessionId, sessionInstanceId) =>
      sessionInstanceId === 'new-instance'
        ? { permissionMode: 'bypassPermissions', remoteHostId: null }
        : null,
    );

    const result = await makeDeps('codex', 'same-business-id', 'old-instance').callGhostTool({
      ghostId: 'art',
      tool: 'run',
      args: {},
      dir,
    });

    expect(result).toMatchObject({ ok: true, result: 'done' });
    expect(liveGrantStateMock).toHaveBeenCalledWith('same-business-id', 'old-instance');
    expect(confirmRequestMock).toHaveBeenCalledTimes(1);
  });

  it('缺 session instance id 时不能借 Full Access 自动扩权', async () => {
    const dir = path.join(outsideDir, 'missing-instance-id');
    fs.mkdirSync(dir, { recursive: true });
    liveGrantStateMock.mockReturnValue({
      permissionMode: 'bypassPermissions',
      remoteHostId: null,
    });

    const result = await makeDeps('claude-code', 'legacy-session', null).callGhostTool({
      ghostId: 'art',
      tool: 'run',
      args: {},
      dir,
    });

    expect(result).toMatchObject({ ok: true, result: 'done' });
    expect(liveGrantStateMock).not.toHaveBeenCalled();
    expect(confirmRequestMock).toHaveBeenCalledTimes(1);
  });

  it('dir 授权后原始 symlink 改指，也只给已裁决的 canonical 路径出票', async () => {
    const approved = path.join(outsideDir, 'dir-approved');
    const replacement = path.join(outsideDir, 'dir-replacement');
    const alias = path.join(outsideDir, 'dir-alias');
    fs.mkdirSync(approved, { recursive: true });
    fs.mkdirSync(replacement, { recursive: true });
    try {
      fs.symlinkSync(approved, alias, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      return;
    }
    const approvedRealPath = fs.realpathSync.native(alias);
    liveGrantStateMock.mockImplementation(() => {
      fs.rmSync(alias, { force: true });
      fs.symlinkSync(replacement, alias, process.platform === 'win32' ? 'junction' : 'dir');
      return { permissionMode: 'bypassPermissions', remoteHostId: null };
    });

    const result = await makeDeps('pi', 'dir-toctou').callGhostTool({
      ghostId: 'art',
      tool: 'run',
      args: {},
      dir: alias,
    });

    expect(result).toMatchObject({ ok: true, result: 'done' });
    expect(dirDepositMock).toHaveBeenCalledWith(
      expect.objectContaining({
        dirAbs: approvedRealPath,
        expectedRealPath: approvedRealPath,
        userGranted: true,
      }),
    );
  });

  it('save_dir 授权后原始 symlink 改指，也只给已裁决的 canonical 路径出票', async () => {
    const approved = path.join(outsideDir, 'save-approved');
    const replacement = path.join(outsideDir, 'save-replacement');
    const alias = path.join(outsideDir, 'save-alias');
    fs.mkdirSync(approved, { recursive: true });
    fs.mkdirSync(replacement, { recursive: true });
    try {
      fs.symlinkSync(approved, alias, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      return;
    }
    const approvedRealPath = fs.realpathSync.native(alias);
    liveGrantStateMock.mockImplementation(() => {
      fs.rmSync(alias, { force: true });
      fs.symlinkSync(replacement, alias, process.platform === 'win32' ? 'junction' : 'dir');
      return { permissionMode: 'bypassPermissions', remoteHostId: null };
    });

    const result = await makeDeps('claude-code', 'save-toctou').callGhostTool({
      ghostId: 'art',
      tool: 'run',
      args: {},
      saveDir: alias,
    });

    expect(result).toMatchObject({ ok: true, result: 'done' });
    expect(saveDepositMock).toHaveBeenCalledWith(
      expect.objectContaining({
        dirAbs: approvedRealPath,
        expectedRealPath: approvedRealPath,
        userGranted: true,
      }),
    );
  });

  it.each(['ask', 'default', 'acceptEdits', 'plan', 'auto'] as const)(
    '%s 不自动批准 workdir 外过户',
    async (permissionMode) => {
      const sessionId = `mode-${permissionMode}`;
      const dir = path.join(outsideDir, sessionId);
      fs.mkdirSync(dir, { recursive: true });
      liveGrantStateMock.mockReturnValue({ permissionMode, remoteHostId: null });

      const result = await makeDeps('claude-code', sessionId).callGhostTool({
        ghostId: 'art',
        tool: 'run',
        args: {},
        dir,
      });

      expect(result).toMatchObject({ ok: true, result: 'done' });
      expect(confirmRequestMock).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    {
      name: 'live session 缺失',
      sessionId: 'missing-live',
      configure: () => liveGrantStateMock.mockReturnValue(null),
    },
    {
      name: 'live permission 查询失败',
      sessionId: 'lookup-failed',
      configure: () =>
        liveGrantStateMock.mockImplementation(() => {
          throw new Error('runtime registry unavailable');
        }),
    },
    {
      name: '远程 Full Access 会话',
      sessionId: 'remote-full',
      configure: () =>
        liveGrantStateMock.mockReturnValue({
          permissionMode: 'bypassPermissions',
          remoteHostId: 'remote-1',
        }),
    },
  ])('$name fail closed 到原确认路径', async ({ sessionId, configure }) => {
    const dir = path.join(outsideDir, sessionId);
    fs.mkdirSync(dir, { recursive: true });
    configure();

    const result = await makeDeps('pi', sessionId).callGhostTool({
      ghostId: 'art',
      tool: 'run',
      args: {},
      dir,
    });

    expect(result).toMatchObject({ ok: true, result: 'done' });
    expect(confirmRequestMock).toHaveBeenCalledTimes(1);
  });

  it('没有 sessionId 时不能借 Full Access 自动扩权', async () => {
    const dir = path.join(outsideDir, 'anonymous');
    fs.mkdirSync(dir, { recursive: true });
    liveGrantStateMock.mockReturnValue({
      permissionMode: 'bypassPermissions',
      remoteHostId: null,
    });

    const result = await makeDeps('claude-code', null).callGhostTool({
      ghostId: 'art',
      tool: 'run',
      args: {},
      dir,
    });

    expect(result).toMatchObject({ ok: false, errorCode: 'DIR_INVALID' });
    expect(liveGrantStateMock).not.toHaveBeenCalled();
    expect(confirmRequestMock).not.toHaveBeenCalled();
    expect(dispatchMock).not.toHaveBeenCalled();
  });
});
