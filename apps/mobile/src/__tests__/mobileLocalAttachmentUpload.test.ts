import { beforeAll, describe, expect, it, vi } from 'vitest';
import { i18n } from '@/i18n';
import {
  createMobileLocalAttachmentUploadController,
  isCameraUnavailableOnSimulator,
  type MobileLocalAttachmentUploadCandidate,
  type MobileLocalAttachmentUploadDeps,
  type PendingLocalAttachmentUpload,
} from '@/session/mobileLocalAttachmentUpload';
import type { RemoteSerializedAttachment } from '@/session/types';

// 文案已 i18n 化;固定 zh-CN 让字面量断言与语言环境解耦(全局 mock 默认 en-US)。
beforeAll(async () => {
  await i18n.changeLanguage('zh-CN');
});

function candidate(name: string, kind: 'image' | 'file' = 'image'): MobileLocalAttachmentUploadCandidate {
  return {
    kind,
    uri: `file:///tmp/${name}`,
    name,
    mimeType: kind === 'image' ? 'image/jpeg' : 'application/pdf',
    size: 1_000_000,
    ...(kind === 'image' ? { width: 4000, height: 3000 } : {}),
  };
}

function attachmentFor(name: string): RemoteSerializedAttachment {
  return {
    id: `mobile-upload:key/${name}`,
    name,
    path: `cindy-oss-attach://key/${name}`,
    ext: '.jpg',
    size: 500_000,
    category: 'image',
    mimeType: 'image/jpeg',
  };
}

/** 可手动放行的上传闸门:模拟 in-flight 上传。 */
function gatedUpload() {
  const gates = new Map<string, { resolve: () => void; reject: (err: Error) => void }>();
  const upload: MobileLocalAttachmentUploadDeps['upload'] = (c) => new Promise((resolve, reject) => {
    gates.set(c.name, {
      resolve: () => resolve(attachmentFor(c.name)),
      reject: (err) => reject(err),
    });
  });
  return {
    upload,
    release: (name: string) => { gates.get(name)?.resolve(); gates.delete(name); },
    fail: (name: string, err = new Error(`upload failed: ${name}`)) => { gates.get(name)?.reject(err); gates.delete(name); },
    inFlight: () => [...gates.keys()],
  };
}

function makeDeps(overrides: Partial<MobileLocalAttachmentUploadDeps> = {}) {
  const pendingSnapshots: PendingLocalAttachmentUpload[][] = [];
  const uploaded: Array<{
    attachment: RemoteSerializedAttachment;
    candidate: MobileLocalAttachmentUploadCandidate;
    uploadedUri: string;
  }> = [];
  const failed: unknown[] = [];
  const discarded: RemoteSerializedAttachment[] = [];
  const preprocessCalls: string[] = [];
  const deps: MobileLocalAttachmentUploadDeps = {
    preprocess: (input) => {
      preprocessCalls.push(input.name);
      return Promise.resolve({ uri: input.uri, name: input.name, mimeType: input.mimeType, size: input.size });
    },
    statSize: () => Promise.resolve(1_000_000),
    assertSize: () => {},
    upload: (c) => Promise.resolve(attachmentFor(c.name)),
    discard: (attachment) => { discarded.push(attachment); },
    onPendingChange: (pending) => { pendingSnapshots.push([...pending]); },
    onUploaded: (attachment, cand, uploadedUri) => { uploaded.push({ attachment, candidate: cand, uploadedUri }); },
    onFailed: (err) => { failed.push(err); },
    ...overrides,
  };
  return { deps, pendingSnapshots, uploaded, failed, discarded, preprocessCalls };
}

const flush = () => new Promise((resolve) => { setTimeout(resolve, 0); });

describe('isCameraUnavailableOnSimulator', () => {
  it('iOS 模拟器沙盒路径(含 /CoreSimulator/)→ 拦截;真机路径 / Android → 放行', () => {
    expect(isCameraUnavailableOnSimulator(
      'ios',
      'file:///Users/alice/Library/Developer/CoreSimulator/Devices/AAAA/data/Containers/Data/Application/BBBB/Documents/',
    )).toBe(true);
    expect(isCameraUnavailableOnSimulator(
      'ios',
      'file:///var/mobile/Containers/Data/Application/BBBB/Documents/',
    )).toBe(false);
    expect(isCameraUnavailableOnSimulator('ios', null)).toBe(false);
    expect(isCameraUnavailableOnSimulator('ios', undefined)).toBe(false);
    // Android 模拟器有虚拟相机,不拦。
    expect(isCameraUnavailableOnSimulator('android', '/data/user/0/com.xd.lizcn/files/')).toBe(false);
  });
});

