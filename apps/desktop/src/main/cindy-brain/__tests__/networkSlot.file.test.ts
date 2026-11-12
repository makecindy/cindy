/**
 * networkSlot · 下行落盘模式(as:'file' + saveTo 票据)单测:载荷校验、
 * 文件名派生(建议名 > Content-Disposition > URL 尾段)、票据无效话术、
 * 非 2xx 回落文本、体积护栏。字节经 deps.writeSaveDeposit 出去,不回沙箱。
 */
import { describe, expect, it, vi } from 'vitest';

import { GhostNetworkSlot, type NetworkSlotDeps } from '../networkSlot';
import type { GhostNetworkNeeds, InstalledGhost } from '../../../shared/ghost';

const TOKEN = '11111111-2222-4333-8444-555555555555';
const FILE_URL = 'https://api.example.com/files/9/download.docx';

function fileGhost(): InstalledGhost {
  const network: GhostNetworkNeeds = { hosts: ['api.example.com'] };
  return {
    manifest: {
      schemaVersion: 2,
      id: 'g-file',
      name: '文件意识',
      version: '1.0.0',
      kind: 'chip',
      entry: 'main.js',
      tools: [{ name: 't', description: 'x' }],
      network,
    },
    dir: '/fake/brain/g-file',
    enabled: true,
  } as InstalledGhost;
}

function bytesResponse(params: { status?: number; headers?: Record<string, string>; body?: Uint8Array | string } = {}): Response {
  const { status = 200, headers = { 'content-type': 'application/octet-stream' }, body = new Uint8Array([7, 8, 9]) } = params;
  const buf = typeof body === 'string' ? new TextEncoder().encode(body).buffer : body.buffer;
  return {
    status,
    headers: new Headers(headers),
    arrayBuffer: async () => buf,
  } as unknown as Response;
}

function makeSlot(overrides: Partial<NetworkSlotDeps> = {}): {
  slot: GhostNetworkSlot;
  fetchImpl: ReturnType<typeof vi.fn>;
  writeSaveDeposit: ReturnType<typeof vi.fn>;
} {
  const fetchImpl = vi.fn(async () => bytesResponse());
  const writeSaveDeposit = vi.fn(async (_g: string, _t: string, name: string) => ({ fileName: name }));
  const deps: NetworkSlotDeps = {
    getGhost: () => fileGhost(),
    readSecret: () => null,
    getLoginEmail: () => null,
    fetchImpl: fetchImpl as unknown as NetworkSlotDeps['fetchImpl'],
    fetchPublicImpl: async () => ({ response: bytesResponse(), release: async () => undefined }),
    saveGhostMedia: async () => ({ url: 'cindy-media://blobs/a.png', hash: 'a'.repeat(64), ext: '.png' }),
    isSupportedMediaMime: () => false,
    readGhostMedia: async () => null,
    takeDirDeposit: () => null,
    writeSaveDeposit: writeSaveDeposit as unknown as NetworkSlotDeps['writeSaveDeposit'],
    ...overrides,
  };
  return { slot: new GhostNetworkSlot(deps), fetchImpl, writeSaveDeposit };
}

describe('networkSlot · as:file 载荷校验', () => {
  it("as:'file' 缺 saveTo / 坏 token / 超长 filename / 非 file 模式带 saveTo 一律拒", async () => {
    const { slot, fetchImpl } = makeSlot();
    expect((await slot.handleFetchRequest('g-file', { url: FILE_URL, as: 'file' })).ok).toBe(false);
    expect((await slot.handleFetchRequest('g-file', { url: FILE_URL, as: 'file', saveTo: { token: 'nope' } })).ok).toBe(false);
    expect(
      (await slot.handleFetchRequest('g-file', { url: FILE_URL, as: 'file', saveTo: { token: TOKEN, filename: 'x'.repeat(129) } })).ok,
    ).toBe(false);
    expect((await slot.handleFetchRequest('g-file', { url: FILE_URL, saveTo: { token: TOKEN } })).ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('networkSlot · as:file 落盘', () => {
  it('happy:建议名优先;回执带最终文件名与字节数,响应体不进沙箱', async () => {
    const { slot, writeSaveDeposit } = makeSlot();
    const r = await slot.handleFetchRequest('g-file', {
      url: FILE_URL,
      as: 'file',
      saveTo: { token: TOKEN, filename: 'report.docx' },
    });
    expect(r).toMatchObject({ ok: true, status: 200, file: { file_name: 'report.docx', bytes: 3 } });
    expect('body' in r).toBe(false);
    expect(writeSaveDeposit).toHaveBeenCalledWith('g-file', TOKEN, 'report.docx', expect.any(Uint8Array));
  });

  it('无建议名:Content-Disposition 次之,URL 尾段兜底', async () => {
    const { slot, writeSaveDeposit } = makeSlot({
      fetchImpl: vi.fn(async () =>
        bytesResponse({ headers: { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="q3 report.pdf"' } }),
      ) as unknown as NetworkSlotDeps['fetchImpl'],
    });
    await slot.handleFetchRequest('g-file', { url: FILE_URL, as: 'file', saveTo: { token: TOKEN } });
    expect(writeSaveDeposit).toHaveBeenCalledWith('g-file', TOKEN, 'q3 report.pdf', expect.any(Uint8Array));

    const { slot: slot2, writeSaveDeposit: w2 } = makeSlot();
    await slot2.handleFetchRequest('g-file', { url: FILE_URL, as: 'file', saveTo: { token: TOKEN } });
    expect(w2).toHaveBeenCalledWith('g-file', TOKEN, 'download.docx', expect.any(Uint8Array));
  });

  it('票据无效 → 带重过户指引的结构化错误', async () => {
    const { slot } = makeSlot({ writeSaveDeposit: async () => null });
    const r = await slot.handleFetchRequest('g-file', { url: FILE_URL, as: 'file', saveTo: { token: TOKEN } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('save_dir');
  });

  it('非 2xx 回落文本形态(错误 JSON 意识看得到),不动票据', async () => {
    const { slot, writeSaveDeposit } = makeSlot({
      fetchImpl: vi.fn(async () =>
        bytesResponse({ status: 404, headers: { 'content-type': 'application/json' }, body: '{"error":"not found"}' }),
      ) as unknown as NetworkSlotDeps['fetchImpl'],
    });
    const r = await slot.handleFetchRequest('g-file', { url: FILE_URL, as: 'file', saveTo: { token: TOKEN } });
    expect(r).toMatchObject({ ok: true, status: 404 });
    if (r.ok && 'body' in r) expect(r.body).toContain('not found');
    expect(writeSaveDeposit).not.toHaveBeenCalled();
  });

  it('声明超大 content-length 在读体前拒', async () => {
    const { slot, writeSaveDeposit } = makeSlot({
      fetchImpl: vi.fn(async () =>
        bytesResponse({ headers: { 'content-type': 'application/zip', 'content-length': String(300 * 1024 * 1024) } }),
      ) as unknown as NetworkSlotDeps['fetchImpl'],
    });
    const r = await slot.handleFetchRequest('g-file', { url: FILE_URL, as: 'file', saveTo: { token: TOKEN } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('文件过大');
    expect(writeSaveDeposit).not.toHaveBeenCalled();
  });
});
