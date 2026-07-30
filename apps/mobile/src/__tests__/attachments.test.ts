import { describe, expect, it } from 'vitest';
import {
  attachmentDisplayLabel,
  basenameRemotePath,
  buildAttachmentPersistFileRefs,
  buildAttachmentPersistImageRefs,
  buildMobileRemoteFileAttachment,
  buildMobileUploadedAttachment,
  MOBILE_MAX_ATTACHMENTS,
  MOBILE_MAX_ATTACHMENT_BYTES,
  categorizeMobileAttachment,
  mergeAttachmentsWithinLimit,
  extractRemoteFileExt,
} from '@/session/attachments';
import { isAttachmentOssRef, parseAttachmentOssRef } from '@/session/attachmentOssRef';
import type { RemoteSerializedAttachment } from '@/session/types';

const SHA256 = 'a'.repeat(64);

describe('mobile remote file attachments', () => {
  it('parses macOS and Windows remote paths without using local platform path rules', () => {
    expect(basenameRemotePath('/repo/docs/spec.pdf')).toBe('spec.pdf');
    expect(basenameRemotePath('C:\\repo\\docs\\notes.md')).toBe('notes.md');
    expect(extractRemoteFileExt('.env.example')).toBe('.env.example');
    expect(extractRemoteFileExt('Dockerfile')).toBe('');
  });

  it('mirrors the desktop attachment categories for common remote files', () => {
    expect(categorizeMobileAttachment('screenshot.png')).toBe('image');
    expect(categorizeMobileAttachment('spec.pdf')).toBe('pdf');
    expect(categorizeMobileAttachment('report.docx')).toBe('office');
    expect(categorizeMobileAttachment('SessionScreen.tsx')).toBe('text');
    expect(categorizeMobileAttachment('Dockerfile')).toBe('text');
    expect(categorizeMobileAttachment('archive.zip')).toBeNull();
  });

  it('builds desktop-compatible serialized attachment and persisted file refs', () => {
    const attachment = buildMobileRemoteFileAttachment('/repo/docs/spec.pdf', {
      id: 'file-1',
      size: 2048,
    });

    expect(attachment).toEqual({
      id: 'file-1',
      name: 'spec.pdf',
      path: '/repo/docs/spec.pdf',
      ext: '.pdf',
      size: 2048,
      category: 'pdf',
      mimeType: 'application/pdf',
    });
    expect(buildAttachmentPersistFileRefs([attachment!])).toEqual([
      { name: 'spec.pdf', path: '/repo/docs/spec.pdf' },
    ]);
    expect(attachmentDisplayLabel(attachment!)).toBe('spec.pdf · 2.0 KB');
  });

  it('builds desktop-compatible OSS attachment refs for uploaded mobile files', () => {
    const attachment = buildMobileUploadedAttachment({
      id: 'upload-1',
      ossKey: 'cindy/device-link/user-1/spec.pdf',
      name: '/local/spec.pdf',
      size: 4096,
      sha256: SHA256,
      mimeType: 'application/pdf',
    });

    expect(attachment).toMatchObject({
      id: 'upload-1',
      name: 'spec.pdf',
      ext: '.pdf',
      size: 4096,
      category: 'pdf',
      mimeType: 'application/pdf',
      originalName: 'spec.pdf',
      sha256: SHA256,
    });
    expect(parseAttachmentOssRef(attachment!.path)).toEqual({
      ossKey: 'cindy/device-link/user-1/spec.pdf',
      mimeType: 'application/pdf',
      originalName: 'spec.pdf',
      size: 4096,
      sha256: SHA256,
    });
    expect(buildAttachmentPersistFileRefs([attachment!])).toEqual([
      { name: 'spec.pdf', path: attachment!.path, size: 4096, sha256: SHA256 },
    ]);
  });

  it('round-trips uploaded attachment refs with CJK original names', () => {
    const attachment = buildMobileUploadedAttachment({
      ossKey: 'cindy/device-link/user-1/report.pdf',
      name: '需求文档.pdf',
      size: 1024,
      sha256: SHA256,
      mimeType: 'application/pdf',
    });

    expect(parseAttachmentOssRef(attachment!.path)).toEqual({
      ossKey: 'cindy/device-link/user-1/report.pdf',
      mimeType: 'application/pdf',
      originalName: '需求文档.pdf',
      size: 1024,
      sha256: SHA256,
    });
  });

  it('uses image refs for image persisted content and file refs for non-images', () => {
    const image = buildMobileUploadedAttachment({
      ossKey: 'cindy/device-link/user-1/photo.png',
      name: 'photo.png',
      size: 1024,
      sha256: SHA256,
      mimeType: 'image/png',
    });
    const file = buildMobileUploadedAttachment({
      ossKey: 'cindy/device-link/user-1/spec.pdf',
      name: 'spec.pdf',
      size: 1024,
      sha256: SHA256,
      mimeType: 'application/pdf',
    });

    // 字段名必须是 originalName(桌面 ImageRef schema):写成 `name` 会被桌面
    // renderer 的图片校验静默过滤,手机贴图在桌面版整个不渲染(2026-07 实踩)。
    expect(buildAttachmentPersistImageRefs([image!, file!])).toEqual([
      {
        url: image!.url,
        originalName: 'photo.png',
        mimeType: 'image/png',
        size: 1024,
        sha256: SHA256,
      },
    ]);
    expect(buildAttachmentPersistFileRefs([image!, file!])).toEqual([
      {
        name: 'spec.pdf',
        path: file!.path,
        size: 1024,
        sha256: SHA256,
      },
    ]);
  });

  it('uses the same OSS ref as image url so desktop can materialize uploaded images', () => {
    const attachment = buildMobileUploadedAttachment({
      ossKey: 'cindy/device-link/user-1/photo.png',
      name: 'photo.png',
      size: 1024,
      sha256: SHA256,
      mimeType: 'image/png',
    });

    expect(attachment?.category).toBe('image');
    expect(attachment?.url).toBe(attachment?.path);
    expect(parseAttachmentOssRef(attachment!.url!)).toMatchObject({
      ossKey: 'cindy/device-link/user-1/photo.png',
      originalName: 'photo.png',
    });
  });

  it('rejects uploaded mobile files outside desktop attachment limits', () => {
    expect(
      buildMobileUploadedAttachment({
        ossKey: 'cindy/device-link/user-1/archive.zip',
        name: 'archive.zip',
        size: 1024,
        sha256: SHA256,
      }),
    ).toBeNull();
    expect(
      buildMobileUploadedAttachment({
        ossKey: 'cindy/device-link/user-1/spec.pdf',
        name: 'spec.pdf',
        size: MOBILE_MAX_ATTACHMENT_BYTES + 1,
        sha256: SHA256,
      }),
    ).toBeNull();
  });
});

