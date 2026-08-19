import { describe, expect, it } from 'vitest';

import {
  GHOST_EXTERNAL_LINK_MIN_INTERVAL_MS,
  GHOST_PREVIEW_MIN_INTERVAL_MS,
  GhostExternalLinkGate,
  GhostPreviewGate,
  classifyGhostPanelNavigation,
  parseGhostMediaHandoverUrl,
  parseGhostPanelMediaUrl,
  parseGhostPreviewUrl,
  resolveGhostPanelMedia,
  type GhostPreviewGateDeps,
} from '../previewGate';

const HASH = 'a'.repeat(64);
const URL_OK = `cindy-ghost://art/preview/${HASH}.png`;

describe('classifyGhostPanelNavigation', () => {
  it('自己协议下的普通页面放行', () => {
    expect(classifyGhostPanelNavigation('cindy-ghost://art/panel.html', 'art')).toBe('allow');
  });

  it('/preview/ 路径识别为预览请求', () => {
    expect(classifyGhostPanelNavigation(URL_OK, 'art')).toBe('preview');
  });

  it('https 外部地址分类为 external(白名单判定在外链闸内,不在分类层)', () => {
    expect(classifyGhostPanelNavigation('https://evil.example/', 'art')).toBe('external');
    expect(classifyGhostPanelNavigation('https://api-dashboard.search.brave.com/app/keys', 'art')).toBe('external');
  });

  it('非 https 外部地址 / 别的意识 / 畸形 URL 一律 block', () => {
    expect(classifyGhostPanelNavigation('http://evil.example/', 'art')).toBe('block');
    expect(classifyGhostPanelNavigation('file:///etc/passwd', 'art')).toBe('block');
    expect(classifyGhostPanelNavigation(`cindy-ghost://other/preview/${HASH}.png`, 'art')).toBe('block');
    expect(classifyGhostPanelNavigation('not-a-url', 'art')).toBe('block');
  });
});

