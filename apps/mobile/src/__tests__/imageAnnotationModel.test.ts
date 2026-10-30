import { describe, expect, it } from 'vitest';
import {
  ANNOTATION_CANVAS_SCRIPT,
  annotationStrokeWidth as sharedAnnotationStrokeWidth,
} from '@cindy/maker-shared/image-annotation';
import {
  ANNOTATION_MAX_BURN_DIMENSION,
  ANNOTATION_MIN_POINT_SCREEN_PX,
  ANNOTATION_MULTI_TOUCH_DISCARD_SCREEN_PX,
  MIN_POINT_DISTANCE_RATIO,
  annotationBurnCanvasSize,
  annotationMinPointDistanceForRect,
  annotationStrokesEqual,
  isAnnotationBurnSourceResultUsable,
  planAnnotationBurnSource,
  shouldDiscardInterruptedStroke,
  ANNOTATION_OUTLINE_COLOR,
  ANNOTATION_STROKE_COLOR,
  annotationBaseRect,
  annotationBurnedFileName,
  annotationDisplayRect,
  annotationStrokeToSvgPath,
  annotationStrokeWidth,
  buildAnnotationBurnInHtml,
  buildAnnotationBurnInInvocation,
  canAnnotateImageMime,
  imageMimeForUriFallback,
  isDirectSendableImageMime,
  normalizeAnnotationPoint,
  parseAnnotationBurnInMessage,
  shouldAppendAnnotationPoint,
  sniffImageMimeFromBase64,
} from '@/session/imageAnnotationModel';

describe('annotationBaseRect(contain 布局)', () => {
  it('横图:宽占满,垂直居中', () => {
    // 容器 400x800,图 2000x1000 → fit 比例 0.2 → 400x200,top=(800-200)/2
    expect(annotationBaseRect(400, 800, 2000, 1000)).toEqual({
      left: 0,
      top: 300,
      width: 400,
      height: 200,
    });
  });

  it('竖图:高占满,水平居中', () => {
    expect(annotationBaseRect(400, 800, 500, 1000)).toEqual({
      left: 0,
      top: 0,
      width: 400,
      height: 800,
    });
  });

  it('非法尺寸返回 null', () => {
    expect(annotationBaseRect(0, 800, 100, 100)).toBeNull();
    expect(annotationBaseRect(400, 800, 0, 100)).toBeNull();
  });
});

describe('annotationDisplayRect(transform 后的显示矩形)', () => {
  const base = { left: 0, top: 300, width: 400, height: 200 };

  it('1x 无平移 = 基础矩形', () => {
    expect(annotationDisplayRect(base, 400, 800, 0, 0, 1)).toEqual(base);
  });

  it('缩放围绕容器中心:尺寸 × scale,中心随平移偏移', () => {
    const rect = annotationDisplayRect(base, 400, 800, 40, -30, 2);
    expect(rect.width).toBe(800);
    expect(rect.height).toBe(400);
    // 中心 = (200+40, 400-30) → left = 240-400, top = 370-200
    expect(rect.left).toBe(-160);
    expect(rect.top).toBe(170);
  });
});

describe('normalizeAnnotationPoint', () => {
  const rect = { left: 100, top: 200, width: 200, height: 100 };

  it('矩形内的点按比例归一化', () => {
    expect(normalizeAnnotationPoint(200, 250, rect)).toEqual({ x: 0.5, y: 0.5 });
  });

  it('越界点钳制到边缘(画到图外时贴边)', () => {
    expect(normalizeAnnotationPoint(0, 0, rect)).toEqual({ x: 0, y: 0 });
    expect(normalizeAnnotationPoint(1000, 1000, rect)).toEqual({ x: 1, y: 1 });
  });

  it('零尺寸矩形返回 null', () => {
    expect(normalizeAnnotationPoint(1, 1, { left: 0, top: 0, width: 0, height: 100 })).toBeNull();
  });
});

