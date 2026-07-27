/**
 * profileEdit.test.ts — 个人资料编辑业务体单测(规则 14:全依赖注入,内存直测)。
 * 覆盖:未登录 / 非法参数拒绝、名字收敛(留空/一致 = 不改)、头像三态
 * (keep / set / reset)的 OSS 直传与 PATCH 组装、体积与扩展名校验、
 * 上传 / PATCH 失败的错误码映射、无变化零请求。
 */

import { describe, it, expect, vi } from 'vitest';

import {
  AVATAR_MAX_BYTES,
  chooseAvatarFile,
  cleanupLegacyProfileOverride,
  getProfileEditState,
  updateProfile,
  type LegacyOverrideCleanupDeps,
  type ProfileEditDeps,
} from '../profileEdit';

type ProfilePatch = { displayName?: string; avatarUrl?: string | null };

const PUBLIC_URL = 'https://oss.example.invalid/cindy/public/avatar/u1/x.png';

function makeDeps(overrides: Partial<ProfileEditDeps> = {}): {
  deps: ProfileEditDeps;
  patches: ProfilePatch[];
} {
  const patches: ProfilePatch[] = [];
  const deps: ProfileEditDeps = {
    getCurrentUserId: () => 'u1',
    getServerProfile: () => ({ name: 'Server Name', avatar: null }),
    showAvatarOpenDialog: vi.fn(async () => null),
    readFile: vi.fn(async () => Buffer.from([1, 2, 3])),
    uploadAvatar: vi.fn(async () => ({ ok: true as const, publicUrl: PUBLIC_URL })),
    patchProfile: vi.fn(async (patch: ProfilePatch) => {
      patches.push(patch);
      return { ok: true as const };
    }),
    logWarn: vi.fn(),
    ...overrides,
  };
  return { deps, patches };
}

const ipcCode = (err: unknown): string | undefined =>
  (err as { code?: string } | null)?.code;

describe('登录态与参数守卫', () => {
  it('未登录:三个入口都抛 PRECONDITION_FAILED', async () => {
    const { deps } = makeDeps({ getCurrentUserId: () => null });
    expect(() => getProfileEditState(deps)).toThrowError();
    await expect(chooseAvatarFile(deps)).rejects.toSatisfy((e) => ipcCode(e) === 'PRECONDITION_FAILED');
    await expect(updateProfile(deps, { name: null, avatar: { type: 'keep' } })).rejects.toSatisfy(
      (e) => ipcCode(e) === 'PRECONDITION_FAILED',
    );
  });

  it('payload 非对象 / avatar 动作畸形 / name 非法类型 → INVALID_PARAMS', async () => {
    const { deps } = makeDeps();
    for (const bad of [null, 'x', { name: 42, avatar: { type: 'keep' } }, { name: null, avatar: { type: 'nope' } }, { name: null, avatar: { type: 'set' } }]) {
      await expect(updateProfile(deps, bad)).rejects.toSatisfy((e) => ipcCode(e) === 'INVALID_PARAMS');
    }
  });

  it('名字超长(>40 码点)拒绝', async () => {
    const { deps } = makeDeps();
    await expect(
      updateProfile(deps, { name: '啊'.repeat(41), avatar: { type: 'keep' } }),
    ).rejects.toSatisfy((e) => ipcCode(e) === 'INVALID_PARAMS');
  });
});

describe('getProfileEditState(弹窗预填)', () => {
  it('返回当前服务端展示资料', () => {
    const { deps } = makeDeps({
      getServerProfile: () => ({ name: 'Server Name', avatar: PUBLIC_URL }),
    });
    expect(getProfileEditState(deps)).toEqual({ name: 'Server Name', avatarUrl: PUBLIC_URL });
  });
});

describe('名字收敛(留空 / 与当前一致 = 不改名)', () => {
  it('新名字与当前不同 → PATCH displayName(trim 后)', async () => {
    const { deps, patches } = makeDeps();
    await updateProfile(deps, { name: '  Lizi  ', avatar: { type: 'keep' } });
    expect(patches).toEqual([{ displayName: 'Lizi' }]);
  });

  it('输入与当前一致 / null / 空串 → 不产生 PATCH 字段(全 keep 时零请求)', async () => {
    const { deps, patches } = makeDeps();
    await expect(
      updateProfile(deps, { name: 'Server Name', avatar: { type: 'keep' } }),
    ).resolves.toEqual({ ok: true });
    await expect(updateProfile(deps, { name: null, avatar: { type: 'keep' } })).resolves.toEqual({
      ok: true,
    });
    await expect(updateProfile(deps, { name: '   ', avatar: { type: 'keep' } })).resolves.toEqual({
      ok: true,
    });
    expect(patches).toEqual([]);
    expect(deps.patchProfile).not.toHaveBeenCalled();
  });
});