describe('createMobileLocalAttachmentUploadController', () => {
  it('enqueue 后立即出现在 pending,上传成功后回调宿主并清空 pending', async () => {
    const { deps, pendingSnapshots, uploaded } = makeDeps();
    const controller = createMobileLocalAttachmentUploadController(deps);
    controller.enqueue([candidate('a.jpg')], { token: 't' });
    // 同步即入 pending(乐观托盘的关键)。
    expect(pendingSnapshots[0]).toHaveLength(1);
    expect(pendingSnapshots[0]?.[0]?.previewUri).toBe('file:///tmp/a.jpg');
    expect(pendingSnapshots[0]?.[0]?.kind).toBe('image');
    expect(controller.hasPending()).toBe(true);
    await controller.waitForIdle();
    expect(uploaded).toHaveLength(1);
    expect(uploaded[0]?.candidate.uri).toBe('file:///tmp/a.jpg');
    // preprocess 未改址(fake 原样返回)→ uploadedUri 即 candidate.uri。
    expect(uploaded[0]?.uploadedUri).toBe('file:///tmp/a.jpg');
    expect(controller.hasPending()).toBe(false);
    expect(pendingSnapshots.at(-1)).toHaveLength(0);
  });

  it('preprocess 改址(降采样产物)时 onUploaded 回传实际上传的 uploadedUri', async () => {
    const { deps, uploaded } = makeDeps({
      preprocess: (input) => Promise.resolve({
        uri: 'file:///tmp/downsampled.jpg',
        name: input.name,
        mimeType: 'image/jpeg',
        size: 200_000,
      }),
    });
    const controller = createMobileLocalAttachmentUploadController(deps);
    controller.enqueue([candidate('a.jpg')], { token: 't' });
    await controller.waitForIdle();
    expect(uploaded).toHaveLength(1);
    // candidate 保持原图(托盘预览映射用),uploadedUri 是实际 PUT 的降采样产物
    // (发送后气泡的本地缩略兜底用它)。
    expect(uploaded[0]?.candidate.uri).toBe('file:///tmp/a.jpg');
    expect(uploaded[0]?.uploadedUri).toBe('file:///tmp/downsampled.jpg');
  });

  it('resolve 型任务:onUploaded 回传就位后的 candidate(实际上传的 uri),保留 sourceId', async () => {
    const { deps, uploaded } = makeDeps();
    const controller = createMobileLocalAttachmentUploadController(deps);
    controller.enqueue([{
      ...candidate('IMG_0001.HEIC'),
      uri: 'ph://asset-1',
      sourceId: 'asset-1',
      resolve: () => Promise.resolve({ uri: 'file:///tmp/IMG_0001.jpg', name: 'IMG_0001.jpg', skipPreprocess: true }),
    }], { token: 't' });
    await controller.waitForIdle();
    expect(uploaded).toHaveLength(1);
    expect(uploaded[0]?.candidate.uri).toBe('file:///tmp/IMG_0001.jpg');
    expect(uploaded[0]?.candidate.name).toBe('IMG_0001.jpg');
    expect(uploaded[0]?.candidate.sourceId).toBe('asset-1');
    expect(uploaded[0]?.candidate.kind).toBe('image');
  });

  it('token 等待 / 资产就位期间被 X 掉的任务在发起 PUT 前短路,不产生需要回收的 OSS 对象', async () => {
    const uploadSpy = vi.fn(async (c: { name: string }) => attachmentFor(c.name));
    const { deps, pendingSnapshots, discarded, failed } = makeDeps({ upload: uploadSpy });
    const controller = createMobileLocalAttachmentUploadController(deps);

    // 场景 1:token 还在网络 refresh 时取消 → 检查点 1 短路,换址/降采样/PUT 全部不发生。
    let releaseToken!: (token: string | null) => void;
    const tokenPromise = new Promise<string | null>((resolve) => { releaseToken = resolve; });
    controller.enqueue([candidate('cancel-in-token-wait.jpg')], { token: tokenPromise });
    controller.remove(pendingSnapshots.at(-1)![0]!.localId);
    releaseToken('t');
    await controller.waitForIdle();
    await flush();
    expect(uploadSpy).not.toHaveBeenCalled();

    // 场景 2:相册换址 / HEIC 转码(resolve 钩子)期间取消 → 检查点 2 在 PUT 前短路。
    let releaseResolve!: () => void;
    const resolveGate = new Promise<void>((resolve) => { releaseResolve = resolve; });
    controller.enqueue([{
      ...candidate('cancel-in-resolve.jpg'),
      resolve: async () => {
        await resolveGate;
        return { uri: 'file:///tmp/resolved.jpg', skipPreprocess: true };
      },
    }], { token: 't' });
    await flush();
    controller.remove(pendingSnapshots.at(-1)![0]!.localId);
    releaseResolve();
    await controller.waitForIdle();
    await flush();
    expect(uploadSpy).not.toHaveBeenCalled();
    // 两个场景都没有已上传对象,自然也没有回收动作;取消的任务不算失败。
    expect(discarded).toHaveLength(0);
    expect(failed).toHaveLength(0);
  });

  it('X 掉 in-flight 任务立即解除 waitForIdle 的既有等待,不陪被取消的上传等到超时', async () => {
    const gate = gatedUpload();
    const { deps, pendingSnapshots, uploaded, discarded } = makeDeps({ upload: gate.upload });
    const controller = createMobileLocalAttachmentUploadController(deps);
    controller.enqueue([candidate('slow.jpg')], { token: 't' });
    await flush();
    expect(gate.inFlight()).toEqual(['slow.jpg']);

    // 先发起等待(send() 的姿势:outcome promise 已被 Promise.all 快照),再点 X。
    let idleSettled = false;
    const idle = controller.waitForIdle().then((result) => {
      idleSettled = true;
      return result;
    });
    await flush();
    expect(idleSettled).toBe(false);
    controller.remove(pendingSnapshots.at(-1)![0]!.localId);
    const { failedCount } = await idle; // 不 release gate:等待必须由 remove 解除
    expect(failedCount).toBe(0);
    // 底层上传随后自行完成:照常回收,不回调宿主。
    gate.release('slow.jpg');
    await flush();
    expect(uploaded).toHaveLength(0);
    expect(discarded.map((item) => item.name)).toEqual(['slow.jpg']);
  });

  it('removeAll:排队任务即刻出队、在途任务完成后回收,controller 仍可继续 enqueue(切换电脑场景)', async () => {
    const gate = gatedUpload();
    const { deps, pendingSnapshots, uploaded, discarded } = makeDeps({ upload: gate.upload });
    const controller = createMobileLocalAttachmentUploadController(deps);
    // 并发上限 2:a/b 在途,c 排队。
    controller.enqueue([candidate('a.jpg'), candidate('b.jpg'), candidate('c.jpg')], { token: 't' });
    await flush();
    expect(gate.inFlight()).toEqual(['a.jpg', 'b.jpg']);

    controller.removeAll();
    // 托盘立即清空,排队中的 c 不再开跑。
    expect(pendingSnapshots.at(-1)).toHaveLength(0);
    expect(controller.hasPending()).toBe(false);
    // 在途的 a/b 完成后走回收,不回调 onUploaded(不混进新电脑草稿)。
    gate.release('a.jpg');
    gate.release('b.jpg');
    await controller.waitForIdle();
    await flush();
    expect(uploaded).toHaveLength(0);
    expect(discarded.map((item) => item.name)).toEqual(['a.jpg', 'b.jpg']);
    expect(gate.inFlight()).toEqual([]);

    // 与 dispose 不同:removeAll 后 controller 继续可用,新批次照常上传。
    controller.enqueue([candidate('d.jpg')], { token: 't' });
    await flush();
    gate.release('d.jpg');
    await controller.waitForIdle();
    expect(uploaded.map((item) => item.attachment.name)).toEqual(['d.jpg']);
  });

  it('token 传 Promise:同步即入 pending,任务等 token 就位后用它上传(粘贴抢发窗口修复)', async () => {
    const tokens: string[] = [];
    const { deps, pendingSnapshots, uploaded } = makeDeps({
      upload: (c, _uri, opts) => {
        tokens.push(opts.token);
        return Promise.resolve(attachmentFor(c.name));
      },
    });
    const controller = createMobileLocalAttachmentUploadController(deps);
    let releaseToken!: (token: string | null) => void;
    const tokenPromise = new Promise<string | null>((resolve) => { releaseToken = resolve; });
    controller.enqueue([candidate('pasted.jpg')], { token: tokenPromise });
    // token 还在网络 refresh:任务已同步可见——此刻 send() 的 waitForIdle 不会空转放行。
    expect(pendingSnapshots[0]).toHaveLength(1);
    expect(controller.hasPending()).toBe(true);
    await flush();
    expect(uploaded).toHaveLength(0);
    releaseToken('fresh-token');
    const { failedCount } = await controller.waitForIdle();
    expect(failedCount).toBe(0);
    expect(uploaded).toHaveLength(1);
    expect(tokens).toEqual(['fresh-token']);
  });

  it('token Promise 落定为 null(登录过期):任务失败并计入 waitForIdle,报对应文案', async () => {
    const { deps, failed } = makeDeps();
    const controller = createMobileLocalAttachmentUploadController(deps);
    controller.enqueue([
      candidate('a.jpg', 'image'),
      candidate('doc.pdf', 'file'),
    ], { token: Promise.resolve(null) });
    const { failedCount } = await controller.waitForIdle();
    expect(failedCount).toBe(2);
    expect(failed.map((err) => (err as Error).message)).toEqual([
      '登录已过期，请重新登录后再上传图片。',
      '登录已过期，请重新登录后再上传附件。',
    ]);
  });

  it('token Promise reject(refresh 网络错):错误经 onFailed 上抛,不吞成 unhandled rejection', async () => {
    const { deps, failed } = makeDeps();
    const controller = createMobileLocalAttachmentUploadController(deps);
    controller.enqueue([candidate('a.jpg')], { token: Promise.reject(new Error('network down')) });
    const { failedCount } = await controller.waitForIdle();
    expect(failedCount).toBe(1);
    expect((failed[0] as Error).message).toBe('network down');
  });

  it('file 类任务跳过 preprocess 直传;image 类走 preprocess', async () => {
    const { deps, uploaded, preprocessCalls } = makeDeps();
    const controller = createMobileLocalAttachmentUploadController(deps);
    controller.enqueue([candidate('doc.pdf', 'file'), candidate('a.jpg', 'image')], { token: 't' });
    await controller.waitForIdle();
    expect(preprocessCalls).toEqual(['a.jpg']);
    expect(uploaded.map((u) => u.candidate.kind).sort()).toEqual(['file', 'image']);
  });

  it('pending 快照携带 kind / size(文件 chip 显示「名称 · 大小」用)', () => {
    const gate = gatedUpload();
    const { deps, pendingSnapshots } = makeDeps({ upload: gate.upload });
    const controller = createMobileLocalAttachmentUploadController(deps);
    controller.enqueue([candidate('doc.pdf', 'file')], { token: 't' });
    expect(pendingSnapshots[0]?.[0]).toMatchObject({ kind: 'file', name: 'doc.pdf', size: 1_000_000 });
    controller.dispose();
  });

  it('并发上限 2:第三个要等前面完成后才开跑', async () => {
    const gate = gatedUpload();
    const { deps } = makeDeps({ upload: gate.upload });
    const controller = createMobileLocalAttachmentUploadController(deps);
    controller.enqueue([candidate('a.jpg'), candidate('b.jpg'), candidate('c.jpg')], { token: 't' });
    await flush();
    expect(gate.inFlight()).toEqual(['a.jpg', 'b.jpg']);
    gate.release('a.jpg');
    await flush();
    expect(gate.inFlight()).toEqual(['b.jpg', 'c.jpg']);
    gate.release('b.jpg');
    gate.release('c.jpg');
    await controller.waitForIdle();
  });

  it('单个失败回调 onFailed,其余照常成功;waitForIdle 统计失败数', async () => {
    const gate = gatedUpload();
    const { deps, uploaded, failed } = makeDeps({ upload: gate.upload });
    const controller = createMobileLocalAttachmentUploadController(deps);
    controller.enqueue([candidate('a.jpg'), candidate('b.jpg')], { token: 't' });
    await flush();
    gate.fail('a.jpg');
    gate.release('b.jpg');
    const { failedCount } = await controller.waitForIdle();
    expect(failedCount).toBe(1);
    expect(failed).toHaveLength(1);
    expect(uploaded.map((u) => u.attachment.name)).toEqual(['b.jpg']);
  });

  it('remove 排队中的任务:直接出队,无回调无回收', async () => {
    const gate = gatedUpload();
    const { deps, pendingSnapshots, discarded, uploaded } = makeDeps({ upload: gate.upload });
    const controller = createMobileLocalAttachmentUploadController(deps);
    controller.enqueue([candidate('a.jpg'), candidate('b.jpg'), candidate('c.jpg')], { token: 't' });
    await flush();
    const queuedId = pendingSnapshots[0]?.[2]?.localId;
    expect(queuedId).toBeTruthy();
    controller.remove(queuedId!);
    gate.release('a.jpg');
    gate.release('b.jpg');
    const { failedCount } = await controller.waitForIdle();
    expect(failedCount).toBe(0);
    expect(discarded).toHaveLength(0);
    expect(uploaded).toHaveLength(2);
  });

  it('remove in-flight 任务:立即从 pending 消失,完成后回收 OSS 对象且不回调宿主', async () => {
    const gate = gatedUpload();
    const { deps, pendingSnapshots, discarded, uploaded, failed } = makeDeps({ upload: gate.upload });
    const controller = createMobileLocalAttachmentUploadController(deps);
    controller.enqueue([candidate('a.jpg')], { token: 't' });
    await flush();
    const localId = pendingSnapshots[0]?.[0]?.localId;
    controller.remove(localId!);
    expect(pendingSnapshots.at(-1)).toHaveLength(0);
    expect(controller.hasPending()).toBe(false);
    gate.release('a.jpg');
    const { failedCount } = await controller.waitForIdle();
    expect(failedCount).toBe(0);
    expect(uploaded).toHaveLength(0);
    expect(failed).toHaveLength(0);
    expect(discarded.map((a) => a.name)).toEqual(['a.jpg']);
  });

  it('remove in-flight 后 waitForIdle 立即落定,不等被丢弃的上传跑完', async () => {
    const gate = gatedUpload();
    const { deps, pendingSnapshots, discarded } = makeDeps({ upload: gate.upload });
    const controller = createMobileLocalAttachmentUploadController(deps);
    controller.enqueue([candidate('a.jpg')], { token: 't' });
    await flush();
    controller.remove(pendingSnapshots[0]![0]!.localId);
    // 闸门未放行(上传仍在途),waitForIdle 必须已经不等它。
    const { failedCount } = await controller.waitForIdle();
    expect(failedCount).toBe(0);
    expect(gate.inFlight()).toEqual(['a.jpg']);
    // 收尾放行,确认回收仍然发生。
    gate.release('a.jpg');
    await flush();
    expect(discarded.map((a) => a.name)).toEqual(['a.jpg']);
  });

  it('remove in-flight 且上传最终失败:静默,不回调 onFailed', async () => {
    const gate = gatedUpload();
    const { deps, pendingSnapshots, failed, discarded } = makeDeps({ upload: gate.upload });
    const controller = createMobileLocalAttachmentUploadController(deps);
    controller.enqueue([candidate('a.jpg')], { token: 't' });
    await flush();
    controller.remove(pendingSnapshots[0]![0]!.localId);
    gate.fail('a.jpg');
    const { failedCount } = await controller.waitForIdle();
    expect(failedCount).toBe(0);
    expect(failed).toHaveLength(0);
    expect(discarded).toHaveLength(0);
  });

  it('assertSize 抛错走失败路径(超限附件不上传),并能按 kind 区分', async () => {
    const asserted: Array<{ size: number; kind: string }> = [];
    const { deps, failed } = makeDeps({
      assertSize: (size, cand) => {
        asserted.push({ size, kind: cand.kind });
        throw new Error('超过 30 MB');
      },
    });
    const upload = vi.fn();
    deps.upload = upload;
    const controller = createMobileLocalAttachmentUploadController(deps);
    controller.enqueue([candidate('doc.pdf', 'file')], { token: 't' });
    const { failedCount } = await controller.waitForIdle();
    expect(failedCount).toBe(1);
    expect(failed).toHaveLength(1);
    expect(asserted).toEqual([{ size: 1_000_000, kind: 'file' }]);
    expect(upload).not.toHaveBeenCalled();
  });

  it('waitForIdle 覆盖等待期间新入队的任务', async () => {
    const gate = gatedUpload();
    const { deps, uploaded } = makeDeps({ upload: gate.upload });
    const controller = createMobileLocalAttachmentUploadController(deps);
    controller.enqueue([candidate('a.jpg')], { token: 't' });
    await flush();
    const idle = controller.waitForIdle();
    controller.enqueue([candidate('b.jpg')], { token: 't' });
    await flush();
    gate.release('a.jpg');
    await flush();
    gate.release('b.jpg');
    await idle;
    expect(uploaded).toHaveLength(2);
  });

  it('dispose:in-flight 完成后回收,不再回调宿主;之后 enqueue 无效', async () => {
    const gate = gatedUpload();
    const { deps, pendingSnapshots, uploaded, discarded } = makeDeps({ upload: gate.upload });
    const controller = createMobileLocalAttachmentUploadController(deps);
    controller.enqueue([candidate('a.jpg')], { token: 't' });
    await flush();
    controller.dispose();
    gate.release('a.jpg');
    await controller.waitForIdle();
    expect(uploaded).toHaveLength(0);
    expect(discarded.map((a) => a.name)).toEqual(['a.jpg']);
    const snapshotCount = pendingSnapshots.length;
    controller.enqueue([candidate('b.jpg')], { token: 't' });
    expect(pendingSnapshots.length).toBe(snapshotCount);
  });
});