describe('shouldAppendAnnotationPoint(点距抑制)', () => {
  it('首点恒收', () => {
    expect(shouldAppendAnnotationPoint({ points: [] }, { x: 0.5, y: 0.5 })).toBe(true);
  });

  it('距上一点过近的 move 点丢弃,超过阈值才收', () => {
    const stroke = { points: [{ x: 0.5, y: 0.5 }] };
    expect(shouldAppendAnnotationPoint(stroke, { x: 0.5001, y: 0.5 })).toBe(false);
    expect(shouldAppendAnnotationPoint(stroke, { x: 0.51, y: 0.5 })).toBe(true);
  });
});

describe('annotationStrokeWidth(共享核心公式)', () => {
  it('小图走下限、大图走上限、中等图按比例', () => {
    expect(annotationStrokeWidth(200, 200)).toBe(4);
    expect(annotationStrokeWidth(10000, 10000)).toBe(24);
    expect(annotationStrokeWidth(2000, 3000)).toBe(10);
  });

  it('是共享核心的薄 re-export(超长截图同样加粗)', () => {
    expect(annotationStrokeWidth).toBe(sharedAnnotationStrokeWidth);
    expect(annotationStrokeWidth(1000, 8000)).toBe(sharedAnnotationStrokeWidth(1000, 8000));
  });
});

describe('normalizeAnnotationPoint 量化(共享核心)', () => {
  it('坐标量化到 4 位小数', () => {
    expect(normalizeAnnotationPoint(1, 0, { left: 0, top: 0, width: 3, height: 1 })).toEqual({ x: 0.3333, y: 0 });
  });
});

describe('annotationMinPointDistanceForRect(屏幕像素阈值)', () => {
  it('按显示矩形长边把 1.5 屏幕像素换算成归一化距离', () => {
    expect(annotationMinPointDistanceForRect({ width: 400, height: 300 }))
      .toBeCloseTo(ANNOTATION_MIN_POINT_SCREEN_PX / 400);
    // 放大 4 倍时阈值随之变细,保住放大作画的精度。
    expect(annotationMinPointDistanceForRect({ width: 1600, height: 1200 })!)
      .toBeLessThan(MIN_POINT_DISTANCE_RATIO);
  });

  it('矩形非法时退回共享默认阈值(undefined)', () => {
    expect(annotationMinPointDistanceForRect({ width: 0, height: 0 })).toBeUndefined();
    expect(shouldAppendAnnotationPoint(
      { points: [{ x: 0.5, y: 0.5 }] },
      { x: 0.5015, y: 0.5 },
      annotationMinPointDistanceForRect({ width: 0, height: 0 }),
    )).toBe(false);
  });
});

describe('shouldDiscardInterruptedStroke(捏合起手误触)', () => {
  it('手势被第二根手指取消且路径很短才丢弃', () => {
    expect(shouldDiscardInterruptedStroke(false, 0)).toBe(true);
    expect(shouldDiscardInterruptedStroke(false, ANNOTATION_MULTI_TOUCH_DISCARD_SCREEN_PX - 0.1)).toBe(true);
    expect(shouldDiscardInterruptedStroke(false, ANNOTATION_MULTI_TOUCH_DISCARD_SCREEN_PX)).toBe(false);
    // 单指点按 / 正常结束的笔画永远保留。
    expect(shouldDiscardInterruptedStroke(true, 0)).toBe(false);
  });
});

describe('annotationStrokesEqual', () => {
  it('逐条按引用比较', () => {
    const a = { points: [{ x: 0, y: 0 }] };
    const b = { points: [{ x: 0, y: 0 }] };
    expect(annotationStrokesEqual([a], [a])).toBe(true);
    expect(annotationStrokesEqual([], [])).toBe(true);
    expect(annotationStrokesEqual([a], [b])).toBe(false);
    expect(annotationStrokesEqual([a], [])).toBe(false);
  });
});

