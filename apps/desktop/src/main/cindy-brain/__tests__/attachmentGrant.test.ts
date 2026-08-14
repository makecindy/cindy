/**
 * attachmentGrant.test.ts — 用户图片过户单测(纯 DI,无 Electron)。
 * 覆盖:happy path 记账链路(blob 入账 + 人工/工具交接引用 + 指纹返回)、
 * 地址解析失败整批拒且零副作用、张数上限、空批直通、落库中途失败报错。
 */

import { describe, expect, it, vi } from 'vitest';

import { GrantPolicyError, grantAttachmentsToGhost, type AttachmentGrantDeps } from '../attachmentGrant';

/**
 * 真身 withMediaRefCompensation 的前置校验。mock 必须复刻它,否则调用方违反
 * 记账层契约(比如拿空 refIds 开事务)时单测照样绿,把回归藏到运行期。
 * 真身见 cindy-media/refCompensationJournal.ts。
 */
const REF_COMPENSATION_MAX_REF_IDS = 256;
const REF_COMPENSATION_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function assertRefCompensationBatch(refIds: readonly string[]): void {
  if (refIds.length === 0 || refIds.length > REF_COMPENSATION_MAX_REF_IDS) {
    throw new Error('cindy-media: invalid reference compensation batch size');
  }
  if (!refIds.every((id) => REF_COMPENSATION_UUID_PATTERN.test(id))) {
    throw new Error('cindy-media: invalid staged reference id');
  }
}

function makeDeps(overrides: Partial<AttachmentGrantDeps> = {}): {
  deps: AttachmentGrantDeps;
  writeBlob: ReturnType<typeof vi.fn>;
  recordBlob: ReturnType<typeof vi.fn>;
  addRef: ReturnType<typeof vi.fn>;
  withRefCompensation: ReturnType<typeof vi.fn>;
} {
  const writeBlob = vi.fn(async ({ buffer }: { buffer: Uint8Array }) => ({
    hash: `${'0'.repeat(63)}${buffer[0]}`,
    ext: '.png',
    mimeType: 'image/png',
    bytes: buffer.byteLength,
  }));
  const recordBlob = vi.fn(async () => {});
  const addRef = vi.fn(async (_params: Parameters<AttachmentGrantDeps['addRef']>[0]) => {});
  const removeRefById = vi.fn(async (_id: string) => {});
  const withRefCompensation = vi.fn(
    async <T,>({
      refIds,
      perform,
    }: {
      refIds: readonly string[];
      perform: () => Promise<T>;
      compensate: (refId: string) => Promise<unknown>;
    }): Promise<T> => {
      assertRefCompensationBatch(refIds);
      return perform();
    },
  );
  const deps: AttachmentGrantDeps = {
    resolveImageUrl: (url: string) => {
      if (!url.startsWith('xdt-image://')) throw new Error('xdt-image: invalid url');
      return { absPath: `/cache/${url.slice('xdt-image://'.length)}`, mimeType: 'image/png' };
    },
    readFile: async (absPath: string) => new Uint8Array([absPath.length % 256, 2, 3]),
    writeBlob,
    recordBlob,
    addRef,
    removeRefById,
    withRefCompensation: withRefCompensation as AttachmentGrantDeps['withRefCompensation'],
    ...overrides,
  };
  return { deps, writeBlob, recordBlob, addRef, withRefCompensation };
}