describe('pendingCount(附件槽位校验的同步真源,review P1)', () => {
  it('enqueue 后同步可见(不等 React state commit),完成 / 移除 / 丢弃后同步递减', async () => {
    const gate = gatedUpload();
    const { deps } = makeDeps({ upload: gate.upload });
    const controller = createMobileLocalAttachmentUploadController(deps);

    // 入队的同一同步 tick 内即计入:标注信箱串行 drain 的下一条提交在
    // microtask 恢复后立刻读取,必须已含前一条。
    controller.enqueue([candidate('a.jpg'), candidate('b.jpg')], { token: 'tok' });
    expect(controller.pendingCount()).toBe(2);

    // 被 X 掉(in-flight 标 discarded)立即不再计入。
    await flush();
    const pendingIds = [...gate.inFlight()];
    expect(pendingIds).toHaveLength(2);
    controller.remove('local-attachment-upload-1');
    expect(controller.pendingCount()).toBe(1);

    // 上传完成后归零。
    gate.release('a.jpg');
    gate.release('b.jpg');
    await flush();
    expect(controller.pendingCount()).toBe(0);
  });
});

describe('failed-state retry(弱网失败卡保留与重试)', () => {
  it('上传失败:卡片保留为 failed 态而不是从托盘消失,waitForIdle 计入失败', async () => {
    const { deps, pendingSnapshots, failed } = makeDeps({
      upload: () => Promise.reject(new Error('network down')),
    });
    const controller = createMobileLocalAttachmentUploadController(deps);
    controller.enqueue([candidate('a.jpg')], { token: 't' });
    const idle = await controller.waitForIdle();
    expect(idle.failedCount).toBe(1);
    expect(failed).toHaveLength(1);
    // 失败卡还在托盘(failed 标),没有静默消失
    const last = pendingSnapshots.at(-1);
    expect(last).toHaveLength(1);
    expect(last?.[0]?.failed).toBe(true);
    expect(controller.hasPending()).toBe(true);
    expect(controller.pendingCount()).toBe(1); // 仍占附件槽位
  });

  it('retry:失败卡重新入队跑完整管线,成功后转正、托盘清空', async () => {
    let attempts = 0;
    const { deps, pendingSnapshots, uploaded } = makeDeps({
      upload: (c) => {
        attempts += 1;
        return attempts === 1
          ? Promise.reject(new Error('network down'))
          : Promise.resolve(attachmentFor(c.name));
      },
    });
    const controller = createMobileLocalAttachmentUploadController(deps);
    controller.enqueue([candidate('a.jpg')], { token: 't' });
    await controller.waitForIdle();
    const failedCard = pendingSnapshots.at(-1)?.[0];
    expect(failedCard?.failed).toBe(true);

    controller.retry(failedCard!.localId, { token: 't2' });
    // 重试立即回到上传中(failed 标清除)
    expect(pendingSnapshots.at(-1)?.[0]?.failed).toBeUndefined();
    const idle = await controller.waitForIdle();
    expect(idle.failedCount).toBe(0);
    expect(uploaded).toHaveLength(1);
    expect(pendingSnapshots.at(-1)).toHaveLength(0);
  });

  it('remove 失败卡:直接出队,不再计失败', async () => {
    const { deps, pendingSnapshots } = makeDeps({
      upload: () => Promise.reject(new Error('network down')),
    });
    const controller = createMobileLocalAttachmentUploadController(deps);
    controller.enqueue([candidate('a.jpg')], { token: 't' });
    await controller.waitForIdle();
    const failedCard = pendingSnapshots.at(-1)?.[0];
    controller.remove(failedCard!.localId);
    expect(controller.hasPending()).toBe(false);
    await expect(controller.waitForIdle()).resolves.toEqual({ failedCount: 0 });
  });

  it('retry 对非失败态任务 no-op;removeAll 连失败卡一起清', async () => {
    const gate = gatedUpload();
    const { deps } = makeDeps({ upload: gate.upload });
    const controller = createMobileLocalAttachmentUploadController(deps);
    controller.enqueue([candidate('a.jpg')], { token: 't' });
    await flush();
    // in-flight 任务 retry 应 no-op(不重置状态、不重复入队)
    controller.retry('local-attachment-upload-1', { token: 't2' });
    expect(controller.pendingCount()).toBe(1);
    gate.fail('a.jpg');
    await controller.waitForIdle();
    expect(controller.pendingCount()).toBe(1); // 失败卡
    controller.removeAll();
    expect(controller.hasPending()).toBe(false);
  });

  it('失败卡不阻塞后续新任务的上传(不占并发位)', async () => {
    let calls = 0;
    const { deps, uploaded } = makeDeps({
      upload: (c) => {
        calls += 1;
        return calls === 1
          ? Promise.reject(new Error('network down'))
          : Promise.resolve(attachmentFor(c.name));
      },
    });
    const controller = createMobileLocalAttachmentUploadController(deps);
    controller.enqueue([candidate('a.jpg')], { token: 't' });
    await controller.waitForIdle();
    controller.enqueue([candidate('b.jpg'), candidate('c.jpg')], { token: 't' });
    const idle = await controller.waitForIdle();
    expect(uploaded.map((u) => u.attachment.name).sort()).toEqual(['b.jpg', 'c.jpg']);
    expect(idle.failedCount).toBe(1); // a.jpg 的失败卡仍在
  });
});