describe('planAnnotationBurnSource(烧录前预处理)', () => {
  it('小图 / 尺寸未知:原样交给 WebView(既有路径)', () => {
    expect(planAnnotationBurnSource({ mimeType: 'image/jpeg', platformOS: 'ios', naturalWidth: 2048, naturalHeight: 1536 })).toBeNull();
    expect(planAnnotationBurnSource({ mimeType: 'image/png', platformOS: 'android' })).toBeNull();
  });

  it('超大 JPEG 按上传口径预缩,中间产物保持 JPEG 最高质量,笔迹空间 = 未预缩时的 canvas', () => {
    expect(planAnnotationBurnSource({ mimeType: 'image/jpeg', platformOS: 'ios', naturalWidth: 4032, naturalHeight: 3024 })).toEqual({
      resize: { width: 2048 },
      format: 'jpeg',
      compress: 1,
      strokeSpace: { width: 4032, height: 3024 },
    });
    // 超过 4096 的图,笔迹空间与既有 WebView 安全钳一致。
    expect(planAnnotationBurnSource({ mimeType: 'image/jpeg', platformOS: 'ios', naturalWidth: 6000, naturalHeight: 8000 })?.strokeSpace)
      .toEqual(annotationBurnCanvasSize(6000, 8000));
    expect(annotationBurnCanvasSize(6000, 8000)).toEqual({ width: 3072, height: 4096 });
  });

  it('PNG / WebP 截图预缩为无损 PNG(不改输出格式)', () => {
    expect(planAnnotationBurnSource({ mimeType: 'image/png', platformOS: 'ios', naturalWidth: 1290, naturalHeight: 2796 }))
      .toMatchObject({ resize: { height: 2048 }, format: 'png' });
    expect(planAnnotationBurnSource({ mimeType: 'image/webp', platformOS: 'android', naturalWidth: 3000, naturalHeight: 1000 }))
      .toMatchObject({ resize: { width: 2048 }, format: 'png' });
  });

  it('Android 上 HEIC 即使是小图 / 尺寸未知也先转码为高质量 JPEG,AVIF 转无损 PNG 保留透明;iOS 小图维持原路径', () => {
    expect(planAnnotationBurnSource({ mimeType: 'image/heic', platformOS: 'android', naturalWidth: 800, naturalHeight: 600 }))
      .toEqual({ resize: null, format: 'jpeg', compress: 0.92, strokeSpace: null });
    expect(planAnnotationBurnSource({ mimeType: 'image/avif', platformOS: 'android' }))
      .toEqual({ resize: null, format: 'png', compress: 1, strokeSpace: null });
    // 转码 + 预缩同时发生时仍是 JPEG。
    expect(planAnnotationBurnSource({ mimeType: 'image/heif', platformOS: 'android', naturalWidth: 4032, naturalHeight: 3024 }))
      .toMatchObject({ resize: { width: 2048 }, format: 'jpeg', compress: 0.92, strokeSpace: { width: 4032, height: 3024 } });
    // iOS 大 HEIC 只预缩,保持无损 PNG(与既有非 JPEG 源的输出格式一致)。
    expect(planAnnotationBurnSource({ mimeType: 'image/heic', platformOS: 'ios', naturalWidth: 4032, naturalHeight: 3024 }))
      .toMatchObject({ format: 'png', compress: 1 });
    expect(planAnnotationBurnSource({ mimeType: 'image/heic', platformOS: 'ios', naturalWidth: 800, naturalHeight: 600 })).toBeNull();
  });

  it('未知 / 矢量 / 动图不交给 manipulator', () => {
    for (const mimeType of ['image/svg+xml', 'image/gif', 'image/bmp', 'application/octet-stream']) {
      expect(planAnnotationBurnSource({ mimeType, platformOS: 'android', naturalWidth: 9000, naturalHeight: 9000 })).toBeNull();
    }
  });

  it('预缩产物必须与提示尺寸同宽高比、不超上限,否则回退原路径', () => {
    const plan = planAnnotationBurnSource({ mimeType: 'image/jpeg', platformOS: 'ios', naturalWidth: 4032, naturalHeight: 3024 })!;
    const hint = { width: 4032, height: 3024 };
    expect(isAnnotationBurnSourceResultUsable(plan, { width: 2048, height: 1536 }, hint)).toBe(true);
    expect(isAnnotationBurnSourceResultUsable(plan, { width: 2048, height: 2731 }, hint)).toBe(false); // 方向对不上
    expect(isAnnotationBurnSourceResultUsable(plan, { width: 4032, height: 3024 }, hint)).toBe(false); // 没缩
    expect(isAnnotationBurnSourceResultUsable(plan, { width: 0, height: 0 }, hint)).toBe(false);
    const transcode = planAnnotationBurnSource({ mimeType: 'image/heic', platformOS: 'android' })!;
    expect(isAnnotationBurnSourceResultUsable(transcode, { width: 800, height: 600 }, {})).toBe(true);
  });
});

