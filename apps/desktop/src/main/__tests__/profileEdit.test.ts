/**
 * profileEdit.test.ts — 个人资料编辑业务体单测(规则 14:全依赖注入,内存直测)。
 * 覆盖:未登录 / 非法参数拒绝、名字收敛(留空/一致 = 不改)、头像三态
 * (keep / set / reset)的 OSS 直传与 PATCH 组装、导出字节的类型 / 文件头 / 体积 / 尺寸 / 解码校验、
 * 选图的扩展名与源图体积校验、HDR 头像在取景前转 SDR、保存途中切换账号、
 * 上传 / PATCH 失败的错误码映射、无变化零请求。
 */

import fs from 'node:fs';
import path from 'node:path';

import { describe, it, expect, vi } from 'vitest';

import { toSdrAvatarImage, readPngHdrChunks } from '../hdrAvatarToSdr';

import {
  AVATAR_MAX_BYTES,
  AVATAR_SOURCE_MAX_BYTES,
  AVATAR_UPLOAD_MAX_EDGE_PX,
  chooseAvatarFile,
  chooseAvatarSource,
  cleanupLegacyProfileOverride,
  getProfileEditState,
  readAvatarDimensions,
  updateProfile,
  type LegacyOverrideCleanupDeps,
  type ProfileEditDeps,
} from '../profileEdit';

type ProfilePatch = { displayName?: string; avatarUrl?: string | null };

const PUBLIC_URL = 'https://oss.example.invalid/cindy/public/avatar/u1/x.png';

