/**
 * imageLightboxCloseAnywhere.test.ts
 * ---------------------------------------------------------------------------
 * 回归测试:lightbox 关闭契约(image-lightbox-zoom 起变更)。
 *
 * 历史契约演进:
 *   v1 旧症状:<img> onClick stopPropagation,点图片关不掉,只有背景能关。
 *   v2(lightbox-close-on-any-click):全域关闭,点图片也关。
 *   v3(当前,image-lightbox-zoom):点**背景**关闭;点图片本身不关——单击
 *      必须让位给双击缩放(单击立即关闭会让 dblclick 永远无法触发)与标注
 *      画笔,这也是主流图片查看器的行为。标注模式中背景点击也不关(防误触
 *      丢笔迹,放弃走 X / Esc)。
 *
 * 沿用项目静态源码扫描约定(见 userInfoSectionHover.test.ts),让测试跑在
 * Node vitest 环境,避免为行为契约引入 jsdom + react-dom。
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const sourcePath = resolve(
  __dirname,
  '..',
  'components',
  'chat',
  'ImageLightbox.tsx',
);
const source = readFileSync(sourcePath, 'utf8');
const sourceWithoutBlockComments = source.replace(/\/\*[\s\S]*?\*\//g, '');

describe('ImageLightbox — backdrop click closes, image click does not', () => {
  it('overlay <div> click handler still calls handleClose (backdrop click closes)', () => {
    // overlay 容器保留关闭入口。
    expect(sourceWithoutBlockComments).toMatch(
      /onClick=\{\(e\)\s*=>\s*\{[\s\S]*?handleClose\(\);[\s\S]*?\}\}/,
    );
  });

  it('overlay onClick gates on e.target !== e.currentTarget (image click must NOT close)', () => {
    // 决断(v3):仅背景关闭。点图片不关——单击关闭会吞掉双击缩放。
    expect(source).toMatch(/e\.target\s*!==\s*e\.currentTarget/);
  });

  it('overlay onClick bails out while annotating (stroke loss guard)', () => {
    // 标注模式中误点背景不能丢笔迹;放弃走 X / Esc。
    expect(sourceWithoutBlockComments).toMatch(/if\s*\(isAnnotating\)\s*return;/);
  });
});

describe('ImageLightbox — <img> stays click-transparent', () => {
  it('image element does NOT register its own onClick', () => {
    // 用 ref={imgRef} 锚定真正的 JSX 标签,避免匹配到行注释里的 "<img>" 字样。
    const imageElement =
      sourceWithoutBlockComments.match(/<img\s+ref=\{imgRef\}[\s\S]*?\/>/)?.[0] ?? '';
    expect(imageElement).not.toBe('');
    expect(imageElement).toContain('src={currentSrc}');
    expect(imageElement).not.toMatch(/\bonClick\s*=/);
  });

  it('image element still has onError={handleClose-via-toast} for missing file', () => {
    // image-local-cache F4 契约:缺失文件时关闭 lightbox 并提示用户。
    expect(source).toMatch(/onError=\{\(\)\s*=>\s*\{/);
    expect(source).toContain("toast.warning(t('chat.media.imageMissing'))");
    expect(source).toMatch(/handleClose\(\)/);
  });
});

describe('ImageLightbox — handleClose stays idempotent', () => {
  it('handleClose guards against double-fire via isClosingRef', () => {
    expect(source).toContain('isClosingRef.current');
    expect(source).toMatch(/if\s*\(isClosingRef\.current\)\s*return;/);
  });
});