describe('annotationStrokeToSvgPath', () => {
  it('空笔迹返回空串', () => {
    expect(annotationStrokeToSvgPath({ points: [] }, 100, 100)).toBe('');
  });

  it('单点画极短线段(round cap 呈圆点)', () => {
    const d = annotationStrokeToSvgPath({ points: [{ x: 0.5, y: 0.5 }] }, 100, 100);
    expect(d).toBe('M 50.0 50.0 L 50.1 50.0');
  });

  it('多点连线映射到像素空间', () => {
    const d = annotationStrokeToSvgPath(
      { points: [{ x: 0, y: 0 }, { x: 0.5, y: 0.5 }, { x: 1, y: 1 }] },
      200,
      100,
    );
    expect(d).toBe('M 0.0 0.0 L 100.0 50.0 L 200.0 100.0');
  });
});

describe('烧录 WebView 协议', () => {
  it('HTML 内联共享核心的 canvas 脚本并调用它,不再维护本地副本', () => {
    const html = buildAnnotationBurnInHtml();
    expect(html).toContain(ANNOTATION_CANVAS_SCRIPT);
    expect(html).toContain('cindyDrawAnnotationStrokes(ctx, request.strokes');
    expect(html).not.toContain('function strokeWidthFor');
    expect(html).not.toContain('function drawPass(ctx, strokes');
    // 编码策略只在 mobileImagePreprocess 维护一份,WebView 不做任何上传定稿。
    expect(html).not.toContain('finalize');
  });

  it('HTML 内嵌与模型层一致的视觉参数与安全钳', () => {
    const html = buildAnnotationBurnInHtml();
    expect(html).toContain(ANNOTATION_STROKE_COLOR);
    expect(html).toContain(ANNOTATION_OUTLINE_COLOR);
    expect(html).toContain(String(ANNOTATION_MAX_BURN_DIMENSION));
    expect(html).toContain('window.__xdtBurnIn');
    // 回包协议字段
    expect(html).toContain('ready: true');
  });

  it('invocation 把请求 JSON 内联进调用语句', () => {
    const call = buildAnnotationBurnInInvocation({
      id: 'burn-1',
      base64: 'QUJD',
      mimeType: 'image/png',
      strokes: [{ points: [{ x: 0.1, y: 0.2 }] }],
    });
    expect(call.startsWith('window.__xdtBurnIn({')).toBe(true);
    expect(call).toContain('"id":"burn-1"');
    expect(call).toContain('"base64":"QUJD"');
    expect(call.endsWith('true;')).toBe(true);
  });

  it('parse:ready / 成功 / 失败回包与噪声', () => {
    expect(parseAnnotationBurnInMessage(JSON.stringify({ ready: true }))).toEqual({ ready: true });
    expect(parseAnnotationBurnInMessage(JSON.stringify({
      id: 'burn-2',
      ok: true,
      base64: 'eHl6',
      mimeType: 'image/jpeg',
      width: 10,
      height: 20,
    }))).toEqual({ id: 'burn-2', ok: true, base64: 'eHl6', mimeType: 'image/jpeg', width: 10, height: 20 });
    expect(parseAnnotationBurnInMessage(JSON.stringify({ id: 'burn-3', ok: false, error: 'x' })))
      .toEqual({ id: 'burn-3', ok: false, error: 'x' });
    // 非本协议消息(第三方注入 / 乱码)一律 null
    expect(parseAnnotationBurnInMessage('not-json')).toBeNull();
    expect(parseAnnotationBurnInMessage(JSON.stringify({ foo: 1 }))).toBeNull();
    expect(parseAnnotationBurnInMessage(JSON.stringify({ id: 'x', ok: true }))).toBeNull();
  });
});

