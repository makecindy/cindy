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
import type { AttachmentGrantDeps } from '../../cindy-brain/attachmentGrant';
import type {
  GhostSetupEnsureRequest,
  GhostSetupEnsureResult,
} from '../../cindy-brain/ghostSetupCoordinator';
import { t } from '../../i18n';
import type { WriteDocsOutputFn } from '@cindy/mcps';
import { runDocsOutputWriteForTest } from '../../doc-tools/docsOutputWriterUtilityProcess.js';
import { handleGhostCall } from 'cindy-tools';

const { writeDocsOutputMock } = vi.hoisted(() => ({ writeDocsOutputMock: vi.fn<WriteDocsOutputFn>(async () => {}) }));
vi.mock('../../doc-tools/docsOutputWriter.js', () => ({ writeDocsOutput: writeDocsOutputMock }));
import type { CindyGhostsHostDeps } from '../ghost';

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-workdir-gate-'));
const prefsFile = () => path.join(tmpUserData, 'ghost-workdir-prefs.json');
const outsideDir = path.join(tmpUserData, 'outside');
const logWarnMock = vi.fn();
const logInfoMock = vi.fn();
const grantAttachmentsMock = vi.fn();
const { packGhostDirMock, scaffoldGhostDirMock, forgeInstallPackageMock } = vi.hoisted(() => ({
  packGhostDirMock: vi.fn(),
  scaffoldGhostDirMock: vi.fn(),
  forgeInstallPackageMock: vi.fn(),
}));
const { completeForgePackStagingMock } = vi.hoisted(() => ({
  completeForgePackStagingMock: vi.fn(() => ({
    ticket: 'publish-token-1',
    installPath: '/host/staging/demo.cindy',
    agentCindyPath: 'demo-1.0.0.cindy',
    packageSha256: 'a'.repeat(64),
  })),
}));
const {
  publishTicketConsumeMock,
  releaseForgePackStagingMock,
  startPluginPublishMock,
  currentPublisherIdentityMock,
} = vi.hoisted(() => ({
  publishTicketConsumeMock: vi.fn(),
  releaseForgePackStagingMock: vi.fn(),
  startPluginPublishMock: vi.fn(() => ({ transferId: 'transfer-1', uploadId: null })),
  currentPublisherIdentityMock: vi.fn<
    () => { membershipId: string; orgSlug: string; orgName: string } | null
  >(() => ({
    membershipId: 'member-1',
    orgSlug: 'acme',
    orgName: 'Acme',
  })),
}));
const releaseMutationMock = vi.fn();
const appSessionBoundaryPendingMock = vi.fn(() => false);
const appVersionMock = vi.fn(() => '2.3.4');
const captureMutationOwnerMock = vi.fn(() => ({
  mode: 'local' as const,
  dataOwnerId: 'test',
  generation: 0,
}));
const acquireMutationLeaseMock = vi.fn(() => releaseMutationMock);
const confirmRequestMock = vi.fn(async (): Promise<{ confirmed: boolean; allowDirs: boolean; reason?: string }> => ({ confirmed: true, allowDirs: false }));
const classifyLocalAttachmentPathMock = vi.fn();
const resolveGhostAttachmentUrlMock = vi.fn();
type TestLedgerRef = {
  hash: string;
  refKind: string;
  refId: string;
  originKind?: 'user' | 'tool';
  id?: string;
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
let ledgerRefSeq = 0;
const ledgerAddRefMock = vi.fn(async (params: TestLedgerRef) => {
  const id = params.id ?? `ref-${++ledgerRefSeq}`;
  ledgerRefs.push({ ...params, id });
  return id;
});
const ledgerRemoveSessionAttachmentRefMock = vi.fn(async (params: { sessionId: string; hash: string }) => {
  const before = ledgerRefs.length;
  for (let i = ledgerRefs.length - 1; i >= 0; i -= 1) {
    const ref = ledgerRefs[i]!;
    if (ref.refKind === 'session-attachment' && ref.refId === params.sessionId && ref.hash === params.hash) ledgerRefs.splice(i, 1);
  }
  return before - ledgerRefs.length;
});
const ledgerRemoveRefByIdMock = vi.fn(async (id: string) => {
  const index = ledgerRefs.findIndex(ref => ref.id === id);
  if (index < 0) return 0;
  ledgerRefs.splice(index, 1);
  return 1;
});
const remoteFsRequestMock = vi.fn<(hostId: string, method: string, params: Record<string, unknown>, options?: { beforeSend?: () => Promise<void> }) => Promise<unknown>>(async () => ({}));
const callCindyMediaMock = vi.fn();
const dirDepositMock = vi.fn(() => ({ ok: true, receipt: { token: 'dir-ticket' } }));
const saveDepositMock = vi.fn(() => ({ ok: true, receipt: { token: 'save-ticket' } }));
const liveGrantStateMock = vi.fn();
const alsSessionContextMock = vi.fn();
const resolvedAttachmentOrigins: Array<'user' | 'tool' | undefined> = [];

vi.mock('electron', () => ({ app: { getPath: () => tmpUserData } }));
vi.mock('../../appSessionState.js', () => ({
  ownerScopedUserDataPath: (...parts: string[]) => path.join(tmpUserData, ...parts),
  getActiveAppSession: () => ({ mode: 'cloud', dataOwnerId: 'member-1', generation: 7 }),
  isAppSessionBoundaryPending: appSessionBoundaryPendingMock,
}));
vi.mock('../../maker-host/logger-adapter.js', () => {
  const createMakerLogger = () => ({
    trace: () => {},
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    fatal: () => {},
    child: () => createMakerLogger(),
    isDebugEnabled: () => false,
  });
  return { createMakerLogger, desktopMakerLogger: createMakerLogger() };
});
vi.mock('../../logger.js', () => ({
  createLogger: () => ({ info: logInfoMock, warn: logWarnMock, error: () => {}, debug: () => {} }),
}));
// Claude 走建线闭包 ctx；Codex / Pi 用此 mock 模拟 HTTP bridge 的 ALS 恢复。
vi.mock('@cindy/mcps', () => ({ getLiziMcpSessionContext: () => alsSessionContextMock() }));

const isAuthorizationSessionMock = vi.fn(async () => false);
vi.mock('../../maker-ipc/botAuthorizationHost.js', () => ({ isBotAuthorizationSession: isAuthorizationSessionMock }));
const authorizationRequestMock = vi.fn(async () => ({ ok: true as const }));
vi.mock('../../maker-ipc/botAuthorizationService.js', () => ({
  getBotAuthorizationService: () => ({ request: authorizationRequestMock }),
}));

const WORKDIR = '/proj/alpha';
const listMock = vi.fn<() => unknown[]>(() => []);
const activeSessionAvailableMock = vi.fn((_ghostId: string) => true);
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
  installOrUpdateLocalGhostPackageFromForge: forgeInstallPackageMock,
  getGhostPipeDispatcher: () => ({ callGhostTool: dispatchMock }),
  getGhostCardService: () => ({ registerCall: () => {}, finalizeCall: () => null }),
  getGhostSetupAssessment: setupAssessmentMock,
  isGhostAvailableForActiveSession: activeSessionAvailableMock,
}));
vi.mock('../../cindy-brain/ghostSetupCoordinator.js', () => ({
  getGhostSetupCoordinator: () => ({
    ensureReady: ensureReadyMock,
  }),
}));
// 以下依赖在本测试路径上不会被触达,但 import 副作用重,一律断开。
vi.mock('../../cindy-brain/attachmentGrant.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../cindy-brain/attachmentGrant.js')>(),
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
  scaffoldGhostDir: scaffoldGhostDirMock,
}));
vi.mock('../../cindy-brain/forgePackStaging.js', () => ({
  completeForgePackStaging: completeForgePackStagingMock,
  getForgePackStagingController: () => ({
    consume: publishTicketConsumeMock,
    releaseStaging: releaseForgePackStagingMock,
  }),
  invalidateForgePackTicket: vi.fn(),
  releaseForgePackStaging: releaseForgePackStagingMock,
}));
vi.mock('../../localDb/ipc/sessions.js', () => ({
  getSessionFsSnapshot: sessionSnapshotMock,
}));
vi.mock('../../plugin-publisher/host.js', () => ({
  currentPublisherIdentity: currentPublisherIdentityMock,
  getPluginPublisherOrchestrator: vi.fn(),
  startPluginPublish: startPluginPublishMock,
}));
vi.mock('../../cindy-media/blobStore.js', () => ({
  mimeForExt: () => 'image/png',
  parseBlobUrl: (url: string) => {
    const match = /^cindy-media:\/\/blobs\/([a-f0-9]{64})\.png$/.exec(url);
    return match ? { hash: match[1], ext: '.png' } : null;
  },
}));
vi.mock('../../cindy-media/ledger.js', () => ({
  pinBlob: vi.fn(async () => {}),
  hasRef: ledgerHasRefMock,
  hasGhostToolGrant: ledgerHasGhostToolGrantMock,
  addRef: ledgerAddRefMock,
  removeRefById: ledgerRemoveRefByIdMock,
  removeSessionAttachmentRefIfUnreferencedByLiveMessage: ledgerRemoveSessionAttachmentRefMock,
}));
vi.mock('../../file-browser/remote-deps.js', () => ({
  getRemoteFileBrowser: () => ({ request: remoteFsRequestMock }),
}));
vi.mock('../../cindy-media/invocationService.js', () => ({
  callCindyMedia: callCindyMediaMock,
}));
vi.mock('../../cindy-media/attachmentGrantGate.js', () => ({ chatAttachmentOrigin: vi.fn() }));
vi.mock('../ghostAttachmentResolve.js', () => ({
  resolveGhostAttachmentUrl: resolveGhostAttachmentUrlMock,
}));

const { getCindyGhostsMcpDeps, getGhostRosterPrompt, REMOTE_WRITE_RECONCILE } = await import('../ghost');
const { createCindyGhostsMcpServer } = await import('cindy-tools');
const { setGhostDisabledForWorkdir, listDisabledGhostIdsForWorkdir, isGhostDisabledForWorkdir } =
  await import('../../cindy-brain/ghostWorkdirPrefs');
import type { LiziMcpSessionContext } from '@cindy/mcps';

function chipGhost(
  id: string,
  capabilities: string[] = ['tool'],
  extra: Record<string, unknown> = {},
): unknown {
  return {
    enabled: true,
    manifest: {
      id,
      name: `Ghost ${id}`,
      kind: 'chip',
      tools: [{ name: 'run', description: 'd' }],
      ...(capabilities.includes('panel') ? { panel: { html: 'panel.html' } } : {}),
      ...(capabilities.includes('session-context') ? { sessionContext: true } : {}),
      ...extra,
    },
  };
}

type TestAgentKind = 'claude-code' | 'codex' | 'pi';

function makeDeps(
  agentKind: TestAgentKind = 'claude-code',
  sessionId: string | null = 's1',
  sessionInstanceId: string | null = sessionId ? `${sessionId}-instance` : null,
  vendorOptions: Record<string, unknown> = {},
  pluginMarket?: CindyGhostsHostDeps['pluginMarket'],
) {
  const ctx = {
    agentKind,
    workingDir: WORKDIR,
    vendorOptions,
    ...(sessionId ? { sessionId } : {}),
    ...(sessionInstanceId ? { sessionInstanceId } : {}),
  } as unknown as LiziMcpSessionContext;
  // Claude 的 in-process server 闭包 session ctx；Codex/Pi 的共享 HTTP bridge
  // 在 tool-call 时从 ALS 恢复真实 ctx。
  alsSessionContextMock.mockReturnValue(agentKind === 'claude-code' ? undefined : ctx);
  return getCindyGhostsMcpDeps(agentKind === 'claude-code' ? ctx : undefined, {
    pluginMarket,
    getAppVersion: appVersionMock,
    getLiveSessionGrantState: liveGrantStateMock,
  });
}

function clearAllPrefs(): void {
  // 把测试涉及的目录 × id 全部清一遍(幂等;清空后 store 自动删文件)。
  for (const dir of [WORKDIR, `${WORKDIR} `, '/proj/beta', 'E:/Repo']) {
    for (const id of ['art', 'other', 'missing', 'sleeping', 'account']) {
      setGhostDisabledForWorkdir(dir, id, false);
    }
  }
}

