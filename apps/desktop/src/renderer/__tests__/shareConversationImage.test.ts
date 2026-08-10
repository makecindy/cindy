// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const loadImageSourceBase64 = vi.fn();
const isImageBytesReachable = vi.fn();

vi.mock('@/lib/annotationBurnIn', () => ({
  loadImageSourceBase64: (src: string) => loadImageSourceBase64(src),
  isImageBytesReachable: (src: string) => isImageBytesReachable(src),
  blobToDataUrl: vi.fn(),
}));

const {
  SHARE_EXCLUDE_ATTR,
  SHARE_MESSAGE_ATTR,
  SHARE_SESSION_ATTR,
  ShareImageTooLargeError,
  assertShareImageReadableSize,
  buildShareImageFooter,
  expandScrollableBlocks,
  inlineCloneImages,
  queryShareableMessageIds,
  redactTextNodes,
  stripCloneAnchors,
  stripInteractiveElements,
} = await import('@/lib/shareConversationImage');

beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = '';
});

function root(html: string): HTMLElement {
  const el = document.createElement('div');
  el.innerHTML = html;
  return el;
}

describe('stripInteractiveElements', () => {
  it('删掉所有打了排除标记的元素,保留正文', () => {
    const el = root(`
      <div class="body">正文内容</div>
      <div ${SHARE_EXCLUDE_ATTR}><button>复制</button></div>
      <p>段落<span ${SHARE_EXCLUDE_ATTR}>hover 工具栏</span></p>
    `);
    stripInteractiveElements(el);
    expect(el.querySelectorAll(`[${SHARE_EXCLUDE_ATTR}]`)).toHaveLength(0);
    expect(el.querySelector('button')).toBeNull();
    expect(el.textContent).toContain('正文内容');
    expect(el.textContent).toContain('段落');
    expect(el.textContent).not.toContain('hover 工具栏');
  });
});

describe('stripCloneAnchors', () => {
  it('清掉会污染全局 querySelector 的锚点属性(含根节点自身)', () => {
    const el = document.createElement('div');
    el.setAttribute(SHARE_SESSION_ATTR, 's1');
    el.setAttribute(SHARE_MESSAGE_ATTR, 'm1');
    el.setAttribute('data-message-client-id', 'client-root');
    el.innerHTML = `<div data-user-msg-id="m1" data-message-client-ids="client-a client-b"><span ${SHARE_MESSAGE_ATTR}="m2">x</span></div>`;

    stripCloneAnchors(el);

    expect(el.hasAttribute(SHARE_SESSION_ATTR)).toBe(false);
    expect(el.hasAttribute(SHARE_MESSAGE_ATTR)).toBe(false);
    expect(el.hasAttribute('data-message-client-id')).toBe(false);
    expect(el.querySelectorAll('[data-user-msg-id]')).toHaveLength(0);
    expect(el.querySelectorAll('[data-message-client-ids]')).toHaveLength(0);
    expect(el.querySelectorAll(`[${SHARE_MESSAGE_ATTR}]`)).toHaveLength(0);
  });

  it('保留 id —— mermaid / KaTeX 产物内部有 url(#id) 自引用', () => {
    const el = root('<svg><clipPath id="mmd-clip-1"></clipPath></svg>');
    stripCloneAnchors(el);
    expect(el.querySelector('#mmd-clip-1')).not.toBeNull();
  });
});

describe('redactTextNodes', () => {
  it('脱掉裸 Bearer token,保留其余正文', () => {
    const el = root('<p>调用失败,令牌 Bearer sk-abc123456789 已过期</p>');
    redactTextNodes(el);
    expect(el.textContent).not.toContain('sk-abc123456789');
    expect(el.textContent).toContain('[REDACTED]');
    expect(el.textContent).toContain('已过期');
  });

  it('header 形式的凭证连同该行剩余内容一起吞掉(既有实现的保守策略)', () => {
    const el = root('<p>Authorization: Bearer sk-abc123456789 trailing</p>');
    redactTextNodes(el);
    expect(el.textContent).not.toContain('sk-abc123456789');
    expect(el.textContent).not.toContain('trailing');
  });

  it('脱掉 key 形式的凭证', () => {
    const el = root('<code>api_key=sk-livesecretvalue123</code>');
    redactTextNodes(el);
    expect(el.textContent).not.toContain('sk-livesecretvalue123');
  });

  it('不改变 DOM 结构(代码高亮的 span 切分必须原样保留)', () => {
    const el = root(
      '<pre><code><span class="a">const t = </span><span class="b">"Bearer sk-zzzzzzzzzz"</span></code></pre>',
    );
    redactTextNodes(el);
    expect(el.querySelectorAll('span')).toHaveLength(2);
    expect(el.querySelector('span.a')?.textContent).toBe('const t = ');
    expect(el.querySelector('span.b')?.textContent).not.toContain('sk-zzzzzzzzzz');
  });

  it('普通正文不被改动', () => {
    const el = root('<p>今天天气不错,我们来聊聊架构设计。</p>');
    const before = el.innerHTML;
    redactTextNodes(el);
    expect(el.innerHTML).toBe(before);
  });
});