describe('GhostExternalLinkGate(设置区/面板「前往控制台」外链闸)', () => {
  const DECLARED = 'https://example.com/settings/keys';
  const makeGate = (opts?: { urls?: string[] | null; now?: () => number }) =>
    new GhostExternalLinkGate({
      declaredExternalUrls: (ghostId) => {
        if (ghostId !== 'art') return null;
        return opts && 'urls' in opts ? (opts.urls ?? null) : [DECLARED];
      },
      now: opts?.now,
    });
  const focused = () => true;

  it('身份卡声明过的地址 + 持焦点 → 直接打开原样 URL', () => {
    expect(makeGate().request({ ghostId: 'art', url: DECLARED, isPanelFocused: focused })).toEqual({
      action: 'direct-open',
      url: DECLARED,
    });
  });

  it.each([
    'https://xd.com/',
    'https://www.xd.com/path',
    'https://deep.console.xd.com/path',
    'https://xd.cn/',
    'https://www.xd.cn/path',
    'https://deep.console.xd.cn/path',
    'https://workers.xd.team/workspace/published',
  ])('固定授信主机直接打开：%s', (url) => {
    expect(
      makeGate({ urls: [] }).request({ ghostId: 'art', url, isPanelFocused: focused }),
    ).toEqual({
      action: 'direct-open',
      url,
    });
  });

  it.each([
    'https://evilxd.com/',
    'https://xd.com.evil.com/',
    'https://notxd.cn/',
    'https://xd.cn.evil.com/',
    'https://sub.workers.xd.team/',
    'https://workers-xd.team/',
    'https://example.com/path',
  ])('近似主机或普通 HTTPS 不自动授信，而是请求确认：%s', (url) => {
    expect(
      makeGate({ urls: [] }).request({ ghostId: 'art', url, isPanelFocused: focused }),
    ).toEqual({
      action: 'confirm',
      url,
    });
  });

  it('合法 HTTPS 在判定前规范化，并仅以规范化后的 hostname 判断授信', () => {
    expect(
      makeGate({ urls: [] }).request({
        ghostId: 'art',
        url: 'https://XD.COM:443/workspace/./published',
        isPanelFocused: focused,
      }),
    ).toEqual({ action: 'direct-open', url: 'https://xd.com/workspace/published' });
  });

  it('现有声明地址仍优先逐字命中；非逐字版本作为普通 HTTPS 进入确认', () => {
    let t = 1000;
    const gate = makeGate({ now: () => t });
    expect(gate.request({ ghostId: 'art', url: DECLARED, isPanelFocused: focused })).toEqual({
      action: 'direct-open',
      url: DECLARED,
    });
    t += GHOST_EXTERNAL_LINK_MIN_INTERVAL_MS;
    expect(gate.request({ ghostId: 'art', url: `${DECLARED}/`, isPanelFocused: focused })).toEqual({
      action: 'confirm',
      url: `${DECLARED}/`,
    });
  });

  it.each([
    ['固定授信地址', 'https://workers.xd.team/workspace/published'],
    ['普通 HTTPS', 'https://example.com/workspace'],
  ])('查无此意识或已停用时拒绝%s，不保留旧 guest 的宿主能力', (_label, url) => {
    expect(
      makeGate().request({ ghostId: 'other', url, isPanelFocused: focused }),
    ).toEqual({
      action: 'reject',
      reason: 'ghost-unavailable',
    });
  });

  it('有效意识的空声明列表与不可用意识保持可区分', () => {
    expect(
      makeGate({ urls: [] }).request({
        ghostId: 'art',
        url: 'https://example.com/workspace',
        isPanelFocused: focused,
      }),
    ).toEqual({
      action: 'confirm',
      url: 'https://example.com/workspace',
    });
    expect(
      makeGate({ urls: null }).request({
        ghostId: 'art',
        url: 'https://example.com/workspace',
        isPanelFocused: focused,
      }),
    ).toEqual({
      action: 'reject',
      reason: 'ghost-unavailable',
    });
  });

  it.each([
    'http://xd.com/',
    'ftp://xd.com/',
    'file:///etc/passwd',
    'custom://xd.com/path',
    'https://user@xd.com/',
    'https://user:password@xd.com/',
    'not-a-url',
    'https://[invalid',
  ])('非 HTTPS、带凭证或畸形 URL 拒绝：%s', (url) => {
    expect(makeGate().request({ ghostId: 'art', url, isPanelFocused: focused })).toEqual({
      action: 'reject',
      reason: 'bad-url',
    });
  });

  it('不持焦点拒(后台脚本 location.href 刷不起浏览器),且不记限速账', () => {
    let t = 1000;
    const gate = makeGate({ now: () => t });
    expect(gate.request({ ghostId: 'art', url: DECLARED, isPanelFocused: () => false })).toEqual({
      action: 'reject',
      reason: 'not-focused',
    });
    // 失焦拒绝不占限速窗口:随后用户真点击立即可放行。
    t += 1;
    expect(gate.request({ ghostId: 'art', url: DECLARED, isPanelFocused: focused }).action).toBe(
      'direct-open',
    );
  });

  it('限速按尝试记账:窗口内重试被拒且顺延窗口,连续 spam 闸整体关死', () => {
    let t = 1000;
    const gate = makeGate({ now: () => t });
    expect(gate.request({ ghostId: 'art', url: DECLARED, isPanelFocused: focused }).action).toBe(
      'direct-open',
    );
    // 999ms 后重试:拒,且这次尝试本身顺延了窗口。
    t += GHOST_EXTERNAL_LINK_MIN_INTERVAL_MS - 1;
    expect(gate.request({ ghostId: 'art', url: DECLARED, isPanelFocused: focused })).toEqual({
      action: 'reject',
      reason: 'rate-limited',
    });
    // 距首次放行已 1s,但距上次「尝试」只差 1ms:仍拒(spam 关死语义)。
    t += 1;
    expect(gate.request({ ghostId: 'art', url: DECLARED, isPanelFocused: focused })).toEqual({
      action: 'reject',
      reason: 'rate-limited',
    });
    // 距上次尝试满 1s:恢复。
    t += GHOST_EXTERNAL_LINK_MIN_INTERVAL_MS;
    expect(gate.request({ ghostId: 'art', url: DECLARED, isPanelFocused: focused }).action).toBe(
      'direct-open',
    );
  });

  it('限速罩住声明比对:窗口内的垃圾导航不触发白名单查询(不给刷磁盘 IO)', () => {
    let t = 1000;
    let lookups = 0;
    const gate = new GhostExternalLinkGate({
      declaredExternalUrls: () => {
        lookups += 1;
        return [DECLARED];
      },
      now: () => t,
    });
    expect(
      gate.request({ ghostId: 'art', url: 'https://evil.example/', isPanelFocused: focused })
        .action,
    ).toBe('confirm');
    expect(lookups).toBe(1);
    // 窗口内连环垃圾导航:rate-limited 提前拦下,白名单查询一次都不该发生。
    for (let i = 0; i < 10; i += 1) {
      t += 10;
      expect(
        gate.request({ ghostId: 'art', url: 'https://evil.example/', isPanelFocused: focused }),
      ).toEqual({
        action: 'reject',
        reason: 'rate-limited',
      });
    }
    expect(lookups).toBe(1);
  });

  it('同一 ghost 确认进行中拒绝新的尝试，释放后可再次确认', () => {
    let t = 1000;
    const gate = makeGate({ urls: [], now: () => t });
    const first = gate.request({
      ghostId: 'art',
      url: 'https://example.com/first',
      isPanelFocused: focused,
    });
    expect(first).toEqual({ action: 'confirm', url: 'https://example.com/first' });
    t += GHOST_EXTERNAL_LINK_MIN_INTERVAL_MS;
    expect(
      gate.request({ ghostId: 'art', url: 'https://example.com/second', isPanelFocused: focused }),
    ).toEqual({
      action: 'reject',
      reason: 'confirmation-pending',
    });

    gate.releaseConfirmation('art');
    t += GHOST_EXTERNAL_LINK_MIN_INTERVAL_MS;
    expect(
      gate.request({ ghostId: 'art', url: 'https://example.com/second', isPanelFocused: focused }),
    ).toEqual({
      action: 'confirm',
      url: 'https://example.com/second',
    });
  });

  it('direct-open 与 reject 不占确认状态', () => {
    let t = 1000;
    const gate = makeGate({ now: () => t });
    expect(gate.request({ ghostId: 'art', url: DECLARED, isPanelFocused: focused }).action).toBe(
      'direct-open',
    );
    t += GHOST_EXTERNAL_LINK_MIN_INTERVAL_MS;
    expect(
      gate.request({ ghostId: 'art', url: 'http://example.com/', isPanelFocused: focused }),
    ).toEqual({
      action: 'reject',
      reason: 'bad-url',
    });
    t += GHOST_EXTERNAL_LINK_MIN_INTERVAL_MS;
    expect(
      gate.request({ ghostId: 'art', url: 'https://example.com/confirm', isPanelFocused: focused }),
    ).toEqual({
      action: 'confirm',
      url: 'https://example.com/confirm',
    });
  });
});

