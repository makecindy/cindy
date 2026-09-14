import { beforeAll, describe, expect, it, vi } from 'vitest';
import { apiFetchRaw } from '@/api/client';
import { DEVICE_LINK_API_BASE_URL } from '@/config/env';
import { i18n } from '@/i18n';
import { buildAttachmentOssRef, parseAttachmentOssRef } from '@/session/attachmentOssRef';
import {
  discardMobileUploadedAttachment,
  presignMobileAttachmentUpload,
  putMobileAttachmentUpload,
  putMobileAttachmentUploadFromFile,
  uploadMobileAttachment,
  uploadMobileAttachmentFromFile,
} from '@/session/mobileAttachmentUpload';

// 文案已 i18n 化;固定 zh-CN 让字面量断言与语言环境解耦(全局 mock 默认 en-US)。
beforeAll(async () => {
  await i18n.changeLanguage('zh-CN');
});

const readFileChunk = vi.fn(async (_uri: string, _position: number, length: number) =>
  Buffer.alloc(length, 0x78).toString('base64'),
);

describe('mobileAttachmentUpload', () => {
  it('requests a device-link media presign-put with desktop-compatible file metadata', async () => {
    const apiFetch = vi.fn(async () => ({
      putUrl: 'https://oss.example/upload',
      key: 'cindy/device-link/user-1/spec.pdf',
      expiresAt: '2026-06-16T00:00:00.000Z',
    }));

    const result = await presignMobileAttachmentUpload(
      {
        name: 'spec.pdf',
        size: 4096,
        mimeType: 'application/pdf',
      },
      {
        token: 'token-1',
        deps: { apiFetch: apiFetch as unknown as typeof apiFetchRaw },
      },
    );

    expect(apiFetch).toHaveBeenCalledWith('/api/device-link/media/presign-put', {
      baseUrl: DEVICE_LINK_API_BASE_URL,
      method: 'POST',
      token: 'token-1',
      timeoutMs: 12_000,
      body: {
        size: 4096,
        contentType: 'application/pdf',
        ext: 'pdf',
      },
    });
    expect(result.key).toBe('cindy/device-link/user-1/spec.pdf');
  });

  it('uploads bytes with the signed PUT url', async () => {
    const fetchPut = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
    } as Response));
    const data = new Blob(['hello'], { type: 'text/plain' });

    await putMobileAttachmentUpload('https://oss.example/upload', data, 'text/plain', {
      fetch: fetchPut,
    });

    expect(fetchPut).toHaveBeenCalledWith('https://oss.example/upload', {
      method: 'PUT',
      headers: {
        'Content-Type': 'text/plain',
        'x-oss-object-acl': 'private',
      },
      body: data,
      // 弱网加固:Android RN fetch 无默认超时,PUT 必须带 abort signal 兜底
      signal: expect.any(AbortSignal),
    });
  });

  it('returns an OSS-ref attachment after successful upload', async () => {
    const apiFetch = vi.fn(async () => ({
      putUrl: 'https://oss.example/upload',
      key: 'cindy/device-link/user-1/photo.png',
      expiresAt: '2026-06-16T00:00:00.000Z',
    }));
    const fetchPut = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
    } as Response));

    const attachment = await uploadMobileAttachment(
      {
        name: 'photo.png',
        size: 5,
        mimeType: 'image/png',
      },
      new Blob(['image'], { type: 'image/png' }),
      {
        token: 'token-1',
        id: 'mobile-upload-1',
        deps: {
          apiFetch: apiFetch as unknown as typeof apiFetchRaw,
          fetch: fetchPut,
        },
      },
    );

    expect(attachment).toMatchObject({
      id: 'mobile-upload-1',
      name: 'photo.png',
      category: 'image',
      mimeType: 'image/png',
      size: 5,
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(attachment.url).toBe(attachment.path);
    expect(parseAttachmentOssRef(attachment.path)).toEqual({
      ossKey: 'cindy/device-link/user-1/photo.png',
      mimeType: 'image/png',
      originalName: 'photo.png',
      size: 5,
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it('rejects an unsupported local file type before any presign or PUT (no orphaned OSS object)', async () => {
    const apiFetch = vi.fn();
    const fetchPut = vi.fn();

    await expect(
      uploadMobileAttachment(
        {
          name: 'archive.zip',
          size: 4096,
          mimeType: 'application/zip',
        },
        new Blob(['zip'], { type: 'application/zip' }),
        {
          token: 'token-1',
          deps: {
            apiFetch: apiFetch as unknown as typeof apiFetchRaw,
            fetch: fetchPut,
          },
        },
      ),
    ).rejects.toThrow('这个本机文件类型暂不支持作为附件发送。');

    // 关键:校验发生在网络调用之前,绝不能 presign / PUT,否则会留下孤儿对象。
    expect(apiFetch).not.toHaveBeenCalled();
    expect(fetchPut).not.toHaveBeenCalled();
  });

  it('fails when OSS PUT does not accept the upload, surfacing the OSS error code', async () => {
    const fetchPut = vi.fn(async () => ({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      text: async () => '<?xml version="1.0"?><Error><Code>SignatureDoesNotMatch</Code></Error>',
    } as unknown as Response));

    await expect(putMobileAttachmentUpload('https://oss.example/upload', new Blob(['x']), 'text/plain', {
      fetch: fetchPut,
    })).rejects.toThrow('附件上传失败：HTTP 403 (SignatureDoesNotMatch)');
  });

  it('still reports the bare status when the OSS error body is unavailable', async () => {
    // mock 无 text():读 body 失败不能吞掉主错误。
    const fetchPut = vi.fn(async () => ({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
    } as Response));

    await expect(putMobileAttachmentUpload('https://oss.example/upload', new Blob(['x']), 'text/plain', {
      fetch: fetchPut,
    })).rejects.toThrow('附件上传失败：HTTP 403');
  });

  it('uploads a local file natively with the signed PUT url and OSS headers', async () => {
    const uploadFile = vi.fn(async () => ({ status: 200 }));

    await putMobileAttachmentUploadFromFile('https://oss.example/upload', 'file:///tmp/photo.png', 'image/png', {
      uploadFile,
    });

    expect(uploadFile).toHaveBeenCalledWith('https://oss.example/upload', 'file:///tmp/photo.png', {
      'Content-Type': 'image/png',
      'x-oss-object-acl': 'private',
    }, { signal: expect.any(AbortSignal), onProgress: expect.any(Function) });
  });

  it('returns an OSS-ref attachment after successful native file upload', async () => {
    const apiFetch = vi.fn(async () => ({
      putUrl: 'https://oss.example/upload',
      key: 'cindy/device-link/user-1/photo.png',
      expiresAt: '2026-06-16T00:00:00.000Z',
    }));
    const uploadFile = vi.fn(async () => ({ status: 200 }));

    const attachment = await uploadMobileAttachmentFromFile(
      {
        name: 'photo.png',
        size: 12,
        mimeType: 'image/png',
      },
      'file:///tmp/photo.png',
      {
        token: 'token-1',
        id: 'mobile-upload-2',
        deps: {
          apiFetch: apiFetch as unknown as typeof apiFetchRaw,
          uploadFile,
          readFileChunk,
        },
      },
    );

    expect(uploadFile).toHaveBeenCalledWith('https://oss.example/upload', 'file:///tmp/photo.png', {
      'Content-Type': 'image/png',
      'x-oss-object-acl': 'private',
    }, { signal: expect.any(AbortSignal), onProgress: expect.any(Function) });
    expect(attachment).toMatchObject({
      id: 'mobile-upload-2',
      name: 'photo.png',
      category: 'image',
      mimeType: 'image/png',
      size: 12,
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(parseAttachmentOssRef(attachment.path)).toEqual({
      ossKey: 'cindy/device-link/user-1/photo.png',
      mimeType: 'image/png',
      originalName: 'photo.png',
      size: 12,
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it('hashes and uploads the same immutable snapshot file', async () => {
    const apiFetch = vi.fn(async () => ({
      putUrl: 'https://oss.example/upload',
      key: 'xdt-maker/device-link/user-1/photo.png',
      expiresAt: '2026-06-16T00:00:00.000Z',
    }));
    const uploadFile = vi.fn(async () => ({ status: 200 }));
    const cleanup = vi.fn(async () => undefined);
    const snapshotFile = vi.fn(async () => ({
      uri: 'file:///cache/upload-snapshot.png',
      size: 12,
      cleanup,
    }));
    const snapshotRead = vi.fn(async (uri: string, _position: number, length: number) => {
      expect(uri).toBe('file:///cache/upload-snapshot.png');
      return Buffer.alloc(length, 0x78).toString('base64');
    });

    await uploadMobileAttachmentFromFile(
      { name: 'photo.png', size: 12, mimeType: 'image/png' },
      'file:///tmp/mutable-photo.png',
      {
        token: 'token-1',
        deps: {
          apiFetch: apiFetch as unknown as typeof apiFetchRaw,
          uploadFile,
          readFileChunk: snapshotRead,
          snapshotFile,
        },
      },
    );

    expect(snapshotFile).toHaveBeenCalledWith('file:///tmp/mutable-photo.png');
    expect(uploadFile).toHaveBeenCalledWith(
      'https://oss.example/upload',
      'file:///cache/upload-snapshot.png',
      expect.any(Object),
      { signal: expect.any(AbortSignal), onProgress: expect.any(Function) },
    );
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('falls back to application/octet-stream in BOTH presign and PUT headers when mimeType is missing', async () => {
    // 回归:mimeType 缺失时预签名不锁 Content-Type,而 expo 原生直传层自动补
    // application/octet-stream,签名不一致 → OSS SignatureDoesNotMatch 403
    // (2026-07 粘贴图片实撞)。两端必须同源兜底到 octet-stream。
    const apiFetch = vi.fn(async () => ({
      putUrl: 'https://oss.example/upload',
      key: 'cindy/device-link/user-1/file.pdf',
      expiresAt: '2026-06-16T00:00:00.000Z',
    }));
    const uploadFile = vi.fn(async () => ({ status: 200 }));

    await uploadMobileAttachmentFromFile(
      {
        name: 'scan.pdf',
        size: 128,
        mimeType: undefined,
      },
      'file:///tmp/scan.pdf',
      {
        token: 'token-1',
        deps: {
          apiFetch: apiFetch as unknown as typeof apiFetchRaw,
          uploadFile,
          readFileChunk,
        },
      },
    );

    expect(apiFetch).toHaveBeenCalledWith(
      '/api/device-link/media/presign-put',
      expect.objectContaining({
        body: expect.objectContaining({
          contentType: 'application/octet-stream',
        }),
      }),
    );
    expect(uploadFile).toHaveBeenCalledWith(
      'https://oss.example/upload',
      'file:///tmp/scan.pdf',
      {
        'Content-Type': 'application/octet-stream',
        'x-oss-object-acl': 'private',
      },
      { signal: expect.any(AbortSignal), onProgress: expect.any(Function) },
    );
  });

  it('surfaces the OSS error code from the native file PUT failure body', async () => {
    const uploadFile = vi.fn(async () => ({
      status: 403,
      body: '<?xml version="1.0"?><Error><Code>SignatureDoesNotMatch</Code></Error>',
    }));

    await expect(putMobileAttachmentUploadFromFile('https://oss.example/upload', 'file:///tmp/x.png', 'image/png', {
      uploadFile,
    })).rejects.toThrow('附件上传失败：HTTP 403 (SignatureDoesNotMatch)');
  });

  it('rejects an unsupported file type before presign in the native file path (no orphaned OSS object)', async () => {
    const apiFetch = vi.fn();
    const uploadFile = vi.fn();

    await expect(
      uploadMobileAttachmentFromFile(
        {
          name: 'archive.zip',
          size: 4096,
          mimeType: 'application/zip',
        },
        'file:///tmp/archive.zip',
        {
          token: 'token-1',
          deps: {
            apiFetch: apiFetch as unknown as typeof apiFetchRaw,
            uploadFile,
          },
        },
      ),
    ).rejects.toThrow('这个本机文件类型暂不支持作为附件发送。');

    expect(apiFetch).not.toHaveBeenCalled();
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it('fails when the native file PUT does not accept the upload', async () => {
    const uploadFile = vi.fn(async () => ({ status: 403 }));

    await expect(putMobileAttachmentUploadFromFile('https://oss.example/upload', 'file:///tmp/x.png', 'image/png', {
      uploadFile,
    })).rejects.toThrow('附件上传失败：HTTP 403');
    // HTTP 状态码失败是签名/权限类问题,重试无意义,只允许调用一次。
    expect(uploadFile).toHaveBeenCalledTimes(1);
  });

  it('retries once after a native transport error and succeeds', async () => {
    const uploadFile = vi.fn()
      .mockRejectedValueOnce(new Error("Unable to upload the file: 'Error Domain=NSURLErrorDomain Code=-1'"))
      .mockResolvedValueOnce({ status: 200 });

    await putMobileAttachmentUploadFromFile('https://oss.example/upload', 'file:///tmp/x.png', 'image/png', {
      uploadFile,
    });

    expect(uploadFile).toHaveBeenCalledTimes(2);
  });

  it('wraps repeated native transport errors into a readable Chinese message', async () => {
    const nativeMessage = "Unable to upload the file: 'Error Domain=NSURLErrorDomain Code=-1 \"unknown error\"'";
    const uploadFile = vi.fn(async () => {
      throw new Error(nativeMessage);
    });

    await expect(putMobileAttachmentUploadFromFile('https://oss.example/upload', 'file:///tmp/x.png', 'image/png', {
      uploadFile,
    })).rejects.toThrow('附件上传失败：网络传输异常，请检查网络后重试。');
    expect(uploadFile).toHaveBeenCalledTimes(2);
  });

  it('settles after bounded automatic recovery even when native upload ignores abort', async () => {
    vi.useFakeTimers();
    try {
      const uploadFile = vi.fn(() => new Promise<{ status: number }>(() => {}));

      const pending = putMobileAttachmentUploadFromFile('https://oss.example/upload', 'file:///tmp/x.png', 'image/png', {
        uploadFile,
      });
      const expectation = expect(pending).rejects.toThrow('附件上传超时，请检查网络后重试。');
      await vi.advanceTimersByTimeAsync(120_800);
      await expectation;
      expect(uploadFile).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('automatically recovers a stuck PUT using the same bytes and ignores its late success', async () => {
    vi.useFakeTimers();
    try {
      let resolveFirst!: (value: { status: number }) => void;
      const uploadFile = vi.fn()
        .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
        .mockResolvedValueOnce({ status: 200 });
      const onLateSuccess = vi.fn();
      const pending = putMobileAttachmentUploadFromFile('https://oss.example/upload', 'file:///tmp/x.png', 'image/png', { uploadFile }, { onLateSuccess });
      await vi.advanceTimersByTimeAsync(60_800);
      await pending;
      expect(uploadFile).toHaveBeenCalledTimes(2);
      expect(uploadFile.mock.calls[0].slice(0, 3)).toEqual(uploadFile.mock.calls[1].slice(0, 3));
      expect(uploadFile.mock.calls[0][3].signal.aborted).toBe(true);
      resolveFirst({ status: 200 });
      await vi.advanceTimersByTimeAsync(0);
      expect(onLateSuccess).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it('reclaims a late native success after all attempts failed', async () => {
    vi.useFakeTimers();
    try {
      let resolveFirst!: (value: { status: number }) => void;
      const uploadFile = vi.fn()
        .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
        .mockResolvedValueOnce({ status: 403 });
      const onLateSuccess = vi.fn();
      const pending = putMobileAttachmentUploadFromFile('https://oss.example/upload', 'file:///tmp/x.png', 'image/png', { uploadFile }, { onLateSuccess });
      const failed = expect(pending).rejects.toThrow('HTTP 403');
      await vi.advanceTimersByTimeAsync(60_800);
      await failed;
      resolveFirst({ status: 200 });
      await vi.advanceTimersByTimeAsync(0);
      expect(onLateSuccess).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  it.each([408, 429, 503])('automatically recovers a temporary HTTP %s failure', async (status) => {
    const uploadFile = vi.fn().mockResolvedValueOnce({ status }).mockResolvedValueOnce({ status: 200 });
    await putMobileAttachmentUploadFromFile('https://oss.example/upload', 'file:///tmp/x.png', 'image/png', { uploadFile });
    expect(uploadFile).toHaveBeenCalledTimes(2);
  });

  it('bounds Blob uploads even when fetch ignores abort', async () => {
    vi.useFakeTimers();
    try {
      const fetchPut = vi.fn(() => new Promise<Response>(() => {}));
      const pending = putMobileAttachmentUpload('https://oss.example/upload', new Blob(['x']), 'text/plain', { fetch: fetchPut });
      const failed = expect(pending).rejects.toThrow('附件上传超时');
      await vi.advanceTimersByTimeAsync(240_800);
      await failed;
      expect(fetchPut).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });

  it('lets a slow native upload continue while bytes advance and retires its progress callback', async () => {
    vi.useFakeTimers();
    try {
      let finish!: (value: { status: number }) => void;
      let progress!: (bytes: number) => void;
      let signal!: AbortSignal;
      const uploadFile = vi.fn((_url, _uri, _headers, opts) => {
        progress = opts.onProgress;
        signal = opts.signal;
        return new Promise<{ status: number }>((resolve) => { finish = resolve; });
      });
      const pending = putMobileAttachmentUploadFromFile('https://oss.example/upload', 'file:///tmp/x.png', 'image/png', { uploadFile });
      await vi.advanceTimersByTimeAsync(50_000);
      progress(100);
      await vi.advanceTimersByTimeAsync(40_000);
      expect(signal.aborted).toBe(false);
      expect(uploadFile).toHaveBeenCalledTimes(1);
      finish({ status: 200 });
      await pending;
      progress(200);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('duplicate progress events cannot keep a stalled native upload alive', async () => {
    vi.useFakeTimers();
    try {
      let progress!: (bytes: number) => void;
      const uploadFile = vi.fn()
        .mockImplementationOnce((_url, _uri, _headers, opts) => {
          progress = opts.onProgress;
          return new Promise(() => {});
        })
        .mockResolvedValueOnce({ status: 200 });
      const pending = putMobileAttachmentUploadFromFile('https://oss.example/upload', 'file:///tmp/x.png', 'image/png', { uploadFile });
      progress(100);
      await vi.advanceTimersByTimeAsync(50_000);
      progress(100);
      await vi.advanceTimersByTimeAsync(10_800);
      await pending;
      expect(uploadFile).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });

  it('propagates external cancellation without retrying', async () => {
    const outer = new AbortController();
    const uploadFile = vi.fn((_url: string, _fileUri: string, _headers: Record<string, string>, opts?: { signal?: AbortSignal }) =>
      new Promise<{ status: number }>((_resolve, reject) => {
        opts?.signal?.addEventListener('abort', () => reject(new Error('附件上传已取消。')));
      }));

    const pending = putMobileAttachmentUploadFromFile(
      'https://oss.example/upload',
      'file:///tmp/x.png',
      'image/png',
      { uploadFile },
      { signal: outer.signal },
    );
    const expectation = expect(pending).rejects.toThrow('附件上传已取消。');
    outer.abort();
    await expectation;
    expect(uploadFile).toHaveBeenCalledTimes(1);
  });

  it('rejects immediately when called with an already-aborted signal', async () => {
    const outer = new AbortController();
    outer.abort();
    const uploadFile = vi.fn();

    await expect(putMobileAttachmentUploadFromFile(
      'https://oss.example/upload',
      'file:///tmp/x.png',
      'image/png',
      { uploadFile },
      { signal: outer.signal },
    )).rejects.toThrow('附件上传已取消。');
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it('deletes the staged OSS object when an uploaded attachment is discarded before send', async () => {
    const apiFetch = vi.fn(async () => ({ deleted: true }));
    const path = buildAttachmentOssRef({ ossKey: 'cindy/device-link/user-1/photo.png', mimeType: 'image/png' });

    discardMobileUploadedAttachment({ path }, {
      getToken: async () => 'token-1',
      deps: { apiFetch: apiFetch as unknown as typeof apiFetchRaw },
    });
    await vi.waitFor(() => expect(apiFetch).toHaveBeenCalled());

    expect(apiFetch).toHaveBeenCalledWith('/api/device-link/media', {
      baseUrl: DEVICE_LINK_API_BASE_URL,
      method: 'DELETE',
      token: 'token-1',
      body: { key: 'cindy/device-link/user-1/photo.png' },
    });
  });

  it('does not call the media DELETE endpoint for non-OSS attachments or when delete fails', async () => {
    // 远端路径附件没有中转对象:不发 DELETE。
    const apiFetch = vi.fn(async () => ({ deleted: true }));
    discardMobileUploadedAttachment({ path: '/Users/me/docs/spec.pdf' }, {
      getToken: async () => 'token-1',
      deps: { apiFetch: apiFetch as unknown as typeof apiFetchRaw },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(apiFetch).not.toHaveBeenCalled();

    // best-effort:DELETE 失败静默,不向上抛(unhandled rejection 会让本用例失败)。
    const failingFetch = vi.fn(async () => {
      throw new Error('network down');
    });
    const path = buildAttachmentOssRef({
      ossKey: 'cindy/device-link/user-1/photo.png',
    });
    discardMobileUploadedAttachment(
      { path },
      {
        getToken: async () => 'token-1',
        deps: { apiFetch: failingFetch as unknown as typeof apiFetchRaw },
      },
    );
    await vi.waitFor(() => expect(failingFetch).toHaveBeenCalled());
  });
});