// 头像编辑器导出的字节:只认 PNG / JPEG,文件头必须与声明的 mime 一致,且带可读尺寸。
const PNG_HEADER = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const u16 = (n: number) => [(n >> 8) & 0xff, n & 0xff];
const u32 = (n: number) => [(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
const pngBytes = (size = 64, width = 256, height = 256) => {
  const data = new Uint8Array(size);
  data.set([...PNG_HEADER, ...u32(13), 0x49, 0x48, 0x44, 0x52, ...u32(width), ...u32(height)]);
  return data;
};
// SOI + JFIF APP0 + SOF0(高在宽前)。
const jpegBytes = (width = 256, height = 256) =>
  Uint8Array.from([
    0xff, 0xd8,
    0xff, 0xe0, ...u16(16), 0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0,
    0xff, 0xc0, ...u16(17), 8, ...u16(height), ...u16(width), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1,
    0xff, 0xda,
  ]);
const resourceBytes = (name: string) =>
  new Uint8Array(fs.readFileSync(path.resolve(__dirname, '../../../resources', name)));

function makeDeps(overrides: Partial<ProfileEditDeps> = {}): {
  deps: ProfileEditDeps;
  patches: ProfilePatch[];
} {
  const patches: ProfilePatch[] = [];
  const deps: ProfileEditDeps = {
    getCurrentUserId: () => 'u1',
    getAccountScopeKey: () => 'cloud:u1:1',
    getServerProfile: () => ({ name: 'Server Name', avatar: null }),
    showAvatarOpenDialog: vi.fn(async () => null),
    readFile: vi.fn(async () => Buffer.from([1, 2, 3])),
    toSdrAvatar: vi.fn(async (image) => image),
    // 默认模拟解码成功:像素尺寸与文件头声明一致。
    decodeAvatarImage: vi.fn(({ buffer, mimeType }: { buffer: Uint8Array; mimeType: string }) =>
      readAvatarDimensions(buffer, mimeType),
    ),
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
  it('set:导出字节原样 OSS 直传 → PATCH avatarUrl=publicUrl(不再读任何文件路径)', async () => {
    const { deps, patches } = makeDeps();
    const data = pngBytes();
    await updateProfile(deps, { name: null, avatar: { type: 'set', data, mimeType: 'image/png' } });
    expect(deps.uploadAvatar).toHaveBeenCalledWith({ buffer: data, mimeType: 'image/png' });
    expect(deps.readFile).not.toHaveBeenCalled();
    expect(patches).toEqual([{ avatarUrl: PUBLIC_URL }]);
  });

  it('set + 改名:一次 PATCH 同时带两个字段', async () => {
    const { deps, patches } = makeDeps();
    await updateProfile(deps, {
      name: 'Lizi',
      avatar: { type: 'set', data: jpegBytes(), mimeType: 'image/jpeg' },
    });
    expect(patches).toEqual([{ displayName: 'Lizi', avatarUrl: PUBLIC_URL }]);
  });

  it('reset:PATCH avatarUrl=null(清除自定义头像)', async () => {
    const { deps, patches } = makeDeps();
    await updateProfile(deps, { name: null, avatar: { type: 'reset' } });
    expect(patches).toEqual([{ avatarUrl: null }]);
    expect(deps.uploadAvatar).not.toHaveBeenCalled();
  });

  it('set:类型不在导出白名单 / 文件头与 mime 不符 / 超限 / 空字节 / 非字节数组 → INVALID_PARAMS,不触发上传', async () => {
    const { deps } = makeDeps();
    const oversized = pngBytes(AVATAR_MAX_BYTES + 1);
    const bad: unknown[] = [
      { type: 'set', data: pngBytes(), mimeType: 'image/webp' },
      { type: 'set', data: pngBytes(), mimeType: 'image/gif' },
      { type: 'set', data: pngBytes(), mimeType: 'image/jpeg' },
      { type: 'set', data: jpegBytes(), mimeType: 'image/png' },
      { type: 'set', data: Uint8Array.from([0x89, 0x50]), mimeType: 'image/png' },
      { type: 'set', data: oversized, mimeType: 'image/png' },
      { type: 'set', data: new Uint8Array(0), mimeType: 'image/png' },
      { type: 'set', data: [...PNG_HEADER], mimeType: 'image/png' },
      { type: 'set', filePath: '/a/b.png' },
    ];
    for (const avatar of bad) {
      await expect(updateProfile(deps, { name: null, avatar })).rejects.toSatisfy(
        (e) => ipcCode(e) === 'INVALID_PARAMS',
      );
    }
    expect(deps.uploadAvatar).not.toHaveBeenCalled();
    expect(deps.readFile).not.toHaveBeenCalled();
  });

  it('set:文件头尺寸缺失 / 为 0 / 超过导出边长 → INVALID_PARAMS,不解码也不上传', async () => {
    const { deps } = makeDeps();
    const noIhdr = pngBytes();
    noIhdr.set([0x67, 0x41, 0x4d, 0x41], 12); // 第一个 chunk 不是 IHDR
    const max = AVATAR_UPLOAD_MAX_EDGE_PX;
    const bad: Array<{ data: Uint8Array; mimeType: string }> = [
      { data: noIhdr, mimeType: 'image/png' },
      { data: Uint8Array.from([...PNG_HEADER, 0, 0, 0, 13]), mimeType: 'image/png' },
      { data: pngBytes(64, 0, 256), mimeType: 'image/png' },
      { data: pngBytes(64, max + 1, 16), mimeType: 'image/png' },
      { data: pngBytes(64, 0x7fffffff, 0x7fffffff), mimeType: 'image/png' },
      { data: jpegBytes(16, max + 1), mimeType: 'image/jpeg' },
      { data: Uint8Array.from([0xff, 0xd8, 0xff, 0xda, 0, 2, 0, 0]), mimeType: 'image/jpeg' },
      { data: Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]), mimeType: 'image/jpeg' },
      { data: resourceBytes('bgicon.jpg'), mimeType: 'image/jpeg' },
    ];
    for (const { data, mimeType } of bad) {
      await expect(
        updateProfile(deps, { name: null, avatar: { type: 'set', data, mimeType } }),
      ).rejects.toSatisfy((e) => ipcCode(e) === 'INVALID_PARAMS');
    }
    expect(deps.decodeAvatarImage).not.toHaveBeenCalled();
    expect(deps.uploadAvatar).not.toHaveBeenCalled();
  });

  it('set:main 完整解码失败或像素尺寸与文件头不符 → INVALID_PARAMS,不上传', async () => {
    for (const decoded of [null, { width: 128, height: 256 }]) {
      const { deps } = makeDeps({ decodeAvatarImage: vi.fn(() => decoded) });
      const data = pngBytes();
      await expect(
        updateProfile(deps, { name: null, avatar: { type: 'set', data, mimeType: 'image/png' } }),
      ).rejects.toSatisfy((e) => ipcCode(e) === 'INVALID_PARAMS');
      expect(deps.decodeAvatarImage).toHaveBeenCalledWith({ buffer: data, mimeType: 'image/png' });
      expect(deps.uploadAvatar).not.toHaveBeenCalled();
    }
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
      updateProfile(deps, {
        name: null,
        avatar: { type: 'set', data: pngBytes(), mimeType: 'image/png' },
      }),
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

describe('HDR 头像在取景前转 SDR', () => {
  const hdrPng = fs.readFileSync(path.join(__dirname, 'fixtures', 'hdr-avatar', 'pq-bt2100.png'));

  it('chooseAvatarFile:取景源就是真实转换后的 SDR 字节', async () => {
    const { deps } = makeDeps({
      showAvatarOpenDialog: vi.fn(async () => '/pics/hdr.png'),
      readFile: vi.fn(async () => hdrPng),
      toSdrAvatar: toSdrAvatarImage,
    });
    const result = await chooseAvatarFile(deps);
    const preview = Buffer.from(result.previewDataUrl!.split(',')[1]!, 'base64');
    expect(result.previewDataUrl!.startsWith('data:image/png;base64,')).toBe(true);
    expect(readPngHdrChunks(hdrPng).cicp?.transfer).toBe(16);
    expect(readPngHdrChunks(preview).cicp).toBeNull();
    expect(preview.equals((await toSdrAvatarImage({ buffer: hdrPng, mimeType: 'image/png' })).buffer)).toBe(true);
  });

  // Unit regression #6889: local-mode Bot picking must share real HDR
  // preparation without bypassing the account editor's existing login guard.
  // Account-only tests previously rejected every unlogged-in chooser.
  it('local Bot source preparation tone-maps HDR without reading or writing account data', async () => {
    const hdrPng = fs.readFileSync(path.join(__dirname, 'fixtures/hdr-avatar/pq-bt2100.png'));
    const { deps } = makeDeps({
      getCurrentUserId: () => null,
      showAvatarOpenDialog: vi.fn(async () => '/fixture/avatar.png'),
      readFile: vi.fn(async () => hdrPng),
      toSdrAvatar: toSdrAvatarImage,
      getServerProfile: () => { throw new Error('No account in local mode'); },
    });
    await expect(chooseAvatarFile(deps)).rejects.toSatisfy((error) => ipcCode(error) === 'PRECONDITION_FAILED');
    const result = await chooseAvatarSource(deps);
    const expected = await toSdrAvatarImage({ buffer: hdrPng, mimeType: 'image/png' });
    expect(result).toEqual({ canceled: false, previewDataUrl: `data:${expected.mimeType};base64,${expected.buffer.toString('base64')}` });
    expect(deps.uploadAvatar).not.toHaveBeenCalled();
    expect(deps.patchProfile).not.toHaveBeenCalled();
  });

  it('chooseAvatarFile:转换结果超出源图上限 → 选图阶段就 INVALID_PARAMS', async () => {
    const { deps } = makeDeps({
      showAvatarOpenDialog: vi.fn(async () => '/pics/hdr.png'),
      toSdrAvatar: vi.fn(async () => ({
        buffer: Buffer.alloc(AVATAR_SOURCE_MAX_BYTES + 1),
        mimeType: 'image/png',
      })),
    });
    await expect(chooseAvatarFile(deps)).rejects.toSatisfy((e) => ipcCode(e) === 'INVALID_PARAMS');
  });

  it('set:上传的就是编辑器导出的字节,不在裁剪后二次转换', async () => {
    const { deps } = makeDeps();
    const data = pngBytes();
    await updateProfile(deps, { name: null, avatar: { type: 'set', data, mimeType: 'image/png' } });
    expect(deps.toSdrAvatar).not.toHaveBeenCalled();
    expect(deps.uploadAvatar).toHaveBeenCalledWith({ buffer: data, mimeType: 'image/png' });
  });
});

describe('保存途中切换账号', () => {
  // 每次读取账号会话标识时推进一步:前 n 次仍是原会话,之后换成新会话,模拟在第 n 个 await 前后切号。
  const switchAfter = (reads: number, next = 'cloud:u2:2') => {
    let count = 0;
    return () => (++count <= reads ? 'cloud:u1:1' : next);
  };
  const setAvatar = () => ({ type: 'set' as const, data: pngBytes(), mimeType: 'image/png' });

  it('上传前切号 → PRECONDITION_FAILED,不上传也不 PATCH', async () => {
    const { deps } = makeDeps({ getAccountScopeKey: switchAfter(1) });
    await expect(
      updateProfile(deps, { name: 'Lizi', avatar: setAvatar() }),
    ).rejects.toSatisfy((e) => ipcCode(e) === 'PRECONDITION_FAILED');
    expect(deps.uploadAvatar).not.toHaveBeenCalled();
    expect(deps.patchProfile).not.toHaveBeenCalled();
  });

  it('上传期间切号 → PRECONDITION_FAILED,不把头像与旧名字 PATCH 到新账号', async () => {
    const { deps } = makeDeps({ getAccountScopeKey: switchAfter(2) });
    await expect(
      updateProfile(deps, { name: 'Lizi', avatar: setAvatar() }),
    ).rejects.toSatisfy((e) => ipcCode(e) === 'PRECONDITION_FAILED');
    expect(deps.uploadAvatar).toHaveBeenCalledTimes(1);
    expect(deps.patchProfile).not.toHaveBeenCalled();
  });

  it('同一用户 id 切到另一区域(会话代次变化)同样拦下,不 PATCH 到新区域', async () => {
    // getCurrentUserId 始终是 u1:只比较用户 id 的检查会放行。
    const { deps } = makeDeps({ getAccountScopeKey: switchAfter(2, 'cloud:u1:2') });
    await expect(
      updateProfile(deps, { name: 'Lizi', avatar: setAvatar() }),
    ).rejects.toSatisfy((e) => ipcCode(e) === 'PRECONDITION_FAILED');
    expect(deps.patchProfile).not.toHaveBeenCalled();
  });

  it('账号不变时照常上传并 PATCH', async () => {
    const { deps, patches } = makeDeps({ getAccountScopeKey: switchAfter(Infinity) });
    await updateProfile(deps, { name: 'Lizi', avatar: setAvatar() });
    expect(patches).toEqual([{ displayName: 'Lizi', avatarUrl: PUBLIC_URL }]);
  });
});

describe('readAvatarDimensions(文件头尺寸)', () => {
  it('读出真实 PNG / JPEG 的像素尺寸', () => {
    expect(readAvatarDimensions(resourceBytes('icon.png'), 'image/png')).toEqual({
      width: 512,
      height: 512,
    });
    expect(readAvatarDimensions(resourceBytes('bgicon.jpg'), 'image/jpeg')).toEqual({
      width: 1024,
      height: 1024,
    });
    expect(readAvatarDimensions(jpegBytes(300, 200), 'image/jpeg')).toEqual({
      width: 300,
      height: 200,
    });
  });

  it('边长恰为上限的真实 PNG 可以上传,字节原样', async () => {
    const { deps, patches } = makeDeps();
    const data = resourceBytes('icon.png');
    await updateProfile(deps, { name: null, avatar: { type: 'set', data, mimeType: 'image/png' } });
    expect(deps.uploadAvatar).toHaveBeenCalledWith({ buffer: data, mimeType: 'image/png' });
    expect(patches).toEqual([{ avatarUrl: PUBLIC_URL }]);
  });
});

describe('chooseAvatarFile(选图预校验,不上传)', () => {
  it('取消选择返回 canceled,不读文件', async () => {
    const { deps } = makeDeps();
    await expect(chooseAvatarFile(deps)).resolves.toEqual({ canceled: true });
    expect(deps.readFile).not.toHaveBeenCalled();
  });

  it('合法图片返回 data URL 取景源(不回传本机路径);不触发上传', async () => {
    const { deps } = makeDeps({
      showAvatarOpenDialog: vi.fn(async () => '/pics/me.webp'),
      readFile: vi.fn(async () => Buffer.from('abc')),
    });
    const result = await chooseAvatarFile(deps);
    expect(result.canceled).toBe(false);
    expect(result).not.toHaveProperty('filePath');
    expect(result.previewDataUrl).toBe(`data:image/webp;base64,${Buffer.from('abc').toString('base64')}`);
    expect(deps.uploadAvatar).not.toHaveBeenCalled();
  });

  it('源图体积按选图上限(20MB)校验:超过上传上限但在源图上限内的原片可选', async () => {
    const { deps } = makeDeps({
      showAvatarOpenDialog: vi.fn(async () => '/pics/photo.jpg'),
      readFile: vi.fn(async () => Buffer.alloc(AVATAR_MAX_BYTES + 1)),
    });
    await expect(chooseAvatarFile(deps)).resolves.toMatchObject({ canceled: false });

    (deps.readFile as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      Buffer.alloc(AVATAR_SOURCE_MAX_BYTES + 1),
    );
    await expect(chooseAvatarFile(deps)).rejects.toSatisfy((e) => ipcCode(e) === 'INVALID_PARAMS');
    (deps.readFile as ReturnType<typeof vi.fn>).mockResolvedValueOnce(Buffer.alloc(0));
    await expect(chooseAvatarFile(deps)).rejects.toSatisfy((e) => ipcCode(e) === 'INVALID_PARAMS');
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