describe('grantAttachmentsToGhost', () => {
  it('happy path:逐张落仓 + ghost-grant 记账(originKind=user),按序返回指纹', async () => {
    const { deps, recordBlob, addRef } = makeDeps();
    const r = await grantAttachmentsToGhost(deps, {
      ghostId: 'cindy-art',
      urls: ['xdt-image://s1/a.png', 'xdt-image://s1/bb.png'],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.hashes).toHaveLength(2);
    expect(recordBlob).toHaveBeenCalledTimes(2);
    expect(recordBlob).toHaveBeenCalledWith(expect.objectContaining({ isCache: false }));
    expect(addRef).toHaveBeenCalledTimes(2);
    expect(addRef).toHaveBeenCalledWith(
      expect.objectContaining({ refKind: 'ghost-grant', refId: 'cindy-art', originKind: 'user' }),
    );
  });

  it('任一地址解析失败 → 整批拒,零副作用(先整批解析再落库)', async () => {
    const { deps, writeBlob, addRef } = makeDeps();
    const r = await grantAttachmentsToGhost(deps, {
      ghostId: 'cindy-art',
      urls: ['xdt-image://s1/a.png', 'not-a-url'],
    });
    expect(r).toMatchObject({ ok: false });
    expect((r as { message: string }).message).toContain('无法解析');
    expect(writeBlob).not.toHaveBeenCalled();
    expect(addRef).not.toHaveBeenCalled();
  });

  it('超过 4 张 → 拒;空批直通返回空指纹且不开补偿事务', async () => {
    const { deps, withRefCompensation } = makeDeps();
    const over = await grantAttachmentsToGhost(deps, {
      ghostId: 'g',
      urls: Array(5).fill('xdt-image://s/x.png'),
    });
    expect(over).toMatchObject({ ok: false });
    expect((over as { message: string }).message).toContain('上限');

    const empty = await grantAttachmentsToGhost(deps, { ghostId: 'g', urls: [] });
    expect(empty).toEqual({ ok: true, hashes: [] });
    // 真身 withMediaRefCompensation 对空 refIds 是硬抛。空批必须整段跳过补偿
    // 事务,否则记账层的批次校验会把合法的零附件翻译成「附件过户失败」。
    expect(withRefCompensation).not.toHaveBeenCalled();
  });

  it('落库中途失败 → 整批报错(不返回半截指纹)', async () => {
    const { deps } = makeDeps({
      writeBlob: vi.fn(async () => Promise.reject(new Error('disk full'))) as unknown as AttachmentGrantDeps['writeBlob'],
    });
    const r = await grantAttachmentsToGhost(deps, { ghostId: 'g', urls: ['xdt-image://s/a.png'] });
    expect(r).toMatchObject({ ok: false });
    expect((r as { message: string }).message).toContain('disk full');
  });

  it('工具出生附件使用独立 ghost-tool-grant，避免旧版误当人工永久授权', async () => {
    const { deps, addRef } = makeDeps({
      // 异步 resolveImageUrl(接线层查账后附带出生);会话内生成图 = tool。
      resolveImageUrl: async () => ({
        absPath: '/blobs/aa/x.jpg',
        mimeType: 'image/jpeg',
        originKind: 'tool' as const,
      }),
    });
    const r = await grantAttachmentsToGhost(deps, { ghostId: 'g', urls: ['cindy-media://blobs/x.jpg'] });
    expect(r.ok).toBe(true);
    expect(addRef).toHaveBeenCalledWith(
      expect.objectContaining({ refKind: 'ghost-tool-grant', originKind: 'tool' }),
    );
  });

  it('异步挂授权行后切换 blocked → 精确回滚本次 ref，绝不留下插件可读权限', async () => {
    let blocked = false;
    let createdRefId = '';
    const removeRefById = vi.fn(async () => {});
    const addRef = vi.fn(async (params: Parameters<AttachmentGrantDeps['addRef']>[0]) => {
      // 模拟 DB await 返回后用户正好把目标工具切为 blocked。
      createdRefId = params.id;
      blocked = true;
    });
    const { deps } = makeDeps({
      addRef,
      removeRefById,
      withRefCompensation: async ({ refIds, perform, compensate }) => {
        expect(refIds).toEqual([expect.any(String)]);
        try {
          return await perform();
        } catch (error) {
          await Promise.all(refIds.map((id) => compensate(id)));
          throw error;
        }
      },
      assertStillAllowed: () => {
        if (blocked) throw new GrantPolicyError('该插件工具已被用户阻止');
      },
    });

    const result = await grantAttachmentsToGhost(deps, {
      ghostId: 'cindy-art',
      urls: ['xdt-image://s1/a.png'],
    });

    expect(result).toMatchObject({ ok: false, errorCode: 'PERMISSION_DENIED' });
    expect(addRef).toHaveBeenCalledWith(expect.objectContaining({ id: expect.any(String) }));
    expect(removeRefById).toHaveBeenCalledWith(createdRefId);
  });

  it('即时回滚失败时由持久补偿保留精确 id，后续重放删掉残留授权', async () => {
    let blocked = false;
    const liveRefs = new Set<string>();
    const pendingRecovery = new Set<string>();
    const addRef = vi.fn(async (params: Parameters<AttachmentGrantDeps['addRef']>[0]) => {
      liveRefs.add(params.id);
      blocked = true;
    });
    const removeRefById = vi
      .fn<(id: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error('DB worker disposed'))
      .mockImplementation(async (id) => {
        liveRefs.delete(id);
      });
    const withRefCompensation: AttachmentGrantDeps['withRefCompensation'] = async ({
      refIds,
      perform,
      compensate,
    }) => {
      refIds.forEach((id) => pendingRecovery.add(id));
      try {
        const result = await perform();
        refIds.forEach((id) => pendingRecovery.delete(id));
        return result;
      } catch (error) {
        const rollback = await Promise.allSettled(refIds.map(compensate));
        rollback.forEach((result, index) => {
          if (result.status === 'fulfilled') pendingRecovery.delete(refIds[index]!);
        });
        throw error;
      }
    };
    const { deps } = makeDeps({
      addRef,
      removeRefById,
      withRefCompensation,
      assertStillAllowed: () => {
        if (blocked) throw new GrantPolicyError('该插件工具已被用户阻止');
      },
    });

    const result = await grantAttachmentsToGhost(deps, {
      ghostId: 'cindy-art',
      urls: ['xdt-image://s1/a.png'],
    });

    expect(result).toMatchObject({ ok: false, errorCode: 'PERMISSION_DENIED' });
    expect(liveRefs).toHaveLength(1);
    expect(pendingRecovery).toEqual(liveRefs);

    // 模拟同 owner DB 下次 ready 时 journal reconcile 的幂等重放。
    await Promise.all([...pendingRecovery].map((id) => removeRefById(id)));
    pendingRecovery.clear();
    expect(liveRefs).toHaveLength(0);
    expect(pendingRecovery).toHaveLength(0);
  });

  it('账本闸策略拒(GrantPolicyError)→ 整批拒零副作用,拒绝理由原样透出不落格式教学文案', async () => {
    const { deps, writeBlob } = makeDeps({
      resolveImageUrl: async () => {
        throw new GrantPolicyError('该图片不是聊天里出现过的附件,不可过户');
      },
    });
    const r = await grantAttachmentsToGhost(deps, { ghostId: 'g', urls: ['cindy-media://blobs/y.jpg'] });
    expect(r).toMatchObject({ ok: false });
    expect((r as { message: string }).message).toContain('不可过户');
    expect((r as { message: string }).message).not.toContain('无法解析');
    expect(writeBlob).not.toHaveBeenCalled();
  });

  it('普通解析错误仍落格式教学文案(内部错误细节不透给模型)', async () => {
    const { deps } = makeDeps({
      resolveImageUrl: async () => {
        throw new Error('ENOENT: secret internal detail');
      },
    });
    const r = await grantAttachmentsToGhost(deps, { ghostId: 'g', urls: ['cindy-media://blobs/z.jpg'] });
    expect(r).toMatchObject({ ok: false });
    expect((r as { message: string }).message).toContain('无法解析');
    expect((r as { message: string }).message).not.toContain('secret');
  });
});

describe('grantAttachmentsToGhost — 解析层带 buffer 时的字节穿透', () => {
  it('resolveImageUrl 返回 buffer 时不再二次读盘,落仓用的正是该字节(防确认后换文件)', async () => {
    const t1Bytes = new Uint8Array([9, 9, 9]);
    const readFile = vi.fn(async () => new Uint8Array([1, 2, 3])); // 盘上"已被换"的字节
    const { deps, writeBlob } = makeDeps({
      resolveImageUrl: () => ({ absPath: '/outside/a.png', mimeType: 'image/png', buffer: t1Bytes }),
      readFile,
    });
    const r = await grantAttachmentsToGhost(deps, { ghostId: 'g1', urls: ['C:/outside/a.png'] });
    expect(r.ok).toBe(true);
    expect(readFile).not.toHaveBeenCalled();
    expect(writeBlob).toHaveBeenCalledWith(expect.objectContaining({ buffer: t1Bytes }));
  });
});