describe('attachmentOssRef legacy 兼容', () => {
  it('legacy xdt-oss-attach 引用仍可识别与解析(旧版本在途消息 / 本机存量 outbox)', () => {
    const fresh = buildMobileUploadedAttachment({
      ossKey: 'cindy/device-link/user-1/legacy.png',
      name: 'legacy.png',
      size: 1,
      sha256: SHA256,
      mimeType: 'image/png',
    });
    const legacyRef = fresh!.path.replace('cindy-oss-attach://', 'xdt-oss-attach://');
    expect(isAttachmentOssRef(legacyRef)).toBe(true);
    expect(parseAttachmentOssRef(legacyRef)).toEqual({
      ossKey: 'cindy/device-link/user-1/legacy.png',
      mimeType: 'image/png',
      originalName: 'legacy.png',
      size: 1,
      sha256: SHA256,
    });
    // rollout 期间生成面使用旧 scheme，确保旧版桌面端可识别
    expect(fresh!.path.startsWith('xdt-oss-attach://m/')).toBe(true);
  });
});

describe('mergeAttachmentsWithinLimit', () => {
  const item = (id: string): RemoteSerializedAttachment => ({
    id,
    name: `${id}.png`,
    path: `cindy-oss-attach://key/${id}`,
    ext: '.png',
    size: 1,
    category: 'image',
    mimeType: 'image/png',
  });

  it('按 id 去重,前者优先,顺序稳定', () => {
    const result = mergeAttachmentsWithinLimit([item('a'), item('b')], [item('b'), item('c')]);
    expect(result.merged.map((a) => a.id)).toEqual(['a', 'b', 'c']);
    expect(result.dropped).toEqual([]);
  });

  it('溢出的附件进 dropped,不静默消失', () => {
    // 上限是「每条消息」的产品约束,而创建失败的恢复要把 N 条待发消息并进一条草稿:
    // 溢出不可避免,但必须交给调用方回收中转对象 + 告知用户,不能内部丢掉(review P1)。
    const preferred = Array.from({ length: MOBILE_MAX_ATTACHMENTS }, (_, i) => item(`p${i}`));
    const extra = [item('x'), item('y')];
    const result = mergeAttachmentsWithinLimit(preferred, extra);
    expect(result.merged).toHaveLength(MOBILE_MAX_ATTACHMENTS);
    expect(result.dropped.map((a) => a.id)).toEqual(['x', 'y']);
    // 一个都不许凭空消失:merged + dropped 覆盖全部输入(去重后)。
    expect(result.merged.length + result.dropped.length).toBe(preferred.length + extra.length);
  });

  it('重复 id 不占额度(先去重再判上限)', () => {
    const preferred = Array.from({ length: MOBILE_MAX_ATTACHMENTS }, (_, i) => item(`p${i}`));
    const result = mergeAttachmentsWithinLimit(preferred, [item('p0'), item('z')]);
    // p0 已在,既不重复也不算溢出;只有真正装不下的 z 进 dropped。
    expect(result.merged).toHaveLength(MOBILE_MAX_ATTACHMENTS);
    expect(result.dropped.map((a) => a.id)).toEqual(['z']);
  });

  it('preferred 自身超限时原样保留(不越权截断调用方自己的内容)', () => {
    const preferred = Array.from({ length: MOBILE_MAX_ATTACHMENTS + 3 }, (_, i) => item(`p${i}`));
    const result = mergeAttachmentsWithinLimit(preferred, []);
    expect(result.merged).toHaveLength(MOBILE_MAX_ATTACHMENTS + 3);
    expect(result.dropped).toEqual([]);
  });
});