describe('claim(划归乐观消息)', () => {
  it('claim 后任务离开托盘 / 限额 / waitForIdle,产物仍带 localId 回调', async () => {
    const gate = gatedUpload();
    const { deps, pendingSnapshots, uploaded } = makeDeps({ upload: gate.upload });
    const uploadedIds: string[] = [];
    deps.onUploaded = (attachment, cand, uploadedUri, localId) => {
      uploaded.push({ attachment, candidate: cand, uploadedUri });
      uploadedIds.push(localId);
    };
    const controller = createMobileLocalAttachmentUploadController(deps);
    controller.enqueue([candidate('a.jpg')], { token: 't' });
    await flush();
    const claimable = controller.claimableTasks();
    expect(claimable).toEqual([{
      localId: 'local-attachment-upload-1',
      failed: false,
      kind: 'image',
      previewUri: 'file:///tmp/a.jpg',
    }]);
    controller.claim(claimable.map((task) => task.localId));
    // 托盘同步清空,限额与发送等待不再计入。
    expect(pendingSnapshots.at(-1)).toHaveLength(0);
    expect(controller.pendingCount()).toBe(0);
    expect(controller.hasPending()).toBe(false);
    const idle = await controller.waitForIdle();
    expect(idle.failedCount).toBe(0);
    // 任务本身照跑,完成后带 localId 回调。
    gate.release('a.jpg');
    await flush();
    expect(uploaded).toHaveLength(1);
    expect(uploadedIds).toEqual(['local-attachment-upload-1']);
  });

  it('claimed 失败卡不计入 waitForIdle failedCount,retry 对其仍有效', async () => {
    const gate = gatedUpload();
    const failedIds: string[] = [];
    const { deps, uploaded } = makeDeps({ upload: gate.upload });
    deps.onFailed = (_err, localId) => { failedIds.push(localId); };
    const controller = createMobileLocalAttachmentUploadController(deps);
    controller.enqueue([candidate('a.jpg')], { token: 't' });
    await flush();
    controller.claim(['local-attachment-upload-1']);
    gate.fail('a.jpg');
    await flush();
    expect(failedIds).toEqual(['local-attachment-upload-1']);
    // composer 域的发送等待不受 claimed 失败卡影响。
    const idle = await controller.waitForIdle();
    expect(idle.failedCount).toBe(0);
    expect(controller.claimableTasks()).toEqual([]);
    // outbox 条目重试:同一 localId 重跑完整管线。
    controller.retry('local-attachment-upload-1', { token: 't2' });
    await flush();
    gate.release('a.jpg');
    await flush();
    expect(uploaded).toHaveLength(1);
  });

  it('claim 未知 / 已丢弃任务是安全 no-op', () => {
    const { deps } = makeDeps();
    const controller = createMobileLocalAttachmentUploadController(deps);
    expect(() => controller.claim(['nope'])).not.toThrow();
    expect(controller.claimableTasks()).toEqual([]);
  });

  it('unclaim 把在途任务交还托盘:继续跑、重回限额、产物回落 composer', async () => {
    // 创建失败把待发消息交还输入框时走这条路:取消重传是错的(用户已经等过一次上传,
    // 粘贴来源的本地文件此时可能已被回收,连重选都做不到,review P1)。
    const gate = gatedUpload();
    const { deps, pendingSnapshots, uploaded, discarded } = makeDeps({ upload: gate.upload });
    const controller = createMobileLocalAttachmentUploadController(deps);
    controller.enqueue([candidate('a.jpg')], { token: 't' });
    await flush();
    controller.claim(['local-attachment-upload-1']);
    expect(controller.pendingCount()).toBe(0);

    controller.unclaim(['local-attachment-upload-1']);
    // 回到托盘:重新出现在 pending 列表、重新占限额、waitForIdle 重新等它。
    expect(pendingSnapshots.at(-1)?.map((item) => item.localId)).toEqual(['local-attachment-upload-1']);
    expect(controller.pendingCount()).toBe(1);
    expect(controller.claimableTasks().map((task) => task.localId)).toEqual(['local-attachment-upload-1']);
    // 上传没有被取消:放行后照常产出,且中转对象没有被回收。
    gate.release('a.jpg');
    await flush();
    expect(uploaded).toHaveLength(1);
    expect(discarded).toEqual([]);
  });

  it('unclaim 把失败卡交还托盘(可重试),对未 claim / 未知任务是 no-op', async () => {
    const gate = gatedUpload();
    const { deps, pendingSnapshots } = makeDeps({ upload: gate.upload });
    const controller = createMobileLocalAttachmentUploadController(deps);
    controller.enqueue([candidate('a.jpg')], { token: 't' });
    await flush();
    controller.claim(['local-attachment-upload-1']);
    gate.fail('a.jpg');
    await flush();
    expect(controller.claimableTasks()).toEqual([]);

    controller.unclaim(['local-attachment-upload-1']);
    // 失败卡回到托盘,带 failed 标(渲染成可 retry / X 的卡)。
    expect(pendingSnapshots.at(-1)?.map((item) => ({ id: item.localId, failed: item.failed })))
      .toEqual([{ id: 'local-attachment-upload-1', failed: true }]);
    expect(controller.claimableTasks()).toEqual([{
      localId: 'local-attachment-upload-1',
      failed: true,
      kind: 'image',
      previewUri: 'file:///tmp/a.jpg',
    }]);

    const snapshotCount = pendingSnapshots.length;
    expect(() => controller.unclaim(['local-attachment-upload-1', 'nope'])).not.toThrow();
    // 已在托盘 / 不存在的任务不产生多余通知。
    expect(pendingSnapshots).toHaveLength(snapshotCount);
  });

  it('removeAll 只丢 composer 域任务,claimed 任务照跑并回调(排队编辑退出不打断已发消息)', async () => {
    const gate = gatedUpload();
    const uploadedIds: string[] = [];
    const { deps } = makeDeps({ upload: gate.upload });
    deps.onUploaded = (_attachment, _cand, _uri, localId) => { uploadedIds.push(localId); };
    const controller = createMobileLocalAttachmentUploadController(deps);
    controller.enqueue([candidate('claimed.jpg'), candidate('tray.jpg')], { token: 't' });
    await flush();
    controller.claim(['local-attachment-upload-1']);
    controller.removeAll();
    // composer 域任务被丢弃,claimed 任务仍在跑。
    expect(controller.hasPending()).toBe(false);
    gate.release('claimed.jpg');
    gate.release('tray.jpg');
    await flush();
    expect(uploadedIds).toEqual(['local-attachment-upload-1']);
  });
});

