/**
 * 导入编排集成测试:在测试内构造真实 .xdtshare 包(明文/加密),mock DB 与
 * codex/媒体依赖,走 inspect → unlock → commit 全流程,验证转录落位、URL 重写、
 * 冲突拒绝与失败回滚。
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import JSZip from 'jszip';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'xdtshare-import-test-'));
const projectsRoot = path.join(tmpRoot, 'claude-home', 'projects');
const newWorkdir = path.join(tmpRoot, 'their-proj');
const sharedMediaRoot = path.join(tmpRoot, 'shared-media');

const dbMock = vi.hoisted(() => ({
  conflictRow: null as { id: string; status?: string } | null,
  txCalls: [] as Array<{ name: string; args: unknown }>,
  txError: null as Error | null,
}));
const patchMock = vi.hoisted(() => ({
  calls: [] as Array<{ sessionId: string; patch: Record<string, unknown> }>,
}));
const codexMock = vi.hoisted(() => ({
  importCalls: [] as unknown[],
  removeCalls: [] as unknown[],
}));
const cindyMediaMock = vi.hoisted(() => ({
  ingestCalls: [] as Array<{ buffer: Buffer; mimeType: string; refs: Array<Record<string, unknown>> }>,
  removeSessionRefsCalls: [] as string[],
  /** 置为 Error 让 ingest 全部失败(测回落老目录路径)。 */
  ingestError: null as Error | null,
}));
const legacyImageMock = vi.hoisted(() => ({
  removeSessionCalls: [] as string[],
}));

