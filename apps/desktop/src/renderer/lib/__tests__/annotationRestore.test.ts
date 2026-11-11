/**
 * annotationRestore —「烧录附件 → 可编辑态」唯一实现的行为锁定。
 *
 * 队列编辑草稿、队列编辑"是否未改"比较、回退草稿三处共用本模块;这里锁住配对
 * 条件(防止把无关原图换进来)与还原形态(原图 url / 扩展名 / MIME、去 annotated、
 * 笔迹深拷贝)。
 */

import { describe, expect, it } from 'vitest';

import {
  annotationStrokesEqual,
  cloneAnnotationStrokes,
  queuedAnnotationEditMeta,
  toEditableAnnotatedAttachment,
} from '@/lib/annotationRestore';
import type { AttachedFile } from '@/lib/fileTypes';

const strokes = [{ points: [{ x: 0.1, y: 0.2 }, { x: 0.3, y: 0.4 }] }];

const burned: AttachedFile = {
  id: 'img-1',
  name: 'shot-annotated.png',
  originalName: 'shot-annotated.png',
  path: '/Users/sam/shot.jpg',
  ext: '.png',
  size: 42,
  category: 'image',
  mimeType: 'image/png',
  url: 'cindy-media://blobs/burned.png',
  annotated: true,
  annotationRegions: [{ x0: 0.1, y0: 0.2, x1: 0.3, y1: 0.4 }],
};

const retry: AttachedFile = {
  ...burned,
  annotationSourceUrl: 'cindy-media://blobs/source.jpg',
  annotationStrokes: strokes,
};

describe('queuedAnnotationEditMeta', () => {
  it('pairs a burned queue file with the retry file that describes it', () => {
    expect(queuedAnnotationEditMeta(burned, retry)).toEqual({
      sourceUrl: 'cindy-media://blobs/source.jpg',
      strokes,
    });
  });

  it('refuses mismatched or incomplete pairs', () => {
    expect(queuedAnnotationEditMeta(burned, undefined)).toBeNull();
    expect(queuedAnnotationEditMeta({ ...burned, annotated: undefined }, retry)).toBeNull();
    expect(queuedAnnotationEditMeta(burned, { ...retry, annotated: undefined })).toBeNull();
    expect(queuedAnnotationEditMeta(burned, { ...retry, url: 'cindy-media://blobs/x.png' })).toBeNull();
    expect(queuedAnnotationEditMeta(burned, { ...retry, path: '/other.png' })).toBeNull();
    expect(
      queuedAnnotationEditMeta(burned, { ...retry, annotationSourceUrl: undefined }),
    ).toBeNull();
    expect(queuedAnnotationEditMeta(burned, { ...retry, annotationStrokes: [] })).toBeNull();
  });
});

describe('toEditableAnnotatedAttachment', () => {
  it('points the attachment back at the unburned source with deep-copied strokes', () => {
    const editable = toEditableAnnotatedAttachment(burned, {
      sourceUrl: 'cindy-media://blobs/source.jpg',
      strokes,
    });

    expect(editable).toMatchObject({
      id: 'img-1',
      name: 'shot-annotated.png',
      path: 'cindy-media://blobs/source.jpg',
      url: 'cindy-media://blobs/source.jpg',
      ext: '.jpg',
      mimeType: 'image/jpeg',
      annotationStrokes: strokes,
    });
    expect(editable).not.toHaveProperty('annotated');
    expect(editable).not.toHaveProperty('annotationRegions');
    expect(editable).not.toHaveProperty('annotationSourceUrl');
    expect(editable.annotationStrokes?.[0]).not.toBe(strokes[0]);
    // 输入不被修改。
    expect(burned.annotated).toBe(true);
  });

  it('keeps the attachment extension when the source url has none', () => {
    const editable = toEditableAnnotatedAttachment(burned, {
      sourceUrl: 'cindy-media://blobs/noext',
      strokes,
    });
    expect(editable.ext).toBe('.png');
    expect(editable.mimeType).toBe('image/png');
  });
});

describe('stroke helpers', () => {
  it('clones only coordinates and compares point by point', () => {
    const cloned = cloneAnnotationStrokes(strokes);
    expect(cloned).toEqual(strokes);
    expect(annotationStrokesEqual(cloned, strokes)).toBe(true);
    expect(annotationStrokesEqual(undefined, [])).toBe(true);
    expect(annotationStrokesEqual(strokes, [])).toBe(false);
    expect(
      annotationStrokesEqual(strokes, [{ points: [{ x: 0.1, y: 0.2 }, { x: 0.3, y: 0.41 }] }]),
    ).toBe(false);
    expect(annotationStrokesEqual(strokes, [{ points: [{ x: 0.1, y: 0.2 }] }])).toBe(false);
  });
});