describe('in-flight 取消(abort 传递)', () => {
  it('remove in-flight 任务时 upload 收到已中止的 signal', async () => {
    let seenSignal: AbortSignal | undefined;
    const gate = gatedUpload();
    const { deps } = makeDeps({
      upload: (c, fileUri, opts) => {
        seenSignal = opts.signal;
        return gate.upload(c, fileUri, opts);
      },
    });
    const controller = createMobileLocalAttachmentUploadController(deps);
    controller.enqueue([candidate('a.jpg')], { token: 't' });
    await flush();
    expect(seenSignal?.aborted).toBe(false);
    controller.remove('local-attachment-upload-1');
    expect(seenSignal?.aborted).toBe(true);
    // 被 abort 的传输随后 reject:任务应结算为 discarded(不产生失败回调)。
    gate.fail('a.jpg', new Error('附件上传已取消。'));
    const idle = await controller.waitForIdle();
    expect(idle.failedCount).toBe(0);
  });

  it('removeAll 与 dispose 同样中止 in-flight 传输', async () => {
    const signals: AbortSignal[] = [];
    const gate = gatedUpload();
    const { deps } = makeDeps({
      upload: (c, fileUri, opts) => {
        if (opts.signal) signals.push(opts.signal);
        return gate.upload(c, fileUri, opts);
      },
    });
    const controller = createMobileLocalAttachmentUploadController(deps);
    controller.enqueue([candidate('a.jpg'), candidate('b.jpg')], { token: 't' });
    await flush();
    expect(signals).toHaveLength(2);
    controller.removeAll();
    expect(signals.every((signal) => signal.aborted)).toBe(true);

    const gate2 = gatedUpload();
    const signals2: AbortSignal[] = [];
    const second = makeDeps({
      upload: (c, fileUri, opts) => {
        if (opts.signal) signals2.push(opts.signal);
        return gate2.upload(c, fileUri, opts);
      },
    });
    const controller2 = createMobileLocalAttachmentUploadController(second.deps);
    controller2.enqueue([candidate('c.jpg')], { token: 't' });
    await flush();
    controller2.dispose();
    expect(signals2[0]?.aborted).toBe(true);
  });

  it('retry 换新 abort 通道:上一轮超时的 aborted signal 不影响重试', async () => {
    const signals: AbortSignal[] = [];
    let calls = 0;
    const { deps, uploaded } = makeDeps({
      upload: (c, _fileUri, opts) => {
        if (opts.signal) signals.push(opts.signal);
        calls += 1;
        return calls === 1
          ? Promise.reject(new Error('附件上传超时,请检查网络后重试。'))
          : Promise.resolve(attachmentFor(c.name));
      },
    });
    const controller = createMobileLocalAttachmentUploadController(deps);
    controller.enqueue([candidate('a.jpg')], { token: 't' });
    await controller.waitForIdle();
    controller.retry('local-attachment-upload-1', { token: 't2' });
    await controller.waitForIdle();
    expect(uploaded).toHaveLength(1);
    expect(signals).toHaveLength(2);
    expect(signals[0]).not.toBe(signals[1]);
  });
});