describe('sniffImageMimeFromBase64(字节魔数,与桌面 sniffImageMime 同口径)', () => {
  const b64 = (bytes: number[]) => Buffer.from(bytes).toString('base64');

  it('识别 png / jpeg / gif / webp 魔数', () => {
    expect(sniffImageMimeFromBase64(b64([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])))
      .toBe('image/png');
    expect(sniffImageMimeFromBase64(b64([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])))
      .toBe('image/jpeg');
    expect(sniffImageMimeFromBase64(b64([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0, 0, 0])))
      .toBe('image/gif'); // GIF89a
    expect(sniffImageMimeFromBase64(b64([
      0x52, 0x49, 0x46, 0x46, 0x11, 0x22, 0x33, 0x44, 0x57, 0x45, 0x42, 0x50,
    ]))).toBe('image/webp'); // RIFF....WEBP
  });

  it('识别不出返回 null(bmp / 文本 / 空串)', () => {
    expect(sniffImageMimeFromBase64(b64([0x42, 0x4d, 0x36, 0x00, 0x00, 0x00, 0, 0, 0, 0, 0, 0]))).toBeNull(); // BM
    expect(sniffImageMimeFromBase64(Buffer.from('hello world!').toString('base64'))).toBeNull();
    expect(sniffImageMimeFromBase64('')).toBeNull();
  });
});

describe('isDirectSendableImageMime(直传白名单;名单外走光栅化)', () => {
  it('四格式直传,bmp / heic / svg 走烧录光栅化', () => {
    expect(isDirectSendableImageMime('image/png')).toBe(true);
    expect(isDirectSendableImageMime('image/jpeg')).toBe(true);
    expect(isDirectSendableImageMime('image/gif')).toBe(true);
    expect(isDirectSendableImageMime('image/webp')).toBe(true);
    expect(isDirectSendableImageMime('image/bmp')).toBe(false);
    expect(isDirectSendableImageMime('image/heic')).toBe(false);
    expect(isDirectSendableImageMime('image/svg+xml')).toBe(false);
  });
});

describe('imageMimeForUriFallback(嗅探失败的扩展名兜底)', () => {
  it('已知扩展返回真实 mime(含查询串)', () => {
    expect(imageMimeForUriFallback('file:///a/b.PNG')).toBe('image/png');
    expect(imageMimeForUriFallback('https://x/y.jpg?sig=1')).toBe('image/jpeg');
    expect(imageMimeForUriFallback('file:///a/b.heic')).toBe('image/heic');
    expect(imageMimeForUriFallback('file:///a/b.bmp')).toBe('image/bmp');
    expect(imageMimeForUriFallback('file:///a/b.svg')).toBe('image/svg+xml');
  });

  it('绝不默认 image/jpeg:未知扩展 / 无扩展给非直传 mime,落入光栅化路径(review P1)', () => {
    const unknown = imageMimeForUriFallback('https://oss/presigned-no-ext');
    expect(unknown).toBe('application/octet-stream');
    expect(isDirectSendableImageMime(unknown)).toBe(false);
    expect(isDirectSendableImageMime(imageMimeForUriFallback('file:///a/b.heic'))).toBe(false);
  });
});

describe('annotationBurnedFileName / canAnnotateImageMime', () => {
  it('jpeg 保 jpg 扩展,其余 png', () => {
    expect(annotationBurnedFileName('image/jpeg', 123)).toBe('annotated-123.jpg');
    expect(annotationBurnedFileName('image/png', 123)).toBe('annotated-123.png');
    expect(annotationBurnedFileName('image/webp', 123)).toBe('annotated-123.png');
  });

  it('gif / svg / 非图片不开放画笔;未知 mime 放行(由 uri 后缀兜底)', () => {
    expect(canAnnotateImageMime('image/gif')).toBe(false);
    expect(canAnnotateImageMime('image/svg+xml')).toBe(false);
    expect(canAnnotateImageMime('video/mp4')).toBe(false);
    expect(canAnnotateImageMime('image/png')).toBe(true);
    expect(canAnnotateImageMime('image/jpeg')).toBe(true);
    expect(canAnnotateImageMime(undefined)).toBe(true);
  });
});