beforeEach(() => {
  writeDocsOutputMock.mockReset();
  writeDocsOutputMock.mockResolvedValue(undefined);
  authorizationRequestMock.mockClear();
  isAuthorizationSessionMock.mockResolvedValue(false);
  fs.mkdirSync(outsideDir, { recursive: true });
  listMock.mockReset();
  listMock.mockReturnValue([chipGhost('art'), chipGhost('other')]);
  activeSessionAvailableMock.mockReset();
  activeSessionAvailableMock.mockReturnValue(true);
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
    return params.id ?? `ref-${ledgerRefs.length}`;
  });
  ledgerRefs.length = 0;
  dirDepositMock.mockClear();
  saveDepositMock.mockClear();
  liveGrantStateMock.mockReset();
  liveGrantStateMock.mockReturnValue({ permissionMode: 'auto', remoteHostId: null });
  remoteFsRequestMock.mockReset();
  remoteFsRequestMock.mockResolvedValue({});
  ledgerRemoveSessionAttachmentRefMock.mockClear();
  ledgerRemoveRefByIdMock.mockClear();
  callCindyMediaMock.mockReset();
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
  scaffoldGhostDirMock.mockReset();
  scaffoldGhostDirMock.mockResolvedValue({
    ok: true,
    dir: path.join(WORKDIR, 'new-plugin'),
    template: 'plain',
    files: ['ghost.json', 'main.js'],
    nextSteps: [],
  });
  forgeInstallPackageMock.mockReset();
  forgeInstallPackageMock.mockResolvedValue({
    action: 'installed',
    ghost: {
      enabled: true,
      manifest: { id: 'demo', name: 'Demo', version: '1.0.0' },
    },
  });
  completeForgePackStagingMock.mockClear();
  publishTicketConsumeMock.mockReset();
  publishTicketConsumeMock.mockReturnValue({
    owner: { mode: 'cloud', dataOwnerId: 'member-1', generation: 7 },
    operationKind: 'install',
    stagingPath: '/host/staging/demo.cindy',
    packageSha256: 'a'.repeat(64),
    manifestId: 'demo',
    packExpiresAt: Date.now() + 600_000,
  });
  releaseForgePackStagingMock.mockClear();
  startPluginPublishMock.mockClear();
  currentPublisherIdentityMock.mockReset();
  currentPublisherIdentityMock.mockReturnValue({
    membershipId: 'member-1',
    orgSlug: 'acme',
    orgName: 'Acme',
  });
  appSessionBoundaryPendingMock.mockReset();
  appSessionBoundaryPendingMock.mockReturnValue(false);
  appVersionMock.mockReset();
  appVersionMock.mockReturnValue('2.3.4');
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

  it('keeps default intent as pure packaging without exposing a publish token', async () => {
    packGhostDirMock.mockResolvedValueOnce({
      ok: true,
      buf: Buffer.from('packed'),
      cindyPath: path.join(WORKDIR, 'plugin-src', 'demo-1.0.0.cindy'),
      manifest: { id: 'demo', name: 'Demo', version: '1.0.0' },
    });
    const result = await makeDeps().forgePack({ dir: path.join(WORKDIR, 'plugin-src') });
    expect(result).toMatchObject({
      ok: true,
      cindyPath: path.join(WORKDIR, 'plugin-src', 'demo-1.0.0.cindy'),
    });
    if (!result.ok) throw new Error('default pack unexpectedly failed');
    expect(result).not.toHaveProperty('publishToken');
    expect(result.note).toContain('本工具不会安装或更新插件');
    expect(completeForgePackStagingMock).not.toHaveBeenCalled();
  });

  it('installs only through the explicit Forge install method and binds the packed bytes', async () => {
    const bytes = Buffer.from('packed');
    const cindyPath = path.join(WORKDIR, 'plugin-src', 'demo-1.0.0.cindy');
    packGhostDirMock.mockResolvedValueOnce({
      ok: true,
      buf: bytes,
      cindyPath,
      manifest: { id: 'demo', name: 'Demo', version: '1.0.0' },
    });

    const result = await makeDeps().forgeInstall({
      dir: path.join(WORKDIR, 'plugin-src'),
    });

    expect(forgeInstallPackageMock).toHaveBeenCalledWith(cindyPath, {
      ghostId: 'demo',
      packageSha256: createHash('sha256').update(bytes).digest('hex'),
    });
    expect(result).toMatchObject({
      ok: true,
      action: 'installed',
      id: 'demo',
      enabled: true,
    });
    expect(completeForgePackStagingMock).not.toHaveBeenCalled();
  });

  it('does not suggest organization publishing to a personal account after default pack', async () => {
    currentPublisherIdentityMock.mockReturnValueOnce(null);
    packGhostDirMock.mockResolvedValueOnce({
      ok: true,
      buf: Buffer.from('packed'),
      cindyPath: path.join(WORKDIR, 'plugin-src', 'demo-1.0.0.cindy'),
      manifest: { id: 'demo', name: 'Demo', version: '1.0.0' },
    });

    const result = await makeDeps().forgePack({ dir: path.join(WORKDIR, 'plugin-src') });

    // Excludes showing an unusable publish next step to personal accounts.
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('personal pack unexpectedly failed');
    expect(result.note).not.toContain("intent='publish'");
    // Default packaging remains independent from publisher identity.
    expect(result).not.toHaveProperty('publishToken');
  });

  it('returns the one-shot token for publish intent', async () => {
    packGhostDirMock.mockResolvedValueOnce({
      ok: true,
      buf: Buffer.from('packed'),
      cindyPath: path.join(WORKDIR, 'plugin-src', 'demo-1.0.0.cindy'),
      manifest: { id: 'demo', name: 'Demo', version: '1.0.0' },
    });
    const result = await makeDeps().forgePack({
      dir: path.join(WORKDIR, 'plugin-src'),
      intent: 'publish',
    });
    expect(result).toMatchObject({ ok: true, publishToken: 'publish-token-1' });
  });

  it('consumes the publish token and binds publisher input to ticket id, SHA and cleanup', async () => {
    const result = await makeDeps().forgePublish({ token: 'publish-token-1' });
    expect(result).toMatchObject({ ok: true, transferId: 'transfer-1', uploadId: null });
    expect(publishTicketConsumeMock).toHaveBeenCalledWith('publish-token-1');
    expect(startPluginPublishMock).toHaveBeenCalledWith(
      '/host/staging/demo.cindy',
      null,
      expect.objectContaining({
        manifestId: 'demo',
        packageSha256: 'a'.repeat(64),
        onTerminal: expect.any(Function),
      }),
    );
    const binding = (
      startPluginPublishMock.mock.calls as unknown as Array<[
        string,
        null,
        { onTerminal: () => void },
      ]>
    )[0]?.[2];
    binding?.onTerminal();
    expect(releaseForgePackStagingMock).toHaveBeenCalledWith('/host/staging/demo.cindy');
  });

  it('explains that an invalid publish token must come from a publish-intent pack', async () => {
    publishTicketConsumeMock.mockReturnValueOnce(undefined);

    const result = await makeDeps().forgePublish({ token: 'invalid-token' });

    expect(result).toMatchObject({ ok: false, errorCode: 'PUBLISH_TOKEN_INVALID' });
    if (result.ok) throw new Error('invalid publish token unexpectedly succeeded');
    expect(result.message).toContain(
      "只能由 ghost_forge_pack(intent='publish') 签发",
    );
  });

  it('keeps owner-mismatch and boundary-pending guidance distinct from invalid-token repacking', async () => {
    publishTicketConsumeMock.mockReturnValueOnce({
      owner: { mode: 'cloud', dataOwnerId: 'member-1', generation: 8 },
      operationKind: 'install',
      stagingPath: '/host/staging/demo.cindy',
      packageSha256: 'a'.repeat(64),
      manifestId: 'demo',
      packExpiresAt: Date.now() + 600_000,
    });
    const ownerMismatch = await makeDeps().forgePublish({ token: 'other-owner' });
    if (ownerMismatch.ok) throw new Error('owner-mismatch token unexpectedly succeeded');
    expect(ownerMismatch).toEqual({
      ok: false,
      errorCode: 'PUBLISH_TOKEN_OWNER_MISMATCH',
      message: '发布票据无效、已过期或已被使用，请重新打包',
    });

    appSessionBoundaryPendingMock.mockReturnValueOnce(true);
    const boundaryPending = await makeDeps().forgePublish({ token: 'boundary' });
    if (boundaryPending.ok) throw new Error('boundary-pending token unexpectedly succeeded');
    expect(boundaryPending).toEqual({
      ok: false,
      errorCode: 'SESSION_BOUNDARY_PENDING',
      message: '账号切换中，请稍后重试',
    });
    // Excludes collapsing account-boundary failures into the invalid-ticket fix.
    expect(ownerMismatch.message).not.toContain("intent='publish'");
    expect(boundaryPending.message).not.toContain("intent='publish'");
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

  it('uses the current stable Cindy version only as scaffold metadata for the concrete package', async () => {
    const deps = makeDeps();
    await expect(
      deps.forgeScaffold({
        dir: path.join(WORKDIR, 'new-plugin'),
        template: 'plain',
        id: 'new-plugin',
        name: 'New plugin',
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(scaffoldGhostDirMock).toHaveBeenCalledWith(
      expect.objectContaining({ minCindyVersion: '2.3.4' }),
      expect.any(Object),
    );
  });

  it('requires explicit package metadata when scaffold runs in an unpublished Cindy build', async () => {
    appVersionMock.mockReturnValue('0.0.0');
    const deps = makeDeps();
    await expect(
      deps.forgeScaffold({
        dir: path.join(WORKDIR, 'new-plugin'),
        template: 'plain',
        id: 'new-plugin',
        name: 'New plugin',
      }),
    ).resolves.toMatchObject({ ok: false, errorCode: 'INVALID_INPUT' });
    expect(scaffoldGhostDirMock).not.toHaveBeenCalled();

    await expect(
      deps.forgeScaffold({
        dir: path.join(WORKDIR, 'new-plugin'),
        template: 'plain',
        id: 'new-plugin',
        name: 'New plugin',
        minCindyVersion: '1.4.0',
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(scaffoldGhostDirMock).toHaveBeenCalledWith(
      expect.objectContaining({ minCindyVersion: '1.4.0' }),
      expect.any(Object),
    );

    scaffoldGhostDirMock.mockClear();
    await expect(
      deps.forgeScaffold({
        dir: path.join(WORKDIR, 'new-plugin'),
        template: 'plain',
        id: 'new-plugin',
        name: 'New plugin',
        minCindyVersion: '1.4.0-beta.1',
      }),
    ).resolves.toMatchObject({ ok: false, errorCode: 'INVALID_INPUT' });
    expect(scaffoldGhostDirMock).not.toHaveBeenCalled();

    await expect(
      deps.forgeScaffold({
        dir: path.join(WORKDIR, 'new-plugin'),
        template: 'plain',
        id: 'new-plugin',
        name: 'New plugin',
        minCindyVersion: '0.0.0',
      }),
    ).resolves.toMatchObject({ ok: false, errorCode: 'INVALID_INPUT' });
    expect(scaffoldGhostDirMock).not.toHaveBeenCalled();
  });
});

afterAll(() => {
  fs.rmSync(tmpUserData, { recursive: true, force: true });
});

describe('写路径 roundtrip(真实存储,tmp userData)', () => {
  it('keeps adjacent whitespace-distinct project overrides independent', () => {
    setGhostDisabledForWorkdir(WORKDIR, 'art', true);
    expect(isGhostDisabledForWorkdir('art', `${WORKDIR} `)).toBe(false);
    setGhostDisabledForWorkdir(`${WORKDIR} `, 'other', true);
    expect(listDisabledGhostIdsForWorkdir(`${WORKDIR} `)).toEqual(['other']);
    expect(listDisabledGhostIdsForWorkdir(WORKDIR)).toEqual(['art']);
  });
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

describe('connect_account shares Host live plugin policy', () => {
  it('passes dynamically discovered plugins to Host without treating builtin toolsets as plugin grants', async () => {
    const deps = makeDeps('claude-code', 'bot-session', 'bot-instance', {
      __cindyAllowedBuiltinPluginIds: ['memory', 'xdt_helper'],
    });
    await deps.connectAccount!({ kind: 'plugin', id: 'art' });
    expect(authorizationRequestMock).toHaveBeenCalledWith('bot-session', { kind: 'plugin', id: 'art' });
    await deps.connectAccount!({ kind: 'host', id: 'grok' });
    expect(authorizationRequestMock).toHaveBeenCalledTimes(2);
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

  it('Bot discovers installed plugins on demand without inheriting the full roster', async () => {
    const deps = makeDeps('claude-code', 'bot-session', 'bot-instance', {
      __cindyAllowedBuiltinPluginIds: ['memory', 'xdt_helper'],
    });
    expect(deps.getRosterItems?.()).toEqual([]);
    await expect(deps.listAwakeGhosts()).resolves.toMatchObject([{ id: 'art' }, { id: 'other' }]);
    await expect(deps.getAwakeGhost('art')).resolves.toMatchObject({ ok: true, ghost: { id: 'art' } });
    setGhostDisabledForWorkdir(WORKDIR, 'art', true);
    await expect(deps.getAwakeGhost('art')).resolves.toMatchObject({ ok: false, errorCode: 'GHOST_DISABLED_IN_WORKDIR' });
  });

  it('缺 workingDir 时 system 花名册 fail closed，不回退全量', () => {
    expect(getGhostRosterPrompt({})).toBe('');
    expect(getGhostRosterPrompt({ workingDir: '' })).toBe('');
    alsSessionContextMock.mockReturnValue(undefined);
    const deps = getCindyGhostsMcpDeps();
    const server = createCindyGhostsMcpServer(deps) as unknown as {
      _registeredTools: Record<string, { description?: string } | undefined>;
    };
    expect(server._registeredTools.ghost_list?.description).not.toContain('<ghost-roster>');
  });

  it('目录停用插件不进入 system 花名册', () => {
    setGhostDisabledForWorkdir(WORKDIR, 'art', true);
    const prompt = getGhostRosterPrompt({ workingDir: WORKDIR });
    expect(prompt).not.toContain('"id":"art"');
    expect(prompt).toContain('"id":"other"');
  });

  it('system 花名册与 ghost_list 描述使用同一 JSONL 块', () => {
    const deps = makeDeps();
    const systemPrompt = getGhostRosterPrompt({ workingDir: WORKDIR });
    const server = createCindyGhostsMcpServer(deps) as unknown as {
      _registeredTools: Record<string, { description?: string } | undefined>;
    };
    const listDescription = server._registeredTools.ghost_list?.description ?? '';
    const marker = '插件召回规则：以下是已安装插件作者提供的元数据';
    expect(listDescription.slice(listDescription.indexOf(marker))).toBe(systemPrompt);
  });

  it('ghost_list 召回线索优先 whenToUse，缺省回落 description', async () => {
    listMock.mockReturnValue([
      chipGhost('when', ['tool'], {
        name: 'When',
        description: '给人的介绍',
        whenToUse: '给模型的召回场景',
      }),
      chipGhost('fallback', ['tool'], {
        name: 'Fallback',
        description: '缺少 whenToUse 时的回落介绍',
      }),
    ]);

    const ghosts = await makeDeps().listAwakeGhosts();

    expect(ghosts.map(({ id, recall }) => ({ id, recall }))).toEqual([
      { id: 'when', recall: '给模型的召回场景' },
      { id: 'fallback', recall: '缺少 whenToUse 时的回落介绍' },
    ]);
  });

  it('ghost_info 命中时返回完整单条详情', async () => {
    listMock.mockReturnValue([
      chipGhost('art', ['tool'], {
        command: '画图',
        description: '给人的介绍',
        whenToUse: '需要画图或改图时使用',
        tools: [
          {
            name: 'run',
            description: '生成图片',
            parameters: { type: 'object' },
          },
        ],
      }),
    ]);

    await expect(makeDeps().getAwakeGhost('art')).resolves.toMatchObject({
      ok: true,
      ghost: {
        id: 'art',
        name: 'Ghost art',
        command: '画图',
        recall: '需要画图或改图时使用',
        setup: { state: 'ready' },
        tools: [
          {
            name: 'run',
            description: '生成图片',
            parameters: { type: 'object' },
          },
        ],
      },
    });
  });

  it('ghost_list/info 只投影 manual 轻量索引，ghost_manual 根索引不启动插件运行时', async () => {
    listMock.mockReturnValue([
      chipGhost('art', ['tool'], {
        manual: {
          items: [{ dir: 'private/docs', name: 'image-workflow', description: '完整画图工作流' }],
        },
      }),
    ]);
    const deps = makeDeps();
    await expect(deps.listAwakeGhosts()).resolves.toMatchObject([
      {
        id: 'art',
        manual: [{ name: 'image-workflow', description: '完整画图工作流' }],
      },
    ]);
    await expect(deps.getAwakeGhost('art')).resolves.toMatchObject({
      ok: true,
      ghost: { manual: [{ name: 'image-workflow', description: '完整画图工作流' }] },
    });
    await expect(deps.readGhostManual({ ghostId: 'art' })).resolves.toEqual({
      ok: true,
      manual: [{ name: 'image-workflow', description: '完整画图工作流' }],
      content: '',
    });
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(JSON.stringify(await deps.listAwakeGhosts())).not.toContain('private/docs');
  });

  it('ghost_info 对不存在目标优先返回 GHOST_NOT_FOUND', async () => {
    setGhostDisabledForWorkdir(WORKDIR, 'missing', true);
    activeSessionAvailableMock.mockReturnValue(false);

    await expect(makeDeps().getAwakeGhost('missing')).resolves.toEqual({
      ok: false,
      errorCode: 'GHOST_NOT_FOUND',
      message: t('newChat.pluginSetup.targetNotFound'),
    });
  });

  it('ghost_info 对未启用目标返回 GHOST_ASLEEP', async () => {
    listMock.mockReturnValue([
      { ...(chipGhost('sleeping') as Record<string, unknown>), enabled: false },
    ]);

    await expect(makeDeps().getAwakeGhost('sleeping')).resolves.toEqual({
      ok: false,
      errorCode: 'GHOST_ASLEEP',
      message: t('newChat.pluginSetup.targetDisabled'),
    });
  });

  it('ghost_info 对账号不可用目标返回未登录口径的 GHOST_NOT_FOUND', async () => {
    listMock.mockReturnValue([chipGhost('account')]);
    activeSessionAvailableMock.mockReturnValue(false);
    setGhostDisabledForWorkdir(WORKDIR, 'account', true);

    await expect(makeDeps().getAwakeGhost('account')).resolves.toEqual({
      ok: false,
      errorCode: 'GHOST_NOT_FOUND',
      message: '该插件需要 Cindy 账号，未登录状态不可用；不要重试，改用本地可用方式。',
    });
  });

  it('ghost_info 对目录停用目标优先于未启用返回 GHOST_DISABLED_IN_WORKDIR', async () => {
    listMock.mockReturnValue([
      { ...(chipGhost('sleeping') as Record<string, unknown>), enabled: false },
    ]);
    setGhostDisabledForWorkdir(WORKDIR, 'sleeping', true);

    await expect(makeDeps().getAwakeGhost('sleeping')).resolves.toMatchObject({
      ok: false,
      errorCode: 'GHOST_DISABLED_IN_WORKDIR',
    });
  });

  it('ghost_info 对无工具的纯面板插件返回写实提示', async () => {
    listMock.mockReturnValue([chipGhost('panel', ['panel'], { tools: [] })]);

    await expect(makeDeps().getAwakeGhost('panel')).resolves.toEqual({
      ok: false,
      errorCode: 'GHOST_NOT_FOUND',
      message: '该插件未声明任何可供调用的工具;不要重试,改用其它方式完成。',
    });
  });

  it('单插件 setup assessment 失败只省略该 setup，不拖垮查询', async () => {
    setupAssessmentMock.mockImplementation((ghostId) => {
      if (ghostId === 'art') throw new SyntaxError('malformed setup storage');
      return { state: 'ready', revision: 0, groups: [] };
    });

    const deps = makeDeps();
    const ghosts = await deps.listAwakeGhosts();
    const info = await deps.getAwakeGhost('art');

    expect(ghosts.map((ghost) => ghost.id)).toEqual(['art', 'other']);
    expect(ghosts[0]?.setup).toBeUndefined();
    expect(ghosts[1]?.setup).toEqual({ state: 'ready', revision: 0, groups: [] });
    expect(info).toMatchObject({ ok: true, ghost: { id: 'art' } });
    expect(info.ok && info.ghost.setup).toBeUndefined();
    expect(logWarnMock).toHaveBeenCalledTimes(2);
    expect(logWarnMock).toHaveBeenCalledWith('ghost setup assessment omitted from discovery', {
      ghostId: 'art',
      errorType: 'SyntaxError',
    });
    expect(JSON.stringify({ ghosts, info })).not.toContain('malformed setup storage');
  });
});

describe('ghost_call 兜底拒绝', () => {
  it('不存在优先于未登录与残留目录偏好返回 GHOST_NOT_FOUND', async () => {
    listMock.mockReturnValue([]);
    activeSessionAvailableMock.mockReturnValue(false);
    setGhostDisabledForWorkdir(WORKDIR, 'missing', true);

    await expect(
      makeDeps().callGhostTool({ ghostId: 'missing', tool: 'run', args: {} }),
    ).resolves.toEqual({
      ok: false,
      errorCode: 'GHOST_NOT_FOUND',
      message: t('newChat.pluginSetup.targetNotFound'),
    });
    expect(ensureReadyMock).not.toHaveBeenCalled();
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it('未登录优先于目录停用与未启用返回 GHOST_NOT_FOUND', async () => {
    listMock.mockReturnValue([
      { ...(chipGhost('account') as Record<string, unknown>), enabled: false },
    ]);
    activeSessionAvailableMock.mockReturnValue(false);
    setGhostDisabledForWorkdir(WORKDIR, 'account', true);

    await expect(
      makeDeps().callGhostTool({ ghostId: 'account', tool: 'run', args: {} }),
    ).resolves.toEqual({
      ok: false,
      errorCode: 'GHOST_NOT_FOUND',
      message: '该插件需要 Cindy 账号，未登录状态不可用；不要重试，改用本地可用方式。',
    });
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it('目录停用优先于未启用返回 GHOST_DISABLED_IN_WORKDIR', async () => {
    listMock.mockReturnValue([
      { ...(chipGhost('sleeping') as Record<string, unknown>), enabled: false },
    ]);
    setGhostDisabledForWorkdir(WORKDIR, 'sleeping', true);

    const result = await makeDeps().callGhostTool({
      ghostId: 'sleeping',
      tool: 'run',
      args: {},
    });
    expect(result).toMatchObject({
      ok: false,
      errorCode: 'GHOST_DISABLED_IN_WORKDIR',
      message: t('newChat.pluginSetup.targetDisabledInWorkdir'),
    });
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it('仅未启用时返回 GHOST_ASLEEP 与侧边栏启用引导', async () => {
    listMock.mockReturnValue([
      { ...(chipGhost('sleeping') as Record<string, unknown>), enabled: false },
    ]);

    const result = await makeDeps().callGhostTool({
      ghostId: 'sleeping',
      tool: 'run',
      args: {},
    });
    expect(result).toEqual({
      ok: false,
      errorCode: 'GHOST_ASLEEP',
      message: t('newChat.pluginSetup.targetDisabled'),
    });
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it('禁用 → GHOST_DISABLED_IN_WORKDIR,派发器零触碰', async () => {
    setGhostDisabledForWorkdir(WORKDIR, 'art', true);
    const deps = makeDeps();
    const r = await deps.callGhostTool({ ghostId: 'art', tool: 'run', args: {} });
    expect(r).toMatchObject({ ok: false, errorCode: 'GHOST_DISABLED_IN_WORKDIR' });
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it('Bot uses an installed plugin through the existing call and workdir authorization', async () => {
    const deps = makeDeps('claude-code', 'bot-session', 'bot-instance', {
      __cindyAllowedBuiltinPluginIds: ['memory', 'xdt_helper'],
    });
    await expect(deps.callGhostTool({ ghostId: 'art', tool: 'run', args: {} })).resolves.toMatchObject({ ok: true, result: 'done' });
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    setGhostDisabledForWorkdir(WORKDIR, 'art', true);
    await expect(deps.callGhostTool({ ghostId: 'art', tool: 'run', args: {} })).resolves.toMatchObject({ ok: false, errorCode: 'GHOST_DISABLED_IN_WORKDIR' });
    expect(dispatchMock).toHaveBeenCalledTimes(1);
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

describe('Cindy media 本机路径揭示', () => {
  it('只在用户点击允许后把已解析路径返回给 Agent', async () => {
    const url = `cindy-media://blobs/${'a'.repeat(64)}.png`;
    callCindyMediaMock.mockResolvedValue({
      ok: true,
      url,
      local_path: process.execPath,
      mime_type: 'image/png',
    });

    const result = await makeDeps('codex', 'media-path').callMedia?.({
      action: 'resolve_local_path',
      url,
    });

    expect(confirmRequestMock).toHaveBeenCalledWith(
      'media-path',
      expect.objectContaining({
        ghostId: 'cindy-media',
        ghostName: 'Cindy Media',
        lane: 'reveal_path',
        items: [
          expect.objectContaining({
            absPath: process.execPath,
            mimeType: 'image/png',
          }),
        ],
      }),
    );
    expect(result).toMatchObject({ ok: true, local_path: process.execPath });
  });

  it.each((['claude-code', 'codex', 'pi'] as const).flatMap((agentKind) =>
    (['session_closed', 'session_aborted'] as const).map((reason) => ({ agentKind, reason })),
  ))('$agentKind keeps $reason distinct from user denial on media and file handoffs', async ({ agentKind, reason }) => {
    const url = `cindy-media://blobs/${'b'.repeat(64)}.png`;
    callCindyMediaMock.mockResolvedValue({ ok: true, url, local_path: process.execPath, mime_type: 'image/png' });
    confirmRequestMock.mockResolvedValue({ confirmed: false, allowDirs: false, reason });
    const deps = makeDeps(agentKind, `cancel-${agentKind}-${reason}`);
    const media = await deps.callMedia?.({ action: 'resolve_local_path', url });
    expect(media).toMatchObject({ ok: false, errorCode: 'LOCAL_PATH_REVEAL_DENIED', message: expect.stringContaining(reason) });
    expect(media).not.toHaveProperty('local_path');
    const dir = path.join(outsideDir, `cancel-${agentKind}-${reason}`);
    fs.mkdirSync(dir, { recursive: true });
    const handoff = await deps.callGhostTool({ ghostId: 'art', tool: 'run', args: {}, dir });
    expect(handoff).toMatchObject({ ok: false, message: expect.stringContaining(reason) });
    expect(JSON.stringify([media, handoff])).toContain('并非用户手动拒绝');
  });

  it('用户拒绝或调用缺少会话语境时不把路径放进工具结果', async () => {
    const url = `cindy-media://blobs/${'b'.repeat(64)}.png`;
    callCindyMediaMock.mockResolvedValue({
      ok: true,
      url,
      local_path: process.execPath,
      mime_type: 'image/png',
    });
    confirmRequestMock.mockResolvedValueOnce({ confirmed: false, allowDirs: false });

    const denied = await makeDeps('claude-code', 'media-path-denied').callMedia?.({
      action: 'resolve_local_path',
      url,
    });
    expect(denied).toMatchObject({ ok: false, errorCode: 'LOCAL_PATH_REVEAL_DENIED' });
    expect(denied).not.toHaveProperty('local_path');

    const noSession = await makeDeps('claude-code', null).callMedia?.({
      action: 'resolve_local_path',
      url,
    });
    expect(noSession).toMatchObject({
      ok: false,
      errorCode: 'LOCAL_PATH_REVEAL_CONFIRM_UNAVAILABLE',
    });
    expect(noSession).not.toHaveProperty('local_path');
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


describe('Host Auto review', () => {
  it.each(['bypassPermissions', 'auto', 'ask'].flatMap((permissionMode) =>
    [false, true].map((grantOnly) => ({ permissionMode, grantOnly })),
  ))('$permissionMode / grant_only=$grantOnly 在最终授权记账前再次复核', async ({ permissionMode, grantOnly }) => {
    let current = true;
    let granting = false;
    const file = path.join(outsideDir, 'late-ledger.png');
    fs.writeFileSync(file, 'late-ledger');
    liveGrantStateMock.mockReturnValue({ permissionMode, remoteHostId: null,
      isCurrent: () => current, reviewAction: async () => ({ verdict: 'allow' }),
    });
    ledgerHasRefMock.mockImplementation(async () => {
      if (granting) current = false;
      return false;
    });
    const actual = await vi.importActual<typeof import('../../cindy-brain/attachmentGrant')>('../../cindy-brain/attachmentGrant');
    grantAttachmentsMock.mockImplementationOnce((deps: AttachmentGrantDeps, params) => {
      granting = true;
      return actual.grantAttachmentsToGhost({ ...deps,
        writeBlob: async () => ({ hash: 'a'.repeat(64), ext: '.png', mimeType: 'image/png', bytes: 11 }),
        recordBlob: async () => {},
      }, params);
    });
    const result = await makeDeps().callGhostTool({ ghostId: 'art', tool: 'run', args: {}, attachments: [file], grantOnly });
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining('permissions changed') });
    expect(ledgerAddRefMock).not.toHaveBeenCalled();
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it.each(['dir', 'saveDir'] as const)('%s 在 Full 返回与票据签发之间失效时拒绝', async (lane) => {
    let current = true;
    liveGrantStateMock.mockImplementation(() => {
      queueMicrotask(() => { current = false; });
      return { permissionMode: 'bypassPermissions', remoteHostId: null, isCurrent: () => current };
    });
    const result = await makeDeps().callGhostTool({ ghostId: 'art', tool: 'run', args: {}, [lane]: outsideDir });
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining('permissions changed') });
    expect(dirDepositMock).not.toHaveBeenCalled();
    expect(saveDepositMock).not.toHaveBeenCalled();
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it.each((['claude-code', 'codex', 'pi'] as const).flatMap((agentKind) =>
    (['attachments', 'dir', 'saveDir'] as const).map((lane) => ({ agentKind, lane })),
  ))('$agentKind 的 $lane 在派发前失效不能交给插件', async ({ agentKind, lane }) => {
    let current = true;
    const file = path.join(outsideDir, 'late-dispatch.png');
    fs.writeFileSync(file, 'late-dispatch');
    listMock.mockReturnValue([chipGhost('art', ['tool', 'session-context'])]);
    liveGrantStateMock.mockReturnValue({ permissionMode: 'bypassPermissions', remoteHostId: null, isCurrent: () => current });
    sessionSnapshotMock.mockImplementationOnce(async () => {
      current = false;
      return { workingDir: WORKDIR, permissionMode: 'auto', planModeEnabled: true, remoteHostId: null };
    });
    const result = await makeDeps(agentKind).callGhostTool({ ghostId: 'art', tool: 'run', args: {},
      ...(lane === 'attachments' ? { attachments: [file] } : { [lane]: outsideDir }),
    });
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining('permissions changed') });
    expect(sessionSnapshotMock).toHaveBeenCalledOnce();
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it('后一个目录取得新授权，不能替换同一请求中已失效的先前授权', async () => {
    let generation = 0;
    liveGrantStateMock.mockImplementation(() => {
      const captured = generation++;
      return { permissionMode: 'bypassPermissions', remoteHostId: null, isCurrent: () => generation === captured + 1 };
    });
    const result = await makeDeps().callGhostTool({ ghostId: 'art', tool: 'run', args: {}, dir: outsideDir, saveDir: outsideDir });
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining('permissions changed') });
    expect(dirDepositMock).toHaveBeenCalledOnce();
    expect(saveDepositMock).not.toHaveBeenCalled();
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it.each(['bypassPermissions', 'auto', 'ask'] as const)('%s rejects media reveal and file handoff with unavailable Plan authority', async (permissionMode) => {
    liveGrantStateMock.mockReturnValue({ permissionMode, remoteHostId: null, isCurrent: () => false });
    const file = path.join(outsideDir, `plan-${permissionMode}.png`);
    fs.writeFileSync(file, 'png');
    const url = `cindy-media://blobs/${'a'.repeat(64)}.png`;
    callCindyMediaMock.mockResolvedValue({ ok: true, url, local_path: file, mime_type: 'image/png' });
    const deps = makeDeps('claude-code', `plan-${permissionMode}`);
    expect(await deps.callMedia?.({ action: 'resolve_local_path', url })).toMatchObject({ ok: false, errorCode: 'LOCAL_PATH_REVEAL_DENIED' });
    expect(await deps.callGhostTool({ ghostId: 'art', tool: 'run', args: {}, attachments: [file] })).toMatchObject({ ok: false });
    expect(confirmRequestMock).not.toHaveBeenCalled();
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it.each(['auto', 'ask'] as const)('%s cannot return media or hand off files after captured authority changes during approval', async (permissionMode) => {
    const file = path.join(outsideDir, `late-plan-${permissionMode}.png`);
    fs.writeFileSync(file, 'png');
    const url = `cindy-media://blobs/${'a'.repeat(64)}.png`;
    callCindyMediaMock.mockResolvedValue({ ok: true, url, local_path: file, mime_type: 'image/png' });
    for (const kind of ['media', 'handoff']) {
      let current = true;
      liveGrantStateMock.mockReturnValue({ permissionMode, remoteHostId: null, isCurrent: () => current,
        reviewAction: async () => { current = false; return { verdict: 'allow' }; },
      });
      confirmRequestMock.mockImplementation(async () => { current = false; return { confirmed: true, allowDirs: false }; });
      const deps = makeDeps('pi', `late-plan-${permissionMode}-${kind}`);
      const result = kind === 'media'
        ? await deps.callMedia?.({ action: 'resolve_local_path', url })
        : await deps.callGhostTool({ ghostId: 'art', tool: 'run', args: {}, attachments: [file] });
      expect(result).toMatchObject({ ok: false });
      expect(result).not.toHaveProperty('local_path');
    }
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it('rechecks media authority at the final path return after the Full Access shortcut', async () => {
    let current = true;
    liveGrantStateMock.mockImplementation(() => {
      queueMicrotask(() => { current = false; });
      return { permissionMode: 'bypassPermissions', remoteHostId: null, isCurrent: () => current };
    });
    const url = `cindy-media://blobs/${'a'.repeat(64)}.png`;
    callCindyMediaMock.mockResolvedValue({ ok: true, url, local_path: process.execPath, mime_type: 'image/png' });
    expect(await makeDeps('codex', 'late-full-media').callMedia?.({ action: 'resolve_local_path', url })).toMatchObject({ ok: false, errorCode: 'LOCAL_PATH_REVEAL_DENIED' });
    expect(confirmRequestMock).not.toHaveBeenCalled();
  });

  it.each(['claude-code', 'codex', 'pi'] as const)('%s media reveal follows Full access and a later switch to Ask', async (agentKind) => {
    let permissionMode = 'bypassPermissions';
    const reviewAction = vi.fn();
    liveGrantStateMock.mockImplementation(() => ({ permissionMode, remoteHostId: null, reviewAction }));
    const url = `cindy-media://blobs/${'a'.repeat(64)}.png`;
    callCindyMediaMock.mockResolvedValue({ ok: true, url, local_path: process.execPath, mime_type: 'image/png' });
    const deps = makeDeps(agentKind, 'full-media');
    expect(await deps.callMedia?.({ action: 'resolve_local_path', url })).toMatchObject({ ok: true });
    expect(confirmRequestMock).not.toHaveBeenCalled();
    expect(reviewAction).not.toHaveBeenCalled();
    permissionMode = 'ask';
    await deps.callMedia?.({ action: 'resolve_local_path', url });
    expect(confirmRequestMock).toHaveBeenCalledOnce();
  });

  it.each(['lookup', 'review'] as const)('media %s failure falls back to real confirmation', async (failure) => {
    const reviewAction = vi.fn(async () => { throw new Error('review unavailable'); });
    liveGrantStateMock.mockImplementation(() => {
      if (failure === 'lookup') throw new Error('registry unavailable');
      return { permissionMode: 'auto', remoteHostId: null, reviewAction };
    });
    const url = `cindy-media://blobs/${'a'.repeat(64)}.png`;
    callCindyMediaMock.mockResolvedValue({ ok: true, url, local_path: process.execPath, mime_type: 'image/png' });
    for (const confirmed of [true, false]) {
      confirmRequestMock.mockResolvedValueOnce({ confirmed, allowDirs: false });
      const result = await makeDeps('pi', 'auto-media').callMedia?.({ action: 'resolve_local_path', url });
      expect(result).toMatchObject(confirmed ? { ok: true, local_path: process.execPath } : { ok: false, errorCode: 'LOCAL_PATH_REVEAL_DENIED' });
    }
    expect(confirmRequestMock).toHaveBeenCalledTimes(2);
  });

  it.each(['allow', 'block', 'ask'] as const)('media path reveal obeys AI %s', async (verdict) => {
    const reviewAction = vi.fn(async () => ({ verdict, reason: 'reviewed' }));
    liveGrantStateMock.mockReturnValue({ permissionMode: 'auto', remoteHostId: null, reviewAction });
    const url = `cindy-media://blobs/${'a'.repeat(64)}.png`;
    callCindyMediaMock.mockResolvedValue({ ok: true, url, local_path: process.execPath, mime_type: 'image/png' });
    const result = await makeDeps('pi', 'auto-media').callMedia?.({ action: 'resolve_local_path', url });
    expect(reviewAction).toHaveBeenCalledOnce();
    expect(confirmRequestMock).toHaveBeenCalledTimes(verdict === 'ask' ? 1 : 0);
    if (verdict === 'block') expect(result).toMatchObject({ ok: false });
    else expect(result).toMatchObject({ ok: true, local_path: process.execPath });
  });

  it('AI file handoff does not become permanent human authorization', async () => {
    const file = path.join(outsideDir, 'auto-review.png');
    fs.writeFileSync(file, 'png');
    let permissionMode = 'auto';
    const reviewAction = vi.fn(async () => ({ verdict: 'allow' as const }));
    liveGrantStateMock.mockImplementation(() => ({ permissionMode, remoteHostId: null, reviewAction }));
    const deps = makeDeps('pi', 'auto-handoff');
    const request = { ghostId: 'art', tool: 'run', args: {}, attachments: [file] };
    expect(await deps.callGhostTool(request)).toMatchObject({ ok: true });
    expect(reviewAction).toHaveBeenCalledOnce();
    expect(confirmRequestMock).not.toHaveBeenCalled();
    expect(resolvedAttachmentOrigins).toEqual(['tool']);
    expect(ledgerRefs.map((ref) => [ref.refKind, ref.originKind])).toEqual([['ghost-tool-grant', 'tool']]);
    permissionMode = 'ask';
    await deps.callGhostTool(request);
    expect(confirmRequestMock).toHaveBeenCalledOnce();
    expect(ledgerRefs.map((ref) => [ref.refKind, ref.originKind])).toEqual([['ghost-tool-grant', 'tool'], ['ghost-grant', 'user']]);
  });

  it('AI block stops attachment handoff before granting or dispatching', async () => {
    const file = path.join(outsideDir, 'auto-block.png');
    fs.writeFileSync(file, 'png');
    const reviewAction = vi.fn(async () => ({ verdict: 'block' as const, reason: 'Outside user authorization' }));
    liveGrantStateMock.mockReturnValue({ permissionMode: 'auto', remoteHostId: null, reviewAction });
    expect(await makeDeps('pi', 'auto-block').callGhostTool({ ghostId: 'art', tool: 'run', args: {}, attachments: [file] })).toMatchObject({ ok: false });
    expect(reviewAction).toHaveBeenCalledOnce();
    expect(confirmRequestMock).not.toHaveBeenCalled();
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(grantAttachmentsMock).not.toHaveBeenCalled();
  });
});

it.each([false, true])('only marks a teammate setup plan as reauthorization with a current suggestion (%s)', async (reauth) => {
  listMock.mockReturnValue([chipGhost('art')]);
  isAuthorizationSessionMock.mockResolvedValue(true);
  const assessment = { state: 'ready' as const, revision: 1, groups: [],
    ...(reauth ? { reauthSuggest: { ghostId: 'art', secretKey: 'account', missingScopes: ['write'],
      missingScopeCount: 1, requirement: { ref: 'secret:account', kind: 'oauth' as const,
        label: 'Account', action: { id: 'connect', kind: 'oauth_connect' as const } } } } : {}) };
  setupAssessmentMock.mockReturnValue(assessment);
  const setupPlan = { assessmentRevision: 1, steps: [] };
  await makeDeps().callGhostTool({ ghostId: 'art', tool: 'run', args: {}, setupPlan });
  expect(authorizationRequestMock).toHaveBeenCalledWith('s1', {
    kind: 'plugin', id: 'art', ...(reauth ? { reauthorize: true } : {}),
  }, setupPlan);
});

describe('oversized ghost result Host storage', () => {
  // main 起 Auto 会话的 workdir 写入走会话统一审阅器:默认桩给一个放行的 reviewAction。
  const reviewAllow = vi.fn(async () => ({ verdict: 'allow' as const }));
  beforeEach(() => {
    reviewAllow.mockClear();
    // Shorten the remote reconcile window so ambiguity paths stay fast in tests.
    REMOTE_WRITE_RECONCILE.intervalMs = 1;
    REMOTE_WRITE_RECONCILE.maxAttempts = 5;
    REMOTE_WRITE_RECONCILE.windowMs = 2_000;
    liveGrantStateMock.mockReturnValue({ permissionMode: 'auto', remoteHostId: null, isCurrent: () => true, reviewAction: reviewAllow });
  });

  // Codex P1 (round 10): the local writer's own realpath/lstat checks and utility-process
  // start-up are async. Live instance/permission is re-checked at the writer's final
  // `beforeCommit` boundary, so an instance that ended meanwhile never gets bytes written.
  it('revalidates at the local writer boundary and withholds the bytes when the instance ended', async () => {
    const deps = makeDeps('codex');
    sessionSnapshotMock.mockResolvedValue({ workingDir: WORKDIR, remoteHostId: null, permissionMode: 'auto', planModeEnabled: false });
    let current = true;
    liveGrantStateMock.mockReturnValue({ permissionMode: 'auto', remoteHostId: null, isCurrent: () => current, reviewAction: reviewAllow });
    let bytesHandedOver = false;
    writeDocsOutputMock.mockImplementation(async input => {
      // Simulate the instance ending while the writer was starting up, then reach the boundary.
      current = false;
      await input.beforeCommit?.();
      bytesHandedOver = true;
    });
    await expect(deps.saveLargeGhostResult!('result')).rejects.toThrow();
    expect(writeDocsOutputMock).toHaveBeenCalledOnce();
    expect(bytesHandedOver).toBe(false);
    expect(ledgerAddRefMock).not.toHaveBeenCalled();
  });

  // Codex P1 (round 15): the reviewer's allow belongs to the generation that produced it.
  // Switching permission/Plan away and back mints a new generation whose own isCurrent()
  // is true, but the approval must not carry over to it.
  it('does not carry an Auto allow across a permission generation switch-away-and-back', async () => {
    const deps = makeDeps('codex');
    sessionSnapshotMock.mockResolvedValue({ workingDir: WORKDIR, remoteHostId: null, permissionMode: 'auto', planModeEnabled: false });
    let generation = 0;
    liveGrantStateMock.mockImplementation(() => {
      const captured = generation;
      return { permissionMode: 'auto', remoteHostId: null, isCurrent: () => generation === captured, reviewAction: reviewAllow };
    });
    let bytesHandedOver = false;
    writeDocsOutputMock.mockImplementation(async input => {
      // Away (e.g. to Ask / Plan) and back to Auto while the writer was starting up.
      generation += 2;
      await input.beforeCommit?.();
      bytesHandedOver = true;
    });
    // The old allow does not carry over; the new Auto generation reviews the target itself
    // at the boundary (round 28) and, allowing it, the write proceeds on that fresh review.
    await expect(deps.saveLargeGhostResult!('result')).resolves.toMatch(/^tool-results/);
    expect(reviewAllow).toHaveBeenCalledTimes(2);
    expect(bytesHandedOver).toBe(true);
  });

  // Codex P1 (round 28): a Full Access clearance never stands in for an Auto review. When
  // the session is downgraded to Auto while the writer starts, the current Auto generation
  // must review the target itself at the final boundary.
  it('requires a fresh Auto review at the boundary when Full Access was downgraded to Auto meanwhile', async () => {
    const deps = makeDeps('codex');
    sessionSnapshotMock.mockResolvedValue({ workingDir: WORKDIR, remoteHostId: null, permissionMode: 'bypassPermissions', planModeEnabled: false });
    let mode: 'bypassPermissions' | 'auto' = 'bypassPermissions';
    liveGrantStateMock.mockImplementation(() => ({ permissionMode: mode, remoteHostId: null, isCurrent: () => true, reviewAction: reviewAllow }));
    const seen: string[] = [];
    writeDocsOutputMock.mockImplementation(async input => {
      mode = 'auto'; // downgraded while the utility process was starting
      await input.beforeCommit?.();
      seen.push('write');
    });
    const saved = await deps.saveLargeGhostResult!('result');
    expect(reviewAllow).toHaveBeenCalledOnce();
    expect(reviewAllow).toHaveBeenCalledWith(expect.objectContaining({ kind: 'file-write', path: path.join(WORKDIR, saved) }));
    expect(seen).toEqual(['write']);
  });

  it('withholds the write when the fresh Auto review after a downgrade blocks it', async () => {
    const deps = makeDeps('codex');
    sessionSnapshotMock.mockResolvedValue({ workingDir: WORKDIR, remoteHostId: null, permissionMode: 'bypassPermissions', planModeEnabled: false });
    let mode: 'bypassPermissions' | 'auto' = 'bypassPermissions';
    const reviewBlock = vi.fn(async () => ({ verdict: 'block' as const, reason: 'no spills' }));
    liveGrantStateMock.mockImplementation(() => ({ permissionMode: mode, remoteHostId: null, isCurrent: () => true, reviewAction: reviewBlock }));
    let bytesHandedOver = false;
    writeDocsOutputMock.mockImplementation(async input => {
      mode = 'auto';
      await input.beforeCommit?.();
      bytesHandedOver = true;
    });
    await expect(deps.saveLargeGhostResult!('result')).rejects.toThrow('no spills');
    expect(reviewBlock).toHaveBeenCalledOnce();
    expect(bytesHandedOver).toBe(false);
    expect(ledgerAddRefMock).not.toHaveBeenCalled();
  });

  it('keeps an Auto allow while the approving generation stays live', async () => {
    const deps = makeDeps('codex');
    sessionSnapshotMock.mockResolvedValue({ workingDir: WORKDIR, remoteHostId: null, permissionMode: 'auto', planModeEnabled: false });
    const generation = 0;
    liveGrantStateMock.mockImplementation(() => {
      const captured = generation;
      return { permissionMode: 'auto', remoteHostId: null, isCurrent: () => generation === captured, reviewAction: reviewAllow };
    });
    writeDocsOutputMock.mockImplementation(async input => { await input.beforeCommit?.(); });
    const saved = await deps.saveLargeGhostResult!('result');
    expect(path.dirname(saved)).toBe('tool-results'); // platform separator (Windows CI uses '\\')
    expect(reviewAllow).toHaveBeenCalledOnce();
  });

  // Codex P1 (round 15 / round 30): the cleanup anchor comes from the writer's own handle,
  // never from a later path query; a path re-pointed at an unrelated file must not be
  // destroyed — and a write whose inode can no longer be bound is an unsettled write: the
  // call fails before anything is booked in its name.
  it('never destroys a file that replaced the spill path and fails closed when the inode cannot be bound', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ghost-spill-replaced-'));
    try {
      const deps = makeDeps();
      sessionSnapshotMock.mockResolvedValue({ workingDir: root, remoteHostId: null, permissionMode: 'auto', planModeEnabled: false });
      writeDocsOutputMock.mockImplementation(async input => {
        await fs.promises.mkdir(path.dirname(input.path), { recursive: true });
        await fs.promises.writeFile(input.path, input.data);
        const st = await fs.promises.lstat(input.path, { bigint: true });
        // A workdir process swaps the UUID path for an unrelated file right after the write.
        await fs.promises.rename(input.path, `${input.path}.moved`);
        await fs.promises.writeFile(input.path, 'someone else');
        return { identity: { dev: st.dev.toString(), ino: st.ino.toString() } };
      });
      const broken = 'f'.repeat(64);
      await expect(deps.saveLargeGhostResult!(JSON.stringify({ c: `cindy-media://blobs/${broken}.png` }))).rejects.toThrow('lost its anchor');
      expect(ledgerAddRefMock).not.toHaveBeenCalled();
      const written = writeDocsOutputMock.mock.calls[0]![0].path;
      expect(await fs.promises.readFile(written, 'utf8')).toBe('someone else');
      // Our own inode (now under the moved name) was the only thing eligible for cleanup;
      // it is left untouched because it no longer sits at the spill path.
      expect(await fs.promises.readFile(`${written}.moved`, 'utf8')).toContain(broken);
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });

  it('skips cleanup entirely when the writer attested no identity', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ghost-spill-noid-'));
    try {
      const deps = makeDeps();
      sessionSnapshotMock.mockResolvedValue({ workingDir: root, remoteHostId: null, permissionMode: 'auto', planModeEnabled: false });
      writeDocsOutputMock.mockImplementation(async input => {
        await fs.promises.mkdir(path.dirname(input.path), { recursive: true });
        await fs.promises.writeFile(input.path, input.data);
      });
      const broken = 'f'.repeat(64);
      ledgerAddRefMock.mockImplementation(async () => { throw new Error('FOREIGN KEY constraint failed'); });
      await expect(deps.saveLargeGhostResult!(JSON.stringify({ c: `cindy-media://blobs/${broken}.png` }))).rejects.toThrow('media references unavailable');
      const written = writeDocsOutputMock.mock.calls[0]![0].path;
      await expect(fs.promises.access(written)).resolves.toBeUndefined();
    } finally {
      ledgerAddRefMock.mockImplementation(async (params: TestLedgerRef) => {
        const id = params.id ?? `ref-${++ledgerRefSeq}`;
        ledgerRefs.push({ ...params, id });
        return id;
      });
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });

  it('passes a beforeCommit revalidation to the local writer on the happy path', async () => {
    const deps = makeDeps('codex');
    sessionSnapshotMock.mockResolvedValue({ workingDir: WORKDIR, remoteHostId: null, permissionMode: 'auto', planModeEnabled: false });
    const seen: string[] = [];
    writeDocsOutputMock.mockImplementation(async input => {
      seen.push('before');
      await input.beforeCommit?.();
      seen.push('write');
    });
    await deps.saveLargeGhostResult!('result');
    expect(seen).toEqual(['before', 'write']);
    expect(writeDocsOutputMock.mock.calls[0]![0].beforeCommit).toBeTypeOf('function');
  });

  it('asks the session reviewer for the exact workdir target before writing in Auto', async () => {
    const deps = makeDeps('codex');
    sessionSnapshotMock.mockResolvedValue({ workingDir: WORKDIR, remoteHostId: null, permissionMode: 'auto', planModeEnabled: false });
    const rel = await deps.saveLargeGhostResult!('result');
    expect(reviewAllow).toHaveBeenCalledOnce();
    expect(reviewAllow).toHaveBeenCalledWith({
      kind: 'file-write',
      path: path.join(WORKDIR, rel),
      resolvedPath: path.join(WORKDIR, rel),
      resolvedWritableRoots: [WORKDIR],
    });
    expect(writeDocsOutputMock).toHaveBeenCalledOnce();
  });

  it.each([
    { name: 'reviewer blocks', reviewAction: async () => ({ verdict: 'block' as const, reason: 'nope' }) },
    { name: 'reviewer asks', reviewAction: async () => ({ verdict: 'ask' as const }) },
    { name: 'reviewer throws', reviewAction: async () => { throw new Error('boom'); } },
    { name: 'reviewer missing', reviewAction: undefined },
  ])('fails closed in Auto when the session reviewer does not allow the write (%s)', async ({ reviewAction }) => {
    const deps = makeDeps('codex');
    sessionSnapshotMock.mockResolvedValue({ workingDir: WORKDIR, remoteHostId: null, permissionMode: 'auto', planModeEnabled: false });
    liveGrantStateMock.mockReturnValue({ permissionMode: 'auto', remoteHostId: null, isCurrent: () => true, ...(reviewAction ? { reviewAction } : {}) });
    await expect(deps.saveLargeGhostResult!('result')).rejects.toThrow();
    expect(writeDocsOutputMock).not.toHaveBeenCalled();
    expect(remoteFsRequestMock).not.toHaveBeenCalled();
    expect(ledgerAddRefMock).not.toHaveBeenCalled();
    expect(releaseMutationMock).toHaveBeenCalledOnce();
  });

  it('does not consult the reviewer for Full Access sessions', async () => {
    const deps = makeDeps('codex');
    sessionSnapshotMock.mockResolvedValue({ workingDir: WORKDIR, remoteHostId: null, permissionMode: 'bypassPermissions', planModeEnabled: false });
    liveGrantStateMock.mockReturnValue({ permissionMode: 'bypassPermissions', remoteHostId: null, isCurrent: () => true, reviewAction: reviewAllow });
    await expect(deps.saveLargeGhostResult!('result')).resolves.toMatch(/^tool-results/);
    expect(reviewAllow).not.toHaveBeenCalled();
  });
  it('roundtrips a production handler result through the safe filesystem writer', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ghost-safe-spill-'));
    try {
      const deps = makeDeps();
      sessionSnapshotMock.mockResolvedValue({ workingDir: root, remoteHostId: null, permissionMode: 'auto', planModeEnabled: false });
      writeDocsOutputMock.mockImplementation(async input => {
        const realRoot = await fs.promises.realpath(root);
        const stat = await fs.promises.lstat(realRoot, { bigint: true });
        await runDocsOutputWriteForTest({
          expectedRoot: { realPath: realRoot, dev: stat.dev, ino: stat.ino },
          expectedParent: null,
          parentRelativePath: path.relative(input.root, path.dirname(input.path)),
          targetName: path.basename(input.path), data: input.data, overwrite: input.overwrite,
        }, realRoot);
      });
      const data = '\\'.repeat(641694);
      const response = await handleGhostCall({ ...deps, callGhostTool: async () => ({ ok: true, result: { data } }) }, { ghost_id: 'synthetic', tool: 'read' });
      const projection = JSON.parse(response.content[0].text);
      expect(projection.complete_result_saved).toBe(true);
      const stored = JSON.parse(await fs.promises.readFile(path.join(root, projection.saved_to), 'utf8'));
      expect(stored.result.data).toBe(data);
      expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThanOrEqual(64 * 1024);
    } finally { await fs.promises.rm(root, { recursive: true, force: true }); }
  });

  it('pins media that only occurs beyond the inline preview once the bytes are durable', async () => {
    const deps = makeDeps();
    const hash = 'b'.repeat(64);
    await deps.saveLargeGhostResult!(JSON.stringify({ result: { text: 'x'.repeat(70000), image: `cindy-media://blobs/${hash}.png` } }));
    // Codex P1: the spilled file owns its media refs (not the message-lifecycle session-attachment row).
    expect(ledgerRefs).toContainEqual(expect.objectContaining({ hash, refKind: 'ghost-tool-result', refId: expect.stringMatching(/^tool-results[\\/]/), originKind: 'tool' }));
    expect(ledgerRefs).not.toContainEqual(expect.objectContaining({ hash, refKind: 'session-attachment' }));
    // Greptile P2: refs are committed after the safe write so a failed write never leaves an orphan ref.
    expect(writeDocsOutputMock.mock.invocationCallOrder[0]).toBeLessThan(ledgerAddRefMock.mock.invocationCallOrder[0]!);
  });

  it.each<TestAgentKind>(['claude-code', 'codex', 'pi'])('uses the authoritative local root and safe writer for %s', async agentKind => {
    const deps = makeDeps(agentKind);
    const text = JSON.stringify({ ok: true, result: { data: 'x'.repeat(70000) } });
    const saved = await deps.saveLargeGhostResult!(text);
    expect(liveGrantStateMock).toHaveBeenCalledWith('s1', 's1-instance');
    expect(sessionSnapshotMock).toHaveBeenCalledWith('s1');
    expect(path.dirname(saved)).toBe('tool-results');
    expect(path.basename(saved)).toMatch(/^ghost-[0-9a-f-]+\.json$/);
    expect(writeDocsOutputMock).toHaveBeenCalledWith({
      root: WORKDIR, path: path.join(WORKDIR, saved), data: Buffer.from(text), overwrite: false,
      beforeCommit: expect.any(Function),
    });
    expect(remoteFsRequestMock).not.toHaveBeenCalled();
    expect(captureMutationOwnerMock).toHaveBeenCalledOnce();
    expect(releaseMutationMock).toHaveBeenCalledOnce();
  });

  // Codex P1: the persisted row lags runtime permission changes and a rebuilt
  // instance reuses the business id; only the exact live instance may authorize.
  it.each([
    { name: 'stale instance', live: null },
    { name: 'runtime switched to ask', live: { permissionMode: 'ask', remoteHostId: null } },
    { name: 'runtime switched to plan', live: { permissionMode: 'plan', remoteHostId: null } },
    { name: 'runtime permission unknown', live: { permissionMode: null, remoteHostId: null } },
    { name: 'runtime plan mode on (isCurrent false)', live: { permissionMode: 'auto', remoteHostId: null, isCurrent: () => false } },
    { name: 'runtime remote but row local', live: { permissionMode: 'auto', remoteHostId: 'remote' } },
  ])('does not spill on a persisted auto row when the live session says otherwise (%s)', async ({ live }) => {
    const deps = makeDeps('codex');
    sessionSnapshotMock.mockResolvedValue({ workingDir: WORKDIR, remoteHostId: null, permissionMode: 'auto', planModeEnabled: false });
    liveGrantStateMock.mockReturnValue(live);
    await expect(deps.saveLargeGhostResult!('result')).rejects.toThrow();
    expect(liveGrantStateMock).toHaveBeenCalledWith('s1', 's1-instance');
    expect(writeDocsOutputMock).not.toHaveBeenCalled();
    expect(remoteFsRequestMock).not.toHaveBeenCalled();
    expect(ledgerAddRefMock).not.toHaveBeenCalled();
    expect(releaseMutationMock).toHaveBeenCalledOnce();
  });

  it('prefers the live plan-mode reading over a stale persisted row', async () => {
    const deps = makeDeps('codex');
    sessionSnapshotMock.mockResolvedValue({ workingDir: WORKDIR, remoteHostId: null, permissionMode: 'ask', planModeEnabled: true });
    liveGrantStateMock.mockReturnValue({ permissionMode: 'auto', remoteHostId: null, isCurrent: () => true, reviewAction: reviewAllow });
    await expect(deps.saveLargeGhostResult!('result')).resolves.toMatch(/^tool-results/);
    expect(writeDocsOutputMock).toHaveBeenCalledOnce();
  });

  it.each([
    { remoteHostId: 'remote', permissionMode: 'auto', planModeEnabled: false },
    { remoteHostId: null, permissionMode: 'auto', planModeEnabled: true },
  ])('does not spill when the persisted row disagrees with the live session (%j)', async state => {
    const deps = makeDeps('codex');
    // 旧装配方没有 isCurrent:计划模式回退持久化行;远端归属不一致同样拒绝。
    liveGrantStateMock.mockReturnValue({ permissionMode: 'auto', remoteHostId: null, reviewAction: reviewAllow });
    sessionSnapshotMock.mockResolvedValue({ workingDir: WORKDIR, ...state });
    await expect(deps.saveLargeGhostResult!('result')).rejects.toThrow();
    expect(writeDocsOutputMock).not.toHaveBeenCalled();
    expect(remoteFsRequestMock).not.toHaveBeenCalled();
    expect(releaseMutationMock).toHaveBeenCalledOnce();
  });

  it.each([
    { name: 'unknown session', sessionId: null, sessionInstanceId: null },
    { name: 'missing instance id', sessionId: 's1', sessionInstanceId: null },
  ])('does not fall back to the cwd or the persisted row (%s)', async ({ sessionId, sessionInstanceId }) => {
    const deps = makeDeps('codex', sessionId, sessionInstanceId);
    await expect(deps.saveLargeGhostResult!('result')).rejects.toThrow();
    expect(liveGrantStateMock).not.toHaveBeenCalled();
    expect(writeDocsOutputMock).not.toHaveBeenCalled();
  });

  it('does not spill when the host cannot read the live session', async () => {
    alsSessionContextMock.mockReturnValue({ agentKind: 'codex', workingDir: WORKDIR, sessionId: 's1', sessionInstanceId: 's1-instance' });
    const deps = getCindyGhostsMcpDeps(undefined, { getAppVersion: appVersionMock });
    await expect(deps.saveLargeGhostResult!('result')).rejects.toThrow();
    expect(writeDocsOutputMock).not.toHaveBeenCalled();
  });

  it('propagates a failed safe write, commits no media refs and releases the owner lease', async () => {
    const deps = makeDeps();
    const hash = 'c'.repeat(64);
    writeDocsOutputMock.mockRejectedValueOnce(new Error('disk full'));
    await expect(deps.saveLargeGhostResult!(JSON.stringify({ image: `cindy-media://blobs/${hash}.png` }))).rejects.toThrow('disk full');
    expect(writeDocsOutputMock).toHaveBeenCalledOnce();
    expect(ledgerAddRefMock).not.toHaveBeenCalled();
    expect(releaseMutationMock).toHaveBeenCalledOnce();
  });

  it('rolls back only the refs it added and removes the file when media accounting fails', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ghost-spill-rollback-'));
    try {
      const deps = makeDeps();
      sessionSnapshotMock.mockResolvedValue({ workingDir: root, remoteHostId: null, permissionMode: 'auto', planModeEnabled: false });
      writeDocsOutputMock.mockImplementation(async input => {
        await fs.promises.mkdir(path.dirname(input.path), { recursive: true });
        await fs.promises.writeFile(input.path, input.data);
        const st = await fs.promises.lstat(input.path, { bigint: true });
        return { identity: { dev: st.dev.toString(), ino: st.ino.toString() } };
      });
      const existing = 'd'.repeat(64);
      const fresh = 'e'.repeat(64);
      const broken = 'f'.repeat(64);
      ledgerRefs.push({ hash: existing, refKind: 'session-attachment', refId: 's1', originKind: 'tool' });
      ledgerAddRefMock.mockImplementation(async (params: TestLedgerRef) => {
        if (params.hash === broken) throw new Error('FOREIGN KEY constraint failed');
        const id = params.id ?? `ref-${++ledgerRefSeq}`;
        ledgerRefs.push({ ...params, id });
        return id;
      });
      const text = JSON.stringify({ a: `cindy-media://blobs/${existing}.png`, b: `cindy-media://blobs/${fresh}.png`, c: `cindy-media://blobs/${broken}.png` });
      await expect(deps.saveLargeGhostResult!(text)).rejects.toThrow('media references unavailable');
      // The file identity is independent of the pre-existing session-attachment row: both
      // `existing` and `fresh` got their own ghost-tool-result refs; rollback covers those two
      // plus the id reserved for `broken` (its insert may have landed before rejecting).
      expect(ledgerRemoveRefByIdMock).toHaveBeenCalledTimes(3);
      expect(ledgerRemoveSessionAttachmentRefMock).not.toHaveBeenCalled();
      expect(ledgerRefs).toContainEqual(expect.objectContaining({ hash: existing, refKind: 'session-attachment', refId: 's1' }));
      expect(ledgerRefs).not.toContainEqual(expect.objectContaining({ refKind: 'ghost-tool-result' }));
      expect(ledgerRefs).not.toContainEqual(expect.objectContaining({ hash: fresh }));
      const written = writeDocsOutputMock.mock.calls[0]![0].path;
      expect((await fs.promises.stat(written)).size).toBe(0); // erased through the fd; pathname kept
      expect(releaseMutationMock).toHaveBeenCalledOnce();
    } finally {
      ledgerAddRefMock.mockImplementation(async (params: TestLedgerRef) => {
        const id = params.id ?? `ref-${++ledgerRefSeq}`;
        ledgerRefs.push({ ...params, id });
        return id;
      });
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });

  // Codex P1 (round 4): rollback is keyed by the refs this call inserted, so a
  // concurrent spill that booked the same blob keeps its reference.
  it('keeps a concurrent spill\'s reference to the same blob when this call rolls back', async () => {
    const deps = makeDeps();
    const shared = 'a'.repeat(64);
    const broken = 'f'.repeat(64);
    // Both calls observe "no ref yet" for the shared blob (the race window).
    ledgerHasRefMock.mockImplementation(async () => false);
    ledgerAddRefMock.mockImplementation(async (params: TestLedgerRef) => {
      if (params.hash === broken) throw new Error('FOREIGN KEY constraint failed');
      const id = params.id ?? `ref-${++ledgerRefSeq}`;
      ledgerRefs.push({ ...params, id });
      return id;
    });
    try {
      const okText = JSON.stringify({ image: `cindy-media://blobs/${shared}.png` });
      const badText = JSON.stringify({ image: `cindy-media://blobs/${shared}.png`, other: `cindy-media://blobs/${broken}.png` });
      const [ok, bad] = await Promise.allSettled([deps.saveLargeGhostResult!(okText), deps.saveLargeGhostResult!(badText)]);
      expect(ok.status).toBe('fulfilled');
      expect(bad.status).toBe('rejected');
      const remaining = ledgerRefs.filter(ref => ref.hash === shared && ref.refKind === 'ghost-tool-result');
      expect(remaining).toHaveLength(1); // the successful call's row survives
      // Rollback touches only this call's reserved ids (shared + broken), never the other call's row.
      expect(ledgerRemoveRefByIdMock).toHaveBeenCalledTimes(2);
      expect(ledgerRemoveRefByIdMock).not.toHaveBeenCalledWith(remaining[0]!.id);
    } finally {
      ledgerHasRefMock.mockImplementation(async (params: TestLedgerRef) =>
        ledgerRefs.some(ref => ref.hash === params.hash && ref.refKind === params.refKind && ref.refId === params.refId
          && (params.originKind === undefined || ref.originKind === params.originKind)));
      ledgerAddRefMock.mockImplementation(async (params: TestLedgerRef) => {
        const id = params.id ?? `ref-${++ledgerRefSeq}`;
        ledgerRefs.push({ ...params, id });
        return id;
      });
    }
  });

  // Codex P1: an SSH remote session's workdir lives on the remote host. Route
  // the spill through remote-file-service instead of failing closed.
  it.each<TestAgentKind>(['codex', 'pi'])('spills a remote session result through remote-file-service for %s', async agentKind => {
    const deps = makeDeps(agentKind);
    sessionSnapshotMock.mockResolvedValue({ workingDir: '/srv/work', remoteHostId: 'host-1', permissionMode: 'auto', planModeEnabled: false });
    liveGrantStateMock.mockReturnValue({ permissionMode: 'auto', remoteHostId: 'host-1', isCurrent: () => true, reviewAction: reviewAllow });
    const hash = 'a'.repeat(64);
    const text = JSON.stringify({ ok: true, result: { data: 'x'.repeat(70000), image: `cindy-media://blobs/${hash}.png` } });
    const saved = await deps.saveLargeGhostResult!(text);
    expect(saved).toMatch(/^tool-results\/ghost-[0-9a-f-]+\.json$/);
    expect(writeDocsOutputMock).not.toHaveBeenCalled();
    expect(remoteFsRequestMock.mock.calls.map(call => call.slice(0, 2))).toEqual([
      ['host-1', 'createFolder'], ['host-1', 'writeNewFile'],
    ]);
    expect(remoteFsRequestMock).toHaveBeenCalledWith('host-1', 'createFolder', { workdir: '/srv/work', relPath: 'tool-results' }, { beforeSend: expect.any(Function) });
    // Exclusive create+write in one RPC: no createFile → writeFile window for a symlink swap.
    expect(remoteFsRequestMock).toHaveBeenCalledWith('host-1', 'writeNewFile', { workdir: '/srv/work', relPath: saved, content: text }, { beforeSend: expect.any(Function) });
    expect(remoteFsRequestMock.mock.calls.map(call => call[1])).not.toContain('writeFile');
    expect(remoteFsRequestMock.mock.invocationCallOrder.at(-1)).toBeLessThan(ledgerAddRefMock.mock.invocationCallOrder[0]!);
    expect(ledgerRefs).toContainEqual(expect.objectContaining({ hash, refKind: 'ghost-tool-result', refId: saved, originKind: 'tool' }));
    expect(releaseMutationMock).toHaveBeenCalledOnce();
  });

  it('reuses an existing remote tool-results folder', async () => {
    const deps = makeDeps('codex');
    sessionSnapshotMock.mockResolvedValue({ workingDir: '/srv/work', remoteHostId: 'host-1', permissionMode: 'auto', planModeEnabled: false });
    liveGrantStateMock.mockReturnValue({ permissionMode: 'auto', remoteHostId: 'host-1', isCurrent: () => true, reviewAction: reviewAllow });
    remoteFsRequestMock.mockImplementation(async (_host, method) => {
      if (method === 'createFolder') throw new Error('EEXIST: file already exists');
      if (method === 'stat') return { relPath: 'tool-results', type: 'directory', size: 0, mtimeMs: 0 };
      return {};
    });
    await expect(deps.saveLargeGhostResult!('result')).resolves.toMatch(/^tool-results\//);
    expect(remoteFsRequestMock.mock.calls.map(call => call[1])).toEqual(['createFolder', 'stat', 'writeNewFile']);
  });

  it('commits no refs and issues no delete when the remote exclusive write fails outright', async () => {
    const deps = makeDeps('codex');
    sessionSnapshotMock.mockResolvedValue({ workingDir: '/srv/work', remoteHostId: 'host-1', permissionMode: 'auto', planModeEnabled: false });
    liveGrantStateMock.mockReturnValue({ permissionMode: 'auto', remoteHostId: 'host-1', isCurrent: () => true, reviewAction: reviewAllow });
    remoteFsRequestMock.mockImplementation(async (_host, method) => {
      if (method === 'writeNewFile') throw new Error('content too large (>2097152 bytes)');
      return {};
    });
    const hash = 'a'.repeat(64);
    await expect(deps.saveLargeGhostResult!(JSON.stringify({ image: `cindy-media://blobs/${hash}.png` }))).rejects.toThrow('content too large');
    expect(remoteFsRequestMock.mock.calls.map(call => call[1])).toEqual(['createFolder', 'writeNewFile']); // definite failure wrote nothing: no delete
    expect(ledgerAddRefMock).not.toHaveBeenCalled();
    expect(releaseMutationMock).toHaveBeenCalledOnce();
  });

  // Codex P1 (round 3): the live gate is re-read after every await, not cached once.
  it.each([
    { name: 'before the write', sequence: ['auto', 'auto', 'ask'] },
    { name: 'during the snapshot read', sequence: ['auto', 'ask'] },
  ])('does not write when the runtime grant changes %s', async ({ sequence }) => {
    const deps = makeDeps('codex');
    const modes = [...sequence];
    liveGrantStateMock.mockImplementation(() => ({ permissionMode: modes.length > 1 ? modes.shift()! : modes[0]!, remoteHostId: null }));
    await expect(deps.saveLargeGhostResult!('result')).rejects.toThrow();
    expect(writeDocsOutputMock).not.toHaveBeenCalled();
    expect(ledgerAddRefMock).not.toHaveBeenCalled();
  });

  it('discards the written file and books no refs when the instance ends during the write', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ghost-spill-revalidate-'));
    try {
      const deps = makeDeps('codex');
      sessionSnapshotMock.mockResolvedValue({ workingDir: root, remoteHostId: null, permissionMode: 'auto', planModeEnabled: false });
      let calls = 0;
      liveGrantStateMock.mockImplementation(() => (++calls <= 3 ? { permissionMode: 'auto', remoteHostId: null, isCurrent: () => true, reviewAction: reviewAllow } : null));
      writeDocsOutputMock.mockImplementation(async input => {
        await fs.promises.mkdir(path.dirname(input.path), { recursive: true });
        await fs.promises.writeFile(input.path, input.data);
        const st = await fs.promises.lstat(input.path, { bigint: true });
        return { identity: { dev: st.dev.toString(), ino: st.ino.toString() } };
      });
      const hash = 'a'.repeat(64);
      await expect(deps.saveLargeGhostResult!(JSON.stringify({ image: `cindy-media://blobs/${hash}.png` }))).rejects.toThrow('live session');
      expect(writeDocsOutputMock).toHaveBeenCalledOnce();
      expect((await fs.promises.stat(writeDocsOutputMock.mock.calls[0]![0].path)).size).toBe(0);
      expect(ledgerAddRefMock).not.toHaveBeenCalled();
      expect(liveGrantStateMock).toHaveBeenCalledTimes(4);
    } finally { await fs.promises.rm(root, { recursive: true, force: true }); }
  });

  // Codex P1 (round 29): between the writer's success and the ledger commit a workdir process
  // can move the whole output directory out of the workdir; a path-based cleanup would then
  // find nothing. The retained inode-bound handle still zeroes the content wherever it went.
  it('zeroes the spill through the retained handle when its directory was moved out during bookkeeping', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ghost-spill-hold-'));
    const outside = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ghost-spill-hold-outside-'));
    try {
      const deps = makeDeps('codex');
      sessionSnapshotMock.mockResolvedValue({ workingDir: root, remoteHostId: null, permissionMode: 'auto', planModeEnabled: false });
      writeDocsOutputMock.mockImplementation(async input => {
        await fs.promises.mkdir(path.dirname(input.path), { recursive: true });
        await fs.promises.writeFile(input.path, input.data);
        const st = await fs.promises.lstat(input.path, { bigint: true });
        return { identity: { dev: st.dev.toString(), ino: st.ino.toString() } };
      });
      let moved = false;
      ledgerAddRefMock.mockImplementation(async () => {
        // The output directory leaves the workdir while the ledger call is in flight.
        // Windows refuses to move a directory holding an open handle (the retained hold):
        // then no race exists and the file stays put; the erase must still go through.
        moved = await fs.promises.rename(path.join(root, 'tool-results'), path.join(outside, 'tool-results')).then(() => true, () => false);
        throw new Error('FOREIGN KEY constraint failed');
      });
      await expect(deps.saveLargeGhostResult!(JSON.stringify({ image: `cindy-media://blobs/${'f'.repeat(64)}.png` }))).rejects.toThrow('media references unavailable');
      const written = writeDocsOutputMock.mock.calls[0]![0].path;
      if (moved) {
        expect((await fs.promises.stat(path.join(outside, 'tool-results', path.basename(written)))).size).toBe(0);
        await expect(fs.promises.access(written)).rejects.toThrow();
      } else {
        expect(process.platform).toBe('win32');
        expect((await fs.promises.stat(written)).size).toBe(0);
      }
    } finally {
      ledgerAddRefMock.mockImplementation(async (params: TestLedgerRef) => {
        const id = params.id ?? `ref-${++ledgerRefSeq}`;
        ledgerRefs.push({ ...params, id });
        return id;
      });
      await fs.promises.rm(root, { recursive: true, force: true });
      await fs.promises.rm(outside, { recursive: true, force: true });
    }
  });

  // Codex P1 (round 4): the ledger mutations are async boundaries too — an instance that ends
  // while refs are being committed must not keep refs or the private file in its name.
  it('rolls back refs and the file when the instance ends while media refs are committed', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ghost-spill-post-commit-'));
    try {
      const deps = makeDeps('codex');
      sessionSnapshotMock.mockResolvedValue({ workingDir: root, remoteHostId: null, permissionMode: 'auto', planModeEnabled: false });
      let calls = 0;
      liveGrantStateMock.mockImplementation(() => (++calls <= 4 ? { permissionMode: 'auto', remoteHostId: null, isCurrent: () => true, reviewAction: reviewAllow } : null));
      writeDocsOutputMock.mockImplementation(async input => {
        await fs.promises.mkdir(path.dirname(input.path), { recursive: true });
        await fs.promises.writeFile(input.path, input.data);
        const st = await fs.promises.lstat(input.path, { bigint: true });
        return { identity: { dev: st.dev.toString(), ino: st.ino.toString() } };
      });
      ledgerAddRefMock.mockImplementation(async (params: TestLedgerRef) => {
        const id = params.id ?? `ref-${++ledgerRefSeq}`;
        ledgerRefs.push({ ...params, id });
        return id;
      });
      const hash = 'c'.repeat(64);
      await expect(deps.saveLargeGhostResult!(JSON.stringify({ image: `cindy-media://blobs/${hash}.png` }))).rejects.toThrow('live session');
      expect(ledgerAddRefMock).toHaveBeenCalledOnce();
      expect(ledgerRemoveRefByIdMock).toHaveBeenCalledOnce();
      expect(ledgerRemoveRefByIdMock).toHaveBeenCalledWith(await ledgerAddRefMock.mock.results[0]!.value);
      expect(ledgerRefs).not.toContainEqual(expect.objectContaining({ hash }));
      expect((await fs.promises.stat(writeDocsOutputMock.mock.calls[0]![0].path)).size).toBe(0);
      expect(liveGrantStateMock).toHaveBeenCalledTimes(5);
    } finally { await fs.promises.rm(root, { recursive: true, force: true }); }
  });

  // Codex P1 (rounds 5–9): after a client TIMEOUT the daemon may still be writing; the only
  // acceptable proof of *this* write is the daemon's content-identity check (verifyNewFile).
  const remoteIdentity = { size: 0, mtimeMs: 0, dev: '7', ino: '9' };
  const timeoutThenVerify = (verify: (call: number) => unknown) => {
    let verifyCalls = 0;
    remoteFsRequestMock.mockImplementation(async (_host, method) => {
      if (method === 'writeNewFile') throw Object.assign(new Error('writeNewFile TIMEOUT'), { code: 'TIMEOUT' });
      if (method === 'verifyNewFile') return verify(++verifyCalls);
      return {};
    });
    return () => verifyCalls;
  };
  const remoteSession = () => {
    sessionSnapshotMock.mockResolvedValue({ workingDir: '/srv/work', remoteHostId: 'host-1', permissionMode: 'auto', planModeEnabled: false });
    liveGrantStateMock.mockReturnValue({ permissionMode: 'auto', remoteHostId: 'host-1', isCurrent: () => true, reviewAction: reviewAllow });
  };

  // Codex P1 (round 25): the directory mutation before the write is inside the same
  // frame boundary — a stale approval must not create tool-results either.
  it('withholds the remote createFolder when the instance ended while the host was connecting', async () => {
    const deps = makeDeps('codex');
    sessionSnapshotMock.mockResolvedValue({ workingDir: '/srv/work', remoteHostId: 'host-1', permissionMode: 'auto', planModeEnabled: false });
    let current = true;
    liveGrantStateMock.mockReturnValue({ permissionMode: 'auto', remoteHostId: 'host-1', isCurrent: () => current, reviewAction: reviewAllow });
    const sent: string[] = [];
    remoteFsRequestMock.mockImplementation(async (_host, method, _params, options) => {
      if (method === 'createFolder') { current = false; await options?.beforeSend?.(); }
      sent.push(method);
      return {};
    });
    await expect(deps.saveLargeGhostResult!('result')).rejects.toThrow();
    expect(sent).toEqual([]);
    expect(ledgerAddRefMock).not.toHaveBeenCalled();
  });

  // Codex P1 (round 24): the remote write re-checks the live grant at the manager's send
  // boundary (after connect/probe/install/handshake), not only before calling the manager.
  it('passes revalidation as beforeSend and withholds the remote write when the instance ended while connecting', async () => {
    const deps = makeDeps('codex');
    sessionSnapshotMock.mockResolvedValue({ workingDir: '/srv/work', remoteHostId: 'host-1', permissionMode: 'auto', planModeEnabled: false });
    let current = true;
    liveGrantStateMock.mockReturnValue({ permissionMode: 'auto', remoteHostId: 'host-1', isCurrent: () => current, reviewAction: reviewAllow });
    let bytesSent = false;
    remoteFsRequestMock.mockImplementation(async (_host, method, _params, options) => {
      if (method === 'writeNewFile') {
        current = false; // instance ended while the client was being built
        await options?.beforeSend?.();
        bytesSent = true;
        return remoteIdentity;
      }
      return {};
    });
    await expect(deps.saveLargeGhostResult!('result')).rejects.toThrow();
    expect(bytesSent).toBe(false);
    expect(ledgerAddRefMock).not.toHaveBeenCalled();
  });

  it('waits for an in-progress remote write after a timeout and accepts it once the daemon verifies the content', async () => {
    const deps = makeDeps('codex'); remoteSession();
    const text = JSON.stringify({ ok: true, result: 'x'.repeat(100) });
    const calls = timeoutThenVerify(call => { if (call < 4) throw new Error('OPERATION_FAILED: size mismatch'); return remoteIdentity; });
    await expect(deps.saveLargeGhostResult!(text)).resolves.toMatch(/^tool-results\//);
    expect(calls()).toBe(4);
    const methods = remoteFsRequestMock.mock.calls.map(call => call[1]);
    expect(methods).not.toContain('deleteEntry');
    expect(methods).not.toContain('eraseIfSame');
    expect(methods).not.toContain('stat');
    // The verification carries this write's exact content identity, not just a length.
    const verifyParams = remoteFsRequestMock.mock.calls.find(call => call[1] === 'verifyNewFile')![2] as { sha256: string; size: number };
    expect(verifyParams.size).toBe(Buffer.byteLength(text, 'utf8'));
    expect(verifyParams.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('keeps an unverifiable remote path untouched and reports the timeout instead of deleting anything', async () => {
    const deps = makeDeps('codex'); remoteSession();
    const text = JSON.stringify({ ok: true, result: 'x'.repeat(100) });
    const calls = timeoutThenVerify(() => { throw new Error('OPERATION_FAILED: content mismatch'); });
    await expect(deps.saveLargeGhostResult!(text)).rejects.toThrow('writeNewFile TIMEOUT');
    expect(calls()).toBe(REMOTE_WRITE_RECONCILE.maxAttempts);
    const methods = remoteFsRequestMock.mock.calls.map(call => call[1]);
    expect(methods).not.toContain('deleteEntry');
    expect(methods).not.toContain('eraseIfSame');
    expect(ledgerAddRefMock).not.toHaveBeenCalled();
  });

  it('waits through a temporarily missing file after the timeout (remote open may have blocked past the deadline)', async () => {
    const deps = makeDeps('codex'); remoteSession();
    const text = JSON.stringify({ ok: true, result: 'x'.repeat(100) });
    const calls = timeoutThenVerify(call => { if (call < 3) throw new Error('OPERATION_FAILED: ENOENT'); return remoteIdentity; });
    await expect(deps.saveLargeGhostResult!(text)).resolves.toMatch(/^tool-results\//);
    expect(calls()).toBe(3);
  });

  // Codex P1 (round 8): each probe may itself wait on the client deadline; the whole
  // reconciliation is bounded by wall-clock, not by probe count.
  it('stops reconciling once the wall-clock window is spent even if probes are slow', async () => {
    const deps = makeDeps('codex'); remoteSession();
    REMOTE_WRITE_RECONCILE.maxAttempts = 40;
    REMOTE_WRITE_RECONCILE.windowMs = 60;
    const text = JSON.stringify({ ok: true, result: 'x'.repeat(100) });
    const calls = timeoutThenVerify(async () => { await new Promise(resolve => setTimeout(resolve, 40)); throw Object.assign(new Error('verify TIMEOUT'), { code: 'TIMEOUT' }); });
    const started = Date.now();
    await expect(deps.saveLargeGhostResult!(text)).rejects.toThrow('writeNewFile TIMEOUT');
    expect(calls()).toBeLessThanOrEqual(3);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  // Codex P2 (round 18): a probe that never returns (daemon silent on a live channel) must
  // not outlive the reconcile window; each probe is bounded by the remaining budget.
  it('bounds a hanging verifyNewFile probe by the remaining reconcile window', async () => {
    const deps = makeDeps('codex'); remoteSession();
    REMOTE_WRITE_RECONCILE.maxAttempts = 40;
    REMOTE_WRITE_RECONCILE.windowMs = 80;
    const text = JSON.stringify({ ok: true, result: 'x'.repeat(100) });
    const calls = timeoutThenVerify(() => new Promise(() => {})); // never settles
    const started = Date.now();
    await expect(deps.saveLargeGhostResult!(text)).rejects.toThrow('writeNewFile TIMEOUT');
    expect(calls()).toBe(1);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  // Codex P1 (round 9): remote cleanup is identity-checked on the daemon and never path-based.
  it('cleans up a remote spill only through eraseIfSame with the identity returned by writeNewFile', async () => {
    const deps = makeDeps('codex');
    sessionSnapshotMock.mockResolvedValue({ workingDir: '/srv/work', remoteHostId: 'host-1', permissionMode: 'auto', planModeEnabled: false });
    let calls = 0;
    // resolve(2) → pre-write(3) → after directory step(4) → post-write(5): the 5th read ends the instance.
    liveGrantStateMock.mockImplementation(() => (++calls <= 4 ? { permissionMode: 'auto', remoteHostId: 'host-1', isCurrent: () => true, reviewAction: reviewAllow } : null));
    remoteFsRequestMock.mockImplementation(async (_host, method) => (method === 'writeNewFile' ? { size: 5, mtimeMs: 1, dev: '7', ino: '9' } : {}));
    await expect(deps.saveLargeGhostResult!('result')).rejects.toThrow('live session');
    const methods = remoteFsRequestMock.mock.calls.map(call => call[1]);
    expect(methods).not.toContain('deleteEntry');
    expect(remoteFsRequestMock).toHaveBeenCalledWith('host-1', 'eraseIfSame', { workdir: '/srv/work', relPath: expect.stringMatching(/^tool-results\//), dev: '7', ino: '9' });
  });

  // Codex P1 (round 29/30): the daemon keeps the writer's descriptor (hold) as the client's
  // inode capability across its own bookkeeping; it is released only after the last
  // revalidation — re-checked again at the release frame boundary (`beforeSend`) — and any
  // earlier failure withdraws through eraseIfSame *with* the hold. No pathname is deleted.
  it('releases the remote hold only after refs are committed and re-validates at the send boundary', async () => {
    const deps = makeDeps('codex');
    sessionSnapshotMock.mockResolvedValue({ workingDir: '/srv/work', remoteHostId: 'host-1', permissionMode: 'auto', planModeEnabled: false });
    liveGrantStateMock.mockReturnValue({ permissionMode: 'auto', remoteHostId: 'host-1', isCurrent: () => true, reviewAction: reviewAllow });
    remoteFsRequestMock.mockImplementation(async (_host, method, _params, options) => {
      if (method === 'writeNewFile') return { size: 5, mtimeMs: 1, dev: '7', ino: '9', holdId: 'hold-1', durable: true };
      if (method === 'releaseNewFile') { await options?.beforeSend?.(); return { released: true }; }
      return {};
    });
    const hash = 'a'.repeat(64);
    await deps.saveLargeGhostResult!(JSON.stringify({ image: `cindy-media://blobs/${hash}.png` }));
    const methods = remoteFsRequestMock.mock.calls.map(call => call[1]);
    expect(methods).toEqual(['createFolder', 'writeNewFile', 'releaseNewFile']);
    expect(remoteFsRequestMock).toHaveBeenCalledWith('host-1', 'releaseNewFile', { holdId: 'hold-1' }, { beforeSend: expect.any(Function) });
    // Ledger first, release last: the hold outlives every async boundary of the bookkeeping.
    expect(ledgerAddRefMock.mock.invocationCallOrder[0]!).toBeLessThan(remoteFsRequestMock.mock.invocationCallOrder.at(-1)!);
  });

  it('withdraws through the hold when the instance ended at the release frame boundary', async () => {
    const deps = makeDeps('codex');
    sessionSnapshotMock.mockResolvedValue({ workingDir: '/srv/work', remoteHostId: 'host-1', permissionMode: 'auto', planModeEnabled: false });
    let live = true;
    liveGrantStateMock.mockImplementation(() => (live ? { permissionMode: 'auto', remoteHostId: 'host-1', isCurrent: () => true, reviewAction: reviewAllow } : null));
    remoteFsRequestMock.mockImplementation(async (_host, method, _params, options) => {
      if (method === 'writeNewFile') return { size: 5, mtimeMs: 1, dev: '7', ino: '9', holdId: 'hold-1', durable: true };
      if (method === 'releaseNewFile') { live = false; await options?.beforeSend?.(); return { released: true }; }
      return {};
    });
    const hash = 'a'.repeat(64);
    await expect(deps.saveLargeGhostResult!(JSON.stringify({ image: `cindy-media://blobs/${hash}.png` }))).rejects.toThrow('live session');
    expect(remoteFsRequestMock.mock.calls.map(call => call[1])).toEqual(['createFolder', 'writeNewFile', 'releaseNewFile', 'eraseIfSame']);
    expect(remoteFsRequestMock).toHaveBeenCalledWith('host-1', 'eraseIfSame', { workdir: '/srv/work', relPath: expect.stringMatching(/^tool-results\//), dev: '7', ino: '9', holdId: 'hold-1' });
    expect(ledgerRemoveRefByIdMock).toHaveBeenCalledOnce();
    expect(ledgerRefs).not.toContainEqual(expect.objectContaining({ hash }));
  });

  it('keeps a completed remote spill when only the release response is lost', async () => {
    const deps = makeDeps('codex');
    sessionSnapshotMock.mockResolvedValue({ workingDir: '/srv/work', remoteHostId: 'host-1', permissionMode: 'auto', planModeEnabled: false });
    liveGrantStateMock.mockReturnValue({ permissionMode: 'auto', remoteHostId: 'host-1', isCurrent: () => true, reviewAction: reviewAllow });
    remoteFsRequestMock.mockImplementation(async (_host, method) => {
      if (method === 'writeNewFile') return { size: 5, mtimeMs: 1, dev: '7', ino: '9', holdId: 'hold-1', durable: true };
      if (method === 'releaseNewFile') throw Object.assign(new Error('releaseNewFile TIMEOUT'), { code: 'TIMEOUT' });
      return {};
    });
    await expect(deps.saveLargeGhostResult!('result')).resolves.toMatch(/^tool-results\//);
    expect(remoteFsRequestMock.mock.calls.map(call => call[1])).toEqual(['createFolder', 'writeNewFile', 'releaseNewFile']);
  });

  it('passes the hold to eraseIfSame when the ledger fails after a remote write', async () => {
    const deps = makeDeps('codex');
    sessionSnapshotMock.mockResolvedValue({ workingDir: '/srv/work', remoteHostId: 'host-1', permissionMode: 'auto', planModeEnabled: false });
    liveGrantStateMock.mockReturnValue({ permissionMode: 'auto', remoteHostId: 'host-1', isCurrent: () => true, reviewAction: reviewAllow });
    remoteFsRequestMock.mockImplementation(async (_host, method) => (method === 'writeNewFile' ? { size: 5, mtimeMs: 1, dev: '7', ino: '9', holdId: 'hold-1', durable: true } : {}));
    ledgerAddRefMock.mockImplementation(async () => { throw new Error('FOREIGN KEY constraint failed'); });
    try {
      await expect(deps.saveLargeGhostResult!(JSON.stringify({ image: `cindy-media://blobs/${'f'.repeat(64)}.png` }))).rejects.toThrow('media references unavailable');
      expect(remoteFsRequestMock.mock.calls.map(call => call[1])).toEqual(['createFolder', 'writeNewFile', 'eraseIfSame']);
      expect(remoteFsRequestMock).toHaveBeenCalledWith('host-1', 'eraseIfSame', expect.objectContaining({ dev: '7', ino: '9', holdId: 'hold-1' }));
    } finally {
      ledgerAddRefMock.mockImplementation(async (params: TestLedgerRef) => {
        const id = params.id ?? `ref-${++ledgerRefSeq}`;
        ledgerRefs.push({ ...params, id });
        return id;
      });
    }
  });

  // Codex P1 (round 30): a staging removal that did not reach disk is reported, not swallowed;
  // this client is the only party that accepted the publish and withdraws through the hold.
  it('withdraws a remote write whose staging removal was not durable', async () => {
    const deps = makeDeps('codex');
    sessionSnapshotMock.mockResolvedValue({ workingDir: '/srv/work', remoteHostId: 'host-1', permissionMode: 'auto', planModeEnabled: false });
    liveGrantStateMock.mockReturnValue({ permissionMode: 'auto', remoteHostId: 'host-1', isCurrent: () => true, reviewAction: reviewAllow });
    remoteFsRequestMock.mockImplementation(async (_host, method) => (method === 'writeNewFile' ? { size: 5, mtimeMs: 1, dev: '7', ino: '9', holdId: 'hold-1', durable: false } : {}));
    await expect(deps.saveLargeGhostResult!('result')).rejects.toThrow('not durable');
    expect(remoteFsRequestMock.mock.calls.map(call => call[1])).toEqual(['createFolder', 'writeNewFile', 'eraseIfSame']);
    expect(remoteFsRequestMock).toHaveBeenCalledWith('host-1', 'eraseIfSame', expect.objectContaining({ dev: '7', ino: '9', holdId: 'hold-1' }));
    expect(ledgerAddRefMock).not.toHaveBeenCalled();
  });

  it('carries the hold learned from verifyNewFile into the release after a lost write response', async () => {
    const deps = makeDeps('codex');
    sessionSnapshotMock.mockResolvedValue({ workingDir: '/srv/work', remoteHostId: 'host-1', permissionMode: 'auto', planModeEnabled: false });
    liveGrantStateMock.mockReturnValue({ permissionMode: 'auto', remoteHostId: 'host-1', isCurrent: () => true, reviewAction: reviewAllow });
    remoteFsRequestMock.mockImplementation(async (_host, method) => {
      if (method === 'writeNewFile') throw Object.assign(new Error('writeNewFile TIMEOUT'), { code: 'TIMEOUT' });
      if (method === 'verifyNewFile') return { size: 5, mtimeMs: 1, dev: '7', ino: '9', holdId: 'hold-v' };
      if (method === 'releaseNewFile') return { released: true };
      return {};
    });
    await deps.saveLargeGhostResult!('result');
    expect(remoteFsRequestMock.mock.calls.map(call => call[1])).toEqual(['createFolder', 'writeNewFile', 'verifyNewFile', 'releaseNewFile']);
    expect(remoteFsRequestMock).toHaveBeenCalledWith('host-1', 'releaseNewFile', { holdId: 'hold-v' }, { beforeSend: expect.any(Function) });
  });

  // Codex P1 (round 6): createFolder can time out while the daemon is still running mkdir.
  it.each([
    { name: 'waits for the folder to appear after a createFolder timeout, then writes', appears: true },
    { name: 'gives up without writing when the folder never appears after a createFolder timeout', appears: false },
  ])('$name', async ({ appears }) => {
    const deps = makeDeps('codex');
    sessionSnapshotMock.mockResolvedValue({ workingDir: '/srv/work', remoteHostId: 'host-1', permissionMode: 'auto', planModeEnabled: false });
    liveGrantStateMock.mockReturnValue({ permissionMode: 'auto', remoteHostId: 'host-1', isCurrent: () => true, reviewAction: reviewAllow });
    const text = JSON.stringify({ ok: true, result: 'x'.repeat(100) });
    let dirStats = 0;
    remoteFsRequestMock.mockImplementation(async (_host, method, params) => {
      if (method === 'createFolder') throw Object.assign(new Error('createFolder TIMEOUT'), { code: 'TIMEOUT' });
      if (method === 'stat' && (params as { relPath: string }).relPath === 'tool-results') {
        dirStats += 1;
        if (appears && dirStats >= 3) return { relPath: 'tool-results', mtimeMs: 0, type: 'directory', size: 0 };
        throw new Error('OPERATION_FAILED: ENOENT');
      }
      return {};
    });
    const outcome = deps.saveLargeGhostResult!(text);
    const methods = () => remoteFsRequestMock.mock.calls.map(call => call[1]);
    if (appears) {
      await expect(outcome).resolves.toMatch(/^tool-results\//);
      expect(dirStats).toBe(3);
      expect(methods()).toContain('writeNewFile');
    } else {
      await expect(outcome).rejects.toThrow('createFolder TIMEOUT');
      expect(dirStats).toBe(REMOTE_WRITE_RECONCILE.maxAttempts);
      expect(methods()).not.toContain('writeNewFile');
    }
  });

  // Codex P1 (round 3, refined in round 9): a lost RPC response is not a failed write. The
  // daemon's verifyNewFile decides; nothing is ever deleted on ambiguity.
  it.each([
    { name: 'accepts a verified complete file after a lost response', code: 'CHANNEL_CLOSED', verified: true },
    { name: 'keeps an unverified path untouched after a lost response and reports failure', code: 'CHANNEL_CLOSED', verified: false },
    { name: 'accepts a verified complete file after a client timeout', code: 'TIMEOUT', verified: true },
    { name: 'keeps an unverified path untouched after a client timeout and reports failure', code: 'TIMEOUT', verified: false },
    // Codex P1 (round 15b): the endpoint-generation wrapper error hides the real outcome.
    { name: 'accepts a verified complete file after an endpoint-stale wrapper error', code: 'ENDPOINT_STALE', verified: true },
    { name: 'keeps an unverified path untouched after an endpoint-stale wrapper error', code: 'ENDPOINT_STALE', verified: false },
  ])('$name', async ({ code, verified }) => {
    const deps = makeDeps('codex'); remoteSession();
    const text = JSON.stringify({ ok: true, result: 'x'.repeat(100) });
    remoteFsRequestMock.mockImplementation(async (_host, method) => {
      if (method === 'writeNewFile') throw Object.assign(new Error(`writeNewFile ${code}`), { code });
      if (method === 'verifyNewFile') { if (verified) return remoteIdentity; throw new Error('OPERATION_FAILED: not a regular file'); }
      return {};
    });
    const outcome = deps.saveLargeGhostResult!(text);
    if (verified) await expect(outcome).resolves.toMatch(/^tool-results\//);
    else await expect(outcome).rejects.toThrow(`writeNewFile ${code}`);
    const methods = remoteFsRequestMock.mock.calls.map(call => call[1]);
    expect(methods).not.toContain('deleteEntry');
    expect(methods).not.toContain('eraseIfSame');
    expect(methods.slice(0, 3)).toEqual(['createFolder', 'writeNewFile', 'verifyNewFile']);
    if (!verified) expect(methods.filter(m => m === 'verifyNewFile')).toHaveLength(REMOTE_WRITE_RECONCILE.maxAttempts);
  });

  it('does not spill a remote session result when the live instance disagrees about the host', async () => {
    const deps = makeDeps('codex');
    sessionSnapshotMock.mockResolvedValue({ workingDir: '/srv/work', remoteHostId: 'host-1', permissionMode: 'auto', planModeEnabled: false });
    liveGrantStateMock.mockReturnValue({ permissionMode: 'auto', remoteHostId: 'host-2' });
    await expect(deps.saveLargeGhostResult!('result')).rejects.toThrow();
    expect(remoteFsRequestMock).not.toHaveBeenCalled();
  });
});

describe('market install live authority', () => {
  function marketHarness(agentKind: TestAgentKind = 'claude-code') {
    const ghost = { manifest: { id: 'mail-suite', name: 'Mail', version: '1' }, enabled: true };
    const market = {
      snapshot: vi.fn(async () => ({ items: [], unavailableReason: null, customSourceNames: [], unavailableCustomSourceNames: [] })),
      detail: vi.fn(async () => ({ ghostId: 'mail-suite', releaseId: 'r1', manifest: ghost.manifest })),
      install: vi.fn(async (_id: string, _options: unknown, guard?: () => void) => { guard?.(); return { ghost }; }),
    };
    const deps = makeDeps(agentKind, 's1', 's1-instance', {}, market as unknown as CindyGhostsHostDeps['pluginMarket']);
    return { deps, market };
  }

  it.each(['claude-code', 'codex', 'pi'] as const)('uses the live %s task and does not connect on install', async (kind) => {
    liveGrantStateMock.mockReturnValue({ permissionMode: 'auto', isCurrent: () => true });
    const { deps, market } = marketHarness(kind);
    expect(await deps.searchMarket!('gmail')).toMatchObject({ ok: true, items: [] });
    expect(market.install).not.toHaveBeenCalled();
    expect(await deps.installMarket!({ pluginId: 'p1', releaseId: 'r1' })).toMatchObject({ status: 'installed', ghost_id: 'mail-suite' });
    expect(liveGrantStateMock).toHaveBeenCalledWith('s1', 's1-instance');
    expect(releaseMutationMock).toHaveBeenCalledOnce();
    expect(authorizationRequestMock).not.toHaveBeenCalled();
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it.each([null, { permissionMode: 'plan', isCurrent: () => true }, { permissionMode: 'auto' }, { permissionMode: 'auto', isCurrent: () => false }])('rejects unavailable or non-writable live authority %j', async (live) => {
    liveGrantStateMock.mockReturnValue(live);
    const { deps, market } = marketHarness();
    expect(await deps.installMarket!({ pluginId: 'p1', releaseId: 'r1' })).toMatchObject({ ok: false, errorCode: 'PERMISSION_DENIED' });
    expect(market.detail).not.toHaveBeenCalled();
    expect(acquireMutationLeaseMock).not.toHaveBeenCalled();
  });

  it.each(['cancel', 'permission-change'])('rechecks %s at placement and releases the owner lease', async (change) => {
    let current = true;
    const controller = new AbortController();
    liveGrantStateMock.mockReturnValue({ permissionMode: 'auto', isCurrent: () => current });
    const { deps, market } = marketHarness();
    const place = vi.fn();
    market.install.mockImplementation(async (_id, _options, guard) => {
      if (change === 'cancel') controller.abort(); else current = false;
      guard?.(); place();
      throw new Error('unreachable');
    });
    expect(await deps.installMarket!({ pluginId: 'p1', releaseId: 'r1' }, controller.signal)).toMatchObject({ ok: false, errorCode: 'PERMISSION_DENIED' });
    expect(place).not.toHaveBeenCalled();
    expect(releaseMutationMock).toHaveBeenCalledOnce();
  });

  it('rejects an already cancelled request before catalog access', async () => {
    liveGrantStateMock.mockReturnValue({ permissionMode: 'auto', isCurrent: () => true });
    const { deps, market } = marketHarness();
    const controller = new AbortController(); controller.abort();
    expect(await deps.installMarket!({ pluginId: 'p1', releaseId: 'r1' }, controller.signal)).toMatchObject({ ok: false, errorCode: 'PERMISSION_DENIED' });
    expect(market.detail).not.toHaveBeenCalled();
  });
});