describe('parseGhostPreviewUrl', () => {
  it('合法预览链接解析出指纹与后缀', () => {
    expect(parseGhostPreviewUrl(URL_OK, 'art')).toEqual({ hash: HASH, ext: '.png' });
  });

  it('后缀大小写归一化', () => {
    expect(parseGhostPreviewUrl(`cindy-ghost://art/preview/${HASH}.PNG`, 'art')).toEqual({
      hash: HASH,
      ext: '.png',
    });
  });

  it('指纹形状不合格拒绝(长度/字符集)', () => {
    expect(parseGhostPreviewUrl(`cindy-ghost://art/preview/${'a'.repeat(63)}.png`, 'art')).toBeNull();
    expect(parseGhostPreviewUrl(`cindy-ghost://art/preview/${'Z'.repeat(64)}.png`, 'art')).toBeNull();
  });

  it('媒体后缀白名单:视频放行,非媒体后缀拒绝', () => {
    expect(parseGhostPreviewUrl(`cindy-ghost://art/preview/${HASH}.mp4`, 'art')).toEqual({
      hash: HASH,
      ext: '.mp4',
    });
    expect(parseGhostPreviewUrl(`cindy-ghost://art/preview/${HASH}.html`, 'art')).toBeNull();
  });

  it('多级路径 / query / fragment / 冒充他人 id 拒绝', () => {
    expect(parseGhostPreviewUrl(`cindy-ghost://art/preview/../${HASH}.png`, 'art')).toBeNull();
    expect(parseGhostPreviewUrl(`${URL_OK}?x=1`, 'art')).toBeNull();
    expect(parseGhostPreviewUrl(`${URL_OK}#f`, 'art')).toBeNull();
    expect(parseGhostPreviewUrl(URL_OK, 'other')).toBeNull();
  });
});