describe('烧录 WebView 脚本(fake DOM 执行)', () => {
  interface FakeRun {
    posts: Array<Record<string, unknown>>;
    ops: unknown[][];
    dataUrlCalls: Array<[string, number | undefined]>;
  }
  function runBurn(
    request: Record<string, unknown>,
    image: { width: number; height: number },
    encodedBytes: (mime: string, quality: number | undefined) => number,
  ): FakeRun {
    const run: FakeRun = { posts: [], ops: [], dataUrlCalls: [] };
    const html = buildAnnotationBurnInHtml();
    // 只从本模块生成的固定 HTML 里取内联脚本(测试夹具,不是 HTML 过滤)。
    const scripts: string[] = [];
    for (let from = html.indexOf('<script>'); from >= 0; from = html.indexOf('<script>', from)) {
      const end = html.indexOf('</script>', from);
      scripts.push(html.slice(from + '<script>'.length, end));
      from = end;
    }
    const code = scripts.join('\n');
    const ctx = new Proxy({} as Record<string, unknown>, {
      get: (_target, key: string) => (...args: unknown[]) => { run.ops.push([key, ...args]); },
      set: (_target, key: string, value) => { run.ops.push([`set:${key}`, value]); return true; },
    });
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ctx,
      toDataURL: (mime: string, quality?: number) => {
        run.dataUrlCalls.push([mime, quality]);
        const bytes = encodedBytes(mime, quality);
        return `data:${mime};base64,${'A'.repeat(Math.ceil(bytes / 3) * 4)}`;
      },
    };
    class FakeImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      naturalWidth = image.width;
      naturalHeight = image.height;
      width = image.width;
      height = image.height;
      set src(_value: string) { this.onload?.(); }
    }
    const window: Record<string, unknown> = {
      ReactNativeWebView: { postMessage: (raw: string) => run.posts.push(JSON.parse(raw)) },
    };
    const document = { createElement: () => canvas };
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    new Function('window', 'document', 'Image', code)(window, document, FakeImage);
    (window.__xdtBurnIn as (r: unknown) => void)(request);
    return run;
  }
  const strokes = [{ points: [{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.5 }] }];

  it('编码与既有行为一致:JPEG 源 0.92 JPEG、其余 PNG,输出 canvas 尺寸', () => {
    const jpeg = runBurn({ id: 'b1', base64: 'x', mimeType: 'image/jpeg', strokes }, { width: 4032, height: 3024 }, () => 3);
    expect(jpeg.dataUrlCalls).toEqual([['image/jpeg', 0.92]]);
    expect(jpeg.posts.at(-1)).toMatchObject({ id: 'b1', ok: true, mimeType: 'image/jpeg', width: 4032, height: 3024 });
    const png = runBurn({ id: 'b2', base64: 'x', mimeType: 'image/webp', strokes }, { width: 5000, height: 2500 }, () => 3);
    expect(png.dataUrlCalls).toEqual([['image/png', 0.92]]);
    expect(png.posts.at(-1)).toMatchObject({ mimeType: 'image/png', width: 4096, height: 2048 });
  });

  it('预缩源在未预缩的逻辑空间重放笔迹:线宽按逻辑尺寸计算,再等比缩到实际 canvas', () => {
    const run = runBurn(
      { id: 'b5', base64: 'x', mimeType: 'image/jpeg', strokes, strokeSpace: { width: 4032, height: 3024 } },
      { width: 2048, height: 1536 },
      () => 1,
    );
    const scale = run.ops.find((op) => op[0] === 'scale');
    expect(scale?.[1]).toBeCloseTo(2048 / 4032);
    expect(scale?.[2]).toBeCloseTo(1536 / 3024);
    const widths = run.ops.filter((op) => op[0] === 'set:lineWidth').map((op) => op[1]);
    const logicalWidth = annotationStrokeWidth(4032, 3024);
    expect(widths).toEqual([Math.round(logicalWidth * 1.8), logicalWidth]);
    expect(run.ops.find((op) => op[0] === 'moveTo')).toEqual(['moveTo', 0.1 * 4032, 0.1 * 3024]);
    // 不传 strokeSpace:直接在 canvas 尺寸重放(与既有行为一致)。
    const plain = runBurn({ id: 'b6', base64: 'x', mimeType: 'image/png', strokes }, { width: 800, height: 600 }, () => 1);
    expect(plain.ops.some((op) => op[0] === 'scale')).toBe(false);
    expect(plain.ops.filter((op) => op[0] === 'set:lineWidth').map((op) => op[1]))
      .toEqual([Math.round(annotationStrokeWidth(800, 600) * 1.8), annotationStrokeWidth(800, 600)]);
  });
});