describe('inlineCloneImages', () => {
  it('自定义协议图换成 data URL(否则 canvas 会被 taint)', async () => {
    isImageBytesReachable.mockReturnValue(true);
    loadImageSourceBase64.mockResolvedValue({ base64: 'AAAA', mimeType: 'image/png' });

    const el = root('<img src="cindy-media://blobs/abc.png" srcset="x 2x" loading="lazy" />');
    await inlineCloneImages(el);

    const img = el.querySelector('img');
    expect(img?.getAttribute('src')).toBe('data:image/png;base64,AAAA');
    expect(img?.getAttribute('loading')).toBe('eager');
    expect(img?.hasAttribute('srcset')).toBe(false);
  });

  it('已是 data URL 的图也走统一字节层,执行大小限制并归一化', async () => {
    isImageBytesReachable.mockReturnValue(true);
    loadImageSourceBase64.mockResolvedValue({ base64: 'BBBB', mimeType: 'image/png' });
    const el = root('<img src="data:image/png;base64,BBBB" loading="lazy" />');
    await inlineCloneImages(el);

    expect(loadImageSourceBase64).toHaveBeenCalledWith('data:image/png;base64,BBBB');
    expect(el.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,BBBB');
    expect(el.querySelector('img')?.getAttribute('loading')).toBe('eager');
  });

  it('data URL 超出统一字节层上限时移除,不进入 decode / 光栅化', async () => {
    isImageBytesReachable.mockReturnValue(true);
    loadImageSourceBase64.mockRejectedValue(new Error('图片过大'));
    const el = root('<img src="data:image/png;base64,TOO-LARGE" />');

    await inlineCloneImages(el);

    expect(el.querySelector('img')).toBeNull();
  });

  it('字节不可达的图直接移除(留着会渲染成 broken 图标)', async () => {
    isImageBytesReachable.mockReturnValue(false);
    const el = root('<img src="weird-scheme://nope" />');
    await inlineCloneImages(el);
    expect(el.querySelector('img')).toBeNull();
  });

  it('取字节失败时移除该图,不让整张图失败', async () => {
    isImageBytesReachable.mockReturnValue(true);
    loadImageSourceBase64.mockRejectedValue(new Error('read failed'));

    const el = root('<img src="cindy-media://blobs/gone.png" /><p>正文</p>');
    await inlineCloneImages(el);

    expect(el.querySelector('img')).toBeNull();
    expect(el.textContent).toContain('正文');
  });

  it('没有 src 的 img 被移除', async () => {
    const el = root('<img alt="" />');
    await inlineCloneImages(el);
    expect(el.querySelector('img')).toBeNull();
  });
});

describe('assertShareImageReadableSize', () => {
  it('保留至少 1x 的可读导出尺寸', () => {
    const el = root('');
    Object.defineProperties(el, {
      scrollWidth: { value: 800 },
      scrollHeight: { value: 4096 },
    });
    expect(() => assertShareImageReadableSize(el)).not.toThrow();
  });

  it('需要缩到 1x 以下时拒绝生成不可读缩略图', () => {
    const el = root('');
    Object.defineProperties(el, {
      scrollWidth: { value: 800 },
      scrollHeight: { value: 4097 },
    });
    expect(() => assertShareImageReadableSize(el)).toThrow(ShareImageTooLargeError);
  });
});

describe('expandScrollableBlocks', () => {
  it('只对实际溢出的候选读取样式并展开', () => {
    const el = root('<div class="fits"></div><div class="wide"></div>');
    const fits = el.querySelector<HTMLElement>('.fits')!;
    const wide = el.querySelector<HTMLElement>('.wide')!;
    Object.defineProperties(fits, {
      scrollWidth: { value: 100 },
      clientWidth: { value: 100 },
      scrollHeight: { value: 20 },
      clientHeight: { value: 20 },
    });
    Object.defineProperties(wide, {
      scrollWidth: { value: 200 },
      clientWidth: { value: 100 },
      scrollHeight: { value: 20 },
      clientHeight: { value: 20 },
    });
    const getComputedStyle = vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      overflowX: 'auto',
      overflowY: 'visible',
    } as CSSStyleDeclaration);

    try {
      expandScrollableBlocks(el);
      expect(getComputedStyle).toHaveBeenCalledTimes(1);
    } finally {
      getComputedStyle.mockRestore();
    }

    expect(fits.style.overflowX).toBe('');
    expect(wide.style.overflowX).toBe('visible');
    expect(wide.style.width).toBe('max-content');
    expect(wide.style.maxWidth).toBe('none');
  });
});