describe('头像三态', () => {
  it('set:读文件 → OSS 直传 → PATCH avatarUrl=publicUrl', async () => {
    const { deps, patches } = makeDeps();
    await updateProfile(deps, { name: null, avatar: { type: 'set', filePath: 'C:\\pics\\me.PNG' } });
    expect(deps.uploadAvatar).toHaveBeenCalledWith({
      buffer: expect.any(Buffer),
      mimeType: 'image/png',
    });
    expect(patches).toEqual([{ avatarUrl: PUBLIC_URL }]);
  });

  it('set + 改名:一次 PATCH 同时带两个字段', async () => {
    const { deps, patches } = makeDeps();
    await updateProfile(deps, { name: 'Lizi', avatar: { type: 'set', filePath: '/a/b.webp' } });
    expect(patches).toEqual([{ displayName: 'Lizi', avatarUrl: PUBLIC_URL }]);
  });

  it('reset:PATCH avatarUrl=null(清除自定义头像)', async () => {
    const { deps, patches } = makeDeps();
    await updateProfile(deps, { name: null, avatar: { type: 'reset' } });
    expect(patches).toEqual([{ avatarUrl: null }]);
    expect(deps.uploadAvatar).not.toHaveBeenCalled();
  });

  it('set:扩展名不在白名单(含已退役的 gif)/ 超限 / 空文件 → INVALID_PARAMS,不触发上传', async () => {
    const { deps } = makeDeps();
    for (const filePath of ['/a/b.svg', '/a/b.gif']) {
      await expect(
        updateProfile(deps, { name: null, avatar: { type: 'set', filePath } }),
      ).rejects.toSatisfy((e) => ipcCode(e) === 'INVALID_PARAMS');
    }

    (deps.readFile as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      Buffer.alloc(AVATAR_MAX_BYTES + 1),
    );
    await expect(
      updateProfile(deps, { name: null, avatar: { type: 'set', filePath: '/a/b.png' } }),
    ).rejects.toSatisfy((e) => ipcCode(e) === 'INVALID_PARAMS');

    (deps.readFile as ReturnType<typeof vi.fn>).mockResolvedValueOnce(Buffer.alloc(0));
    await expect(
      updateProfile(deps, { name: null, avatar: { type: 'set', filePath: '/a/b.png' } }),
    ).rejects.toSatisfy((e) => ipcCode(e) === 'INVALID_PARAMS');

    expect(deps.uploadAvatar).not.toHaveBeenCalled();
  });

  it('上传失败 → PROFILE_AVATAR_UPLOAD_FAILED,不触发 PATCH', async () => {
    const { deps } = makeDeps({
      uploadAvatar: vi.fn(async () => ({
        ok: false as const,
        stage: 'put' as const,
        status: 403,
      })),
    });
    await expect(
      updateProfile(deps, { name: null, avatar: { type: 'set', filePath: '/a/b.png' } }),
    ).rejects.toSatisfy((e) => ipcCode(e) === 'PROFILE_AVATAR_UPLOAD_FAILED');
    expect(deps.patchProfile).not.toHaveBeenCalled();
  });

  it('PATCH 失败 → PROFILE_UPDATE_FAILED', async () => {
    const { deps } = makeDeps({
      patchProfile: vi.fn(async () => ({ ok: false as const, status: 429, code: 'RATE_LIMITED' })),
    });
    await expect(
      updateProfile(deps, { name: 'Lizi', avatar: { type: 'keep' } }),
    ).rejects.toSatisfy((e) => ipcCode(e) === 'PROFILE_UPDATE_FAILED');
  });
});