vi.mock('electron', () => ({
  app: { getPath: () => tmpRoot, getVersion: () => '9.9.9' },
}));
vi.mock('../../localDb/client/current.js', () => ({
  getDbClient: () => ({
    queryOne: async () => dbMock.conflictRow ?? undefined,
    tx: async (name: string, args: unknown) => {
      if (dbMock.txError) throw dbMock.txError;
      dbMock.txCalls.push({ name, args });
      return { messageCount: (args as { messages: unknown[] }).messages.length };
    },
  }),
}));
vi.mock('../../localDb/dialogueWorkspace.js', () => ({
  ensureDialogueWorkspaceDir: (sessionId: string) => {
    const dir = path.join(tmpRoot, 'dialogues', sessionId);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  },
}));
vi.mock('../../maker-host/codex-local-sessions.js', () => ({
  importSharedCodexThread: async (params: unknown) => {
    codexMock.importCalls.push(params);
    return {
      rolloutPath: path.join(tmpRoot, 'landed-rollout.jsonl'),
      rolloutWritten: true,
      stateWritten: true,
      statePresent: true,
    };
  },
  removeSharedCodexThread: async (threadId: string, written: unknown) => {
    codexMock.removeCalls.push({ threadId, written });
  },
}));
vi.mock('../../maker-orchestration/claudeTranscriptAnchors.js', () => ({
  defaultClaudeConfigDirCandidates: () => [path.join(tmpRoot, 'claude-home')],
}));
vi.mock('../../imageCacheStore.js', () => ({
  getCacheRoot: () => path.join(tmpRoot, 'cc-agent', 'images'),
  getSessionDir: (sessionId: string) => path.join(tmpRoot, 'cc-agent', 'images', sessionId),
  removeSession: async (sessionId: string) => {
    legacyImageMock.removeSessionCalls.push(sessionId);
  },
  resolveSafe: (url: string) => {
    const parsed = new URL(url);
    const host = parsed.hostname;
    const filename = decodeURIComponent(parsed.pathname.slice(1));
    return {
      absPath: path.join(tmpRoot, 'cc-agent', 'images', host, filename),
      mimeType: 'image/png',
    };
  },
}));
vi.mock('../../videoCacheStore.js', () => ({
  resolveSafe: () => ({ absPath: path.join(tmpRoot, 'videos', 'v.mp4'), mimeType: 'video/mp4' }),
}));
vi.mock('../../modelCacheStore.js', () => ({
  resolveSafe: () => {
    throw new Error('unknown host');
  },
}));
vi.mock('../../logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));
// cindy-media:blobStore 用真实实现(纯函数 + electron 已 mock);ingest/ledger
// 记账依赖 DbClient,这里 mock 成调用记录器,测导入编排语义(指纹前置核对、
// mismatch 跳过、journal 回滚)而非账本本体(账本有自己的单测)。
vi.mock('../../cindy-media/ingest.js', () => ({
  ingestMedia: async (params: { buffer: Buffer; mimeType: string; refs: Array<Record<string, unknown>> }) => {
    if (cindyMediaMock.ingestError) throw cindyMediaMock.ingestError;
    cindyMediaMock.ingestCalls.push(params);
    // 用真实 sha256 当指纹:导入路径会经 resolveHashRef 反推仓内路径,
    // 假指纹会被形状校验拒掉、静默落回老路径,测不到新分支。
    const { createHash: ch } = await import('node:crypto');
    const hash = ch('sha256').update(params.buffer).digest('hex');
    const ext = params.mimeType === 'audio/mpeg' ? '.mp3' : '.png';
    return {
      hash,
      ext,
      mimeType: params.mimeType,
      bytes: params.buffer.byteLength,
      url: `cindy-media://blobs/${hash}${ext}`,
      deduplicated: false,
      refIds: ['ref-1'],
    };
  },
}));
vi.mock('../../cindy-media/ledger.js', () => ({
  removeSessionRefs: async (sessionId: string) => {
    cindyMediaMock.removeSessionRefsCalls.push(sessionId);
    return 0;
  },
}));
const worktreeMock = vi.hoisted(() => ({
  detect: null as
    | null
    | { isGitRepo: boolean; isInsideWorktree: boolean; gitInstalled: boolean; repoRoot?: string; currentBranch?: string },
  createResult: null as null | { ok: true; meta: { path: string } } | { ok: false; error: { kind: string; message?: string } },
  createCalls: [] as Array<{ sessionId: string; baseRepo: string; name: string; sourceBranch: string }>,
  removeCalls: [] as string[],
}));
vi.mock('../../worktree/WorktreeManager.js', () => ({
  detectCwd: async () =>
    worktreeMock.detect ?? { isGitRepo: false, isInsideWorktree: false, gitInstalled: true },
  suggestName: async () => 'imported-wt',
  createWorktree: async (req: { sessionId: string; baseRepo: string; name: string; sourceBranch: string }) => {
    worktreeMock.createCalls.push(req);
    return worktreeMock.createResult ?? { ok: false, error: { kind: 'unknown', message: 'no mock' } };
  },
  removeWorktreeForSession: async (sessionId: string) => {
    worktreeMock.removeCalls.push(sessionId);
  },
}));
// 覆盖导入的软删/恢复走 patchSessionMetaInDb(真实实现依赖 Electron 主进程环境)
vi.mock('../../localDb/ipc/sessions.js', () => ({
  patchSessionMetaInDb: async (sessionId: string, patch: Record<string, unknown>) => {
    patchMock.calls.push({ sessionId, patch });
    return { id: sessionId, ...patch };
  },
}));

const { inspectShareFile, unlockShareDraft, commitShareImport, cancelShareDraft } = await import(
  '../sessionShareImport.js'
);
const { buildLooseUrl } = await import('../mediaUrlRewrite.pure.js');
const { buildPlainFile, sealPayload } = await import('../xdtshareCrypto.js');

const OLD_SESSION_ID = 'old-session-id';
const SID = 'aaaaaaaa-1111-2222-3333-444444444444';
const IMAGE_URL = `xdt-image://${OLD_SESSION_ID}/img-1.png`;

/** 老包媒体入总仓后消息里的新地址 = 字节指纹(与 ingest mock 同算法)。 */
function blobUrlOf(bytes: Buffer, ext = '.png'): string {
  return `cindy-media://blobs/${createHash('sha256').update(bytes).digest('hex')}${ext}`;
}
const IMG1_BYTES = Buffer.from([1, 2, 3]);
const IMG2_BYTES = Buffer.from([7, 8, 9]);
const FILE_URL = `xdt-file://local/?path=${encodeURIComponent('/old/machine/doc.pdf')}`;

interface BundleOverrides {
  manifest?: Record<string, unknown>;
  /** 覆盖 session.json snapshot 字段(导出方会话配置不进导入行的语义测试)。 */
  session?: Record<string, unknown>;
  omitTranscript?: boolean;
  agentKind?: 'cc' | 'codex';
  /** 伪造 media-map 里 image entry 的 filename 字段(路径穿越攻击面测试)。 */
  imageFilenameOverride?: string;
  /** 额外加一条不同 old host 的图片 URL(fork 祖先链多 host 测试)。 */
  extraImage?: string;
  /** 加一条 cindy-media blob 条目(媒体总仓);urlHash 可指定 URL 里声称的指纹(不给则用字节真实指纹)。 */
  blob?: { bytes: Buffer; urlHash?: string };
  /** 加一条媒体类 loose 条目(xdt-audio mp3,测试入仓重写)。 */
  looseAudio?: { bytes: Buffer };
  /** v1 旧包没有逐消息 agentKind。 */
  omitMessageAgentKind?: boolean;
}

async function buildBundle(overrides: BundleOverrides = {}): Promise<Buffer> {
  const agentKind = overrides.agentKind ?? 'cc';
  const zip = new JSZip();
  const extraImageText = overrides.extraImage ? ` 祖先图 ${overrides.extraImage}` : '';
  const blobHash = overrides.blob
    ? (overrides.blob.urlHash ?? createHash('sha256').update(overrides.blob.bytes).digest('hex'))
    : null;
  const blobUrl = blobHash ? `cindy-media://blobs/${blobHash}.png` : null;
  const blobText = blobUrl ? ` 总仓图 ${blobUrl}` : '';
  const looseAudioUrl = overrides.looseAudio
    ? `xdt-audio://local/?path=${encodeURIComponent('/old/machine/voice.mp3')}`
    : null;
  const looseAudioText = looseAudioUrl ? ` 音频 ${looseAudioUrl}` : '';
  const messages = [
    {
      id: 'm1',
      clientId: 'c1',
      role: 'user',
      content: JSON.stringify([{ type: 'text', text: `图 ${IMAGE_URL} 文件 ${FILE_URL}${extraImageText}${blobText}${looseAudioText}` }]),
      toolUseId: null,
      agentMeta: null,
      ...(overrides.omitMessageAgentKind ? {} : { agentKind: 'cc' }),
      createdAt: 1700000000100,
      rewindAt: null,
    },
    {
      id: 'm2',
      clientId: 'c2',
      role: 'assistant',
      content: '"ok"',
      toolUseId: null,
      agentMeta: `{"sdkSessionId":"${SID}"}`,
      ...(overrides.omitMessageAgentKind ? {} : { agentKind: 'codex' }),
      createdAt: 1700000000200,
      rewindAt: null,
    },
  ];
  zip.file('session.json', JSON.stringify({ model: 'claude-sonnet-4-6', effort: 'high', permissionMode: 'ask', createdAt: 1700000000000, userSendAt: 1700000000100, ...overrides.session }));
  zip.file('messages.jsonl', messages.map((m) => JSON.stringify(m)).join('\n'));
  const transcriptPath = agentKind === 'cc' ? `transcripts/claude/${SID}.jsonl` : `transcripts/codex/rollout-x-${SID}.jsonl`;
  if (!overrides.omitTranscript) zip.file(transcriptPath, '{"line":1}\n');
  if (agentKind === 'codex') {
    zip.file('codex-state/thread.json', JSON.stringify({ threads: [{ id: SID }], threadDynamicTools: [], threadSpawnEdges: [] }));
  }
  zip.file('media/images/1-img-1.png', Buffer.from([1, 2, 3]));
  zip.file('media/loose/2-doc.pdf', Buffer.from([4, 5, 6]));
  const mediaEntries: Array<Record<string, unknown>> = [
    {
      url: IMAGE_URL,
      scheme: 'xdt-image',
      kind: 'image',
      zipPath: 'media/images/1-img-1.png',
      imageHost: OLD_SESSION_ID,
      filename: overrides.imageFilenameOverride ?? 'img-1.png',
    },
    { url: FILE_URL, scheme: 'xdt-file', kind: 'loose', zipPath: 'media/loose/2-doc.pdf', filename: 'doc.pdf' },
  ];
  if (overrides.extraImage) {
    zip.file('media/images/3-img-2.png', Buffer.from([7, 8, 9]));
    mediaEntries.push({
      url: overrides.extraImage,
      scheme: 'xdt-image',
      kind: 'image',
      zipPath: 'media/images/3-img-2.png',
      imageHost: new URL(overrides.extraImage).hostname,
      filename: 'img-2.png',
    });
  }
  if (overrides.blob && blobUrl && blobHash) {
    const zipPath = `media/blobs/4-${blobHash}.png`;
    zip.file(zipPath, overrides.blob.bytes);
    mediaEntries.push({ url: blobUrl, scheme: 'cindy-media', kind: 'blob', zipPath, filename: `${blobHash}.png` });
  }
  if (overrides.looseAudio && looseAudioUrl) {
    zip.file('media/loose/5-voice.mp3', overrides.looseAudio.bytes);
    mediaEntries.push({
      url: looseAudioUrl,
      scheme: 'xdt-audio',
      kind: 'loose',
      zipPath: 'media/loose/5-voice.mp3',
      filename: 'voice.mp3',
    });
  }
  zip.file('media-map.json', JSON.stringify({ entries: mediaEntries }));
  const manifest = {
    formatVersion: 1,
    minReaderVersion: 1,
    appVersion: '9.9.9',
    platform: 'darwin',
    exportedAt: '2026-07-04T00:00:00.000Z',
    agentKind,
    title: '分享会话',
    workspaceKind: 'project',
    originalWorkingDir: '/old/machine/proj',
    sdkSessionIds: [SID],
    activeSdkSessionId: SID,
    exportFidelity: overrides.omitTranscript ? 'db-only' : 'full',
    counts: { messages: 2, media: 2 },
    entries: [],
    transcripts: [{ sdkSessionId: SID, path: overrides.omitTranscript ? null : transcriptPath }],
    ...overrides.manifest,
  };
  zip.file('manifest.json', JSON.stringify(manifest));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}

async function writeBundleFile(bytes: Buffer, password?: string): Promise<string> {
  const file = password ? await sealPayload(bytes, password) : buildPlainFile(bytes);
  const p = path.join(tmpRoot, `bundle-${Math.random().toString(36).slice(2)}.xdtshare`);
  await fsp.writeFile(p, file);
  return p;
}

describe('sessionShareImport', () => {
  beforeEach(async () => {
    dbMock.conflictRow = null;
    dbMock.txCalls = [];
    dbMock.txError = null;
    patchMock.calls = [];
    codexMock.importCalls = [];
    codexMock.removeCalls = [];
    cindyMediaMock.ingestCalls = [];
    cindyMediaMock.removeSessionRefsCalls = [];
    cindyMediaMock.ingestError = null;
    legacyImageMock.removeSessionCalls = [];
    worktreeMock.detect = null;
    worktreeMock.createResult = null;
    worktreeMock.createCalls = [];
    worktreeMock.removeCalls = [];
    await fsp.rm(projectsRoot, { recursive: true, force: true });
    await fsp.rm(sharedMediaRoot, { recursive: true, force: true });
    await fsp.mkdir(newWorkdir, { recursive: true });
  });

  afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('cc full import: transcript placed at re-sanitized dir, urls rewritten, tx last', async () => {
    const filePath = await writeBundleFile(await buildBundle());
    const inspect = await inspectShareFile(filePath);
    expect(inspect.encrypted).toBe(false);
    if (inspect.encrypted) return;
    expect(inspect.preview.title).toBe('分享会话');

    const result = await commitShareImport({
      draftId: inspect.draftId,
      workingDir: newWorkdir,
      projectsRootOverride: projectsRoot,
      sharedMediaRootOverride: sharedMediaRoot,
    });
    expect(result.fidelity).toBe('full');

    // 转录落在新 workdir 的转码目录
    const key = newWorkdir.replace(/[^a-zA-Z0-9]/g, '-');
    const jsonl = path.join(projectsRoot, key, `${SID}.jsonl`);
    expect(fs.existsSync(jsonl)).toBe(true);

    // DB tx:content 里老 xdt-image 图重写为总仓 blob 地址、loose 非
    // 媒体 url 换 shared-media 新落盘路径
    expect(dbMock.txCalls).toHaveLength(1);
    const txArgs = dbMock.txCalls[0].args as {
      session: { id: string; source: string; sdkSessionId: string; workingDir: string };
      messages: Array<{ content: string; clientId: string; agentKind: string | null }>;
    };
    expect(txArgs.session.source).toBe('shared');
    expect(txArgs.session.sdkSessionId).toBe(SID);
    expect(txArgs.session.workingDir).toBe(newWorkdir);
    expect(txArgs.session.id).toBe(result.sessionId);
    expect(txArgs.messages.map((m) => m.agentKind)).toEqual(['cc', 'codex']);
    const content0 = txArgs.messages[0].content;
    expect(content0).toContain(blobUrlOf(IMG1_BYTES));
    expect(content0).not.toContain('xdt-image://');
    expect(content0).not.toContain(OLD_SESSION_ID);
    expect(content0).not.toContain('%2Fold%2Fmachine%2Fdoc.pdf');
    expect(content0).toContain('2-doc.pdf');

    // 图片入总仓(挂 import 引用),不再写 cc-agent/images;pdf 非媒体维持老路径
    const imgIngest = cindyMediaMock.ingestCalls.find((c) => Buffer.from(c.buffer).equals(IMG1_BYTES));
    expect(imgIngest?.refs).toEqual([{ refKind: 'import', refId: result.sessionId, originKind: 'user' }]);
    expect(fs.existsSync(path.join(tmpRoot, 'cc-agent', 'images', result.sessionId, 'img-1.png'))).toBe(false);
    expect(fs.existsSync(path.join(sharedMediaRoot, result.sessionId, '2-doc.pdf'))).toBe(true);
  });

  it('legacy bundle without message agentKind imports rows as NULL', async () => {
    const filePath = await writeBundleFile(await buildBundle({ omitMessageAgentKind: true }));
    const inspect = await inspectShareFile(filePath);
    if (inspect.encrypted) return;
    await commitShareImport({
      draftId: inspect.draftId,
      workingDir: newWorkdir,
      projectsRootOverride: projectsRoot,
      sharedMediaRootOverride: sharedMediaRoot,
    });
    const txArgs = dbMock.txCalls[0].args as {
      messages: Array<{ agentKind: string | null }>;
    };
    expect(txArgs.messages.map((m) => m.agentKind)).toEqual([null, null]);
  });

  it('loose 媒体(mp3)入总仓:?path= 重写为仓内绝对路径,shared-media 零落盘', async () => {
    const mp3 = Buffer.from('fake-mp3-bytes');
    const filePath = await writeBundleFile(await buildBundle({ looseAudio: { bytes: mp3 } }));
    const inspect = await inspectShareFile(filePath);
    if (inspect.encrypted) return;
    const result = await commitShareImport({
      draftId: inspect.draftId,
      workingDir: newWorkdir,
      projectsRootOverride: projectsRoot,
      sharedMediaRootOverride: sharedMediaRoot,
    });

    const call = cindyMediaMock.ingestCalls.find((c) => Buffer.from(c.buffer).equals(mp3));
    expect(call?.mimeType).toBe('audio/mpeg');
    expect(call?.refs).toEqual([{ refKind: 'import', refId: result.sessionId, originKind: 'user' }]);

    // ?path= 重写为仓内绝对路径(blobStore 真实实现按 tmpRoot userData 反推)
    const hash = createHash('sha256').update(mp3).digest('hex');
    const expectedAbs = path.join(tmpRoot, 'cindy-media', 'blobs', hash.slice(0, 2), `${hash}.mp3`);
    const txArgs = dbMock.txCalls[0].args as { messages: Array<{ content: string }> };
    const content0 = txArgs.messages[0].content;
    expect(content0).toContain(buildLooseUrl('xdt-audio', expectedAbs));
    expect(content0).not.toContain('%2Fold%2Fmachine%2Fvoice.mp3');
    // shared-media 老目录不再收媒体散件
    expect(fs.existsSync(path.join(sharedMediaRoot, result.sessionId, '5-voice.mp3'))).toBe(false);
  });

  it('ingest 全挂时回落老目录:行为与迁移前一致(附件不能丢)', async () => {
    cindyMediaMock.ingestError = new Error('ledger down');
    const filePath = await writeBundleFile(await buildBundle());
    const inspect = await inspectShareFile(filePath);
    if (inspect.encrypted) return;
    const result = await commitShareImport({
      draftId: inspect.draftId,
      workingDir: newWorkdir,
      projectsRootOverride: projectsRoot,
      sharedMediaRootOverride: sharedMediaRoot,
    });

    const txArgs = dbMock.txCalls[0].args as { messages: Array<{ content: string }> };
    const content0 = txArgs.messages[0].content;
    expect(content0).toContain(`xdt-image://${result.sessionId}/img-1.png`);
    expect(content0).not.toContain('cindy-media://');
    expect(fs.existsSync(path.join(tmpRoot, 'cc-agent', 'images', result.sessionId, 'img-1.png'))).toBe(true);
    expect(fs.existsSync(path.join(sharedMediaRoot, result.sessionId, '2-doc.pdf'))).toBe(true);
  });

  it('回落形态 + 落库失败:journal 回滚清理老目录会话图(removeSession 被调)', async () => {
    cindyMediaMock.ingestError = new Error('ledger down');
    dbMock.txError = new Error('db down');
    const filePath = await writeBundleFile(await buildBundle());
    const inspect = await inspectShareFile(filePath);
    if (inspect.encrypted) return;
    await expect(
      commitShareImport({
        draftId: inspect.draftId,
        workingDir: newWorkdir,
        projectsRootOverride: projectsRoot,
        sharedMediaRootOverride: sharedMediaRoot,
      }),
    ).rejects.toThrow();
    expect(legacyImageMock.removeSessionCalls).toHaveLength(1);
  });

  it('cindy-media blob 导入:指纹核对通过 → ingest 挂 import 引用,URL 不重写', async () => {
    const bytes = Buffer.from('blob-bytes-main');
    const hash = createHash('sha256').update(bytes).digest('hex');
    const filePath = await writeBundleFile(await buildBundle({ blob: { bytes } }));
    const inspect = await inspectShareFile(filePath);
    if (inspect.encrypted) return;
    const result = await commitShareImport({
      draftId: inspect.draftId,
      workingDir: newWorkdir,
      projectsRootOverride: projectsRoot,
      sharedMediaRootOverride: sharedMediaRoot,
    });
    // bundle 里的 xdt-image 老图也会 ingest,按字节找 blob 条目那次调用
    const call = cindyMediaMock.ingestCalls.find((c) => Buffer.from(c.buffer).equals(bytes));
    expect(call).toBeDefined();
    expect(call!.mimeType).toBe('image/png');
    expect(call!.refs).toEqual([{ refKind: 'import', refId: result.sessionId, originKind: 'user' }]);
    // 内容寻址地址跨机器稳定:content 里 blob URL 原样保留,不进 urlMap 重写
    const txArgs = dbMock.txCalls[0].args as { messages: Array<{ content: string }> };
    expect(txArgs.messages[0].content).toContain(`cindy-media://blobs/${hash}.png`);
    expect(cindyMediaMock.removeSessionRefsCalls).toHaveLength(0);
  });

  it('cindy-media blob 指纹不符(恶意/损坏包):不入库不挂账,导入照常完成', async () => {
    const filePath = await writeBundleFile(
      await buildBundle({ blob: { bytes: Buffer.from('evil-bytes'), urlHash: 'f'.repeat(64) } }),
    );
    const inspect = await inspectShareFile(filePath);
    if (inspect.encrypted) return;
    const result = await commitShareImport({
      draftId: inspect.draftId,
      workingDir: newWorkdir,
      projectsRootOverride: projectsRoot,
      sharedMediaRootOverride: sharedMediaRoot,
    });
    expect(result.sessionId).toBeTruthy();
    // 指纹不符的 evil 字节绝不入库(img-1 老图的 ingest 是正常行为)
    expect(
      cindyMediaMock.ingestCalls.some((c) => Buffer.from(c.buffer).equals(Buffer.from('evil-bytes'))),
    ).toBe(false);
  });

  it('cindy-media blob 已入账后导入失败:journal 回滚删除新会话名下引用行', async () => {
    dbMock.txError = new Error('db down');
    const filePath = await writeBundleFile(await buildBundle({ blob: { bytes: Buffer.from('rollback-bytes') } }));
    const inspect = await inspectShareFile(filePath);
    if (inspect.encrypted) return;
    await expect(
      commitShareImport({
        draftId: inspect.draftId,
        workingDir: newWorkdir,
        projectsRootOverride: projectsRoot,
        sharedMediaRootOverride: sharedMediaRoot,
      }),
    ).rejects.toThrow();
    const blobCall = cindyMediaMock.ingestCalls.find((c) =>
      Buffer.from(c.buffer).equals(Buffer.from('rollback-bytes')),
    );
    expect(blobCall).toBeDefined();
    const grantedId = blobCall!.refs[0].refId;
    expect(cindyMediaMock.removeSessionRefsCalls).toEqual([grantedId]);
  });

  it('encrypted flow: inspect → wrong password → unlock → commit', async () => {
    const filePath = await writeBundleFile(await buildBundle(), 'pw');
    const inspect = await inspectShareFile(filePath);
    expect(inspect.encrypted).toBe(true);

    await expect(unlockShareDraft(inspect.draftId, 'nope')).rejects.toMatchObject({
      code: 'SHARE_PASSWORD_WRONG',
    });
    const preview = await unlockShareDraft(inspect.draftId, 'pw');
    expect(preview.messageCount).toBe(2);

    const result = await commitShareImport({
      draftId: inspect.draftId,
      workingDir: newWorkdir,
      projectsRootOverride: projectsRoot,
      sharedMediaRootOverride: sharedMediaRoot,
    });
    expect(result.sessionId).toBeTruthy();
  });

  it('codex import delegates to importSharedCodexThread with new cwd', async () => {
    const filePath = await writeBundleFile(await buildBundle({ agentKind: 'codex' }));
    const inspect = await inspectShareFile(filePath);
    if (inspect.encrypted) return;
    const result = await commitShareImport({
      draftId: inspect.draftId,
      workingDir: newWorkdir,
      projectsRootOverride: projectsRoot,
      sharedMediaRootOverride: sharedMediaRoot,
    });
    expect(result.fidelity).toBe('full');
    expect(codexMock.importCalls).toHaveLength(1);
    expect((codexMock.importCalls[0] as { newCwd: string }).newCwd).toBe(newWorkdir);
  });

  it('conflicts only on live db row with same resume id', async () => {
    dbMock.conflictRow = { id: 'existing-session' };
    const f1 = await writeBundleFile(await buildBundle());
    const i1 = await inspectShareFile(f1);
    if (i1.encrypted) return;
    await expect(
      commitShareImport({ draftId: i1.draftId, workingDir: newWorkdir, projectsRootOverride: projectsRoot }),
    ).rejects.toMatchObject({ code: 'SHARE_CONFLICT' });
    expect(dbMock.txCalls).toHaveLength(0);
    expect(patchMock.calls).toHaveLength(0);
  });

  it('overwrite: soft-deletes existing live session then imports as replacement', async () => {
    dbMock.conflictRow = { id: 'existing-session', status: 'active' };
    const filePath = await writeBundleFile(await buildBundle());
    const inspect = await inspectShareFile(filePath);
    if (inspect.encrypted) return;
    const result = await commitShareImport({
      draftId: inspect.draftId,
      workingDir: newWorkdir,
      projectsRootOverride: projectsRoot,
      sharedMediaRootOverride: sharedMediaRoot,
      overwrite: true,
    });
    expect(result.sessionId).toBeTruthy();
    // 旧会话被软删(覆盖 = 替换而非叠加),新会话行正常落库
    expect(patchMock.calls).toEqual([
      { sessionId: 'existing-session', patch: { status: 'deleted' } },
    ]);
    expect(dbMock.txCalls).toHaveLength(1);
  });

  it('overwrite rollback restores the soft-deleted session to its previous status', async () => {
    dbMock.conflictRow = { id: 'existing-session', status: 'archived' };
    dbMock.txError = new Error('disk full');
    const filePath = await writeBundleFile(await buildBundle());
    const inspect = await inspectShareFile(filePath);
    if (inspect.encrypted) return;
    await expect(
      commitShareImport({
        draftId: inspect.draftId,
        workingDir: newWorkdir,
        projectsRootOverride: projectsRoot,
        sharedMediaRootOverride: sharedMediaRoot,
        overwrite: true,
      }),
    ).rejects.toMatchObject({ code: 'SHARE_IMPORT_FAILED' });
    // 逆序回滚把旧会话恢复回原 status(archived 不误恢复成 active),不丢用户数据
    expect(patchMock.calls).toEqual([
      { sessionId: 'existing-session', patch: { status: 'deleted' } },
      { sessionId: 'existing-session', patch: { status: 'archived' } },
    ]);
    expect(dbMock.txCalls).toHaveLength(0);
  });

  it('overwrite flag is a no-op when there is no conflict', async () => {
    const filePath = await writeBundleFile(await buildBundle());
    const inspect = await inspectShareFile(filePath);
    if (inspect.encrypted) return;
    const result = await commitShareImport({
      draftId: inspect.draftId,
      workingDir: newWorkdir,
      projectsRootOverride: projectsRoot,
      sharedMediaRootOverride: sharedMediaRoot,
      overwrite: true,
    });
    expect(result.sessionId).toBeTruthy();
    expect(patchMock.calls).toHaveLength(0);
    expect(dbMock.txCalls).toHaveLength(1);
  });

  it('reuses pre-existing transcript on disk without overwriting (deleted-session re-import)', async () => {
    const key = newWorkdir.replace(/[^a-zA-Z0-9]/g, '-');
    const jsonl = path.join(projectsRoot, key, `${SID}.jsonl`);
    await fsp.mkdir(path.join(projectsRoot, key), { recursive: true });
    await fsp.writeFile(jsonl, 'old\n');

    const filePath = await writeBundleFile(await buildBundle());
    const inspect = await inspectShareFile(filePath);
    if (inspect.encrypted) return;
    const result = await commitShareImport({
      draftId: inspect.draftId,
      workingDir: newWorkdir,
      projectsRootOverride: projectsRoot,
      sharedMediaRootOverride: sharedMediaRoot,
    });
    // 复用不降档,盘上副本未被包内容覆盖
    expect(result.fidelity).toBe('full');
    expect(await fsp.readFile(jsonl, 'utf-8')).toBe('old\n');
    expect(dbMock.txCalls).toHaveLength(1);
  });

  it('rollback after transcript reuse keeps the pre-existing file', async () => {
    const key = newWorkdir.replace(/[^a-zA-Z0-9]/g, '-');
    const jsonl = path.join(projectsRoot, key, `${SID}.jsonl`);
    await fsp.mkdir(path.join(projectsRoot, key), { recursive: true });
    await fsp.writeFile(jsonl, 'old\n');
    dbMock.txError = new Error('disk full');

    const filePath = await writeBundleFile(await buildBundle());
    const inspect = await inspectShareFile(filePath);
    if (inspect.encrypted) return;
    await expect(
      commitShareImport({
        draftId: inspect.draftId,
        workingDir: newWorkdir,
        projectsRootOverride: projectsRoot,
        sharedMediaRootOverride: sharedMediaRoot,
      }),
    ).rejects.toMatchObject({ code: 'SHARE_IMPORT_FAILED' });
    // journal 只登记真实写入的文件:复用的既有转录必须原样留存
    expect(await fsp.readFile(jsonl, 'utf-8')).toBe('old\n');
  });

  it('missing workingDir for project bundle is rejected before any write', async () => {
    const filePath = await writeBundleFile(await buildBundle());
    const inspect = await inspectShareFile(filePath);
    if (inspect.encrypted) return;
    await expect(
      commitShareImport({ draftId: inspect.draftId, projectsRootOverride: projectsRoot }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    await expect(
      commitShareImport({
        draftId: inspect.draftId,
        workingDir: path.join(tmpRoot, 'no-such-dir'),
        projectsRootOverride: projectsRoot,
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(dbMock.txCalls).toHaveLength(0);
  });

  it('tx failure rolls back written transcripts and codex state', async () => {
    dbMock.txError = new Error('disk full');
    const filePath = await writeBundleFile(await buildBundle({ agentKind: 'codex' }));
    const inspect = await inspectShareFile(filePath);
    if (inspect.encrypted) return;
    await expect(
      commitShareImport({
        draftId: inspect.draftId,
        workingDir: newWorkdir,
        projectsRootOverride: projectsRoot,
        sharedMediaRootOverride: sharedMediaRoot,
      }),
    ).rejects.toMatchObject({ code: 'SHARE_IMPORT_FAILED' });
    // codex 写入被逆序回滚
    expect(codexMock.removeCalls).toHaveLength(1);
  });

  it('rejects transcript sdkSessionId containing path traversal', async () => {
    const zip = new (await import('jszip')).default();
    const evilId = '../../evil';
    zip.file('session.json', JSON.stringify({ model: 'm' }));
    zip.file('messages.jsonl', JSON.stringify({ id: 'm1', clientId: 'c1', role: 'user', content: '"x"', createdAt: 1 }));
    zip.file(`transcripts/claude/evil.jsonl`, 'x\n');
    zip.file('media-map.json', JSON.stringify({ entries: [] }));
    zip.file('manifest.json', JSON.stringify({
      formatVersion: 1, minReaderVersion: 1, appVersion: '9', platform: 'darwin',
      exportedAt: '2026-07-04T00:00:00.000Z', agentKind: 'cc', title: 't', workspaceKind: 'project',
      originalWorkingDir: '/x', sdkSessionIds: [evilId], activeSdkSessionId: null,
      exportFidelity: 'full', counts: { messages: 1, media: 0 }, entries: [],
      transcripts: [{ sdkSessionId: evilId, path: 'transcripts/claude/evil.jsonl' }],
    }));
    const bytes = await zip.generateAsync({ type: 'nodebuffer' });
    const filePath = await writeBundleFile(Buffer.from(bytes));
    const inspect = await inspectShareFile(filePath);
    if (inspect.encrypted) return;
    await expect(
      commitShareImport({ draftId: inspect.draftId, workingDir: newWorkdir, projectsRootOverride: projectsRoot }),
    ).rejects.toMatchObject({ code: 'SHARE_FILE_INVALID' });
    // 零写入:转码目录不应存在任何逃逸产物
    expect(fs.existsSync(path.join(projectsRoot, '..', 'evil.jsonl'))).toBe(false);
  });

  it('rejects crafted activeSdkSessionId before any codex write (P0 regression)', async () => {
    const filePath = await writeBundleFile(
      await buildBundle({
        agentKind: 'codex',
        manifest: { activeSdkSessionId: '../../../../tmp/evil', sdkSessionIds: ['../../../../tmp/evil'] },
      }),
    );
    const inspect = await inspectShareFile(filePath);
    if (inspect.encrypted) return;
    await expect(
      commitShareImport({ draftId: inspect.draftId, workingDir: newWorkdir, projectsRootOverride: projectsRoot }),
    ).rejects.toMatchObject({ code: 'SHARE_FILE_INVALID' });
    expect(codexMock.importCalls).toHaveLength(0);
    expect(dbMock.txCalls).toHaveLength(0);
  });

  it('image filename comes from validated url, crafted entry.filename cannot escape', async () => {
    const filePath = await writeBundleFile(await buildBundle({ imageFilenameOverride: '../../../evil.png' }));
    const inspect = await inspectShareFile(filePath);
    if (inspect.encrypted) return;
    const result = await commitShareImport({
      draftId: inspect.draftId,
      workingDir: newWorkdir,
      projectsRootOverride: projectsRoot,
      sharedMediaRootOverride: sharedMediaRoot,
    });
    // 图片入总仓(不落盘 cc-agent),包内伪造的 filename 全程不参与
    // 任何路径拼接,无逃逸文件
    expect(cindyMediaMock.ingestCalls.some((c) => Buffer.from(c.buffer).equals(IMG1_BYTES))).toBe(true);
    expect(fs.existsSync(path.join(tmpRoot, 'cc-agent', 'images', result.sessionId, 'img-1.png'))).toBe(false);
    expect(fs.existsSync(path.join(tmpRoot, 'evil.png'))).toBe(false);
    expect(fs.existsSync(path.join(tmpRoot, 'cc-agent', 'evil.png'))).toBe(false);
  });

  it('rewrites images from multiple old session hosts (fork ancestor chain)', async () => {
    const secondUrl = 'xdt-image://ancestor-session/img-2.png';
    const filePath = await writeBundleFile(await buildBundle({ extraImage: secondUrl }));
    const inspect = await inspectShareFile(filePath);
    if (inspect.encrypted) return;
    const result = await commitShareImport({
      draftId: inspect.draftId,
      workingDir: newWorkdir,
      projectsRootOverride: projectsRoot,
      sharedMediaRootOverride: sharedMediaRoot,
    });
    const txArgs = dbMock.txCalls[0].args as { messages: Array<{ content: string }> };
    const content0 = txArgs.messages[0].content;
    // 多 host 的祖先链图片统一入总仓,逐 URL 重写为各自字节的指纹地址
    expect(content0).toContain(blobUrlOf(IMG1_BYTES));
    expect(content0).toContain(blobUrlOf(IMG2_BYTES));
    expect(content0).not.toContain('xdt-image://');
    expect(content0).not.toContain(OLD_SESSION_ID);
    expect(content0).not.toContain('ancestor-session');
    expect(result.sessionId).toBeTruthy();
  });

  it('cancel releases the draft', async () => {
    const filePath = await writeBundleFile(await buildBundle());
    const inspect = await inspectShareFile(filePath);
    if (inspect.encrypted) return;
    cancelShareDraft(inspect.draftId);
    await expect(
      commitShareImport({ draftId: inspect.draftId, workingDir: newWorkdir }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  // ── 导入语义:会话配置用导入端草稿默认值,agent 跟随分享包 ──
  // 分享包 snapshot 塞满"导出方专属"的会话配置,断言它们一律不进导入行。
  const exporterSessionConfig = {
    model: 'exporter-custom-model',
    effort: 'xhigh',
    permissionMode: 'bypassPermissions',
    fastMode: true,
    planModeEnabled: true,
  };

  it('session config comes from importer draftPrefs, never from exporter snapshot', async () => {
    const filePath = await writeBundleFile(await buildBundle({ session: exporterSessionConfig }));
    const inspect = await inspectShareFile(filePath);
    if (inspect.encrypted) return;
    await commitShareImport({
      draftId: inspect.draftId,
      workingDir: newWorkdir,
      projectsRootOverride: projectsRoot,
      sharedMediaRootOverride: sharedMediaRoot,
      draftPrefs: {
        model: 'my-local-model',
        effort: 'medium',
        permissionMode: 'acceptEdits',
        planMode: false,
        fastMode: false,
        providerId: 'custom-provider-1',
      },
    });
    const session = (dbMock.txCalls[0].args as { session: Record<string, unknown> }).session;
    expect(session.model).toBe('my-local-model');
    expect(session.effort).toBe('medium');
    expect(session.permissionMode).toBe('acceptEdits');
    expect(session.providerId).toBe('custom-provider-1');
    expect(session.fastMode).toBe(false);
    expect(session.planModeEnabled).toBe(false);
    // 历史事实仍照搬 snapshot
    expect(session.createdAt).toBe(1700000000000);
    expect(session.userSendAt).toBe(1700000000100);
  });

  it('missing draftPrefs falls back to built-in defaults, still ignoring snapshot', async () => {
    const filePath = await writeBundleFile(await buildBundle({ session: exporterSessionConfig }));
    const inspect = await inspectShareFile(filePath);
    if (inspect.encrypted) return;
    await commitShareImport({
      draftId: inspect.draftId,
      workingDir: newWorkdir,
      projectsRootOverride: projectsRoot,
      sharedMediaRootOverride: sharedMediaRoot,
    });
    const session = (dbMock.txCalls[0].args as { session: Record<string, unknown> }).session;
    expect(session.model).toBe('claude-sonnet-4-6');
    expect(session.effort).toBe('high');
    expect(session.permissionMode).toBe('auto');
    expect(session.providerId).toBeNull();
    expect(session.fastMode).toBe(false);
    expect(session.planModeEnabled).toBe(false);
  });

  it('codex bundle without draftPrefs falls back to codex default model', async () => {
    const filePath = await writeBundleFile(
      await buildBundle({
        agentKind: 'codex',
        session: { ...exporterSessionConfig, codexHistoryHasProductPrompt: true },
      }),
    );
    const inspect = await inspectShareFile(filePath);
    if (inspect.encrypted) return;
    await commitShareImport({
      draftId: inspect.draftId,
      workingDir: newWorkdir,
      projectsRootOverride: projectsRoot,
      sharedMediaRootOverride: sharedMediaRoot,
    });
    const session = (dbMock.txCalls[0].args as { session: Record<string, unknown> }).session;
    expect(session.model).toBe('gpt-5.4');
    expect(session.codexHistoryHasProductPrompt).toBe(false);
  });

  // ── useWorktree:在 worktree 中创建(与 New Maker 草稿开 worktree 同语义) ──

  it('useWorktree: creates worktree, session workingDir/worktreePath point at it, transcripts keyed by it', async () => {
    const wtPath = path.join(tmpRoot, 'wt', 'imported-wt');
    await fsp.mkdir(wtPath, { recursive: true });
    worktreeMock.detect = {
      isGitRepo: true,
      isInsideWorktree: false,
      gitInstalled: true,
      repoRoot: newWorkdir,
      currentBranch: 'dev',
    };
    worktreeMock.createResult = { ok: true, meta: { path: wtPath } };

    const filePath = await writeBundleFile(await buildBundle());
    const inspect = await inspectShareFile(filePath);
    if (inspect.encrypted) return;
    const result = await commitShareImport({
      draftId: inspect.draftId,
      workingDir: newWorkdir,
      projectsRootOverride: projectsRoot,
      sharedMediaRootOverride: sharedMediaRoot,
      useWorktree: true,
    });

    expect(worktreeMock.createCalls).toHaveLength(1);
    expect(worktreeMock.createCalls[0]).toEqual({
      sessionId: result.sessionId,
      baseRepo: newWorkdir,
      name: 'imported-wt',
      sourceBranch: 'dev',
    });
    const session = (dbMock.txCalls[0].args as { session: Record<string, unknown> }).session;
    expect(session.workingDir).toBe(wtPath);
    expect(session.worktreePath).toBe(wtPath);
    // 转录转码目录按最终 workingDir(worktree 路径)计算,resume 才能找到历史
    const key = wtPath.replace(/[^a-zA-Z0-9]/g, '-');
    expect(fs.existsSync(path.join(projectsRoot, key, `${SID}.jsonl`))).toBe(true);
    // 成功路径不回滚
    expect(worktreeMock.removeCalls).toHaveLength(0);
  });

  it('useWorktree: non-git directory rejects with SHARE_WORKTREE_NOT_GIT before any write', async () => {
    worktreeMock.detect = { isGitRepo: false, isInsideWorktree: false, gitInstalled: true };
    const filePath = await writeBundleFile(await buildBundle());
    const inspect = await inspectShareFile(filePath);
    if (inspect.encrypted) return;
    await expect(
      commitShareImport({
        draftId: inspect.draftId,
        workingDir: newWorkdir,
        projectsRootOverride: projectsRoot,
        sharedMediaRootOverride: sharedMediaRoot,
        useWorktree: true,
      }),
    ).rejects.toMatchObject({ code: 'SHARE_WORKTREE_NOT_GIT' });
    expect(worktreeMock.createCalls).toHaveLength(0);
    expect(dbMock.txCalls).toHaveLength(0);
  });

  it('useWorktree: worktree create failure aborts import with SHARE_WORKTREE_FAILED', async () => {
    worktreeMock.detect = {
      isGitRepo: true,
      isInsideWorktree: false,
      gitInstalled: true,
      repoRoot: newWorkdir,
      currentBranch: 'main',
    };
    worktreeMock.createResult = { ok: false, error: { kind: 'unknown', message: 'boom' } };
    const filePath = await writeBundleFile(await buildBundle());
    const inspect = await inspectShareFile(filePath);
    if (inspect.encrypted) return;
    await expect(
      commitShareImport({
        draftId: inspect.draftId,
        workingDir: newWorkdir,
        projectsRootOverride: projectsRoot,
        sharedMediaRootOverride: sharedMediaRoot,
        useWorktree: true,
      }),
    ).rejects.toMatchObject({ code: 'SHARE_WORKTREE_FAILED' });
    expect(dbMock.txCalls).toHaveLength(0);
    // 创建未成功,不应触发移除
    expect(worktreeMock.removeCalls).toHaveLength(0);
  });

  it('useWorktree: later tx failure rolls back the created worktree', async () => {
    const wtPath = path.join(tmpRoot, 'wt', 'rollback-wt');
    await fsp.mkdir(wtPath, { recursive: true });
    worktreeMock.detect = {
      isGitRepo: true,
      isInsideWorktree: false,
      gitInstalled: true,
      repoRoot: newWorkdir,
      currentBranch: 'main',
    };
    worktreeMock.createResult = { ok: true, meta: { path: wtPath } };
    dbMock.txError = Object.assign(new Error('tx boom'), { code: 'INTERNAL' });

    const filePath = await writeBundleFile(await buildBundle());
    const inspect = await inspectShareFile(filePath);
    if (inspect.encrypted) return;
    await expect(
      commitShareImport({
        draftId: inspect.draftId,
        workingDir: newWorkdir,
        projectsRootOverride: projectsRoot,
        sharedMediaRootOverride: sharedMediaRoot,
        useWorktree: true,
      }),
    ).rejects.toBeTruthy();
    expect(worktreeMock.removeCalls).toHaveLength(1);
  });

  it('without useWorktree the session row keeps worktreePath null', async () => {
    const filePath = await writeBundleFile(await buildBundle());
    const inspect = await inspectShareFile(filePath);
    if (inspect.encrypted) return;
    await commitShareImport({
      draftId: inspect.draftId,
      workingDir: newWorkdir,
      projectsRootOverride: projectsRoot,
      sharedMediaRootOverride: sharedMediaRoot,
    });
    const session = (dbMock.txCalls[0].args as { session: Record<string, unknown> }).session;
    expect(session.worktreePath).toBeNull();
    expect(worktreeMock.createCalls).toHaveLength(0);
  });

  it('invalid draftPrefs enum values fall back to safe defaults', async () => {
    const filePath = await writeBundleFile(await buildBundle());
    const inspect = await inspectShareFile(filePath);
    if (inspect.encrypted) return;
    await commitShareImport({
      draftId: inspect.draftId,
      workingDir: newWorkdir,
      projectsRootOverride: projectsRoot,
      sharedMediaRootOverride: sharedMediaRoot,
      draftPrefs: { model: 'ok-model', effort: 'weird', permissionMode: 'weird' },
    });
    const session = (dbMock.txCalls[0].args as { session: Record<string, unknown> }).session;
    expect(session.model).toBe('ok-model');
    expect(session.effort).toBe('high');
    expect(session.permissionMode).toBe('auto');
  });
});
