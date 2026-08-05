/**
 * 导出编排集成测试:mock DB / bridge / 媒体 store,用 temp projectsRoot 放真实
 * jsonl,走完整 exportSessionShare → openPayload → JSZip 解包验证内容。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import JSZip from 'jszip';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'xdtshare-export-test-'));
const projectsRoot = path.join(tmpRoot, 'claude-home', 'projects');
const workingDir = path.join(tmpRoot, 'proj');

// ── mocks ──
const sessionRowRef: { row: Record<string, unknown> | null } = { row: null };
const messagesRef: { rows: Array<Record<string, unknown>> } = { rows: [] };

vi.mock('electron', () => ({
  app: { getVersion: () => '9.9.9', getPath: () => tmpRoot },
}));
vi.mock('../../localDb/client/current.js', () => ({
  getDbClient: () => ({
    queryOne: async () => sessionRowRef.row,
    // 模拟 readMessageRows 的 clearedAt 过滤(真实 SQL 是 created_at > ?)
    query: async (sql: string, params: unknown[]) => {
      if (typeof sql === 'string' && sql.includes('created_at > ?')) {
        const clearedAt = params[1] as number;
        return messagesRef.rows.filter((r) => (r.createdAt as number) > clearedAt);
      }
      return messagesRef.rows;
    },
    exec: async () => undefined,
  }),
}));
vi.mock('../../maker-host/claude-transcript-relocation.js', () => ({
  collectClaudeSdkSessionIds: async () => ({
    ids: ['sid-a', 'sid-b'],
    activeId: 'sid-b',
  }),
}));
vi.mock('../../maker-host/codex-local-sessions.js', () => ({
  dumpCodexThreadStateRows: async () => ({
    threads: [{ id: 'thread-1', cwd: '/old/cwd' }],
    threadDynamicTools: [],
    threadSpawnEdges: [],
    rolloutPath: path.join(tmpRoot, 'rollout-1-thread-1.jsonl'),
  }),
}));
const configDirCandidatesRef = { dirs: [path.join(tmpRoot, 'claude-home')] };
vi.mock('../../maker-orchestration/claudeTranscriptAnchors.js', () => ({
  defaultClaudeConfigDirCandidates: () => configDirCandidatesRef.dirs,
}));
vi.mock('../../imageCacheStore.js', () => ({
  resolveSafe: (url: string) => {
    if (!url.startsWith('xdt-image://')) throw new Error('bad url');
    return { absPath: path.join(tmpRoot, 'img.png'), mimeType: 'image/png' };
  },
}));
vi.mock('../../videoCacheStore.js', () => ({
  resolveSafe: () => ({ absPath: path.join(tmpRoot, 'missing-video.mp4'), mimeType: 'video/mp4' }),
}));
vi.mock('../../modelCacheStore.js', () => ({
  resolveSafe: () => {
    throw new Error('unknown host');
  },
}));
vi.mock('../../logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

const { exportSessionShare } = await import('../sessionShareExport.js');
const { openPayload } = await import('../xdtshareCrypto.js');
const { validateManifest } = await import('../xdtshareFormat.pure.js');

function baseSession(): Record<string, unknown> {
  return {
    id: 'xdt-session-1',
    title: '测试会话',
    workingDir,
    workspaceKind: 'project',
    model: 'claude-sonnet-4-6',
    effort: 'high',
    permissionMode: 'ask',
    status: 'active',
    sdkSessionId: 'sid-b',
    totalTokenUsage: 100,
    totalCostUsd: 0.1,
    contextTokens: 10,
    contextWindow: 200000,
    fastMode: 0,
    planModeEnabled: 0,
    agentKind: 'cc',
    orcaRole: null,
    remoteHostId: null,
    codexHistoryHasProductPrompt: null,
    clearedAt: null,
    userSendAt: 1700000000000,
    createdAt: 1700000000000,
    updatedAt: 1700000001000,
  };
}

function baseMessages(): Array<Record<string, unknown>> {
  return [
    {
      id: 'm1',
      clientId: 'c1',
      role: 'user',
      content: JSON.stringify([{ type: 'text', text: '看图 xdt-image://xdt-session-1/img.png' }]),
      toolUseId: null,
      agentMeta: null,
      agentKind: 'cc',
      createdAt: 1700000000100,
      rewindAt: null,
    },
    {
      id: 'm2',
      clientId: 'c2',
      role: 'assistant',
      content: JSON.stringify([{ type: 'text', text: 'ok' }]),
      toolUseId: null,
      agentMeta: '{"sdkSessionId":"sid-b"}',
      agentKind: 'codex',
      createdAt: 1700000000200,
      rewindAt: null,
    },
  ];
}

async function unzipOf(filePath: string, password?: string): Promise<JSZip> {
  const bytes = await fsp.readFile(filePath);
  const { zipBytes } = openPayload(bytes, password);
  return JSZip.loadAsync(zipBytes);
}

describe('exportSessionShare', () => {
  beforeEach(async () => {
    sessionRowRef.row = baseSession();
    messagesRef.rows = baseMessages();
    configDirCandidatesRef.dirs = [path.join(tmpRoot, 'claude-home')];
    const projKey = workingDir.replace(/[^a-zA-Z0-9]/g, '-');
    await fsp.mkdir(path.join(projectsRoot, projKey), { recursive: true });
    await fsp.writeFile(path.join(projectsRoot, projKey, 'sid-a.jsonl'), '{"line":1}\n');
    await fsp.writeFile(path.join(projectsRoot, projKey, 'sid-b.jsonl'), '{"line":2}\n');
    await fsp.mkdir(workingDir, { recursive: true });
    await fsp.writeFile(path.join(tmpRoot, 'img.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await fsp.writeFile(path.join(tmpRoot, 'rollout-1-thread-1.jsonl'), '{"session_meta":{}}\n');
  });

  afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('cc full export: transcripts + media + manifest roundtrip (encrypted)', async () => {
    const target = path.join(tmpRoot, 'out-full.xdtshare');
    const outcome = await exportSessionShare({
      sessionId: 'xdt-session-1',
      targetPath: target,
      password: 'pw-测试',
    });
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;
    expect(outcome.fidelity).toBe('full');
    expect(outcome.missingTranscripts).toEqual([]);

    const zip = await unzipOf(target, 'pw-测试');
    const manifest = validateManifest(JSON.parse(await zip.file('manifest.json')!.async('string')));
    expect(manifest.agentKind).toBe('cc');
    expect(manifest.sdkSessionIds.sort()).toEqual(['sid-a', 'sid-b']);
    expect(manifest.activeSdkSessionId).toBe('sid-b');
    expect(manifest.exportFidelity).toBe('full');
    expect(manifest.counts.messages).toBe(2);
    expect(await zip.file('transcripts/claude/sid-a.jsonl')!.async('string')).toBe('{"line":1}\n');
    expect(await zip.file('transcripts/claude/sid-b.jsonl')!.async('string')).toBe('{"line":2}\n');

    const messagesJsonl = await zip.file('messages.jsonl')!.async('string');
    expect(messagesJsonl.split('\n')).toHaveLength(2);
    expect(messagesJsonl.split('\n').map((line) => JSON.parse(line).agentKind)).toEqual([
      'cc',
      'codex',
    ]);

    const mediaMap = JSON.parse(await zip.file('media-map.json')!.async('string')) as {
      entries: Array<{ url: string; kind: string; zipPath: string | null; imageHost?: string }>;
    };
    expect(mediaMap.entries).toHaveLength(1);
    expect(mediaMap.entries[0].kind).toBe('image');
    expect(mediaMap.entries[0].imageHost).toBe('xdt-session-1');
    expect(mediaMap.entries[0].zipPath).toMatch(/^media\/images\//);
    expect(zip.file(mediaMap.entries[0].zipPath!)).toBeTruthy();
  });

  it('cc transcript lookup falls back through all config dir candidates', async () => {
    // 第一个候选目录存在但没有该会话 jsonl,jsonl 落在第二个候选——不应记缺失。
    const emptyHome = path.join(tmpRoot, 'empty-claude-home');
    await fsp.mkdir(path.join(emptyHome, 'projects'), { recursive: true });
    configDirCandidatesRef.dirs = [emptyHome, path.join(tmpRoot, 'claude-home')];
    const target = path.join(tmpRoot, 'out-fallback.xdtshare');
    const outcome = await exportSessionShare({ sessionId: 'xdt-session-1', targetPath: target });
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;
    expect(outcome.fidelity).toBe('full');
    expect(outcome.missingTranscripts).toEqual([]);
  });

  it('cc partial: missing fork-chain jsonl downgrades fidelity and reports id', async () => {
    const projKey = workingDir.replace(/[^a-zA-Z0-9]/g, '-');
    await fsp.rm(path.join(projectsRoot, projKey, 'sid-a.jsonl'));
    const target = path.join(tmpRoot, 'out-partial.xdtshare');
    const outcome = await exportSessionShare({ sessionId: 'xdt-session-1', targetPath: target });
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;
    expect(outcome.fidelity).toBe('partial');
    expect(outcome.missingTranscripts).toEqual(['sid-a']);
  });

  it('codex export bundles rollout + state dump', async () => {
    sessionRowRef.row = { ...baseSession(), agentKind: 'codex', sdkSessionId: 'thread-1' };
    const target = path.join(tmpRoot, 'out-codex.xdtshare');
    const outcome = await exportSessionShare({ sessionId: 'xdt-session-1', targetPath: target });
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;
    expect(outcome.fidelity).toBe('full');
    const zip = await unzipOf(target);
    expect(zip.file('transcripts/codex/rollout-1-thread-1.jsonl')).toBeTruthy();
    const state = JSON.parse(await zip.file('codex-state/thread.json')!.async('string'));
    expect(state.threads[0].id).toBe('thread-1');
  });

  it('oversize returns structured outcome without writing file', async () => {
    const target = path.join(tmpRoot, 'out-oversize.xdtshare');
    const outcome = await exportSessionShare({
      sessionId: 'xdt-session-1',
      targetPath: target,
      sizeLimitBytes: 1,
    });
    expect(outcome.status).toBe('oversize');
    await expect(fsp.stat(target)).rejects.toThrow();
  });

  it('loose media provenance: only managed-root paths bundled, arbitrary paths blocked in any role', async () => {
    const pastedDoc = path.join(tmpRoot, 'pasted-doc.pdf');
    const plantedDoc = path.join(tmpRoot, 'planted-secret.txt');
    const managedAudio = path.join(tmpRoot, 'cc-agent', 'lizi-mivo-audios', 'gen.mp3');
    await fsp.writeFile(pastedDoc, Buffer.from('pasted doc'));
    await fsp.writeFile(plantedDoc, Buffer.from('secret'));
    await fsp.mkdir(path.dirname(managedAudio), { recursive: true });
    await fsp.writeFile(managedAudio, Buffer.from('audio'));
    const pastedUrl = `xdt-file://local/?path=${encodeURIComponent(pastedDoc)}`;
    const plantedUrl = `xdt-file://local/?path=${encodeURIComponent(plantedDoc)}`;
    const managedUrl = `xdt-audio://local/?path=${encodeURIComponent(managedAudio)}`;
    messagesRef.rows = [
      { ...baseMessages()[0], content: JSON.stringify([{ type: 'text', text: `粘贴的 ${pastedUrl}` }]) },
      {
        ...baseMessages()[1],
        content: JSON.stringify([{ type: 'text', text: `工具输出 ${plantedUrl} 与生成音频 ${managedUrl}` }]),
      },
    ];
    const target = path.join(tmpRoot, 'out-loose.xdtshare');
    const outcome = await exportSessionShare({ sessionId: 'xdt-session-1', targetPath: target });
    expect(outcome.status).toBe('ok');
    const zip = await unzipOf(target);
    const mediaMap = JSON.parse(await zip.file('media-map.json')!.async('string')) as {
      entries: Array<{ url: string; zipPath: string | null }>;
    };
    const byUrl = new Map(mediaMap.entries.map((e) => [e.url, e.zipPath]));
    // user 文本里的 loose URL 只可能是粘贴/导入内容(真实附件在 files[]),不豁免
    expect(byUrl.get(pastedUrl)).toBeNull();
    expect(byUrl.get(plantedUrl)).toBeNull(); // assistant 输出的任意路径:拒绝
    expect(byUrl.get(managedUrl)).toMatch(/^media\/loose\//); // 受管媒体区:放行
  });

  it('cleared session: pre-clear messages and their fork transcripts stay out of the bundle', async () => {
    // m1(pre-clear,引用 sid-a fork)在 clearedAt 之前,m2(post-clear,sid-b)之后。
    sessionRowRef.row = { ...baseSession(), clearedAt: 1700000000150 };
    messagesRef.rows = [
      { ...baseMessages()[0], agentMeta: '{"sdkSessionId":"sid-a"}' },
      baseMessages()[1],
    ];
    const target = path.join(tmpRoot, 'out-cleared.xdtshare');
    const outcome = await exportSessionShare({ sessionId: 'xdt-session-1', targetPath: target });
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;
    expect(outcome.fidelity).toBe('full'); // post-clear 链完整即 full,不因排除旧 fork 降档
    const zip = await unzipOf(target);
    const manifest = validateManifest(JSON.parse(await zip.file('manifest.json')!.async('string')));
    expect(manifest.sdkSessionIds).toEqual(['sid-b']);
    expect(zip.file('transcripts/claude/sid-a.jsonl')).toBeNull(); // 旧 fork 不落包
    expect(zip.file('transcripts/claude/sid-b.jsonl')).toBeTruthy();
    const messagesJsonl = await zip.file('messages.jsonl')!.async('string');
    expect(messagesJsonl.split('\n')).toHaveLength(1); // 只有 post-clear 消息
    expect(messagesJsonl).not.toContain('sid-a');
  });

  it('missing media file is recorded as missing, export still succeeds', async () => {
    await fsp.rm(path.join(tmpRoot, 'img.png'));
    const target = path.join(tmpRoot, 'out-missing-media.xdtshare');
    const outcome = await exportSessionShare({ sessionId: 'xdt-session-1', targetPath: target });
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;
    expect(outcome.mediaMissing).toBe(1);
    const zip = await unzipOf(target);
    const mediaMap = JSON.parse(await zip.file('media-map.json')!.async('string'));
    expect(mediaMap.entries[0].zipPath).toBeNull();
  });

  it('rejects remote / orca / deleted / empty sessions', async () => {
    sessionRowRef.row = { ...baseSession(), remoteHostId: 'host-1' };
    await expect(
      exportSessionShare({ sessionId: 'xdt-session-1', targetPath: path.join(tmpRoot, 'x1') }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });

    sessionRowRef.row = { ...baseSession(), orcaRole: 'lead' };
    await expect(
      exportSessionShare({ sessionId: 'xdt-session-1', targetPath: path.join(tmpRoot, 'x2') }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });

    sessionRowRef.row = { ...baseSession(), status: 'deleted' };
    await expect(
      exportSessionShare({ sessionId: 'xdt-session-1', targetPath: path.join(tmpRoot, 'x3') }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    sessionRowRef.row = baseSession();
    messagesRef.rows = [];
    await expect(
      exportSessionShare({ sessionId: 'xdt-session-1', targetPath: path.join(tmpRoot, 'x4') }),
    ).rejects.toMatchObject({ code: 'SHARE_EXPORT_FAILED' });
  });
});