describe('parseGhostMediaHandoverUrl', () => {
  it('/media/ 与 /preview/ 两种形状都解析(拖 <a> 默认带 href = /preview/),图片视频都收', () => {
    expect(parseGhostMediaHandoverUrl(`cindy-ghost://art/media/${HASH}.png`)).toEqual({
      ghostId: 'art',
      hash: HASH,
      ext: '.png',
    });
    expect(parseGhostMediaHandoverUrl(`cindy-ghost://art/preview/${HASH}.webp`)).toEqual({
      ghostId: 'art',
      hash: HASH,
      ext: '.webp',
    });
    expect(parseGhostMediaHandoverUrl(`cindy-ghost://art/media/${HASH}.mp4`)).toEqual({
      ghostId: 'art',
      hash: HASH,
      ext: '.mp4',
    });
  });

  it('意识 id 形状不合格 / 其它路径 / 非媒体后缀 / 坏指纹一律 null', () => {
    expect(parseGhostMediaHandoverUrl(`cindy-ghost://BAD_ID/media/${HASH}.png`)).toBeNull();
    expect(parseGhostMediaHandoverUrl(`cindy-ghost://art/gallery`)).toBeNull();
    expect(parseGhostMediaHandoverUrl(`cindy-ghost://art/media/${HASH}.html`)).toBeNull();
    expect(parseGhostMediaHandoverUrl(`cindy-ghost://art/media/short.png`)).toBeNull();
    expect(parseGhostMediaHandoverUrl(`cindy-ghost://art/media/${HASH}.png?x=1`)).toBeNull();
    expect(parseGhostMediaHandoverUrl(`https://evil/${HASH}.png`)).toBeNull();
  });
});

describe('parseGhostPanelMediaUrl(右键菜单形状:图片 + 视频)', () => {
  it('图片与视频后缀都放行,/media/ 与 /preview/ 两种形状都认', () => {
    expect(parseGhostPanelMediaUrl(`cindy-ghost://art/media/${HASH}.mp4`)).toEqual({
      ghostId: 'art',
      hash: HASH,
      ext: '.mp4',
    });
    expect(parseGhostPanelMediaUrl(`cindy-ghost://art/preview/${HASH}.png`)).toEqual({
      ghostId: 'art',
      hash: HASH,
      ext: '.png',
    });
  });

  it('非媒体后缀 / 坏指纹 / 其它路径仍然 null', () => {
    expect(parseGhostPanelMediaUrl(`cindy-ghost://art/media/${HASH}.html`)).toBeNull();
    expect(parseGhostPanelMediaUrl(`cindy-ghost://art/media/short.mp4`)).toBeNull();
    expect(parseGhostPanelMediaUrl(`cindy-ghost://art/gallery`)).toBeNull();
  });
});