describe('queryShareableMessageIds', () => {
  it('按文档顺序返回本会话已渲染的可选消息 id', () => {
    document.body.innerHTML = `
      <div ${SHARE_SESSION_ATTR}="s1" ${SHARE_MESSAGE_ATTR}="m1"></div>
      <div ${SHARE_SESSION_ATTR}="s1" ${SHARE_MESSAGE_ATTR}="m2"></div>
      <div ${SHARE_SESSION_ATTR}="s1" ${SHARE_MESSAGE_ATTR}="m3"></div>
    `;
    expect(queryShareableMessageIds('s1')).toEqual(['m1', 'm2', 'm3']);
  });

  it('不串到另一个会话的内嵌消息流', () => {
    document.body.innerHTML = `
      <div ${SHARE_SESSION_ATTR}="s1" ${SHARE_MESSAGE_ATTR}="mine"></div>
      <div ${SHARE_SESSION_ATTR}="s2" ${SHARE_MESSAGE_ATTR}="theirs"></div>
    `;
    expect(queryShareableMessageIds('s1')).toEqual(['mine']);
    expect(queryShareableMessageIds('s2')).toEqual(['theirs']);
  });

  it('没有已渲染消息时返回空数组', () => {
    expect(queryShareableMessageIds('s1')).toEqual([]);
  });

  it('完整转义引号、反斜杠与控制字符', () => {
    const sessionId = 's"\\\n\r\f\u0001';
    const message = document.createElement('div');
    message.setAttribute(SHARE_SESSION_ATTR, sessionId);
    message.setAttribute(SHARE_MESSAGE_ATTR, 'escaped');
    document.body.appendChild(message);

    expect(queryShareableMessageIds(sessionId)).toEqual(['escaped']);
  });
});

describe('buildShareImageFooter', () => {
  it('形象与 logo 横向锁定,不附加网址', () => {
    const footer = buildShareImageFooter({
      logoSrc: 'logo.png',
      characterSrc: 'character.jpg',
    });
    const imgs = Array.from(footer.querySelectorAll('img'));
    expect(imgs.map((el) => el.getAttribute('src'))).toEqual(['character.jpg', 'logo.png']);
    expect(imgs[0].parentElement).toBe(imgs[1].parentElement);
    expect(footer.textContent).toBe('');
  });

  it('角色图标保持小尺寸、圆角与源素材颜色', () => {
    const footer = buildShareImageFooter({
      logoSrc: 'logo.png',
      characterSrc: 'character.jpg',
    });
    const character = footer.querySelector('img');
    expect(character?.style.width).toBe('40px');
    expect(character?.style.height).toBe('40px');
    expect(character?.style.borderRadius).toBe('8px');
    expect(character?.style.objectFit).toBe('cover');
    expect(character?.style.filter).toBe('');
    expect(character?.style.opacity).toBe('');
  });

  it('没有形象时只放 logo', () => {
    const footer = buildShareImageFooter({ logoSrc: 'logo.png' });
    const imgs = Array.from(footer.querySelectorAll('img'));
    expect(imgs.map((el) => el.getAttribute('src'))).toEqual(['logo.png']);
  });
});