describe('chooseAvatarFile(选图预校验,不上传)', () => {
  it('取消选择返回 canceled,不读文件', async () => {
    const { deps } = makeDeps();
    await expect(chooseAvatarFile(deps)).resolves.toEqual({ canceled: true });
    expect(deps.readFile).not.toHaveBeenCalled();
  });

  it('合法图片返回路径 + data URL 预览;不触发上传', async () => {
    const { deps } = makeDeps({
      showAvatarOpenDialog: vi.fn(async () => '/pics/me.webp'),
      readFile: vi.fn(async () => Buffer.from('abc')),
    });
    const result = await chooseAvatarFile(deps);
    expect(result.canceled).toBe(false);
    expect(result.filePath).toBe('/pics/me.webp');
    expect(result.previewDataUrl).toBe(`data:image/webp;base64,${Buffer.from('abc').toString('base64')}`);
    expect(deps.uploadAvatar).not.toHaveBeenCalled();
  });

  it('白名单外扩展名拒绝(gif 已随 OSS 场景白名单退役)', async () => {
    for (const filePath of ['/pics/me.bmp', '/pics/me.gif']) {
      const { deps } = makeDeps({ showAvatarOpenDialog: vi.fn(async () => filePath) });
      await expect(chooseAvatarFile(deps)).rejects.toSatisfy((e) => ipcCode(e) === 'INVALID_PARAMS');
    }
  });
});

describe('cleanupLegacyProfileOverride(旧本地覆写退役的一次性清理)', () => {
  function makeCleanupDeps(initialContent: string | null): {
    deps: LegacyOverrideCleanupDeps;
    readContent(): string | null;
  } {
    let content = initialContent;
    const deps: LegacyOverrideCleanupDeps = {
      readOverrideFile: () => content,
      writeOverrideFile: vi.fn((next: string) => {
        content = next;
      }),
      deleteOverrideFile: vi.fn(() => {
        content = null;
      }),
      removeRefs: vi.fn(async () => 1),
      logInfo: vi.fn(),
      logWarn: vi.fn(),
    };
    return { deps, readContent: () => content };
  }

  it('文件不存在:零动作', async () => {
    const { deps } = makeCleanupDeps(null);
    await cleanupLegacyProfileOverride(deps, 'u1');
    expect(deps.removeRefs).not.toHaveBeenCalled();
    expect(deps.deleteOverrideFile).not.toHaveBeenCalled();
  });

  it('当前账号有条目且是最后一条:清引用后删文件', async () => {
    const { deps, readContent } = makeCleanupDeps(JSON.stringify({ u1: { name: 'X' } }));
    await cleanupLegacyProfileOverride(deps, 'u1');
    expect(deps.removeRefs).toHaveBeenCalledWith({ refKind: 'profile-avatar', refId: 'u1' });
    expect(readContent()).toBeNull();
  });

  it('还有其它账号条目:只移除当前账号,回写剩余条目', async () => {
    const { deps, readContent } = makeCleanupDeps(
      JSON.stringify({ u1: { name: 'X' }, u2: { avatarUrl: 'cindy-media://blobs/a.png' } }),
    );
    await cleanupLegacyProfileOverride(deps, 'u1');
    expect(JSON.parse(readContent() ?? '{}')).toEqual({
      u2: { avatarUrl: 'cindy-media://blobs/a.png' },
    });
    expect(deps.removeRefs).toHaveBeenCalledTimes(1);
  });

  it('引用清理失败:保留条目,下次登录重试', async () => {
    const { deps, readContent } = makeCleanupDeps(JSON.stringify({ u1: { name: 'X' } }));
    (deps.removeRefs as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('db not ready'));
    await cleanupLegacyProfileOverride(deps, 'u1');
    expect(JSON.parse(readContent() ?? '{}')).toEqual({ u1: { name: 'X' } });
    expect(deps.logWarn).toHaveBeenCalled();
  });

  it('当前账号无条目:不动引用与文件(其它账号条目待各自登录时清)', async () => {
    const original = JSON.stringify({ u2: { name: 'Y' } });
    const { deps, readContent } = makeCleanupDeps(original);
    await cleanupLegacyProfileOverride(deps, 'u1');
    expect(deps.removeRefs).not.toHaveBeenCalled();
    expect(readContent()).toBe(original);
  });

  it('损坏 JSON / 空对象:直接删文件止损', async () => {
    for (const content of ['not-json{{', '{}']) {
      const { deps, readContent } = makeCleanupDeps(content);
      await cleanupLegacyProfileOverride(deps, 'u1');
      expect(deps.removeRefs).not.toHaveBeenCalled();
      expect(readContent()).toBeNull();
    }
  });
});