describe('resolveGhostPanelMedia(换发闸:attach / menu 两用途)', () => {
  const DEPS = {
    ghostCanRead: async () => true,
    getBlobInfo: async () => ({ ext: '.png', mimeType: 'image/png' }),
    blobUrl: (hash: string, ext: string) => `cindy-media://blobs/${hash}${ext}`,
    blobAbsPath: (hash: string, ext: string) => `/blobs/${hash.slice(0, 2)}/${hash}${ext}`,
    statSize: async () => 1234,
  };
  /** HASH = 'a'×64 的视频换发预期(路径引用元数据齐全)。 */
  const VIDEO_RESOLVED = {
    url: `cindy-media://blobs/${HASH}.mp4`,
    kind: 'video',
    absPath: `/blobs/aa/${HASH}.mp4`,
    size: 1234,
    name: `art-aaaaaaaa.mp4`,
    ext: '.mp4',
    mimeType: 'video/mp4',
  };

  it('menu:图片换发成功并回传 kind=image', async () => {
    await expect(
      resolveGhostPanelMedia(`cindy-ghost://art/media/${HASH}.png`, 'menu', DEPS),
    ).resolves.toEqual({ url: `cindy-media://blobs/${HASH}.png`, kind: 'image' });
  });

  it('menu:视频换发成功,回传 kind=video + 路径引用元数据', async () => {
    await expect(
      resolveGhostPanelMedia(`cindy-ghost://art/preview/${HASH}.mp4`, 'menu', {
        ...DEPS,
        getBlobInfo: async () => ({ ext: '.mp4', mimeType: 'video/mp4' }),
      }),
    ).resolves.toEqual(VIDEO_RESOLVED);
  });

  it('attach:视频同样放行(落 file 类别路径附件,不复制字节)', async () => {
    await expect(
      resolveGhostPanelMedia(`cindy-ghost://art/media/${HASH}.mp4`, 'attach', {
        ...DEPS,
        getBlobInfo: async () => ({ ext: '.mp4', mimeType: 'video/mp4' }),
      }),
    ).resolves.toEqual(VIDEO_RESOLVED);
  });

  it('attach:后缀伪装图片、账本 mime 是视频 → 按账本走视频落点(mime 以账本为准)', async () => {
    await expect(
      resolveGhostPanelMedia(`cindy-ghost://art/media/${HASH}.png`, 'attach', {
        ...DEPS,
        getBlobInfo: async () => ({ ext: '.mp4', mimeType: 'video/mp4' }),
      }),
    ).resolves.toEqual(VIDEO_RESOLVED);
  });

  it('视频:磁盘路径解析失败 / stat 失败视同查无 → null(blob 缺失不给探测面)', async () => {
    const uri = `cindy-ghost://art/media/${HASH}.mp4`;
    const videoDeps = { ...DEPS, getBlobInfo: async () => ({ ext: '.mp4', mimeType: 'video/mp4' }) };
    await expect(
      resolveGhostPanelMedia(uri, 'attach', {
        ...videoDeps,
        blobAbsPath: () => {
          throw new Error('bad ref');
        },
      }),
    ).resolves.toBeNull();
    await expect(
      resolveGhostPanelMedia(uri, 'attach', {
        ...videoDeps,
        statSize: async () => {
          throw new Error('ENOENT');
        },
      }),
    ).resolves.toBeNull();
  });

  it('归属不过 / 查无此账 / 非媒体 mime 一律 null', async () => {
    const uri = `cindy-ghost://art/media/${HASH}.png`;
    await expect(
      resolveGhostPanelMedia(uri, 'menu', { ...DEPS, ghostCanRead: async () => false }),
    ).resolves.toBeNull();
    await expect(
      resolveGhostPanelMedia(uri, 'menu', { ...DEPS, getBlobInfo: async () => null }),
    ).resolves.toBeNull();
    await expect(
      resolveGhostPanelMedia(uri, 'menu', {
        ...DEPS,
        getBlobInfo: async () => ({ ext: '.glb', mimeType: 'model/gltf-binary' }),
      }),
    ).resolves.toBeNull();
  });

  it('换发地址后缀以账本为准(URL 写 .png、账本 .webp → .webp)', async () => {
    await expect(
      resolveGhostPanelMedia(`cindy-ghost://art/media/${HASH}.png`, 'menu', {
        ...DEPS,
        getBlobInfo: async () => ({ ext: '.webp', mimeType: 'image/webp' }),
      }),
    ).resolves.toEqual({ url: `cindy-media://blobs/${HASH}.webp`, kind: 'image' });
  });
});

function makeGate(overrides?: Partial<GhostPreviewGateDeps> & { nowValue?: { t: number } }) {
  const nowValue = overrides?.nowValue ?? { t: 100_000 };
  const deps: GhostPreviewGateDeps = {
    ghostCanRead: async () => true,
    getBlobInfo: async () => ({ ext: '.png', mimeType: 'image/png' }),
    blobUrl: (hash, ext) => `cindy-media://blobs/${hash}${ext}`,
    now: () => nowValue.t,
    ...overrides,
  };
  return { gate: new GhostPreviewGate(deps), nowValue };
}

const FOCUSED = () => true;

describe('GhostPreviewGate', () => {
  it('全链路通过 → 返回主机拼装的 cindy-media 地址(kind=image)', async () => {
    const { gate } = makeGate();
    await expect(
      gate.request({ ghostId: 'art', url: URL_OK, isPanelFocused: FOCUSED }),
    ).resolves.toEqual({ ok: true, src: `cindy-media://blobs/${HASH}.png`, kind: 'image' });
  });

  it('视频产物 → 放行且 kind=video(宿主据此弹 VideoLightbox)', async () => {
    const { gate } = makeGate({ getBlobInfo: async () => ({ ext: '.mp4', mimeType: 'video/mp4' }) });
    await expect(
      gate.request({
        ghostId: 'art',
        url: `cindy-ghost://art/preview/${HASH}.mp4`,
        isPanelFocused: FOCUSED,
      }),
    ).resolves.toEqual({ ok: true, src: `cindy-media://blobs/${HASH}.mp4`, kind: 'video' });
  });

  it('面板未持焦点(脚本自动触发)拒绝', async () => {
    const { gate } = makeGate();
    await expect(
      gate.request({ ghostId: 'art', url: URL_OK, isPanelFocused: () => false }),
    ).resolves.toEqual({ ok: false, reason: 'not-focused' });
  });

  it('限速:间隔内第二次拒绝,过窗口后放行', async () => {
    const { gate, nowValue } = makeGate();
    await gate.request({ ghostId: 'art', url: URL_OK, isPanelFocused: FOCUSED });
    nowValue.t += GHOST_PREVIEW_MIN_INTERVAL_MS - 1;
    await expect(
      gate.request({ ghostId: 'art', url: URL_OK, isPanelFocused: FOCUSED }),
    ).resolves.toEqual({ ok: false, reason: 'rate-limited' });
    nowValue.t += 1;
    await expect(
      gate.request({ ghostId: 'art', url: URL_OK, isPanelFocused: FOCUSED }),
    ).resolves.toMatchObject({ ok: true });
  });

  it('限速按意识记账,互不影响', async () => {
    const { gate } = makeGate();
    await gate.request({ ghostId: 'art', url: URL_OK, isPanelFocused: FOCUSED });
    await expect(
      gate.request({
        ghostId: 'other',
        url: `cindy-ghost://other/preview/${HASH}.png`,
        isPanelFocused: FOCUSED,
      }),
    ).resolves.toMatchObject({ ok: true });
  });

  it('账本归属不过(别人的图)拒绝,且不占限速额度', async () => {
    const { gate } = makeGate({ ghostCanRead: async () => false });
    await expect(
      gate.request({ ghostId: 'art', url: URL_OK, isPanelFocused: FOCUSED }),
    ).resolves.toEqual({ ok: false, reason: 'not-owned' });
  });

  it('账本 mime 非媒体拒绝(URL 后缀伪装不算数)', async () => {
    const { gate } = makeGate({
      getBlobInfo: async () => ({ ext: '.glb', mimeType: 'model/gltf-binary' }),
    });
    await expect(
      gate.request({ ghostId: 'art', url: URL_OK, isPanelFocused: FOCUSED }),
    ).resolves.toEqual({ ok: false, reason: 'not-media' });
  });

  it('查无此账(getBlobInfo null)拒绝', async () => {
    const { gate } = makeGate({ getBlobInfo: async () => null });
    await expect(
      gate.request({ ghostId: 'art', url: URL_OK, isPanelFocused: FOCUSED }),
    ).resolves.toEqual({ ok: false, reason: 'not-media' });
  });

  it('lightbox 地址后缀以账本为准(URL 写 .png、账本是 .webp → 用 .webp)', async () => {
    const { gate } = makeGate({ getBlobInfo: async () => ({ ext: '.webp', mimeType: 'image/webp' }) });
    await expect(
      gate.request({ ghostId: 'art', url: URL_OK, isPanelFocused: FOCUSED }),
    ).resolves.toEqual({ ok: true, src: `cindy-media://blobs/${HASH}.webp`, kind: 'image' });
  });
});
